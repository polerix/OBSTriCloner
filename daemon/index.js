/**
 * OBSTriCloner — index.js
 * Entry point: spins up the HTTP + WebSocket daemon.
 *
 * Routes:
 *   GET  /              → serve ui/index.html
 *   GET  /api/state     → full system state JSON
 *   POST /api/bus       → bus commands (cut, auto, tbar, setPreview, setTransition)
 *   POST /api/dsk       → DSK commands (enable, disable, toggle, setChromaKey)
 *   POST /api/playlist  → playlist commands (load, play, stop, next, prev, append, jumpTo)
 *   POST /api/audio     → audio commands (setVolume, setVolumeDb, mute, unmute, fade)
 *   POST /api/teletext  → OTV-ARPS automation command pass-through
 *   WS   /ws            → WebSocket: real-time state push + command input
 */

require('dotenv').config();
const express     = require('express');
const http        = require('http');
const path        = require('path');
const { WebSocketServer } = require('ws');

const config    = require('./config');
const obs       = require('./obs-bridge');
const bus       = require('./tricaster-bus');
const dsk       = require('./dsk-manager');
const playlist  = require('./playlist-engine');
const mixer     = require('./audio-mixer');
const teletext  = require('./teletext-bridge');
const arps      = require('./arps-bridge');

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../ui')));

// ── API: State ────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({
    connected: obs.connected,
    bus:       bus.getState(),
    dsk:       dsk.getState(),
    playlist:  playlist.getState(),
    mixer:     mixer.getState(),
  });
});

// ── API: Bus ──────────────────────────────────────────────────────────────

app.post('/api/bus', async (req, res) => {
  const { action, scene, position, transition, durationMs } = req.body;
  try {
    switch (action) {
      case 'cut':             await bus.cut(); break;
      case 'auto':            await bus.auto(); break;
      case 'tbar':            await bus.tbar(parseFloat(position)); break;
      case 'setPreview':      await bus.setPreview(scene); break;
      case 'takeToProgram':   await bus.takeToProgram(scene); break;
      case 'setTransition':   await bus.setTransitionType(transition); break;
      case 'setDuration':     await bus.setTransitionDuration(parseInt(durationMs)); break;
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    res.json({ ok: true, state: bus.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: DSK ──────────────────────────────────────────────────────────────

app.post('/api/dsk', async (req, res) => {
  const { action, id = 'DSK1', settings, keyColor } = req.body;
  try {
    switch (action) {
      case 'enable':        await dsk.enable(id); break;
      case 'disable':       await dsk.disable(id); break;
      case 'toggle':        await dsk.toggle(id); break;
      case 'setChromaKey':  await dsk.setChromaKey(id, settings); break;
      case 'setKeyColor':   await dsk.setKeyColor(id, keyColor); break;
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    res.json({ ok: true, state: dsk.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Playlist ─────────────────────────────────────────────────────────

app.post('/api/playlist', async (req, res) => {
  const { action, items, item, idx, id, loop } = req.body;
  try {
    switch (action) {
      case 'load':     playlist.load(items); break;
      case 'append':   playlist.append(item); break;
      case 'remove':   playlist.remove(id); break;
      case 'play':     await playlist.play(idx || 0); break;
      case 'pause':    playlist.pause(); break;
      case 'stop':     playlist.stop(); break;
      case 'next':     await playlist.next(); break;
      case 'prev':     await playlist.prev(); break;
      case 'jumpTo':   await playlist.jumpTo(id); break;
      case 'setLoop':  playlist.setLoop(!!loop); break;
      case 'schedule': playlist.scheduleAll(); break;
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    res.json({ ok: true, state: playlist.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Audio ────────────────────────────────────────────────────────────

app.post('/api/audio', async (req, res) => {
  const { action, id, volume, db, durationMs } = req.body;
  try {
    switch (action) {
      case 'setVolume':   await mixer.setVolume(id, parseFloat(volume)); break;
      case 'setVolumeDb': await mixer.setVolumeDb(id, parseFloat(db)); break;
      case 'mute':        await mixer.mute(id); break;
      case 'unmute':      await mixer.unmute(id); break;
      case 'toggleMute':  await mixer.toggleMute(id); break;
      case 'fade':        await mixer.fade(id, parseFloat(volume), parseInt(durationMs || 1000)); break;
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    res.json({ ok: true, state: mixer.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Teletext / OTV-ARPS ──────────────────────────────────────────────

app.post('/api/teletext', (req, res) => teletext.handleHTTP(req, res));

// ── HTTP + WebSocket server ───────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// Broadcast helper
const broadcast = (type, data) => {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
};

// Push state events to all WS clients
const pushers = [
  [bus,      'state',             'bus:state'],
  [bus,      'programChanged',    'bus:program'],
  [bus,      'previewChanged',    'bus:preview'],
  [bus,      'transitionStarted', 'bus:transitionStarted'],
  [bus,      'transitionEnded',   'bus:transitionEnded'],
  [dsk,      'state',             'dsk:state'],
  [playlist, 'state',             'playlist:state'],
  [playlist, 'itemStarted',       'playlist:itemStarted'],
  [mixer,    'state',             'mixer:state'],
  [obs,      'connected',         'obs:connected'],
  [obs,      'disconnected',      'obs:disconnected'],
];
pushers.forEach(([emitter, event, type]) => {
  emitter.on(event, (data) => broadcast(type, data));
});

// Incoming WS messages (same API as HTTP, for low-latency UI control)
wss.on('connection', (ws, req) => {
  console.log(`[WS] Client connected: ${req.socket.remoteAddress}`);

  // Send full state on connect
  ws.send(JSON.stringify({ type: 'init', data: {
    connected: obs.connected,
    bus:       bus.getState(),
    dsk:       dsk.getState(),
    playlist:  playlist.getState(),
    mixer:     mixer.getState(),
  }}));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      const { type, payload } = msg;

      // Route to correct API handler by type prefix
      if (type === 'bus')      { const r = await handleBusCmd(payload); ws.send(JSON.stringify({ type: 'ack', data: r })); }
      else if (type === 'dsk') { const r = await handleDskCmd(payload);  ws.send(JSON.stringify({ type: 'ack', data: r })); }
      else if (type === 'audio') { const r = await handleAudioCmd(payload); ws.send(JSON.stringify({ type: 'ack', data: r })); }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', data: err.message }));
    }
  });

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// Minimal WS command handlers
async function handleBusCmd(p) {
  switch (p.action) {
    case 'cut':           await bus.cut(); break;
    case 'auto':          await bus.auto(); break;
    case 'tbar':          await bus.tbar(parseFloat(p.position)); break;
    case 'setPreview':    await bus.setPreview(p.scene); break;
    case 'takeToProgram': await bus.takeToProgram(p.scene); break;
    case 'setTransition': await bus.setTransitionType(p.transition); break;
    case 'setDuration':   await bus.setTransitionDuration(parseInt(p.durationMs)); break;
  }
  return bus.getState();
}
async function handleDskCmd(p) {
  switch (p.action) {
    case 'enable':       await dsk.enable(p.id || 'DSK1'); break;
    case 'disable':      await dsk.disable(p.id || 'DSK1'); break;
    case 'toggle':       await dsk.toggle(p.id || 'DSK1'); break;
    case 'setChromaKey': await dsk.setChromaKey(p.id || 'DSK1', p.settings); break;
  }
  return dsk.getState();
}
async function handleAudioCmd(p) {
  switch (p.action) {
    case 'setVolume':  await mixer.setVolume(p.id, parseFloat(p.volume)); break;
    case 'mute':       await mixer.mute(p.id); break;
    case 'unmute':     await mixer.unmute(p.id); break;
    case 'toggleMute': await mixer.toggleMute(p.id); break;
  }
  return mixer.getState();
}

// ── Boot sequence ─────────────────────────────────────────────────────────

const PORT = config.daemon.port;
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║     OBSTriCloner Daemon — ready       ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  HTTP:      http://localhost:${PORT}     ║`);
  console.log(`║  WebSocket: ws://localhost:${PORT}/ws    ║`);
  console.log(`║  Teletext:  TCP port ${config.teletext.port}             ║`);
  console.log(`║  ARPS/OTV:  /api/arps/ (SSE + HTTP)  ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  // Start TCP automation bridge
  teletext.registerHandlers(bus, dsk, playlist, mixer);
  teletext.start();

  // Start ARPS ↔ OTV HTTP/SSE bridge
  arps.registerHandlers(app, bus, dsk, playlist, mixer, broadcast);

  // Connect to OBS
  obs.connect();
});

server.on('error', (err) => {
  console.error('[Daemon] Server error:', err.message);
  process.exit(1);
});

process.on('SIGINT',  () => { console.log('\nShutting down…'); teletext.stop(); process.exit(0); });
process.on('SIGTERM', () => { teletext.stop(); process.exit(0); });
