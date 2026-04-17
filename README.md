# OBSTriCloner

A TriCaster PRO-style broadcast control daemon for OBS Studio. Gives OBS a professional switcher workflow: multi-camera preview/program bus, T-bar transitions, DSK/chroma key management, audio mixer, and scheduled playlist — all controllable from a dark broadcast-style web UI or via TCP automation (TXTerp/OTV-ARPS compatible).

## Quick Start

```bash
# 1. Install Node.js 18+ from https://nodejs.org/

# 2. Run the installer (first time or re-run to reconfigure)
bash install.sh          # macOS / Linux
install.bat              # Windows

# — or — run setup directly if npm install already done:
npm run setup

# 3. Follow the prompts (OBS password, scene mapping)

# 4. Start the daemon
npm start

# 5. Open the control surface
open http://localhost:9090
```

**Pre-flight check only** (no writes, safe to run anytime):
```bash
npm run check
```

> **New to OBSTriCloner?** The setup wizard will:
> - Detect your OBS installation and WebSocket settings
> - Hash and write a secure password to OBS's `global.ini`
> - Save your password to `.env` (and encrypt a local backup in `.env.enc`)
> - Discover your OBS scenes and auto-populate the input mapping

---

## Architecture

```
daemon/index.js          HTTP + WebSocket server (port 9090)
daemon/obs-bridge.js     obs-websocket-js v5 client
daemon/tricaster-bus.js  Program/Preview bus, T-bar, transitions
daemon/dsk-manager.js    Downstream Keyer / chroma key
daemon/playlist-engine.js Scheduled playout, clip queue
daemon/audio-mixer.js    Per-source volume/mute faders
daemon/teletext-bridge.js TXTerp/OTV-ARPS TCP bridge (port 9100)
daemon/config.js         All config + env var overrides

python/obs_control.py    Standalone Python controller (fallback/scripted)

ui/index.html            TriCaster-style web control surface
ui/style.css             Dark broadcast UI
ui/client.js             WebSocket client
```

## Manual Setup (alternative to the wizard)

If you prefer to configure manually instead of using `npm run setup`:

### 1. OBS Setup (required)

In OBS Studio:
- **Tools → WebSocket Server Settings**
- Enable WebSocket server, port `4455`
- Set a password (copy it to `.env`)
- Enable **Studio Mode** (View → Studio Mode) — required for preview/program bus

### 2. Install & Configure

```bash
cd /path/to/OBSTriCloner
npm install
cp .env.example .env
# Edit .env — set OBS_PASSWORD and scene names to match your OBS setup
```

### 3. Run

```bash
npm start
# or for dev with auto-restart:
npm run dev
```

Open **http://localhost:9090** in your browser for the control surface.

## Web UI Controls

| Control | Action |
|---------|--------|
| Input bus buttons (left-click) | Set preview |
| Input bus buttons (right-click) | Take directly to program |
| CUT button | Instant cut preview → program |
| AUTO button | Transition with selected type/duration |
| T-bar | Drag to manually fade to transition |
| Transition selector | Change transition type |
| Duration input | Set transition duration (ms) |
| DSK 1 / DSK 2 | Toggle downstream keyer on/off |
| Audio faders | Drag to set volume |
| M button | Mute/unmute audio channel |
| Playlist | Double-click item to jump to it |

## REST API

All endpoints accept and return JSON.

```
GET  /api/state                    Full state dump
POST /api/bus    { action, ... }   Bus commands
POST /api/dsk    { action, ... }   DSK commands
POST /api/audio  { action, ... }   Audio commands
POST /api/playlist { action, ... } Playlist commands
POST /api/teletext { cmd, ... }    OTV-ARPS command pass-through
```

### Bus actions
- `cut` — instant cut
- `auto` — auto transition
- `tbar` + `position` (0–1) — T-bar position
- `setPreview` + `scene` — set preview scene
- `takeToProgram` + `scene` — take scene directly to air
- `setTransition` + `transition` — change transition type
- `setDuration` + `durationMs` — change duration

### DSK actions
- `enable` / `disable` / `toggle` + `id` (DSK1, DSK2…)
- `setChromaKey` + `id` + `settings` object
- `setKeyColor` + `id` + `keyColor`

### Audio actions
- `setVolume` + `id` + `volume` (0–1)
- `setVolumeDb` + `id` + `db`
- `mute` / `unmute` / `toggleMute` + `id`
- `fade` + `id` + `volume` + `durationMs`

### Playlist actions
- `load` + `items` array
- `append` / `remove` + `item` / `id`
- `play` + `idx` / `pause` / `stop`
- `next` / `prev`
- `jumpTo` + `id`
- `setLoop` + `loop` (bool)
- `schedule` — fire all startAt timers

## TXTerp / OTV-ARPS TCP Protocol

Connect to TCP port `9100`. Send line-terminated key=value commands:

```
CMD=SWITCH_SCENE SCENE=Camera 1
CMD=CUT
CMD=AUTO
CMD=OVERLAY_ON DSK=DSK1
CMD=OVERLAY_OFF DSK=DSK1
CMD=AUDIO_LEVEL CH=pgm LEVEL=0.8
CMD=PLAYLIST_PLAY IDX=0
CMD=PLAYLIST_STOP
CMD=PLAYLIST_NEXT
CMD=PLAYLIST_PREV
CMD=PLAY_CLIP ID=item_001
CMD=STATUS
```

JSON format also accepted:
```json
{"cmd": "SWITCH_SCENE", "scene": "Camera 2"}
```

## Python Controller (fallback/scripted)

```bash
pip3 install -r python/requirements.txt

python3 python/obs_control.py status
python3 python/obs_control.py list-scenes
python3 python/obs_control.py switch "Camera 1"
python3 python/obs_control.py cut
python3 python/obs_control.py volume "Microphone 1" 0.75
python3 python/obs_control.py monitor      # live event stream
```

## Scene Naming Convention

OBSTriCloner works with any OBS scene names — just update the `INPUT_*` variables in `.env` or `daemon/config.js`. Recommended naming for clarity:

```
Camera 1, Camera 2, Camera 3, Camera 4
Background, Black
Clip 1, Clip 2
```

## DSK Setup in OBS

1. Create a source (Browser Source, Image, Media Source) named `DSK Overlay`
2. Add a **Chroma Key** filter to it, name it `Chroma Key`
3. Set `DSK_SOURCE=DSK Overlay` and `DSK_FILTER=Chroma Key` in `.env`
4. OBSTriCloner will enable/disable the filter when you press DSK 1

## Playlist Format

POST to `/api/playlist` with `action: 'load'` and an `items` array:

```json
{
  "action": "load",
  "items": [
    { "id": "intro",   "label": "Station Intro", "sceneName": "Clip 1",    "durationMs": 30000 },
    { "id": "cam1",    "label": "Camera 1 Live",  "sceneName": "Camera 1",  "durationMs": 600000 },
    { "id": "music",   "label": "Music Break",    "sceneName": "Background","durationMs": 180000,
      "startAt": "2026-04-15T20:00:00" }
  ]
}
```

Items with `startAt` will fire at wall-clock time when you call `schedule`.
