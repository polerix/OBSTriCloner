/**
 * OBSTriCloner — arps-bridge.js
 * ARPS (Automated Record Playback System) ↔ OTV integration bridge.
 *
 * OTV (On-The-Video) is a browser-based broadcast scheduler/cassette UI.
 * This bridge exposes HTTP + SSE endpoints so OTV can:
 *   1. Report cassette/slot state → OBSTriCloner triggers OBS scene switches
 *   2. Receive OBSTriCloner on-air state → OTV displays program info
 *
 * Endpoints (added to the existing Express app):
 *   GET  /api/arps/state   — snapshot of OBSTriCloner state in OTV-friendly format
 *   GET  /api/arps/stream  — SSE stream: OBSTriCloner → OTV real-time push
 *   POST /api/arps/event   — OTV → OBSTriCloner event delivery
 *
 * OTV event types (POST body JSON):
 *   { type: 'slot-live',     label, scheduledTime, duration }
 *   { type: 'cassette-play', id, label, sceneName? }
 *   { type: 'cassette-cued', id, label }
 *   { type: 'cassette-stop' }
 *   { type: 'playlist-sync', items: [{id, label, sceneName, durationMs, startAt}] }
 *   { type: 'status-query' }
 *
 * Label-to-scene resolution order:
 *   1. ARPS_SCENE_MAP env var (JSON, e.g. '{"Die Hard":"Movie-Scene"}')
 *   2. Fuzzy match against playlist item labels
 *   3. Fuzzy match against known OBS scene names (from bus state)
 */

'use strict';

const EventEmitter = require('events');
const config       = require('./config');

class ARPSBridge extends EventEmitter {
  constructor() {
    super();
    this._bus        = null;
    this._dsk        = null;
    this._playlist   = null;
    this._mixer      = null;
    this._broadcast  = null;   // ws broadcast fn from index.js
    this._sseClients = new Set();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Wire up Express routes and bind to daemon modules.
   * Call from index.js after all modules are initialised.
   *
   * @param {Express} app
   * @param {TricasterBus} bus
   * @param {DskManager} dsk
   * @param {PlaylistEngine} playlist
   * @param {AudioMixer} mixer
   * @param {Function} broadcast  — ws broadcast helper from index.js
   */
  registerHandlers(app, bus, dsk, playlist, mixer, broadcast) {
    if (!config.arps.enabled) {
      console.log('[ARPS] Bridge disabled (ARPS_ENABLED=false)');
      return;
    }

    this._bus       = bus;
    this._dsk       = dsk;
    this._playlist  = playlist;
    this._mixer     = mixer;
    this._broadcast = broadcast;

    // ── CORS middleware for ARPS routes ──────────────────────────────────────
    const cors = (req, res, next) => {
      const origin = config.arps.otvOrigin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    };

    app.use('/api/arps', cors);

    // ── State snapshot ───────────────────────────────────────────────────────
    app.get('/api/arps/state', (req, res) => {
      res.json(this._makeState());
    });

    // ── SSE stream: OBSTriCloner → OTV ───────────────────────────────────────
    app.get('/api/arps/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send full state immediately on connect
      this._writeSSE(res, { type: 'init', ...this._makeState() });

      this._sseClients.add(res);
      console.log(`[ARPS] OTV SSE connected (${this._sseClients.size} client(s))`);

      req.on('close', () => {
        this._sseClients.delete(res);
        console.log(`[ARPS] OTV SSE disconnected (${this._sseClients.size} remaining)`);
      });
    });

    // ── Event receiver: OTV → OBSTriCloner ───────────────────────────────────
    app.post('/api/arps/event', async (req, res) => {
      const event = req.body;
      if (!event || !event.type) {
        return res.status(400).json({ error: 'Missing event type' });
      }
      try {
        const result = await this._handleOTVEvent(event);
        res.json({ ok: true, result });
      } catch (err) {
        console.error(`[ARPS] Event handler error (${event.type}):`, err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Subscribe to OBSTriCloner state events → push via SSE ───────────────
    const push = (type, data) => this._pushSSE({ type, ...data });

    bus.on('programChanged',    (d) => push('obs:program',    d));
    bus.on('previewChanged',    (d) => push('obs:preview',    d));
    bus.on('transitionStarted', (d) => push('obs:transition', d));
    bus.on('transitionEnded',   (d) => push('obs:ready',      d));
    playlist.on('itemStarted',  (d) => push('playlist:item',  d));
    playlist.on('state',        (d) => push('playlist:state', d));
    mixer.on('state',           (d) => push('mixer:state',    d));

    console.log('[ARPS] Bridge active — OTV endpoint: GET/POST /api/arps/');
  }

  // ── OTV → OBSTriCloner event dispatcher ──────────────────────────────────

  async _handleOTVEvent(event) {
    const { type } = event;
    console.log(`[ARPS] OTV event: ${type}`);

    switch (type) {

      // Schedule slot went live → switch OBS to the matching scene
      case 'slot-live': {
        const sceneName = this._resolveScene(event.label);
        if (sceneName) {
          await this._bus.takeToProgram(sceneName);
          console.log(`[ARPS] slot-live "${event.label}" → scene "${sceneName}"`);
          return { scene: sceneName };
        }
        const item = this._findPlaylistItem(event.label);
        if (item) {
          await this._playlist.jumpTo(item.id);
          console.log(`[ARPS] slot-live "${event.label}" → playlist "${item.id}"`);
          return { playlistItem: item.id };
        }
        console.warn(`[ARPS] No scene/playlist match for slot "${event.label}"`);
        return { warning: `No match for slot "${event.label}"` };
      }

      // Cassette became active → switch scene or jump playlist
      case 'cassette-play': {
        const item = this._findPlaylistItem(event.label || event.id);
        if (item) {
          await this._playlist.jumpTo(item.id);
          return { playlistItem: item.id };
        }
        const sceneName = this._resolveScene(event.label);
        if (sceneName) {
          await this._bus.takeToProgram(sceneName);
          return { scene: sceneName };
        }
        return { warning: `No match for cassette "${event.label || event.id}"` };
      }

      // Cassette cued → set OBS preview
      case 'cassette-cued': {
        const sceneName = this._resolveScene(event.label);
        if (sceneName) {
          await this._bus.setPreview(sceneName);
          return { preview: sceneName };
        }
        return { warning: `No preview match for "${event.label}"` };
      }

      // Cassette stopped
      case 'cassette-stop': {
        this._playlist.stop();
        return { stopped: true };
      }

      // OTV pushes its full schedule as a playlist → load into playlist-engine
      case 'playlist-sync': {
        if (Array.isArray(event.items) && event.items.length > 0) {
          this._playlist.load(event.items);
          console.log(`[ARPS] Synced ${event.items.length} OTV schedule items into playlist`);
          return { loaded: event.items.length };
        }
        return { warning: 'Empty items array' };
      }

      case 'status-query':
        return this._makeState();

      default:
        console.warn(`[ARPS] Unknown OTV event type: ${type}`);
        return { warning: `Unknown event type: ${type}` };
    }
  }

  // ── Scene resolution ─────────────────────────────────────────────────────

  /** Resolve an OTV label to an OBS scene name.
   *  Priority: ARPS_SCENE_MAP → playlist label match → bus scene list fuzzy. */
  _resolveScene(label) {
    if (!label) return null;
    const map = config.arps.sceneMap || {};

    // 1. Exact key match
    if (map[label]) return map[label];

    // 2. Case-insensitive partial key match
    const lower = label.toLowerCase();
    for (const [key, val] of Object.entries(map)) {
      if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
        return val;
      }
    }

    // 3. Fuzzy match against current OBS scene names (if bus exposes them)
    const busState = this._bus.getState();
    if (Array.isArray(busState.scenes)) {
      const match = busState.scenes.find(s =>
        s.toLowerCase().includes(lower) || lower.includes(s.toLowerCase())
      );
      if (match) return match;
    }

    return null;
  }

  /** Find a playlist item by id or label (case-insensitive, partial). */
  _findPlaylistItem(label) {
    if (!label) return null;
    const items = this._playlist.getState().items || [];
    const lower = label.toLowerCase();
    return (
      items.find(i => i.id === label) ||
      items.find(i => i.label && i.label.toLowerCase() === lower) ||
      items.find(i => i.label && i.label.toLowerCase().includes(lower))
    );
  }

  // ── State builder ────────────────────────────────────────────────────────

  /** Build a state object for OTV to consume (safe to serialise). */
  _makeState() {
    const bus  = this._bus  ? this._bus.getState()      : {};
    const pl   = this._playlist ? this._playlist.getState() : {};
    const mix  = this._mixer ? this._mixer.getState()   : {};
    return {
      obs: {
        program:    bus.program    || null,
        preview:    bus.preview    || null,
        transition: bus.transition || null,
      },
      playlist: {
        running:    pl.running    || false,
        current:    pl.current    || null,
        currentIdx: pl.currentIdx !== undefined ? pl.currentIdx : -1,
        items:      pl.items      || [],
      },
      mixer: mix,
      ts: Date.now(),
    };
  }

  // ── SSE helpers ──────────────────────────────────────────────────────────

  _writeSSE(res, payload) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  }

  _pushSSE(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    this._sseClients.forEach(res => {
      try { res.write(line); } catch (_) { this._sseClients.delete(res); }
    });
  }
}

module.exports = new ARPSBridge();
