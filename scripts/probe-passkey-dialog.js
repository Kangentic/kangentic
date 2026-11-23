#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI. WINDOWS ONLY.
 *
 * Does a passkey request in a Browser surface open Windows' "Choose a passkey"
 * dialog, and does the virtual authenticator keep it away? The evidence behind
 * `src/main/browser/passkey-guard.ts` (decision 47 in
 * docs/architecture/embedded-browser/decision-log.md). Re-run it on an Electron
 * upgrade: whether Chromium honours `WebAuthn.enable` before a page's first load
 * is not something a unit test can see.
 *
 * It times `CredentialUIBroker.exe`, the process that draws the dialog, while a
 * page that asks for a passkey as it loads (`mediation: 'conditional'`, the way
 * a sign-in page offers a saved passkey in its email field) runs in a
 * `<webview>` or a hidden window. The shipped `cdp.ts` is bundled and driven, so
 * the probe tests the real install and removal, not a copy.
 *
 * Modes (each runs in its own Electron process):
 *   baseline      a webview nobody armed: the dialog SHOULD appear
 *   armed         armed at web-contents-created: no dialog; also runs a get,
 *                 a create and a get by credential id
 *   cross-origin  armed, then navigated to a second origin: no dialog
 *   partition     armed only through the guard's match, `session.fromPartition`
 *                 against the new guest's session: no dialog
 *   lane          a hidden window armed before its first loadURL: no dialog
 *   released      armed, then the authenticator removed, then a get: the
 *                 dialog SHOULD appear again
 *
 * Usage:
 *   node scripts/probe-passkey-dialog.js [mode ...]
 *
 * With no mode it runs all of them. A dialog that opens closes when the page
 * aborts its request a few seconds later. Windows shows it on your screen while
 * it is up, so run this at the machine, and let each run finish.
 *
 * Measured 2026-11-23 on Electron 45, Windows 11 build 26200:
 * - baseline: the dialog came up 2 s after load and stayed until the abort.
 * - armed, cross-origin, partition and lane: 0 ms of dialog. The load-time
 *   request and an explicit get failed at once with NotAllowedError. A create
 *   succeeded, and a get naming the new credential then succeeded.
 * - released: the next get reached Windows again.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');

const PORTS = [47811, 47812];
const ORIGIN_A = `http://localhost:${PORTS[0]}/`;
const ORIGIN_B = `http://localhost:${PORTS[1]}/`;
const PARTITION = 'persist:kng-passkey-probe';
const MODES = ['baseline', 'armed', 'cross-origin', 'partition', 'lane', 'released'];
/** Modes where the dialog must appear; every other mode must show none. */
const DIALOG_EXPECTED = new Set(['baseline', 'released']);

const PAGE = `<!doctype html><html><body>
<input autocomplete="username webauthn" />
<script>
const log = []; window.__log = log;
const rec = (entry) => log.push({ t: Math.round(performance.now()), ...entry });
const params = new URLSearchParams(location.search);
const steps = (params.get('do') || '').split(',').filter(Boolean);
const abortMs = Number(params.get('abort') || 6000);
const challenge = () => crypto.getRandomValues(new Uint8Array(32));
async function withAbort(label, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), abortMs);
  const started = performance.now();
  try {
    const result = await run(controller.signal);
    if (result && result.rawId && label === 'create') window.__created = result.rawId;
    rec({ ev: label + '-ok', ms: Math.round(performance.now() - started) });
  } catch (error) {
    rec({ ev: label + '-err', name: error.name, ms: Math.round(performance.now() - started) });
  } finally { clearTimeout(timer); }
}
const publicKey = () => ({ challenge: challenge(), rpId: location.hostname, userVerification: 'preferred', timeout: 60000 });
const actions = {
  conditional: () => withAbort('conditional', (signal) => navigator.credentials.get({ mediation: 'conditional', signal, publicKey: publicKey() })),
  get: () => withAbort('get', (signal) => navigator.credentials.get({ signal, publicKey: publicKey() })),
  getById: () => withAbort('getById', (signal) => navigator.credentials.get({ signal, publicKey: { ...publicKey(), allowCredentials: window.__created ? [{ type: 'public-key', id: window.__created }] : [] } })),
  create: () => withAbort('create', (signal) => navigator.credentials.create({ signal, publicKey: { challenge: challenge(), rp: { name: 'probe', id: location.hostname }, user: { id: new Uint8Array(16), name: 'probe', displayName: 'probe' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 60000 } })),
};
window.__run = async (list) => { for (const step of list) await actions[step](); rec({ ev: 'done' }); };
(async () => {
  rec({ ev: 'load' });
  if (steps.includes('conditional')) void actions.conditional();
  await window.__run(steps.filter((step) => step !== 'conditional'));
})();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Electron side: one mode, one process.
// ---------------------------------------------------------------------------

async function runModeInElectron(mode) {
  const { app, BrowserWindow, session } = require('electron');
  const cdp = require(process.env.PROBE_CDP_BUNDLE);
  const startedAt = Date.now();
  const result = { mode, dialogMs: 0, events: [], page: null };
  const note = (event) => result.events.push({ atMs: Date.now() - startedAt, ...event });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let dialogSince = null;
  const poll = setInterval(() => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq CredentialUIBroker.exe', '/NH'], (error, stdout) => {
      const present = !error && /CredentialUIBroker\.exe/i.test(stdout);
      const now = Date.now();
      if (present && dialogSince === null) dialogSince = now;
      if (!present && dialogSince !== null) { result.dialogMs += now - dialogSince; dialogSince = null; }
    });
  }, 250);

  const finish = () => setTimeout(() => {
    clearInterval(poll);
    if (dialogSince !== null) result.dialogMs += Date.now() - dialogSince;
    console.log('RESULT ' + JSON.stringify(result));
    app.exit(0);
  }, 1500);

  const arm = async (guest, label) => {
    const attached = cdp.isDebuggerAttached(guest) || cdp.attachDebugger(guest);
    const installed = await cdp.ensureVirtualAuthenticator(guest);
    note({ ev: 'arm', label, attached, installed });
  };
  const readLog = async (guest) => {
    try { return await guest.executeJavaScript('window.__log || null'); } catch (error) { return String(error); }
  };
  const waitDone = async (guest, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await readLog(guest);
      if (Array.isArray(log) && log.some((entry) => entry.ev === 'done')) return log;
      await wait(250);
    }
    return readLog(guest);
  };

  await app.whenReady();
  setTimeout(() => { note({ ev: 'global-timeout' }); finish(); }, 60000);

  if (mode === 'lane') {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await arm(window.webContents, 'before-first-load');
    await window.webContents.loadURL(ORIGIN_A + '?do=conditional,get&abort=6000');
    await wait(7000);
    result.page = await waitDone(window.webContents, 15000);
    return finish();
  }

  const guestReady = new Promise((resolve) => {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return;
      if (mode === 'partition') {
        const matches = session.fromPartition(PARTITION) === contents.session;
        note({ ev: 'partition-match', matches });
        if (matches) void arm(contents, 'at-creation-by-partition');
      } else if (mode !== 'baseline') {
        void arm(contents, 'at-creation');
      }
      resolve(contents);
    });
  });

  const firstUrl = {
    baseline: ORIGIN_A + '?do=conditional&abort=6000',
    armed: ORIGIN_A + '?do=conditional,get,create,getById&abort=6000',
    'cross-origin': ORIGIN_A + '?do=',
    partition: ORIGIN_A + '?do=conditional&abort=6000',
    released: ORIGIN_A + '?do=&abort=4000',
  }[mode];
  const partitionAttribute = mode === 'partition' ? ` partition="${PARTITION}"` : '';
  const host = new BrowserWindow({ width: 900, height: 700, webPreferences: { webviewTag: true } });
  await host.loadURL('data:text/html,' + encodeURIComponent(
    `<webview src="${firstUrl}"${partitionAttribute} style="width:860px;height:640px"></webview>`,
  ));
  const guest = await guestReady;
  await new Promise((resolve) => guest.once('did-finish-load', resolve));

  if (mode === 'baseline' || mode === 'partition') {
    await wait(8000);
    result.page = await readLog(guest);
  } else if (mode === 'armed') {
    result.page = await waitDone(guest, 40000);
  } else if (mode === 'cross-origin') {
    await guest.loadURL(ORIGIN_B + '?do=conditional,get&abort=6000');
    result.page = await waitDone(guest, 20000);
    await wait(1000);
  } else if (mode === 'released') {
    await wait(1500);
    await cdp.removeVirtualAuthenticator(guest);
    note({ ev: 'released', armed: cdp.hasVirtualAuthenticator(guest) });
    await guest.executeJavaScript('window.__run(["get"])');
    result.page = await waitDone(guest, 15000);
  }
  finish();
}

// ---------------------------------------------------------------------------
// Node side: serve the page, bundle cdp.ts, run each mode.
// ---------------------------------------------------------------------------

async function bundleCdp() {
  const esbuild = require('esbuild');
  const outfile = path.join(os.tmpdir(), `kangentic-passkey-probe-cdp-${process.pid}.js`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'browser', 'cdp', 'cdp.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile,
    logLevel: 'silent',
  });
  return outfile;
}

/** The page's origins are fixed, so a port already in use stops the probe and says which. */
function serve() {
  return PORTS.map((port) => http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(PAGE);
  }).on('error', (error) => {
    console.error(`Could not serve the probe page on port ${port}: ${error.message}`);
    process.exit(1);
  }).listen(port, '127.0.0.1'));
}

/** Past the child's own 60 s timeout, so this fires only for an Electron that hung. */
const CHILD_KILL_MS = 90000;

function runOne(electronPath, mode, bundlePath) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [__filename, '--probe-mode', mode], {
      env: { ...process.env, PROBE_CDP_BUNDLE: bundlePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    const killTimer = setTimeout(() => child.kill(), CHILD_KILL_MS);
    child.on('exit', () => {
      clearTimeout(killTimer);
      const line = output.split('\n').find((candidate) => candidate.startsWith('RESULT '));
      if (line) return resolve(JSON.parse(line.slice('RESULT '.length)));
      resolve({ mode, error: 'no result line', stderr: errorOutput.slice(-2000) });
    });
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('This probe times a Windows process (CredentialUIBroker.exe) and runs on Windows only.');
    process.exitCode = 2;
    return;
  }
  const requested = process.argv.slice(2);
  const modes = requested.length > 0 ? requested : MODES;
  const unknown = modes.filter((mode) => !MODES.includes(mode));
  if (unknown.length > 0) {
    console.error(`Unknown mode: ${unknown.join(', ')}. Modes: ${MODES.join(', ')}.`);
    process.exitCode = 2;
    return;
  }
  const electronPath = require('electron');
  const bundlePath = await bundleCdp();
  const servers = serve();
  let failed = 0;
  try {
    // One at a time: two probe windows on screen at once occlude each other.
    for (const mode of modes) {
      const result = await runOne(electronPath, mode, bundlePath);
      const expectsDialog = DIALOG_EXPECTED.has(mode);
      const sawDialog = (result.dialogMs ?? 0) > 0;
      const pass = !result.error && sawDialog === expectsDialog;
      if (!pass) failed += 1;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${mode}: dialog ${result.dialogMs ?? '?'} ms (expected ${expectsDialog ? 'a dialog' : 'none'})`);
      console.log(`  page: ${JSON.stringify(result.page)}`);
      if (result.events?.length) console.log(`  events: ${JSON.stringify(result.events)}`);
      if (result.stderr) console.log(`  stderr: ${result.stderr}`);
    }
  } finally {
    for (const server of servers) server.close();
    fs.rmSync(bundlePath, { force: true });
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

const modeFlag = process.argv.indexOf('--probe-mode');
if (process.versions.electron && modeFlag !== -1) {
  void runModeInElectron(process.argv[modeFlag + 1]);
} else {
  void main();
}
