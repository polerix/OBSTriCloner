'use strict';
/**
 * lib/obs-check.js
 * Reusable module for detecting OBS state, config paths, and WebSocket health.
 * Used by setup.js and optionally the daemon for pre-flight checks.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Config path ─────────────────────────────────────────────────────────────

/**
 * Returns the OS-appropriate path to OBS's global.ini.
 * @returns {string}
 */
function getObsConfigPath() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'global.ini');
    case 'win32':
      return path.join(process.env.APPDATA || '', 'obs-studio', 'global.ini');
    default: // linux + others
      return path.join(os.homedir(), '.config', 'obs-studio', 'global.ini');
  }
}

// ─── OBS running check ────────────────────────────────────────────────────────

/**
 * Checks if OBS Studio is currently running (platform-appropriate process check).
 * @returns {Promise<{running: boolean, port: number, version: string|null}>}
 */
async function checkObsRunning() {
  const { execSync } = require('child_process');
  let running = false;
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq obs64.exe" 2>NUL', { encoding: 'utf8' });
      running = out.includes('obs64.exe');
    } else {
      const out = execSync('pgrep -x "OBS" || pgrep -x "obs" || pgrep -f "obs64" 2>/dev/null || true', { encoding: 'utf8', shell: '/bin/sh' });
      running = out.trim().length > 0;
    }
  } catch (_) {
    running = false;
  }
  return { running, port: 4455, version: null };
}

// ─── WebSocket enabled check ─────────────────────────────────────────────────

/**
 * Reads OBS global.ini and returns WebSocket config.
 * @returns {{ enabled: boolean, port: number, hasPassword: boolean, passwordHash: string|null }}
 */
function checkWebSocketEnabled() {
  const ini    = require('ini');
  const cfgPath = getObsConfigPath();

  if (!fs.existsSync(cfgPath)) {
    return { enabled: false, port: 4455, hasPassword: false, passwordHash: null };
  }

  let cfg = {};
  try {
    cfg = ini.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (_) {
    return { enabled: false, port: 4455, hasPassword: false, passwordHash: null };
  }

  const section = cfg['OBSWebSocket'] || {};
  const enabled     = section['ServerEnabled'] === 'true';
  const port        = parseInt(section['ServerPort'] || '4455', 10);
  const passwordHash = section['ServerPassword'] || null;
  const hasPassword  = !!(passwordHash && passwordHash.trim().length > 0);

  return { enabled, port, hasPassword, passwordHash };
}

// ─── Connection test ─────────────────────────────────────────────────────────

/**
 * Attempts a live WebSocket handshake with OBS.
 * @param {string} password  Plaintext password (empty string if none)
 * @param {number} [port=4455]
 * @returns {Promise<{ success: boolean, error: string|null, obsVersion: string|null }>}
 */
async function testConnection(password, port = 4455) {
  const OBSWebSocket = require('obs-websocket-js').default;
  const obs = new OBSWebSocket();
  try {
    const { obsWebSocketVersion, negotiatedRpcVersion } =
      await obs.connect(`ws://127.0.0.1:${port}`, password || undefined, {
        rpcVersion: 1,
      });
    await obs.disconnect();
    return { success: true, error: null, obsVersion: obsWebSocketVersion };
  } catch (err) {
    let error = err.message || String(err);
    if (error.includes('4009') || error.includes('Authentication')) {
      error = 'Wrong password (OBS returned auth error 4009)';
    } else if (error.includes('ECONNREFUSED')) {
      error = 'Connection refused — OBS WebSocket not running or wrong port';
    } else if (error.includes('ETIMEDOUT') || error.includes('ENOTFOUND')) {
      error = 'Timeout — OBS not reachable on this host/port';
    }
    return { success: false, error, obsVersion: null };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { getObsConfigPath, checkObsRunning, checkWebSocketEnabled, testConnection };
