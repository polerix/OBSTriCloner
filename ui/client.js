/**
 * OBSTriCloner — client.js
 * WebSocket client for the OBSTriCloner daemon.
 * Drives the TriCaster-style UI: monitors, input bus, audio mixer, playlist.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  connected: false,
  bus:      { program: null, preview: null, scenes: [], transitioning: false, transitionName: 'Fade', transitionMs: 500 },
  dsk:      { layers: [] },
  playlist: { running: false, loop: false, currentIdx: -1, items: [] },
  mixer:    { channels: [] },
};

// ── WebSocket ─────────────────────────────────────────────────────────────

let ws;
let reconnectTimer;
const WS_URL = `ws://${location.host}/ws`;

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(reconnectTimer);
    setObsStatus(true);
  };

  ws.onclose = () => {
    console.warn('[WS] Closed — retrying in 3s');
    setObsStatus(false);
    reconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => console.error('[WS] Error', e);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) {
      console.error('[WS] Parse error', err);
    }
  };
}

function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// ── Message dispatch ──────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      Object.assign(state, msg.data);
      renderAll();
      break;
    case 'bus:state':
    case 'bus:program':
    case 'bus:preview':
      Object.assign(state.bus, msg.data);
      renderBus();
      break;
    case 'bus:transitionStarted':
      state.bus.transitioning = true;
      document.getElementById('program-monitor').classList.add('transitioning');
      document.getElementById('auto-btn').classList.add('is-active');
      break;
    case 'bus:transitionEnded':
      state.bus.transitioning = false;
      document.getElementById('program-monitor').classList.remove('transitioning');
      document.getElementById('auto-btn').classList.remove('is-active');
      renderBus();
      break;
    case 'dsk:state':
      Object.assign(state.dsk, msg.data);
      renderDSK();
      break;
    case 'playlist:state':
      Object.assign(state.playlist, msg.data);
      renderPlaylist();
      break;
    case 'playlist:itemStarted':
      renderPlaylist();
      break;
    case 'mixer:state':
      Object.assign(state.mixer, msg.data);
      renderMixer();
      break;
    case 'obs:connected':
      setObsStatus(true);
      break;
    case 'obs:disconnected':
      setObsStatus(false);
      break;
  }
}

// ── UI renders ────────────────────────────────────────────────────────────

function renderAll() {
  renderBus();
  renderDSK();
  renderMixer();
  renderPlaylist();
}

function renderBus() {
  const { program, preview, scenes, transitioning, transitionName, transitionMs } = state.bus;

  document.getElementById('program-name').textContent = program || '—';
  document.getElementById('preview-name').textContent  = preview  || '—';

  document.getElementById('sb-trans').textContent = transitionName;
  document.getElementById('sb-dur').textContent   = transitionMs + 'ms';

  // Sync transition selector
  const sel = document.getElementById('trans-type-select');
  if (sel.value !== transitionName) sel.value = transitionName;
  document.getElementById('trans-ms').value = transitionMs;

  renderInputBus(scenes, program, preview);
}

function renderInputBus(scenes, program, preview) {
  const bus = document.getElementById('input-bus');
  if (!scenes || scenes.length === 0) {
    bus.innerHTML = '<div style="color:#666;font-size:11px;padding:20px;">No scenes found. Check OBS connection.</div>';
    return;
  }

  // Only re-render if scene list changed
  const existing = [...bus.querySelectorAll('.input-btn')].map(b => b.dataset.scene);
  const same = JSON.stringify(existing) === JSON.stringify(scenes);

  if (!same) {
    bus.innerHTML = '';
    scenes.forEach(sceneName => {
      const btn = document.createElement('div');
      btn.className = 'input-btn';
      btn.dataset.scene = sceneName;
      btn.innerHTML = `
        <div class="input-thumb">🎥</div>
        <div class="input-label">${escHtml(shortName(sceneName))}</div>
        <div class="input-sub">${escHtml(sceneName)}</div>
        <div class="input-bus-row">
          <div class="bus-dot pgm-dot"></div>
          <div class="bus-dot prv-dot"></div>
        </div>`;

      // Left click → take to preview
      btn.addEventListener('click', () => UI.setPreview(sceneName));
      // Right click → take directly to program
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); UI.takeToProgram(sceneName); });

      bus.appendChild(btn);
    });
  }

  // Update active states
  bus.querySelectorAll('.input-btn').forEach(btn => {
    const sc = btn.dataset.scene;
    btn.classList.toggle('is-program', sc === program);
    btn.classList.toggle('is-preview', sc === preview);
    btn.querySelector('.pgm-dot').classList.toggle('pgm', sc === program);
    btn.querySelector('.prv-dot').classList.toggle('prv', sc === preview);
  });
}

function renderDSK() {
  const layers = state.dsk.layers || [];

  layers.forEach(layer => {
    const btn = document.getElementById(`dsk${layer.id.replace('DSK','')}-btn`);
    if (btn) btn.classList.toggle('is-on', layer.enabled);
  });

  const dsk1 = layers.find(l => l.id === 'DSK1');
  document.getElementById('sb-dsk1').textContent = dsk1 ? (dsk1.enabled ? 'ON' : 'OFF') : '—';
}

function renderMixer() {
  const mixer = document.getElementById('audio-mixer');
  const channels = state.mixer.channels || [];

  // Re-render channels if count changed
  if (mixer.children.length !== channels.length) {
    mixer.innerHTML = '';
    channels.forEach(ch => {
      const col = document.createElement('div');
      col.className = 'audio-channel';
      col.dataset.id = ch.id;
      col.innerHTML = `
        <div class="ch-label">${escHtml(ch.label)}</div>
        <div class="fader-track" data-id="${ch.id}">
          <div class="fader-fill" style="height:${Math.round(ch.volume*100)}%"></div>
          <div class="fader-handle" style="bottom:calc(${Math.round(ch.volume*100)}% - 5px)"></div>
        </div>
        <div class="ch-db">${ch.db ? ch.db.toFixed(1) : '0.0'} dB</div>
        <button class="mute-btn${ch.muted ? ' is-muted' : ''}" data-id="${ch.id}" onclick="UI.toggleMute('${ch.id}')">
          ${ch.muted ? 'MUTE' : 'M'}
        </button>`;

      // Fader drag
      setupFaderDrag(col.querySelector('.fader-track'), ch.id);
      mixer.appendChild(col);
    });
  } else {
    // Update values
    channels.forEach(ch => {
      const col = mixer.querySelector(`.audio-channel[data-id="${ch.id}"]`);
      if (!col) return;
      const pct = Math.round(ch.volume * 100);
      col.querySelector('.fader-fill').style.height   = pct + '%';
      col.querySelector('.fader-handle').style.bottom = `calc(${pct}% - 5px)`;
      col.querySelector('.ch-db').textContent         = (ch.db ? ch.db.toFixed(1) : '0.0') + ' dB';
      const muteBtn = col.querySelector('.mute-btn');
      muteBtn.classList.toggle('is-muted', ch.muted);
      muteBtn.textContent = ch.muted ? 'MUTE' : 'M';
    });
  }
}

function renderPlaylist() {
  const { running, loop, currentIdx, items } = state.playlist;
  const queue = document.getElementById('playlist-queue');

  document.getElementById('pl-loop').checked = loop;
  const playBtn = document.getElementById('pl-play-btn');
  playBtn.textContent = running ? '⏹ STOP' : '▶ PLAY';
  playBtn.classList.toggle('is-active', running);

  document.getElementById('sb-playlist').textContent =
    running && items[currentIdx] ? `▶ ${items[currentIdx].label || items[currentIdx].sceneName}` : 'Idle';

  queue.innerHTML = '';
  (items || []).forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `pl-item${idx === currentIdx ? ' active' : ''}`;
    const dur = item.durationMs ? formatDur(item.durationMs) : '∞';
    row.innerHTML = `
      <span class="pl-idx">${idx + 1}</span>
      <div>
        <div class="pl-name">${escHtml(item.label || item.sceneName)}</div>
        <div class="pl-scene">${escHtml(item.sceneName)}</div>
      </div>
      <span class="pl-timecode">${item.startAt ? new Date(item.startAt).toLocaleTimeString() : ''}</span>
      <span class="pl-dur">${dur}</span>`;
    row.addEventListener('dblclick', () => UI.playlistJumpTo(item.id));
    queue.appendChild(row);
  });
}

// ── Fader drag ────────────────────────────────────────────────────────────

function setupFaderDrag(track, chId) {
  let dragging = false;

  track.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = track.getBoundingClientRect();
    const rel  = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    UI.setVolume(chId, rel);
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // Touch support
  track.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const touch = e.touches[0];
    const rect  = track.getBoundingClientRect();
    const rel   = 1 - Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height));
    UI.setVolume(chId, rel);
  });
  document.addEventListener('touchend', () => { dragging = false; });
}

// ── T-bar drag ────────────────────────────────────────────────────────────

(function setupTbar() {
  const track  = document.getElementById('tbar-track');
  const handle = document.getElementById('tbar-handle');
  let dragging = false;

  function updatePos(clientY) {
    const rect = track.getBoundingClientRect();
    const pos  = Math.max(0, Math.min(1, 1 - ((clientY - rect.top - 10) / (rect.height - 20))));
    const pct  = (1 - pos) * 100;
    handle.style.top = `calc(${pct}% - 10px)`;
    UI.tbar(pos);
  }

  track.addEventListener('mousedown',  (e) => { dragging = true; e.preventDefault(); updatePos(e.clientY); });
  document.addEventListener('mousemove', (e) => { if (dragging) updatePos(e.clientY); });
  document.addEventListener('mouseup',   () => { dragging = false; });
})();

// ── UI action handlers ────────────────────────────────────────────────────

const UI = {
  cut()                  { apiPost('/api/bus', { action: 'cut' }); },
  auto()                 { apiPost('/api/bus', { action: 'auto' }); },
  tbar(pos)              { send('bus', { action: 'tbar', position: pos }); },
  setPreview(scene)      { send('bus', { action: 'setPreview', scene }); },
  takeToProgram(scene)   { apiPost('/api/bus', { action: 'takeToProgram', scene }); },
  setTransitionType(t)   { apiPost('/api/bus', { action: 'setTransition', transition: t }); },
  setTransitionDuration(ms) { apiPost('/api/bus', { action: 'setDuration', durationMs: ms }); },

  toggleDSK(id)          { apiPost('/api/dsk', { action: 'toggle', id }); },
  openChromaKey()        { alert('Chroma Key settings: configure DSK_SOURCE and DSK_FILTER in .env, or use /api/dsk endpoint directly.'); },

  setVolume(id, vol)     { send('audio', { action: 'setVolume', id, volume: vol }); },
  toggleMute(id)         { send('audio', { action: 'toggleMute', id }); },

  playlistPlayStop()     {
    if (state.playlist.running) { apiPost('/api/playlist', { action: 'stop' }); }
    else                        { apiPost('/api/playlist', { action: 'play', idx: Math.max(0, state.playlist.currentIdx) }); }
  },
  playlistNext()         { apiPost('/api/playlist', { action: 'next' }); },
  playlistPrev()         { apiPost('/api/playlist', { action: 'prev' }); },
  playlistJumpTo(id)     { apiPost('/api/playlist', { action: 'jumpTo', id }); },
  setLoop(loop)          { apiPost('/api/playlist', { action: 'setLoop', loop }); },
  scheduleAll()          { apiPost('/api/playlist', { action: 'schedule' }); },
};

// ── API helpers ───────────────────────────────────────────────────────────

async function apiPost(url, body) {
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) console.error(`[API] ${url} error:`, data);
  } catch (err) {
    console.error(`[API] ${url} fetch error:`, err);
  }
}

// ── OBS status indicator ──────────────────────────────────────────────────

function setObsStatus(connected) {
  const ind  = document.getElementById('obs-indicator');
  const text = document.getElementById('obs-status-text');
  ind.className  = connected ? 'connected' : 'error';
  text.textContent = connected ? 'OBS Connected' : 'OBS Disconnected';
}

// ── Clock ─────────────────────────────────────────────────────────────────

function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ── Utilities ─────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shortName(name) {
  if (name.length <= 10) return name;
  return name.substring(0, 9) + '…';
}

function formatDur(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return s + 's';
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────

connectWS();
