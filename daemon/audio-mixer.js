/**
 * OBSTriCloner — audio-mixer.js
 * TriCaster-style audio fader control over OBS audio sources.
 *
 * Exposes per-source:
 *   - volume (linear 0–1, maps to OBS inputVolumeMul)
 *   - mute toggle
 *   - fader dB convenience method (converts dB → linear)
 *
 * Source list comes from config.audio.sources.
 */

const obs    = require('./obs-bridge');
const config = require('./config');
const EventEmitter = require('events');

// dB <→ linear helpers (OBS uses linear 0–1 for SetInputVolume)
const dbToLinear = (db) => db <= -100 ? 0 : Math.pow(10, db / 20);
const linearToDb = (lin) => lin <= 0 ? -100 : 20 * Math.log10(lin);

class AudioMixer extends EventEmitter {
  constructor() {
    super();
    // channels: { id, label, obsName, volume (0-1), muted, db }
    this.channels = config.audio.sources.map(s => ({
      ...s,
      volume: 1.0,
      muted:  false,
      db:     0,
    }));

    obs.on('connected',           () => this._onOBSConnected());
    obs.on('InputVolumeChanged',  (d) => this._onVolumeChanged(d));
    obs.on('InputMuteStateChanged', (d) => this._onMuteChanged(d));
  }

  async _onOBSConnected() {
    // Sync initial state from OBS
    for (const ch of this.channels) {
      try {
        const [vol, mute] = await Promise.all([
          obs.getInputVolume(ch.obsName),
          obs.getInputMute(ch.obsName),
        ]);
        ch.volume = vol.inputVolumeMul;
        ch.db     = vol.inputVolumeDb;
        ch.muted  = mute.inputMuted;
      } catch (_) {
        // Source may not exist yet — silently skip
      }
    }
    this.emit('state', this._state());
    console.log('[Audio] Mixer synced from OBS');
  }

  _onVolumeChanged({ inputName, inputVolumeMul, inputVolumeDb }) {
    const ch = this.channels.find(c => c.obsName === inputName);
    if (!ch) return;
    ch.volume = inputVolumeMul;
    ch.db     = inputVolumeDb;
    this.emit('volumeChanged', { id: ch.id, volume: ch.volume, db: ch.db });
    this.emit('state', this._state());
  }

  _onMuteChanged({ inputName, inputMuted }) {
    const ch = this.channels.find(c => c.obsName === inputName);
    if (!ch) return;
    ch.muted = inputMuted;
    this.emit('muteChanged', { id: ch.id, muted: ch.muted });
    this.emit('state', this._state());
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Set volume by linear value (0–1). */
  async setVolume(id, volume) {
    const ch = this._getCh(id);
    volume = Math.max(0, Math.min(1, volume));
    await obs.setInputVolume(ch.obsName, volume);
    ch.volume = volume;
    ch.db     = linearToDb(volume);
    this.emit('state', this._state());
  }

  /** Set volume by dB value (−100 … +26 typical). */
  async setVolumeDb(id, db) {
    await this.setVolume(id, dbToLinear(db));
  }

  /** Mute a channel. */
  async mute(id) {
    const ch = this._getCh(id);
    await obs.setInputMute(ch.obsName, true);
    ch.muted = true;
    this.emit('state', this._state());
  }

  /** Unmute a channel. */
  async unmute(id) {
    const ch = this._getCh(id);
    await obs.setInputMute(ch.obsName, false);
    ch.muted = false;
    this.emit('state', this._state());
  }

  /** Toggle mute. Returns new muted state. */
  async toggleMute(id) {
    const ch = this._getCh(id);
    ch.muted ? await this.unmute(id) : await this.mute(id);
    return ch.muted;
  }

  /** Fade volume from current level to target over durationMs. */
  async fade(id, targetVolume, durationMs = 1000, steps = 30) {
    const ch      = this._getCh(id);
    const start   = ch.volume;
    const delta   = targetVolume - start;
    const stepMs  = durationMs / steps;
    for (let i = 1; i <= steps; i++) {
      await new Promise(r => setTimeout(r, stepMs));
      const v = start + (delta * i / steps);
      await obs.setInputVolume(ch.obsName, Math.max(0, Math.min(1, v)));
    }
    ch.volume = targetVolume;
    ch.db     = linearToDb(targetVolume);
    this.emit('state', this._state());
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  _getCh(id) {
    const ch = this.channels.find(c => c.id === id);
    if (!ch) throw new Error(`Audio channel "${id}" not found`);
    return ch;
  }

  _state() {
    return { channels: this.channels.map(c => ({ ...c })) };
  }

  getState() { return this._state(); }
}

module.exports = new AudioMixer();
