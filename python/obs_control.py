#!/usr/bin/env python3
"""
OBSTriCloner — obs_control.py
Parallel / fallback OBS controller using obs-websocket-py.

Provides the same bus/DSK/audio control surface as the Node.js daemon
but as a standalone Python script — useful for:
  - Testing OBS WebSocket connectivity independently of the Node daemon
  - Scripted automation (cron jobs, shell pipelines)
  - Headless playout without the web UI

Usage:
  python3 obs_control.py [--host HOST] [--port PORT] [--password PASS] <command> [args]

Commands:
  status                        Print full OBS state
  list-scenes                   List all scenes
  switch <scene>                Switch program to scene (Studio Mode auto-transition)
  preview <scene>               Set preview scene
  cut                           Cut preview → program
  auto                          Auto-transition preview → program
  dsk-on  [source] [filter]     Enable chroma-key filter
  dsk-off [source] [filter]     Disable chroma-key filter
  volume <input> <level>        Set input volume (0.0–1.0)
  mute <input>                  Mute input
  unmute <input>                Unmute input
  record-start                  Start recording
  record-stop                   Stop recording
  stream-start                  Start streaming
  stream-stop                   Stop streaming
  monitor                       Live event monitor (Ctrl-C to quit)
"""

import argparse
import asyncio
import json
import sys
import os

try:
    from obswebsocket import obsws, requests as obsreq, events
except ImportError:
    print("ERROR: obs-websocket-py not installed. Run: pip3 install obs-websocket-py")
    sys.exit(1)

# ── Defaults (override with env vars or CLI flags) ────────────────────────

DEFAULT_HOST     = os.environ.get('OBS_HOST',     '127.0.0.1')
DEFAULT_PORT     = int(os.environ.get('OBS_PORT', '4455'))
DEFAULT_PASSWORD = os.environ.get('OBS_PASSWORD', '')

DSK_SOURCE  = os.environ.get('DSK_SOURCE', 'DSK Overlay')
DSK_FILTER  = os.environ.get('DSK_FILTER', 'Chroma Key')

# ── OBS connection ────────────────────────────────────────────────────────

def connect(host, port, password):
    ws = obsws(host, port, password)
    ws.connect()
    print(f"[OBS] Connected to {host}:{port}", file=sys.stderr)
    return ws

def disconnect(ws):
    try:
        ws.disconnect()
    except Exception:
        pass

# ── Commands ──────────────────────────────────────────────────────────────

def cmd_status(ws):
    scenes   = ws.call(obsreq.GetSceneList())
    pgm      = ws.call(obsreq.GetCurrentProgramScene())
    prv      = ws.call(obsreq.GetCurrentPreviewScene())
    studio   = ws.call(obsreq.GetStudioModeEnabled())
    rec      = ws.call(obsreq.GetRecordStatus())
    stream   = ws.call(obsreq.GetStreamStatus())

    state = {
        "program":      pgm.datain.get('currentProgramSceneName'),
        "preview":      prv.datain.get('currentPreviewSceneName'),
        "studio_mode":  studio.datain.get('studioModeEnabled'),
        "recording":    rec.datain.get('outputActive'),
        "streaming":    stream.datain.get('outputActive'),
        "scenes":       [s['sceneName'] for s in scenes.datain.get('scenes', [])],
    }
    print(json.dumps(state, indent=2))


def cmd_list_scenes(ws):
    scenes = ws.call(obsreq.GetSceneList())
    for s in scenes.datain.get('scenes', []):
        print(s['sceneName'])


def cmd_switch(ws, scene):
    # Ensure Studio Mode, set preview, then trigger transition
    ws.call(obsreq.SetStudioModeEnabled(studioModeEnabled=True))
    ws.call(obsreq.SetCurrentPreviewScene(sceneName=scene))
    ws.call(obsreq.TriggerStudioModeTransition())
    print(f"[OBS] Switched → {scene}")


def cmd_preview(ws, scene):
    ws.call(obsreq.SetStudioModeEnabled(studioModeEnabled=True))
    ws.call(obsreq.SetCurrentPreviewScene(sceneName=scene))
    print(f"[OBS] Preview → {scene}")


def cmd_cut(ws):
    ws.call(obsreq.SetCurrentSceneTransition(transitionName='Cut'))
    ws.call(obsreq.TriggerStudioModeTransition())
    print("[OBS] CUT")


def cmd_auto(ws):
    ws.call(obsreq.TriggerStudioModeTransition())
    print("[OBS] AUTO")


def cmd_dsk(ws, enable, source, filt):
    ws.call(obsreq.SetSourceFilterEnabled(
        sourceName=source,
        filterName=filt,
        filterEnabled=enable
    ))
    state = "ON" if enable else "OFF"
    print(f"[OBS] DSK {state} — {source} / {filt}")


def cmd_volume(ws, input_name, level):
    level = max(0.0, min(1.0, float(level)))
    ws.call(obsreq.SetInputVolume(inputName=input_name, inputVolumeMul=level))
    print(f"[OBS] Volume {input_name} → {level:.2f}")


def cmd_mute(ws, input_name, muted):
    ws.call(obsreq.SetInputMute(inputName=input_name, inputMuted=muted))
    print(f"[OBS] {'Muted' if muted else 'Unmuted'} {input_name}")


def cmd_record(ws, start):
    if start:
        ws.call(obsreq.StartRecord())
        print("[OBS] Recording started")
    else:
        ws.call(obsreq.StopRecord())
        print("[OBS] Recording stopped")


def cmd_stream(ws, start):
    if start:
        ws.call(obsreq.StartStream())
        print("[OBS] Streaming started")
    else:
        ws.call(obsreq.StopStream())
        print("[OBS] Streaming stopped")


def cmd_monitor(ws):
    """Live event monitor — prints events as JSON until Ctrl-C."""
    print("[OBS] Monitoring events (Ctrl-C to quit)…", file=sys.stderr)

    def on_event(message):
        print(json.dumps({
            'event': type(message).__name__,
            'data':  message.datain,
        }))

    ws.register(on_event, events.CurrentProgramSceneChanged)
    ws.register(on_event, events.CurrentPreviewSceneChanged)
    ws.register(on_event, events.SceneTransitionStarted)
    ws.register(on_event, events.SceneTransitionEnded)
    ws.register(on_event, events.InputVolumeChanged)
    ws.register(on_event, events.InputMuteStateChanged)

    try:
        import time
        while True:
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\n[OBS] Monitor stopped", file=sys.stderr)

# ── CLI ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='OBSTriCloner Python controller')
    parser.add_argument('--host',     default=DEFAULT_HOST)
    parser.add_argument('--port',     type=int, default=DEFAULT_PORT)
    parser.add_argument('--password', default=DEFAULT_PASSWORD)
    parser.add_argument('command',    nargs='?', default='status')
    parser.add_argument('args',       nargs='*')
    args = parser.parse_args()

    ws = connect(args.host, args.port, args.password)
    try:
        cmd  = args.command.lower().replace('-', '_')
        rest = args.args

        if   cmd == 'status':       cmd_status(ws)
        elif cmd == 'list_scenes':  cmd_list_scenes(ws)
        elif cmd == 'switch':       cmd_switch(ws, rest[0])
        elif cmd == 'preview':      cmd_preview(ws, rest[0])
        elif cmd == 'cut':          cmd_cut(ws)
        elif cmd == 'auto':         cmd_auto(ws)
        elif cmd == 'dsk_on':       cmd_dsk(ws, True,  rest[0] if rest else DSK_SOURCE, rest[1] if len(rest)>1 else DSK_FILTER)
        elif cmd == 'dsk_off':      cmd_dsk(ws, False, rest[0] if rest else DSK_SOURCE, rest[1] if len(rest)>1 else DSK_FILTER)
        elif cmd == 'volume':       cmd_volume(ws, rest[0], rest[1])
        elif cmd == 'mute':         cmd_mute(ws, rest[0], True)
        elif cmd == 'unmute':       cmd_mute(ws, rest[0], False)
        elif cmd == 'record_start': cmd_record(ws, True)
        elif cmd == 'record_stop':  cmd_record(ws, False)
        elif cmd == 'stream_start': cmd_stream(ws, True)
        elif cmd == 'stream_stop':  cmd_stream(ws, False)
        elif cmd == 'monitor':      cmd_monitor(ws)
        else:
            print(f"Unknown command: {args.command}", file=sys.stderr)
            sys.exit(1)
    finally:
        disconnect(ws)

if __name__ == '__main__':
    main()
