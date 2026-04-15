/**
 * OBSTriCloner — playlist-engine.js
 * Scheduled playout / clip queue engine — TriCaster playlist row equivalent.
 *
 * Features:
 *   - Ordered clip queue with scene/source switching
 *   - Timecode-aware playback (wall-clock scheduling)
 *   - Manual step (next/prev/jump)
 *   - Loop mode
 *   - Status events for UI + teletext-bridge
 *
 * Each playlist item:
 *   { id, label, sceneName, durationMs, startAt (ISO string, optional), notes }
 */

const bus  = require('./tricaster-bus');
const EventEmitter = require('events');

class PlaylistEngine extends EventEmitter {
  constructor() {
    super();
    this.items      = [];   // ordered playlist
    this.currentIdx = -1;   // which item is active (-1 = idle)
    this.running    = false;
    this.loop       = false;
    this._timer     = null;
    this._schedTimers = [];
  }

  // ── Playlist management ───────────────────────────────────────────────────

  /** Replace the entire playlist. */
  load(items) {
    this.stop();
    this.items      = items.map((item, i) => ({ ...item, id: item.id || `item_${i}` }));
    this.currentIdx = -1;
    console.log(`[Playlist] Loaded ${this.items.length} items`);
    this.emit('loaded', this.items);
    this.emit('state', this._state());
  }

  /** Append a single item to the end. */
  append(item) {
    item.id = item.id || `item_${Date.now()}`;
    this.items.push(item);
    this.emit('state', this._state());
  }

  /** Remove item by id. */
  remove(id) {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) return;
    this.items.splice(idx, 1);
    if (this.currentIdx >= idx) this.currentIdx--;
    this.emit('state', this._state());
  }

  /** Reorder: move item at fromIdx to toIdx. */
  reorder(fromIdx, toIdx) {
    const [item] = this.items.splice(fromIdx, 1);
    this.items.splice(toIdx, 0, item);
    this.emit('state', this._state());
  }

  // ── Transport controls ────────────────────────────────────────────────────

  /** Start playback from the beginning (or current position). */
  async play(startIdx = 0) {
    if (this.items.length === 0) return;
    this.running    = true;
    this.currentIdx = Math.max(0, Math.min(startIdx, this.items.length - 1));
    await this._playCurrentItem();
  }

  /** Pause auto-advance (stays on current item). */
  pause() {
    this.running = false;
    this._clearTimer();
    console.log('[Playlist] Paused');
    this.emit('paused');
    this.emit('state', this._state());
  }

  /** Stop and reset to beginning. */
  stop() {
    this.running    = false;
    this.currentIdx = -1;
    this._clearTimer();
    this._clearScheduleTimers();
    console.log('[Playlist] Stopped');
    this.emit('stopped');
    this.emit('state', this._state());
  }

  /** Step to next item. */
  async next() {
    this._clearTimer();
    if (this.currentIdx < this.items.length - 1) {
      this.currentIdx++;
    } else if (this.loop) {
      this.currentIdx = 0;
    } else {
      this.stop();
      return;
    }
    await this._playCurrentItem();
  }

  /** Step to previous item. */
  async prev() {
    this._clearTimer();
    if (this.currentIdx > 0) {
      this.currentIdx--;
    } else if (this.loop) {
      this.currentIdx = this.items.length - 1;
    }
    await this._playCurrentItem();
  }

  /** Jump directly to item by id. */
  async jumpTo(id) {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) throw new Error(`Playlist item "${id}" not found`);
    this._clearTimer();
    this.currentIdx = idx;
    await this._playCurrentItem();
  }

  /** Set loop mode. */
  setLoop(loop) {
    this.loop = loop;
    this.emit('state', this._state());
  }

  // ── Wall-clock scheduler ─────────────────────────────────────────────────

  /**
   * Schedule items with startAt ISO timestamps.
   * Any item with a startAt in the future will fire automatically.
   */
  scheduleAll() {
    this._clearScheduleTimers();
    const now = Date.now();
    this.items.forEach((item, idx) => {
      if (!item.startAt) return;
      const fireAt = new Date(item.startAt).getTime();
      const delay  = fireAt - now;
      if (delay <= 0) return;
      const t = setTimeout(async () => {
        console.log(`[Playlist] Scheduled fire: ${item.label || item.id}`);
        this.currentIdx = idx;
        this.running    = true;
        await this._playCurrentItem();
      }, delay);
      this._schedTimers.push(t);
      console.log(`[Playlist] Scheduled "${item.label}" in ${Math.round(delay/1000)}s`);
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _playCurrentItem() {
    const item = this.items[this.currentIdx];
    if (!item) return;

    console.log(`[Playlist] → [${this.currentIdx + 1}/${this.items.length}] ${item.label || item.sceneName}`);
    this.emit('itemStarted', { idx: this.currentIdx, item });
    this.emit('state', this._state());

    // Switch the scene
    try {
      await bus.takeToProgram(item.sceneName);
    } catch (err) {
      console.error(`[Playlist] Scene switch error: ${err.message}`);
    }

    // Auto-advance after duration
    if (this.running && item.durationMs > 0) {
      this._timer = setTimeout(() => this.next(), item.durationMs);
    }
  }

  _clearTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _clearScheduleTimers() {
    this._schedTimers.forEach(t => clearTimeout(t));
    this._schedTimers = [];
  }

  _state() {
    return {
      running:    this.running,
      loop:       this.loop,
      currentIdx: this.currentIdx,
      current:    this.currentIdx >= 0 ? this.items[this.currentIdx] : null,
      items:      this.items,
    };
  }

  getState() { return this._state(); }
}

module.exports = new PlaylistEngine();
