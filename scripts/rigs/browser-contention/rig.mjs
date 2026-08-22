/**
 * Browser-contention rig: the task-#8 shape, reproduced end to end.
 *
 * Task #8 launched three `general-purpose` subagents that drove ONE embedded
 * Browser pane at once, interleaving navigations, clicks and screenshots, each
 * believing it had exclusive control - and nothing logged it.
 *
 * The property that made it possible is that subagents inherit the parent's
 * mcp.json verbatim, so every one of them dials the SAME
 * `/mcp/<projectId>/<callerSessionId>` and is indistinguishable at the
 * transport. This rig reproduces exactly that: N HTTP clients on ONE session
 * id, firing concurrently at the real product MCP server in a live preview.
 * No agent is spawned and no quota is spent - the session is held open by a
 * mock TUI whose only job is to exist in the registry.
 *
 *   node rig.mjs            run every scenario
 *   node rig.mjs --keep     leave the task, session and lanes in place
 *
 * Requires a running /preview of this worktree.
 */
import { evalInPreview, runCommand, McpClient, startPageServer, ok, fail, info, WORKTREE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVERS = 3; // the reported shape
const KEEP = process.argv.includes('--keep');

const state = { taskId: null, sessionId: null, pageServer: null, port: null };

// ── setup ─────────────────────────────────────────────────────────────────

async function setup() {
  console.log('\n=== setup ===');

  const projectId = await evalInPreview(
    'window.electronAPI.projects.list().then(p => p[0].id)',
  );
  const projectPath = await evalInPreview(
    'window.electronAPI.projects.list().then(p => p[0].path)',
  );

  // Telemetry is console output, and the log file is what we can read back.
  await evalInPreview(
    'window.electronAPI.config.get().then(c => window.electronAPI.config.set({ ...c, developer: { ...(c.developer||{}), persistConsoleLogs: true } }))',
  );

  const created = await runCommand('create_task', {
    title: `contention rig ${Date.now() % 100000}`,
    description: 'Three concurrent callers, one pane. Reproduces task #8.',
    column: 'To Do',
  });
  state.taskId = created.data.taskId;
  info(`task ${created.data.displayId} (${state.taskId.slice(0, 8)})`);

  // A real port for a real page, taken through the feature under test.
  const reserved = await runCommand('reserve_dev_ports', { taskId: state.taskId, count: 1 });
  state.port = reserved.data.ports[0];
  state.pageServer = await startPageServer(state.port);
  info(`page server on ${state.port} (reserved through kangentic_reserve_dev_ports)`);

  // A REAL PTY session, so the MCP server can resolve the caller the way it
  // does for an agent. The command is raw, so no agent CLI is involved.
  const mockPath = path.join(HERE, 'mock-tui.js').replace(/\\/g, '/');
  const session = await evalInPreview(
    `window.electronAPI.sessions.spawn({ taskId: ${JSON.stringify(state.taskId)}, `
    + `command: ${JSON.stringify(`node "${mockPath}"`)}, cwd: ${JSON.stringify(WORKTREE)} }, `
    + `${JSON.stringify(projectId)}).then(s => s && (s.id || s.sessionId))`,
  );
  state.sessionId = session;
  info(`mock session ${String(session).slice(0, 8)} (zero quota)`);

  const config = JSON.parse(
    fs.readFileSync(path.join(projectPath, '.kangentic', 'mcp-config.json'), 'utf8'),
  );
  const baseUrl = config.mcpServers.kangentic.url;
  const token = config.mcpServers.kangentic.headers['X-Kangentic-Token'];

  // THE point: every driver dials the same three-segment URL, exactly as N
  // subagents of one parent would.
  const callerUrl = `${baseUrl}/${state.sessionId}`;
  info(`caller url ${callerUrl.replace(/\/\/[^/]+/, '//...')}`);

  const drivers = Array.from({ length: DRIVERS }, (unused, index) =>
    new McpClient({ url: callerUrl, token, label: String.fromCharCode(65 + index) }));

  return { projectId, projectPath, drivers, pageUrl: `http://127.0.0.1:${state.port}/` };
}

// ── scenario A: N concurrent drivers, ONE shared guest ────────────────────

/**
 * The contention itself, asserted on the guest rather than on the surface.
 *
 * `withGuest` acquires the per-guest FIFO keyed by webContentsId, so a lane and
 * a user-visible pane queue through the identical chokepoint - which is the
 * whole reason lanes register into the same registry. Driving a SHARED LANE
 * therefore exercises the same lock the reported bug needed, and does it
 * without depending on the preview window being on screen.
 *
 * A2 below runs the same assertion against a real task-detail pane, and skips
 * with a reason when the window is occluded (rAF stalls, the webview never
 * constructs, and open_pane times out - an environment limit, not a product
 * one).
 */
async function typeConcurrently(drivers, sessionId, label, pageUrl) {
  // Each driver types a long run of ONE distinct character into the same
  // input. If drives interleave, the runs shred into aaabbbaaa...; the FIFO
  // makes each run contiguous. Long enough that interleaving is near-certain
  // without the lock - a short string can land clean by luck.
  const RUN = 40;
  const letters = ['a', 'b', 'c', 'd', 'e'];

  // Fresh page load rather than clearing the field: clearing would need eval,
  // which is off by default in Agent Browser and should stay off for this to
  // mean anything.
  await drivers[0].call('kangentic_browser_navigate', { sessionId, url: pageUrl });

  const results = await Promise.allSettled(
    drivers.map((driver, index) =>
      driver.call('kangentic_browser_type', {
        sessionId,
        selector: '#shared',
        text: letters[index].repeat(RUN),
      })),
  );
  const rejected = results.filter((entry) => entry.status === 'rejected');
  if (rejected.length) info(`${rejected.length} type call(s) rejected: ${String(rejected[0].reason?.message).slice(0, 160)}`);

  // Ask the PAGE what it actually received, through the mirror node. The call
  // returning is the weaker claim and would pass even if nothing landed.
  const read = await drivers[0].call('kangentic_browser_query_dom', {
    sessionId,
    selector: '#mirror',
  });
  const value = (/([abcde]{3,})/.exec(read.text) || [null, ''])[1];

  if (!value) return fail(`${label}: the page received the keystrokes`, `read back: ${read.text.slice(0, 200)}`);
  info(`page value (${value.length} chars): ${value.slice(0, 60)}${value.length > 60 ? '...' : ''}`);

  // TWO assertions, and the completeness one is not optional.
  //
  // Measured with the FIFO disabled, the damage is not shredding - it is LOSS:
  // three concurrent click+type sequences race for focus and only ONE driver's
  // characters reach the page at all (40 of 120, one run, one caller). A
  // contiguity check alone PASSES on that, vacuously, because a single
  // surviving run is trivially contiguous. An assertion the fix's removal
  // satisfies is not an assertion, so completeness is checked first.
  const expected = drivers.length * RUN;
  if (value.length === expected) {
    ok(`${label}: every caller's keystrokes reached the page (${value.length}/${expected})`);
  } else {
    fail(
      `${label}: every caller's keystrokes reached the page`,
      `${value.length}/${expected} chars - ${expected - value.length} LOST to the race`,
    );
  }

  // Then contiguity: collapse runs of the same character. Three clean runs
  // collapse to three characters; shredding collapses to many more.
  const runs = value.replace(/(.)\1*/g, '$1');
  const callers = new Set(value.split('')).size;
  if (runs.length <= callers && callers === drivers.length) {
    ok(`${label}: each caller's keystrokes stayed contiguous (${runs.length} runs, ${callers} callers)`);
  } else {
    fail(
      `${label}: each caller's keystrokes stayed contiguous`,
      `${runs.length} runs from ${callers} of ${drivers.length} callers - saw "${runs}"`,
    );
  }
}

async function scenarioSharedGuest(drivers, pageUrl) {
  console.log('\n=== A1. three concurrent callers, ONE shared guest (lane) ===');
  const opened = await drivers[0].call('kangentic_browser_open_pane', { isolated: true, url: pageUrl });
  const handle = (/"?(?:laneSessionId|sessionId)"?\s*[:=]\s*"([^"]+)"/.exec(opened.text) || [])[1];
  if (!handle) return fail('open a shared guest', opened.text.slice(0, 300));
  info(`all three callers driving guest ${handle.slice(0, 8)}`);
  await typeConcurrently(drivers, handle, 'shared guest', pageUrl);
  return handle;
}

async function scenarioSharedPane(drivers, pageUrl) {
  console.log('\n=== A2. the same, on a real task-detail pane ===');
  const visibility = await evalInPreview('document.visibilityState');
  if (visibility !== 'visible') {
    info(`SKIPPED: preview window is "${visibility}". An occluded window stalls`);
    info('requestAnimationFrame, so the pane webview never constructs and');
    info('open_pane times out. Bring the preview window to the front and re-run');
    info('for this one. A1 covers the same FIFO on the same chokepoint.');
    return;
  }
  const opened = await drivers[0].call('kangentic_browser_open_pane', { url: pageUrl });
  if (opened.isError) return fail('open the shared pane', opened.text.slice(0, 300));
  ok('shared pane opened');
  await typeConcurrently(drivers, undefined, 'shared pane', pageUrl);
}

// ── scenario B: each caller gets its own isolated lane ────────────────────

async function scenarioIsolatedLanes(drivers, pageUrl) {
  console.log('\n=== B. three concurrent callers, one isolated lane each ===');

  const opens = await Promise.allSettled(
    drivers.map((driver) => driver.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl })),
  );

  const handles = [];
  for (const [index, entry] of opens.entries()) {
    if (entry.status !== 'fulfilled' || entry.value.isError) {
      const detail = entry.status === 'rejected' ? entry.reason?.message : entry.value.text;
      fail(`driver ${drivers[index].label} opened a lane`, String(detail).slice(0, 300));
      continue;
    }
    const handle = /"?(?:laneSessionId|sessionId)"?\s*[:=]\s*"([^"]+)"/.exec(entry.value.text);
    handles.push(handle ? handle[1] : null);
  }

  if (handles.filter(Boolean).length !== DRIVERS) {
    return info(`only ${handles.filter(Boolean).length}/${DRIVERS} lane handles parsed; raw: ${opens[0].value?.text?.slice(0, 300)}`);
  }
  const distinct = new Set(handles).size;
  if (distinct === DRIVERS) ok(`each caller got a DISTINCT lane (${distinct} handles)`);
  else fail('each caller got a distinct lane', `${distinct} distinct handles for ${DRIVERS} callers`);

  // Each lane navigates to a URL carrying its own id, then reads it back. If
  // lanes were shared, every driver would read the last navigation's id.
  await Promise.allSettled(
    drivers.map((driver, index) =>
      driver.call('kangentic_browser_navigate', {
        sessionId: handles[index],
        url: `${pageUrl}?lane=${driver.label}`,
      })),
  );
  const reads = await Promise.allSettled(
    drivers.map((driver, index) =>
      driver.call('kangentic_browser_query_dom', { sessionId: handles[index], selector: '#lane' })),
  );

  let isolated = 0;
  for (const [index, entry] of reads.entries()) {
    const label = drivers[index].label;
    const text = entry.status === 'fulfilled' ? entry.value.text : '';
    if (text.includes(`>${label}<`) || text.includes(label)) isolated += 1;
  }
  if (isolated === DRIVERS) ok(`each lane reported ITS OWN page (${isolated}/${DRIVERS})`);
  else fail('each lane reported its own page', `${isolated}/${DRIVERS} matched; a shared guest would collapse to one`);

  return handles;
}

// ── scenario C: the lane cap refuses actionably ───────────────────────────

async function scenarioLaneCap(drivers, pageUrl) {
  console.log('\n=== C. lane cap refuses the N+1th, and says what to do ===');
  const driver = drivers[0];
  let refusal = null;
  for (let attempt = 0; attempt < 8 && !refusal; attempt += 1) {
    const result = await driver.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl });
    if (result.isError) refusal = result.text;
  }
  if (!refusal) return fail('the cap refused an extra lane', 'no refusal after 8 opens');
  info(refusal.split('\n')[0].slice(0, 200));
  const actionable = /reuse|already hold|pass its sessionId|existing lane/i.test(refusal);
  if (actionable) ok('the refusal names lane REUSE, so a retrying caller can self-correct');
  else fail('the refusal names lane reuse', `got: ${refusal.slice(0, 200)}`);
}

// ── scenario D: contention is no longer silent ────────────────────────────

async function scenarioTelemetry(projectPath) {
  console.log('\n=== D. contention is visible in the log ===');
  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(projectPath, '.kangentic', 'logs', `${day}.log`);
  if (!fs.existsSync(logPath)) {
    return info(`no log at ${logPath} - developer.persistConsoleLogs may need a restart to take effect`);
  }
  const text = fs.readFileSync(logPath, 'utf8');
  const drives = (text.match(/\[browser-drive\]/g) || []).length;
  if (drives > 0) ok(`${drives} drives recorded with caller, pane, queue depth and outcome`);
  else fail('drives are recorded', 'no [browser-drive] lines in the log');

  const sample = (text.match(/\[browser-drive\][^\n]*/g) || []).slice(-2);
  for (const line of sample) info(line.slice(0, 150));

  const depths = Array.from(text.matchAll(/\[browser-drive\][^\n]*depth=(\d+)/g)).map((m) => Number(m[1]));
  const maxDepth = depths.length ? Math.max(...depths) : 0;
  if (maxDepth >= 2) ok(`queue depth reached ${maxDepth}, so concurrent sharing is measurable`);
  else info(`max queue depth ${maxDepth} - drives did not overlap this run`);

  if (/CONTENTION/.test(text)) ok('concurrent sharing raised an explicit CONTENTION warning');
  else info('no CONTENTION warning (fires at depth 3+); the per-drive lines above are still the record');
}

// ── teardown ──────────────────────────────────────────────────────────────

async function teardown() {
  if (KEEP) return void console.log('\n(--keep: leaving task, session and lanes in place)');
  console.log('\n=== teardown ===');
  try {
    if (state.sessionId) {
      await evalInPreview(`window.electronAPI.sessions.kill(${JSON.stringify(state.sessionId)})`);
      info('mock session killed');
    }
  } catch (error) {
    info(`session kill: ${error.message}`);
  }
  try {
    if (state.taskId) {
      await runCommand('delete_task', { taskId: state.taskId });
      info('task deleted (releases its reserved ports)');
    }
  } catch (error) {
    info(`task delete: ${error.message}`);
  }
  if (state.pageServer) {
    await state.pageServer.close();
    info('page server closed');
  }
}

// ── run ───────────────────────────────────────────────────────────────────

try {
  const { drivers, pageUrl, projectPath } = await setup();
  await scenarioSharedGuest(drivers, pageUrl);
  await scenarioSharedPane(drivers, pageUrl);
  await scenarioIsolatedLanes(drivers, pageUrl);
  await scenarioLaneCap(drivers, pageUrl);
  await scenarioTelemetry(projectPath);
} catch (error) {
  fail('rig', error.stack || error.message);
} finally {
  await teardown();
  console.log(process.exitCode ? '\nRESULT: failures above\n' : '\nRESULT: all scenarios passed\n');
}
