# Copy to .env and fill in your values

# ── TXOBS WebSocket ──────────────────────────────────────────────
OBS_HOST=127.0.0.1
OBS_PORT=4455
OBS_PASSWORD=arps339

# ── Daemon ───────────────────────────────────────────────────$
DAEMON_PORT=9090   

# ── TXTerp / OTV-ARPS TCP bridge ──────────────────────────────
TELETEXT_PORT=9100

# ── Input mapping (TriCaster label → OBS scene name) ──────────
INPUT_CAM1=Camera 1
INPUT_CAM2=Camera 2
INPUT_CAM3=Camera 3   
INPUT_CAM4=Camera 4  
INPUT_BG=Background
INPUT_BLACK=Black
INPUT_CLIP1=Clip 1
INPUT_CLIP2=Clip 2

# ── DSK (Downstream Keyer) ─────────────────────────────────────
DSK_SOURCE=DSK Overlay
DSK_FILTER=Chroma Key  

# ── TrAudio sources (must match OBS input names exactly) ────────
AUDIO_PGM=Program Audio
AUDIO_MIC1=Microphone 1
AUDIO_MIC2=Microphone 2
AUDIO_MUSIC=Music
AUDIO_FX=Sound Effects
AUDIO_RETURN=IFB Return

# ── Transition defaults ────────────────────────────────────────
TRANSITION_NAME=Fade
TRANSITION_DURATION=500