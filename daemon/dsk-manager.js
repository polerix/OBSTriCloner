/**
 * OBSTriCloner — dsk-manager.js
 * Downstream Keyer (DSK) and chroma-key management.
 *
 * TriCaster DSK concept:
 *   - A DSK is an overlay source that sits on top of program output.
 *   - It can be keyed (chroma, luma, alpha) so the background shows through.
 *   - In OBS, this is modelled as a source with a chroma-key (or other) filter.
 *
 * This module manages:
 *   1. DSK on/off (enable/disable the filter on the overlay source)
 *   2. Chroma key parameter tweaking
 *   3. Multiple DSK layers (DSK1, DSK2, …)
 */

const obs    = require('./obs-bridge');
const config = require('./config');
const EventEmitter = require('events');

class DSKManager extends EventEmitter {
  constructor() {
    super();
    // Registry of DSK slots: { id, sourceName, filterName, enabled, settings }
    this.layers = [];
    obs.on('connected',                    () => this._onOBSConnected());
    obs.on('SourceFilterEnableStateChanged', (d) => this._onFilterStateChanged(d));
  }

  async _onOBSConnected() {
    // Seed default DSK1 from config
    await this.registerLayer('DSK1', config.dsk.sourceName, config.dsk.filterName);
    this.emit('state', this._state());
  }

  // ── Layer registration ────────────────────────────────────────────────────

  /**
   * Register a DSK layer.
   * If the chroma-key filter doesn't exist on the source it will be created.
   */
  async registerLayer(id, sourceName, filterName) {
    try {
      const filters = await obs.getSourceFilterList(sourceName);
      let filter = filters.filters.find(f => f.filterName === filterName);

      if (!filter) {
        console.log(`[DSK] Creating filter "${filterName}" on "${sourceName}"`);
        await obs.createSourceFilter(sourceName, filterName, 'chroma_key_filter_v2', config.dsk.defaultKey);
        filter = { filterEnabled: false, filterSettings: config.dsk.defaultKey };
      }

      const layer = {
        id,
        sourceName,
        filterName,
        enabled:  filter.filterEnabled,
        settings: filter.filterSettings || config.dsk.defaultKey,
      };

      const existing = this.layers.findIndex(l => l.id === id);
      if (existing >= 0) {
        this.layers[existing] = layer;
      } else {
        this.layers.push(layer);
      }

      console.log(`[DSK] Layer ${id} registered (source="${sourceName}", filter="${filterName}", on=${layer.enabled})`);
    } catch (err) {
      console.error(`[DSK] registerLayer(${id}) error:`, err.message);
    }
  }

  _onFilterStateChanged({ sourceName, filterName, filterEnabled }) {
    const layer = this.layers.find(
      l => l.sourceName === sourceName && l.filterName === filterName
    );
    if (layer) {
      layer.enabled = filterEnabled;
      this.emit('layerChanged', { id: layer.id, enabled: filterEnabled });
      this.emit('state', this._state());
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Enable a DSK layer (show overlay). */
  async enable(id) {
    const layer = this._getLayer(id);
    await obs.setSourceFilterEnabled(layer.sourceName, layer.filterName, true);
    layer.enabled = true;
    console.log(`[DSK] ${id} ON`);
    this.emit('state', this._state());
  }

  /** Disable a DSK layer (hide overlay). */
  async disable(id) {
    const layer = this._getLayer(id);
    await obs.setSourceFilterEnabled(layer.sourceName, layer.filterName, false);
    layer.enabled = false;
    console.log(`[DSK] ${id} OFF`);
    this.emit('state', this._state());
  }

  /** Toggle DSK layer on/off. Returns new enabled state. */
  async toggle(id) {
    const layer = this._getLayer(id);
    if (layer.enabled) {
      await this.disable(id);
    } else {
      await this.enable(id);
    }
    return layer.enabled;
  }

  /**
   * Update chroma key settings for a DSK layer.
   * settings: { keyColor, similarity, smoothness, keyColorSpill, opacity, contrast, brightness, gamma }
   */
  async setChromaKey(id, settings) {
    const layer = this._getLayer(id);
    const merged = Object.assign({}, layer.settings, settings);
    await obs.setSourceFilterSettings(layer.sourceName, layer.filterName, merged);
    layer.settings = merged;
    console.log(`[DSK] ${id} chroma key updated`);
    this.emit('state', this._state());
  }

  /** Change the key colour (green, blue, magenta, red, cyan, yellow, white, custom). */
  async setKeyColor(id, keyColor) {
    await this.setChromaKey(id, { keyColor });
  }

  /** Add a second DSK layer dynamically. */
  async addLayer(id, sourceName, filterName) {
    await this.registerLayer(id, sourceName, filterName);
    this.emit('state', this._state());
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  _getLayer(id) {
    const layer = this.layers.find(l => l.id === id);
    if (!layer) throw new Error(`DSK layer "${id}" not registered`);
    return layer;
  }

  _state() {
    return { layers: this.layers.map(l => ({ ...l })) };
  }

  getState() { return this._state(); }
}

module.exports = new DSKManager();
