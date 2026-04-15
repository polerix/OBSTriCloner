/**
 * OBSTriCloner — tricaster-bus.js
 * Implements the TriCaster-style Program/Preview bus with T-bar switching.
 *
 * Concept map:
 *   TriCaster Program  → OBS current program scene (live output)
 *   TriCaster Preview  → OBS current preview scene (Studio Mode)
 *   T-bar              → transition with configurable duration + type
 *   Cut                → instant scene switch (no transition)
 *   Auto               → scene switch with configured transition + duration
 */

const obs    = require('./obs-bridge');
const config = require('./config');
const EventEmitter = require('events');

class TriCasterBus extends EventEmitter {
  constructor() {
    super();
    this.program        = null;  // current on-air scene name
    this.preview        = null;  // current preview scene name
    this.transitioning  = false;
    this.transitionName = config.transition.name;
    this.transitionMs   = config.transition.durationMs;
    this.tbarPosition   = 0;     // 0 = idle, 1 = full transition
    this._sceneList     = [];

    obs.on('connected',                    () => this._onOBSConnected());
    obs.on('CurrentProgramSceneChanged',   (d) => this._onProgramChanged(d));
    obs.on('CurrentPreviewSceneChanged',   (d) => this._onPreviewChanged(d));
    obs.on('SceneTransitionStarted',       (d) => this._onTransitionStarted(d));
    obs.on('SceneTransitionEnded',         (d) => this._onTransitionEnded(d));
  }

  // ── Initialise from OBS state ─────────────────────────────────────────────

  async _onOBSConnected() {
    try {
      await obs.enableStudioMode();
      const [pgm, prv, scenes] = await Promise.all([
        obs.getCurrentProgramScene(),
        obs.getCurrentPreviewScene(),
        obs.getSceneList(),
      ]);
      this.program    = pgm.currentProgramSceneName;
      this.preview    = prv.currentPreviewSceneName;
      this._sceneList = scenes.scenes.map(s => s.sceneName);
      await obs.setTransition(this.transitionName, this.transitionMs);
      console.log(`[Bus] Program="${this.program}" Preview="${this.preview}"`);
      this.emit('state', this._state());
    } catch (err) {
      console.error('[Bus] Init error:', err.message);
    }
  }

  // ── OBS event handlers ────────────────────────────────────────────────────

  _onProgramChanged({ sceneName }) {
    this.program = sceneName;
    this.emit('programChanged', sceneName);
    this.emit('state', this._state());
  }

  _onPreviewChanged({ sceneName }) {
    this.preview = sceneName;
    this.emit('previewChanged', sceneName);
    this.emit('state', this._state());
  }

  _onTransitionStarted({ transitionName }) {
    this.transitioning = true;
    this.emit('transitionStarted', transitionName);
    this.emit('state', this._state());
  }

  _onTransitionEnded({ transitionName }) {
    this.transitioning = false;
    this.tbarPosition  = 0;
    this.emit('transitionEnded', transitionName);
    this.emit('state', this._state());
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Instantly cut preview → program (no transition). */
  async cut() {
    if (this.transitioning) return;
    const prev = this.preview;
    await obs.setTransition('Cut', 0);
    await obs.triggerTransition();
    // Restore preferred transition
    await obs.setTransition(this.transitionName, this.transitionMs);
    console.log(`[Bus] CUT → ${prev}`);
    this.emit('cut', prev);
  }

  /** Auto-transition: preview → program with current transition type/duration. */
  async auto() {
    if (this.transitioning) return;
    await obs.setTransition(this.transitionName, this.transitionMs);
    await obs.triggerTransition();
    console.log(`[Bus] AUTO ${this.transitionName} ${this.transitionMs}ms → ${this.preview}`);
    this.emit('auto', { scene: this.preview, transition: this.transitionName, ms: this.transitionMs });
  }

  /**
   * T-bar move. position 0–1 (float).
   * Simulates T-bar by adjusting transition duration on the fly:
   * position=1 triggers the transition at the proportional speed.
   */
  async tbar(position) {
    this.tbarPosition = Math.max(0, Math.min(1, position));
    this.emit('tbar', this.tbarPosition);
    // When T-bar is pushed all the way (≥0.98) trigger the transition
    if (this.tbarPosition >= 0.98 && !this.transitioning) {
      const elapsed = Math.round(this.transitionMs * this.tbarPosition);
      await obs.setTransition(this.transitionName, Math.max(50, elapsed));
      await obs.triggerTransition();
    }
  }

  /** Set which scene is on preview bus. */
  async setPreview(sceneName) {
    if (!this._sceneList.includes(sceneName)) {
      throw new Error(`Unknown scene: ${sceneName}`);
    }
    await obs.setPreviewScene(sceneName);
  }

  /** Directly take a scene to program (bypasses preview). */
  async takeToProgram(sceneName) {
    await this.setPreview(sceneName);
    await this.cut();
  }

  /** Change active transition type. */
  async setTransitionType(name) {
    this.transitionName = name;
    await obs.setTransition(name, this.transitionMs);
    this.emit('state', this._state());
    console.log(`[Bus] Transition type → ${name}`);
  }

  /** Change transition duration in ms. */
  async setTransitionDuration(ms) {
    this.transitionMs = ms;
    await obs.setTransition(this.transitionName, ms);
    this.emit('state', this._state());
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  getSceneList() {
    return this._sceneList;
  }

  _state() {
    return {
      program:        this.program,
      preview:        this.preview,
      transitioning:  this.transitioning,
      tbarPosition:   this.tbarPosition,
      transitionName: this.transitionName,
      transitionMs:   this.transitionMs,
      scenes:         this._sceneList,
    };
  }

  getState() {
    return this._state();
  }
}

module.exports = new TriCasterBus();
