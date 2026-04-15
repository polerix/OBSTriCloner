/**
 * OBSTriCloner — teletext-bridge.js
 * TXTerp / OTV-ARPS automation TCP bridge.
 *
 * Protocol: line-oriented key=value or JSON over TCP, port 9100 (configurable).
 * Also exposes an HTTP POST endpoint at /api/teletext for REST callers.
 *
 * Supported commands (key=value format):
 *   CMD=SWITCH_SCENE   SCENE=Camera 1
 *   CMD=PLAY_CLIP      ID=item_001
 *   CMD=OVERLAY_ON     DSK=DSK1
 *   CMD=OVERLAY_OFF    DSK=DSK1
 *   CMD=AUDIO_LEVEL    CH=pgm  LEVEL=0.8
 *   CMD=CUT
 *   CMD=AUTO
 *   CMD=PLAYLIST_PLAY  IDX=0
 *   CMD=PLAYLIST_STOP
 *   CMD=PLAYLIST_NEXT
 *   CMD=PLAYLIST_PREV
 *   CMD=STATUS                        → returns JSON state dump
 *
 * JSON format also accepted: { "cmd": "SWITCH_SCENE", "scene": "Camera 1" }
 */

const net          = require('net');
const EventEmitter = require('events');
const config       = require('./config');

class TeletextBridge extends EventEmitter {
  constructor() {
    super();
    this._server    = null;
    this._handlers  = {};  // cmd → async function(params, respond)
    this._sockets   = new Set();
  }

  /** Register handler modules (called from index.js after all modules init). */
  registerHandlers(bus, dsk, playlist, mixer) {
    this._bus      = bus;
    this._dsk      = dsk;
    this._playlist = playlist;
    this._mixer    = mixer;

    this._handlers = {
      SWITCH_SCENE:   async (p, r) => { await bus.setPreview(p.SCENE || p.scene); await bus.auto(); r('OK'); },
      CUT:            async (p, r) => { await bus.cut(); r('OK'); },
      AUTO:           async (p, r) => { await bus.auto(); r('OK'); },
      OVERLAY_ON:     async (p, r) => { await dsk.enable(p.DSK || 'DSK1'); r('OK'); },
      OVERLAY_OFF:    async (p, r) => { await dsk.disable(p.DSK || 'DSK1'); r('OK'); },
      AUDIO_LEVEL:    async (p, r) => { await mixer.setVolume(p.CH || p.ch, parseFloat(p.LEVEL || p.level)); r('OK'); },
      PLAY_CLIP:      async (p, r) => { await playlist.jumpTo(p.ID || p.id); r('OK'); },
      PLAYLIST_PLAY:  async (p, r) => { await playlist.play(parseInt(p.IDX || 0)); r('OK'); },
      PLAYLIST_STOP:  async (p, r) => { playlist.stop(); r('OK'); },
      PLAYLIST_NEXT:  async (p, r) => { await playlist.next(); r('OK'); },
      PLAYLIST_PREV:  async (p, r) => { await playlist.prev(); r('OK'); },
      STATUS:         async (p, r) => {
        r(JSON.stringify({
          bus:      bus.getState(),
          dsk:      dsk.getState(),
          playlist: playlist.getState(),
          mixer:    mixer.getState(),
        }));
      },
    };
  }

  // ── TCP server ────────────────────────────────────────────────────────────

  start() {
    const port = config.teletext.port;
    this._server = net.createServer((socket) => {
      this._sockets.add(socket);
      socket.setEncoding('utf8');
      console.log(`[Teletext] Client connected: ${socket.remoteAddress}:${socket.remotePort}`);

      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        lines.forEach(line => {
          line = line.trim();
          if (line) this._dispatch(line, (resp) => socket.write(resp + '\n'));
        });
      });

      socket.on('close', () => {
        this._sockets.delete(socket);
        console.log('[Teletext] Client disconnected');
      });

      socket.on('error', (err) => {
        console.error('[Teletext] Socket error:', err.message);
        this._sockets.delete(socket);
      });
    });

    this._server.listen(port, () => {
      console.log(`[Teletext] TCP bridge listening on port ${port}`);
    });

    this._server.on('error', (err) => {
      console.error('[Teletext] Server error:', err.message);
    });
  }

  stop() {
    this._sockets.forEach(s => s.destroy());
    if (this._server) this._server.close();
  }

  // ── HTTP handler (called from index.js express router) ────────────────────

  async handleHTTP(req, res) {
    const body = req.body || {};
    // Normalise to uppercase keys
    const params = {};
    Object.keys(body).forEach(k => { params[k.toUpperCase()] = body[k]; });
    const cmd = params.CMD || params.cmd;
    if (!cmd) return res.status(400).json({ error: 'Missing CMD' });

    try {
      await this._dispatch(
        JSON.stringify(body),
        (resp) => res.json({ result: resp })
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async _dispatch(raw, respond) {
    let params = {};
    let cmd;

    // Try JSON first
    if (raw.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(raw);
        cmd = (obj.CMD || obj.cmd || '').toUpperCase();
        Object.keys(obj).forEach(k => { params[k.toUpperCase()] = obj[k]; });
      } catch (_) { respond('ERR invalid JSON'); return; }
    } else {
      // key=value pairs: CMD=SWITCH_SCENE SCENE=Camera 1
      raw.split(/\s+/).forEach(pair => {
        const [k, ...rest] = pair.split('=');
        if (k) params[k.toUpperCase()] = rest.join('=');
      });
      cmd = params.CMD;
    }

    if (!cmd) { respond('ERR no CMD'); return; }

    const handler = this._handlers[cmd];
    if (!handler) { respond(`ERR unknown CMD: ${cmd}`); return; }

    try {
      await handler(params, respond);
      this.emit('command', { cmd, params });
      console.log(`[Teletext] CMD=${cmd}`);
    } catch (err) {
      console.error(`[Teletext] CMD=${cmd} error:`, err.message);
      respond(`ERR ${err.message}`);
    }
  }

  /** Broadcast a message to all connected TCP clients (e.g. status updates). */
  broadcast(msg) {
    const line = (typeof msg === 'object' ? JSON.stringify(msg) : msg) + '\n';
    this._sockets.forEach(s => { try { s.write(line); } catch (_) {} });
  }
}

module.exports = new TeletextBridge();
