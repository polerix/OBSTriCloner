/**
 * OBSTriCloner — obs-bridge.js
 * Thin wrapper around obs-websocket-js v5 (OBS WebSocket protocol 5.x).
 * All other modules use this singleton to talk to OBS.
 */

const OBSWebSocket = require('obs-websocket-js').default;
const config       = require('./config');
const EventEmitter = require('events');

class OBSBridge extends EventEmitter {
  constructor() {
    super();
    this.obs        = new OBSWebSocket();
    this.connected  = false;
    // Default error handler prevents Node crash on unhandled 'error' events
    this.on('error', (err) => {
      console.error('[OBS] Bridge error (handled):', err.message || err);
    });
    this._bindEvents();
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async connect() {
    const { host, port, password } = config.obs;
    const url = `ws://${host}:${port}`;
    try {
      const { obsWebSocketVersion, negotiatedRpcVersion } =
        await this.obs.connect(url, password, { rpcVersion: 1 });
      this.connected = true;
      console.log(`[OBS] Connected — OBS-WS ${obsWebSocketVersion}, RPC ${negotiatedRpcVersion}`);
      this.emit('connected');
    } catch (err) {
      console.error('[OBS] Connection failed:', err.message, '— retrying in 5s…');
      setTimeout(() => this.connect(), 5000); // auto-reconnect
    }
  }

  _bindEvents() {
    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      console.warn('[OBS] Connection closed — retrying in 5s…');
      this.emit('disconnected');
      setTimeout(() => this.connect(), 5000);
    });

    this.obs.on('ConnectionError', (err) => {
      // Log only — reconnect is handled in connect()'s catch
      console.error('[OBS] Connection error:', err && err.message ? err.message : err);
    });

    // Forward relevant OBS events to daemon consumers
    const fwd = (name) => this.obs.on(name, (data) => this.emit(name, data));
    fwd('CurrentProgramSceneChanged');
    fwd('CurrentPreviewSceneChanged');
    fwd('SceneTransitionStarted');
    fwd('SceneTransitionEnded');
    fwd('InputVolumeChanged');
    fwd('InputMuteStateChanged');
    fwd('SourceFilterEnableStateChanged');
    fwd('MediaInputPlaybackStarted');
    fwd('MediaInputPlaybackEnded');
  }

  // ── Generic call wrapper ──────────────────────────────────────────────────

  async call(requestType, requestData = {}) {
    if (!this.connected) throw new Error('OBS not connected');
    try {
      return await this.obs.call(requestType, requestData);
    } catch (err) {
      console.error(`[OBS] call(${requestType}) error:`, err.message);
      throw err;
    }
  }

  // ── Scene helpers ─────────────────────────────────────────────────────────

  async getSceneList() {
    return this.call('GetSceneList');
  }

  async getCurrentProgramScene() {
    return this.call('GetCurrentProgramScene');
  }

  async getCurrentPreviewScene() {
    return this.call('GetCurrentPreviewScene');
  }

  async setProgramScene(sceneName) {
    return this.call('SetCurrentProgramScene', { sceneName });
  }

  async setPreviewScene(sceneName) {
    return this.call('SetCurrentPreviewScene', { sceneName });
  }

  // ── Studio Mode ───────────────────────────────────────────────────────────

  async enableStudioMode() {
    return this.call('SetStudioModeEnabled', { studioModeEnabled: true });
  }

  async isStudioModeEnabled() {
    const res = await this.call('GetStudioModeEnabled');
    return res.studioModeEnabled;
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  async triggerTransition() {
    return this.call('TriggerStudioModeTransition');
  }

  async setTransition(name, durationMs) {
    await this.call('SetCurrentSceneTransition', { transitionName: name });
    if (durationMs !== undefined) {
      await this.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs });
    }
  }

  async getTransitionList() {
    return this.call('GetSceneTransitionList');
  }

  // ── Source / Filter helpers ───────────────────────────────────────────────

  async getSourceFilterList(sourceName) {
    return this.call('GetSourceFilterList', { sourceName });
  }

  async setSourceFilterEnabled(sourceName, filterName, filterEnabled) {
    return this.call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled });
  }

  async setSourceFilterSettings(sourceName, filterName, filterSettings) {
    return this.call('SetSourceFilterSettings', { sourceName, filterName, filterSettings });
  }

  async createSourceFilter(sourceName, filterName, filterKind, filterSettings = {}) {
    return this.call('CreateSourceFilter', { sourceName, filterName, filterKind, filterSettings });
  }

  // ── Audio helpers ─────────────────────────────────────────────────────────

  async getInputVolume(inputName) {
    return this.call('GetInputVolume', { inputName });
  }

  async setInputVolume(inputName, inputVolumeMul) {
    return this.call('SetInputVolume', { inputName, inputVolumeMul });
  }

  async setInputMute(inputName, inputMuted) {
    return this.call('SetInputMute', { inputName, inputMuted });
  }

  async getInputMute(inputName) {
    return this.call('GetInputMute', { inputName });
  }

  // ── Media / VLC source ────────────────────────────────────────────────────

  async triggerMediaInput(inputName, mediaAction) {
    return this.call('TriggerMediaInputAction', { inputName, mediaAction });
  }

  async getMediaInputStatus(inputName) {
    return this.call('GetMediaInputStatus', { inputName });
  }

  // ── Virtual cam / recording ───────────────────────────────────────────────

  async getRecordStatus() {
    return this.call('GetRecordStatus');
  }

  async getStreamStatus() {
    return this.call('GetStreamStatus');
  }
}

// Export singleton
module.exports = new OBSBridge();
