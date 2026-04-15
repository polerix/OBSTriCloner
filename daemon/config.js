/**
 * OBSTriCloner — config.js
 * OBS WebSocket connection settings + TriCaster-style scene/source mappings.
 * All values can be overridden via environment variables (see .env.example).
 */

require('dotenv').config();

module.exports = {
  // ── OBS WebSocket connection ──────────────────────────────────────────────
  obs: {
    host:     process.env.OBS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.OBS_PORT || '4455'),
    password: process.env.OBS_PASSWORD || '',
  },

  // ── Daemon HTTP + WebSocket server ────────────────────────────────────────
  daemon: {
    port: parseInt(process.env.DAEMON_PORT || '9090'),
  },

  // ── TXTerp / OTV-ARPS automation TCP bridge ───────────────────────────────
  teletext: {
    port: parseInt(process.env.TELETEXT_PORT || '9100'),
  },

  // ── TriCaster bus → OBS scene name mapping ────────────────────────────────
  // Keys are TriCaster input labels; values are OBS scene names.
  // Edit these to match your OBS scene collection.
  inputs: {
    CAM1:  process.env.INPUT_CAM1  || 'Camera 1',
    CAM2:  process.env.INPUT_CAM2  || 'Camera 2',
    CAM3:  process.env.INPUT_CAM3  || 'Camera 3',
    CAM4:  process.env.INPUT_CAM4  || 'Camera 4',
    BG:    process.env.INPUT_BG    || 'Background',
    BLACK: process.env.INPUT_BLACK || 'Black',
    CLIP1: process.env.INPUT_CLIP1 || 'Clip 1',
    CLIP2: process.env.INPUT_CLIP2 || 'Clip 2',
  },

  // ── DSK (Downstream Keyer) configuration ─────────────────────────────────
  // sourceName: OBS source that carries the DSK (e.g. a browser/image source)
  // filterName: Name of the chroma-key filter applied to that source
  dsk: {
    sourceName: process.env.DSK_SOURCE || 'DSK Overlay',
    filterName: process.env.DSK_FILTER || 'Chroma Key',
    // Default chroma key settings (green screen)
    defaultKey: {
      keyColor:      'green',
      similarity:    400,
      smoothness:    80,
      keyColorSpill: 100,
      opacity:       1.0,
      contrast:      0,
      brightness:    0,
      gamma:         0,
    },
  },

  // ── Audio source → OBS input name mapping ─────────────────────────────────
  audio: {
    sources: [
      { id: 'pgm',    label: 'Program',    obsName: process.env.AUDIO_PGM    || 'Program Audio'   },
      { id: 'mic1',   label: 'Mic 1',      obsName: process.env.AUDIO_MIC1   || 'Microphone 1'    },
      { id: 'mic2',   label: 'Mic 2',      obsName: process.env.AUDIO_MIC2   || 'Microphone 2'    },
      { id: 'music',  label: 'Music',      obsName: process.env.AUDIO_MUSIC  || 'Music'           },
      { id: 'fx',     label: 'FX',         obsName: process.env.AUDIO_FX     || 'Sound Effects'   },
      { id: 'return', label: 'IFB Return', obsName: process.env.AUDIO_RETURN || 'IFB Return'      },
    ],
  },

  // ── Default transition settings ────────────────────────────────────────────
  transition: {
    name:         process.env.TRANSITION_NAME     || 'Fade',
    durationMs:   parseInt(process.env.TRANSITION_DURATION || '500'),
    // Available transition names (must match OBS transition names):
    // 'Cut', 'Fade', 'Swipe', 'Slide', 'Stinger', 'Fade to Black', 'Luma Wipe'
  },
};
