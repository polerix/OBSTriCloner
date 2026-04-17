#!/usr/bin/env node
'use strict';
/**
 * setup.js — OBSTriCloner interactive setup wizard
 *
 * Usage:
 *   node setup.js            Full interactive setup
 *   node setup.js --check-only   Pre-flight checks only (no writes)
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ─── Flags ────────────────────────────────────────────────────────────────────
const CHECK_ONLY = process.argv.includes('--check-only');

// ─── Lazy-load colour + prompt deps (fail gracefully if missing) ─────────────
let chalk, inquirer;
try { chalk    = require('chalk'); }      catch (_) { chalk    = { green: s => s, red: s => s, yellow: s => s, cyan: s => s, bold: s => s, gray: s => s }; }
try { inquirer = require('inquirer'); }   catch (_) { inquirer = null; }

const { getObsConfigPath, checkObsRunning, checkWebSocketEnabled, testConnection } = require('./lib/obs-check');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(msg); }
function ok(msg)   { console.log(chalk.green('✅ ' + msg)); }
function warn(msg) { console.log(chalk.yellow('⚠️  ' + msg)); }
function fail(msg) { console.log(chalk.red('❌ ' + msg)); }
function info(msg) { console.log(chalk.cyan('ℹ️  ' + msg)); }

function separator() { log(chalk.gray('─'.repeat(60))); }

/** Generate a cryptographically random password (24 chars, URL-safe base64). */
function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

/** Derive a 32-byte AES key from machine ID + app salt via SHA-256. */
async function deriveKey(machineId) {
  const raw = machineId + 'obstricloner';
  return crypto.createHash('sha256').update(raw).digest();
}

/** AES-256-GCM encrypt plaintext; returns { iv, authTag, ciphertext } as base64 strings. */
async function encryptPassword(plaintext, key) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv:         iv.toString('base64'),
    authTag:    authTag.toString('base64'),
    ciphertext: enc.toString('base64'),
  };
}


// ─── Step 1: Node version check ───────────────────────────────────────────────

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    fail(`Node.js ${process.versions.node} detected — requires ≥ 18.`);
    fail('Download from https://nodejs.org/');
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);
}

// ─── Step 2: OBS installed? ───────────────────────────────────────────────────

function checkObsInstalled() {
  const locations = {
    darwin: [
      '/Applications/OBS.app',
      path.join(os.homedir(), 'Applications', 'OBS.app'),
    ],
    win32: [
      'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
      'C:\\Program Files (x86)\\obs-studio\\bin\\32bit\\obs32.exe',
    ],
    linux: ['/usr/bin/obs', '/usr/local/bin/obs', '/snap/bin/obs-studio'],
  };

  const candidates = locations[process.platform] || [];
  const found = candidates.some(p => fs.existsSync(p));
  if (found) {
    ok('OBS Studio installation found');
  } else {
    warn('OBS Studio not found at standard paths (might be installed elsewhere)');
    warn('Download OBS from https://obsproject.com if not installed');
  }
  return found;
}

// ─── Step 3: Python (optional) ────────────────────────────────────────────────

function checkPython() {
  const { execSync } = require('child_process');
  const cmds = ['python3 --version', 'python --version'];
  for (const cmd of cmds) {
    try {
      const v = execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
      ok(`Python available: ${v}`);
      return true;
    } catch (_) {}
  }
  warn('Python 3 not found — python/obs_control.py fallback will not work');
  warn('Install from https://python.org if needed');
  return false;
}

// ─── Step 4: WebSocket reachability ──────────────────────────────────────────

async function checkWebSocketReachable(port = 4455) {
  const net = require('net');
  return new Promise(resolve => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 2000 });
    sock.once('connect', ()  => { sock.destroy(); resolve(true);  });
    sock.once('error',   ()  => { sock.destroy(); resolve(false); });
    sock.once('timeout', ()  => { sock.destroy(); resolve(false); });
  });
}


// ─── Step 5: Read / write global.ini ─────────────────────────────────────────

function readGlobalIni() {
  const ini     = require('ini');
  const cfgPath = getObsConfigPath();
  if (!fs.existsSync(cfgPath)) return { cfg: {}, cfgPath, exists: false };
  const cfg = ini.parse(fs.readFileSync(cfgPath, 'utf8'));
  return { cfg, cfgPath, exists: true };
}

function writeGlobalIni(cfgPath, cfg) {
  const ini = require('ini');
  fs.writeFileSync(cfgPath, ini.stringify(cfg), 'utf8');
}

// Patch [OBSWebSocket] section in cfg object (mutates in place)
function patchObsWebSocket(cfg, { enabled = true, port = 4455, passwordHash }) {
  if (!cfg['OBSWebSocket']) cfg['OBSWebSocket'] = {};
  cfg['OBSWebSocket']['ServerEnabled']  = enabled ? 'true' : 'false';
  cfg['OBSWebSocket']['ServerPort']     = String(port);
  if (passwordHash !== undefined) cfg['OBSWebSocket']['ServerPassword'] = passwordHash;
}

// ─── Step 6: .env helpers ─────────────────────────────────────────────────────

const ENV_PATH     = path.join(__dirname, '.env');
const ENV_ENC_PATH = path.join(__dirname, '.env.enc');

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

function writeEnvFile(values) {
  // Merge with existing .env (preserve existing keys not in values)
  const existing = readEnvFile();
  const merged   = { ...existing, ...values };
  // Also merge from .env.example to keep all keys present
  const examplePath = path.join(__dirname, '.env.example');
  let template = '';
  if (fs.existsSync(examplePath)) {
    template = fs.readFileSync(examplePath, 'utf8');
    // Replace values in template lines
    const outLines = template.split('\n').map(line => {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m && merged[m[1].trim()] !== undefined) {
        return `${m[1].trim()}=${merged[m[1].trim()]}`;
      }
      return line;
    });
    // Append any new keys not already in template
    const templateKeys = new Set(
      template.split('\n').map(l => { const m = l.match(/^([^#=\s][^=]*)=/); return m ? m[1].trim() : null; }).filter(Boolean)
    );
    for (const [k, v] of Object.entries(merged)) {
      if (!templateKeys.has(k)) outLines.push(`${k}=${v}`);
    }
    fs.writeFileSync(ENV_PATH, outLines.join('\n'), 'utf8');
  } else {
    const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
  }
}


// ─── Step 7: Scene/source discovery ──────────────────────────────────────────

async function discoverObsScenes(password, port = 4455) {
  const OBSWebSocket = require('obs-websocket-js').default;
  const obs = new OBSWebSocket();
  try {
    await obs.connect(`ws://127.0.0.1:${port}`, password || undefined, { rpcVersion: 1 });
    const { scenes }  = await obs.call('GetSceneList');
    const { inputs }  = await obs.call('GetInputList');
    await obs.disconnect();
    return {
      scenes: scenes.map(s => s.sceneName),
      inputs: inputs.map(i => i.inputName),
    };
  } catch (err) {
    return { scenes: [], inputs: [], error: err.message };
  }
}

// Map discovered scenes to OBSTriCloner INPUT_* slots
function mapScenesToEnv(scenes) {
  const mapping = {};
  const slotNames = ['CAM1','CAM2','CAM3','CAM4','BG','BLACK','CLIP1','CLIP2'];
  const defaults  = ['Camera 1','Camera 2','Camera 3','Camera 4','Background','Black','Clip 1','Clip 2'];
  slotNames.forEach((slot, i) => {
    mapping[`INPUT_${slot}`] = scenes[i] || defaults[i];
  });
  return mapping;
}

// ─── Prompt helpers (require inquirer) ───────────────────────────────────────

async function prompt(questions) {
  if (!inquirer) throw new Error('inquirer not available — run npm install first');
  return inquirer.prompt(questions);
}

async function pressEnterToContinue(message) {
  await prompt([{ type: 'input', name: '_', message }]);
}


// ─── CHECK-ONLY mode ──────────────────────────────────────────────────────────

async function runCheckOnly() {
  separator();
  log(chalk.bold('OBSTriCloner — Pre-flight check'));
  separator();

  checkNodeVersion();
  checkObsInstalled();
  checkPython();

  const wsConfig = checkWebSocketEnabled();
  if (wsConfig.enabled) {
    ok(`OBS WebSocket enabled in global.ini (port ${wsConfig.port})`);
    if (wsConfig.hasPassword) {
      ok('OBS WebSocket has a password set');
    } else {
      warn('OBS WebSocket has no password — setup recommended');
    }
  } else {
    warn('OBS WebSocket not enabled in global.ini (or config not found)');
    info('Enable it in OBS → Tools → WebSocket Server Settings');
  }

  const obsRunning = await checkObsRunning();
  if (obsRunning.running) {
    ok('OBS Studio is running');
  } else {
    info('OBS Studio does not appear to be running');
  }

  const port      = wsConfig.port || 4455;
  const reachable = await checkWebSocketReachable(port);
  if (reachable) {
    ok(`OBS WebSocket port ${port} is reachable`);
  } else {
    warn(`OBS WebSocket port ${port} is not reachable (OBS may be stopped or WebSocket disabled)`);
  }

  separator();
  ok('Check complete — run `npm run setup` for full interactive setup');
}

// ─── FULL SETUP mode ──────────────────────────────────────────────────────────

async function runFullSetup() {
  separator();
  log(chalk.bold('OBSTriCloner — Setup Wizard'));
  separator();

  // ── 1. Node version ──────────────────────────────────────────────────────────
  checkNodeVersion();
  checkObsInstalled();
  checkPython();
  separator();

  // ── 2. Read existing config ───────────────────────────────────────────────────
  const wsConfig = checkWebSocketEnabled();
  const { cfg, cfgPath, exists } = readGlobalIni();

  // ── 3. Warn if OBS is running ─────────────────────────────────────────────────
  const obsRunning = await checkObsRunning();
  if (obsRunning.running) {
    warn('OBS Studio is currently running.');
    warn('OBS will overwrite global.ini when it quits — you MUST quit OBS before we write the config.');
    await pressEnterToContinue('Please QUIT OBS now, then press Enter to continue...');
  }

  // ── 4. Password setup ─────────────────────────────────────────────────────────
  let password;
  const existingEnv = readEnvFile();
  if (existingEnv['OBS_PASSWORD'] && existingEnv['OBS_PASSWORD'] !== 'your_obs_websocket_password_here') {
    const { useExisting } = await prompt([{
      type: 'confirm', name: 'useExisting',
      message: `Found existing OBS_PASSWORD in .env — use it?`,
      default: true,
    }]);
    if (useExisting) {
      password = existingEnv['OBS_PASSWORD'];
      ok('Using existing password from .env');
    }
  }

  if (!password) {
    if (wsConfig.hasPassword) {
      info('OBS global.ini already has a password hash.');
      const { action } = await prompt([{
        type: 'list', name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Enter the existing plaintext password (just save to .env)', value: 'enter' },
          { name: 'Set a NEW password (overwrite global.ini hash)',            value: 'new'   },
          { name: 'Generate a new random password',                            value: 'gen'   },
        ],
      }]);
      if (action === 'enter') {
        const { pw } = await prompt([{ type: 'password', name: 'pw', message: 'Enter the current OBS WebSocket password:', mask: '*' }]);
        password = pw;
      } else if (action === 'new') {
        const { pw, pw2 } = await prompt([
          { type: 'password', name: 'pw',  message: 'Enter new password:',     mask: '*' },
          { type: 'password', name: 'pw2', message: 'Confirm new password:',   mask: '*' },
        ]);
        if (pw !== pw2) { fail('Passwords do not match — aborting.'); process.exit(1); }
        password = pw;
      } else {
        password = generatePassword();
        ok(`Generated password: ${chalk.cyan(password)}`);
        info('Save this somewhere safe — it will also be stored in .env');
      }
    } else {
      const { action } = await prompt([{
        type: 'list', name: 'action',
        message: 'No OBS WebSocket password found. Choose:',
        choices: [
          { name: 'Generate a strong random password (recommended)', value: 'gen'   },
          { name: 'Enter a password manually',                        value: 'enter' },
          { name: 'Use no password (not recommended)',                value: 'none'  },
        ],
      }]);
      if (action === 'gen') {
        password = generatePassword();
        ok(`Generated password: ${chalk.cyan(password)}`);
      } else if (action === 'enter') {
        const { pw, pw2 } = await prompt([
          { type: 'password', name: 'pw',  message: 'Enter password:', mask: '*' },
          { type: 'password', name: 'pw2', message: 'Confirm:',        mask: '*' },
        ]);
        if (pw !== pw2) { fail('Passwords do not match — aborting.'); process.exit(1); }
        password = pw;
      } else {
        password = '';
        warn('No password set — WebSocket will be open to localhost');
      }
    }
  }

  separator();

  // ── 5. Hash + write global.ini ────────────────────────────────────────────────
  const bcrypt = require('bcryptjs');
  let passwordHash = '';
  if (password) {
    info('Hashing password with bcrypt (cost factor 10)...');
    passwordHash = bcrypt.hashSync(password, 10);
    ok('Password hashed');
  }

  if (exists) {
    patchObsWebSocket(cfg, { enabled: true, port: wsConfig.port || 4455, passwordHash });
    writeGlobalIni(cfgPath, cfg);
    ok(`Updated global.ini at ${cfgPath}`);
  } else {
    warn(`global.ini not found at ${cfgPath}`);
    warn('You may need to run OBS once first to create it, or enable WebSocket manually in OBS Settings');
  }

  // ── 6. Write .env ──────────────────────────────────────────────────────────────
  const envUpdates = { OBS_HOST: '127.0.0.1', OBS_PORT: String(wsConfig.port || 4455), OBS_PASSWORD: password };
  writeEnvFile(envUpdates);
  ok('Written OBS_PASSWORD to .env');

  // ── 7. Encrypt password to .env.enc ───────────────────────────────────────────
  if (password) {
    try {
      const { machineId } = require('node-machine-id');
      const mid = await machineId();
      const key = await deriveKey(mid);
      const enc = await encryptPassword(password, key);
      fs.writeFileSync(ENV_ENC_PATH, JSON.stringify(enc, null, 2), 'utf8');
      ok('Encrypted password stored in .env.enc (recoverable on this machine only)');
    } catch (err) {
      warn(`Could not write .env.enc: ${err.message}`);
    }
  }

  separator();


  // ── 8. OBS restart + WebSocket verification ───────────────────────────────────
  info('Now restart OBS Studio to pick up the new WebSocket settings.');
  await pressEnterToContinue('Press Enter once OBS has restarted...');

  let connected = false;
  let retries = 0;
  while (!connected && retries < 3) {
    info('Attempting WebSocket connection...');
    const result = await testConnection(password, wsConfig.port || 4455);
    if (result.success) {
      ok(`OBS WebSocket connected! (obs-websocket ${result.obsVersion})`);
      writeEnvFile({ OBS_CONNECTED: 'true' });
      connected = true;
    } else {
      fail(`Connection failed: ${result.error}`);
      retries++;
      if (retries < 3) {
        const { retry } = await prompt([{
          type: 'confirm', name: 'retry',
          message: 'Retry? (Make sure OBS is running and WebSocket is enabled)',
          default: true,
        }]);
        if (!retry) break;
      }
    }
  }

  if (!connected) {
    warn('Could not verify OBS WebSocket connection.');
    info('Manual steps:');
    info('  1. Open OBS → Tools → WebSocket Server Settings');
    info('  2. Enable the server, set port 4455');
    info(`  3. Set password to match OBS_PASSWORD in your .env`);
    info('  4. Restart OBS and run `npm run check` to verify');
  }

  separator();

  // ── 9. Scene/source discovery ─────────────────────────────────────────────────
  if (connected) {
    info('Discovering OBS scenes and sources...');
    const { scenes, inputs, error } = await discoverObsScenes(password, wsConfig.port || 4455);

    if (error) {
      warn(`Scene discovery failed: ${error}`);
    } else if (scenes.length === 0) {
      warn('No scenes found in OBS — add scenes and re-run setup');
    } else {
      log('');
      log(chalk.bold('Scenes found in OBS:'));
      scenes.forEach((s, i) => log(`  ${chalk.cyan(i + 1)}. ${s}`));
      log('');

      const autoMapping = mapScenesToEnv(scenes);
      log(chalk.bold('Suggested slot → scene mapping:'));
      const slotLabels = { CAM1:'Camera 1', CAM2:'Camera 2', CAM3:'Camera 3', CAM4:'Camera 4',
                           BG:'Background', BLACK:'Black', CLIP1:'Clip 1', CLIP2:'Clip 2' };
      for (const [key, val] of Object.entries(autoMapping)) {
        const slot = key.replace('INPUT_', '');
        log(`  ${chalk.cyan(slotLabels[slot] || slot).padEnd(16)} → ${val}`);
      }
      log('');

      const { acceptMapping } = await prompt([{
        type: 'confirm', name: 'acceptMapping',
        message: 'Accept this mapping?',
        default: true,
      }]);

      const finalMapping = { ...autoMapping };
      if (!acceptMapping) {
        for (const [key] of Object.entries(autoMapping)) {
          const slot = key.replace('INPUT_', '');
          const { choice } = await prompt([{
            type: 'list', name: 'choice',
            message: `Map INPUT_${slot} to:`,
            choices: [...scenes, '(leave blank)'],
          }]);
          finalMapping[key] = choice === '(leave blank)' ? '' : choice;
        }
      }

      writeEnvFile(finalMapping);
      ok('Scene mapping written to .env');

      if (inputs.length > 0) {
        log('');
        log(chalk.bold('Audio inputs found in OBS:'));
        inputs.forEach((inp, i) => log(`  ${chalk.cyan(i + 1)}. ${inp}`));
        info('Update AUDIO_* variables in .env to match your OBS audio source names');
      }
    }
  }

  separator();

  // ── 10. ARPS ↔ OTV bridge setup ───────────────────────────────────────────
  log(chalk.bold('ARPS ↔ OTV Integration (On-The-Video)'));
  log('OTV is a browser-based cassette/scheduler UI. This bridge lets OTV');
  log('trigger OBS scene switches and receive live on-air state from OBSTriCloner.');
  log('');

  const { arpsEnabled } = await prompt([{
    type: 'confirm', name: 'arpsEnabled',
    message: 'Enable ARPS ↔ OTV bridge?',
    default: true,
  }]);

  if (arpsEnabled) {
    const { arpsHost, arpsPort, arpsOtvPort } = await prompt([
      {
        type: 'input', name: 'arpsHost',
        message: 'Host where OBSTriCloner is reachable FROM the OTV browser:',
        default: 'localhost',
      },
      {
        type: 'input', name: 'arpsPort',
        message: 'OBSTriCloner daemon port (ARPS endpoint lives here):',
        default: '9090',
      },
      {
        type: 'input', name: 'arpsOtvPort',
        message: 'OTV web server port (for CORS — enter * to allow all origins):',
        default: '*',
      },
    ]);

    const otvOrigin = arpsOtvPort === '*' ? '*' : `http://${arpsHost}:${arpsOtvPort}`;
    writeEnvFile({
      ARPS_ENABLED:    'true',
      ARPS_HOST:       arpsHost,
      ARPS_PORT:       arpsPort,
      ARPS_OTV_PORT:   arpsOtvPort,
      ARPS_OTV_ORIGIN: otvOrigin,
      ARPS_SCENE_MAP:  '{}',
    });

    ok('ARPS bridge enabled');
    info(`OTV should connect to: http://${arpsHost}:${arpsPort}/api/arps/`);
    info('Add this to OTV\'s index.html (before </body>):');
    log('');
    log(chalk.cyan(`  <script>window.OTC_HOST = 'http://${arpsHost}:${arpsPort}';</script>`));
    log(chalk.cyan('  <script src="js/obstricloner-client.js"></script>'));
    log('');
    info('Edit ARPS_SCENE_MAP in .env to map OTV cassette labels → OBS scene names.');
    info('Example: ARPS_SCENE_MAP=\'{"Die Hard":"Movie-Scene","Station ID":"Bumper"}\'');
  } else {
    writeEnvFile({ ARPS_ENABLED: 'false' });
    ok('ARPS bridge disabled');
  }

  separator();
  ok('Setup complete!');
  log('');
  log(`  Run ${chalk.cyan('npm start')} to start the OBSTriCloner daemon`);
  log(`  Open  ${chalk.cyan('http://localhost:9090')} for the control surface`);
  log(`  Run   ${chalk.cyan('npm run check')} anytime to verify connectivity`);
  separator();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  try {
    if (CHECK_ONLY) {
      await runCheckOnly();
    } else {
      await runFullSetup();
    }
  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
})();
