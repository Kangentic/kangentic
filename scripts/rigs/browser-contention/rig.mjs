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
 *   node rig.mjs --keep     leave the task, session and surface in place
 *
 * Requires a running /preview of this worktree.
 */
import { evalInPreview, runCommand, McpClient, startPageServer, openTaskWindow, dropTaskWindow, ok, fail, info, WORKTREE } from './lib.mjs';
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

// ── scenario A: N concurrent drivers, ONE guest, in each form it takes ────

/**
 * The contention itself, asserted on the guest rather than on the surface.
 *
 * `withGuest` acquires the per-guest FIFO keyed by webContentsId, so a parked
 * pane, a pane on screen and a lane all queue through the identical chokepoint.
 * A task has one surface, so the three scenarios below are that one surface in
 * each form it can take, none of which needs the preview window on screen.
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

async function scenarioParkedPane(drivers, pageUrl) {
  console.log('\n=== A1. three concurrent callers, a parked pane (no window open) ===');
  const opened = await drivers[0].call('kangentic_browser_open_pane', { url: pageUrl });
  if (opened.isError) return fail('open the pane', opened.text.slice(0, 300));
  const handle = (/"?sessionId"?\s*[:=]\s*"(pane_[^"]+)"/.exec(opened.text) || [])[1];
  if (!handle) return fail('read the pane handle', opened.text.slice(0, 300));
  info(`all three callers driving guest ${handle}`);
  await typeConcurrently(drivers, handle, 'parked pane', pageUrl);
}

async function scenarioOpenPane(drivers, pageUrl) {
  console.log('\n=== A2. the same, with the task window open ===');
  await openTaskWindow(state.taskId);
  await typeConcurrently(drivers, undefined, 'open pane', pageUrl);
}

async function scenarioLane(drivers, pageUrl) {
  console.log('\n=== A3. the same, on the offscreen lane a dead guest leaves ===');
  await dropTaskWindow(state.taskId);
  const listed = JSON.parse((await drivers[0].call('kangentic_browser_list_panes', {})).text);
  const lane = listed.panes.find((pane) => pane.taskId === state.taskId && pane.kind === 'lane' && pane.alive);
  if (!lane) return fail('a lane took over', JSON.stringify(listed.panes).slice(0, 300));
  await typeConcurrently(drivers, lane.sessionId, 'lane', pageUrl);
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
  if (KEEP) return void console.log('\n(--keep: leaving task, session and surface in place)');
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
  await scenarioParkedPane(drivers, pageUrl);
  await scenarioOpenPane(drivers, pageUrl);
  await scenarioLane(drivers, pageUrl);
  await scenarioTelemetry(projectPath);
} catch (error) {
  fail('rig', error.stack || error.message);
} finally {
  await teardown();
  console.log(process.exitCode ? '\nRESULT: failures above\n' : '\nRESULT: all scenarios passed\n');
}
