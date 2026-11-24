/**
 * Launch echo probe.
 *
 * Answers one question with numbers, before and after a change: when the app
 * launches and resumes its agents, how long does a keystroke typed into a
 * terminal take to paint, and which leg of the round trip holds it?
 *
 * It drives a running `/preview` of this checkout through the dev inspection
 * bridge (`src/devtools/main/inspection-server.ts`):
 *   1. Restarts the app in place (`window.electronAPI.app.restart()`), which
 *      keeps the data folder, so startup recovery resumes every agent the
 *      board holds and the boot does everything a real launch does.
 *   2. Waits for the new bridge, then for one resumed agent's terminal to be
 *      mounted and in the alternate screen. Typing starts only then: a key
 *      typed while Kangentic is still typing the launch command into the shell
 *      would land in that command.
 *   3. Posts `/scroll-latency` with a key drive: `x` then Backspace, never
 *      Enter, so the agent's input line ends where it began. The route arms the
 *      renderer's probe and the pty host's, and joins them.
 *   4. Saves the whole report, the boot's `agent:list` and `accounts:list`
 *      durations from the IPC log, and what the pty host's labelled work cost.
 *
 * Reading the result. `keyToPainted` is the wait a typist sees. Its legs:
 * `keyToSend` (the renderer was busy when the key came), `transportLegs.toHost`
 * (the port to the pty host), `host.agentResponse` (the write to the first
 * output after it: conhost plus the agent), `transportLegs.toRenderer`, then
 * parse and paint. The largest leg names the process that held the echo.
 *
 * Set up the board first: a column with no automations and a few idle agents
 * (a task whose prompt asks for one word and nothing else). A restart resumes
 * them all, and one of them must be showing in a terminal.
 *
 * Usage (from the worktree a preview is running in):
 *   node scripts/probe-launch-echo.mjs --out <folder> [--label before]
 *     [--task <task id>] [--windows 6] [--ticks 20] [--interval 250] [--no-restart]
 *     [--allow-hidden]
 *
 * One window is `ticks` pairs of keys `interval` ms apart, then a second for
 * the last answer. The defaults give six 11 s windows, the first minute of a
 * launch.
 *
 * `--no-restart` skips step 1 and types into the running app, which gives the
 * idle figure to compare a launch against. `--allow-hidden` runs against a
 * covered or minimized window, where only the host's legs can be read.
 *
 * Exit code 0 means a report was saved, 2 means the probe could not reach its
 * fixture (no preview, no agent terminal, a hidden window).
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const worktree = path.resolve(option('--worktree') ?? process.cwd());
const outputFolder = option('--out');
const label = option('--label') ?? 'run';
const taskId = option('--task') ?? null;
const ticks = Number(option('--ticks') ?? 20);
const intervalMs = Number(option('--interval') ?? 250);
const windowCount = Number(option('--windows') ?? 6);
const settleMs = 1000;
const restart = !argv.includes('--no-restart');
const allowHidden = argv.includes('--allow-hidden');
const lockPath = path.join(worktree, '.kangentic', 'preview.lock');

function fail(message) {
  console.error(`[launch-echo] ${message}`);
  process.exit(2);
}

if (!outputFolder) fail('Pass --out <folder> for the report.');

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function bridge(port, method, route, body, timeoutMs = 5000) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function evaluate(port, expression, timeoutMs = 5000) {
  return (await bridge(port, 'POST', '/eval', { expression }, timeoutMs)).value;
}

/** The mounted agent terminals and the page's visibility, read in the renderer. */
const READ_TERMINALS = `(async () => {
  const grids = window.__kangenticTerminalGrids?.() ?? [];
  const sessions = await window.electronAPI.sessions.list();
  return {
    visibility: document.visibilityState,
    sessions: sessions.map((session) => ({ id: session.id, taskId: session.taskId, status: session.status })),
    grids: grids.map((grid) => ({ sessionId: grid.sessionId, surface: grid.surface, altScreen: grid.altScreen })),
  };
})()`;

function pickTarget(state) {
  const running = new Map(state.sessions.filter((session) => session.status === 'running').map((session) => [session.id, session]));
  const candidates = state.grids.filter((grid) => grid.altScreen === true && running.has(grid.sessionId));
  const wanted = taskId ? candidates.filter((grid) => running.get(grid.sessionId).taskId === taskId) : candidates;
  return wanted[0] ?? null;
}

function stat(stats) {
  if (!stats || stats.count === 0) return 'none';
  return `p50 ${stats.p50Ms} p95 ${stats.p95Ms} max ${stats.maxMs}`;
}

/** One window's figures on one line: the wait a typist saw, then each leg of it. */
function summaryLine(offsetMs, report, sessionId) {
  const session = (report.sessions ?? []).find((entry) => entry.sessionId === sessionId);
  if (!session) return `+${offsetMs} ms: the report holds nothing for the session`;
  const renderer = session.renderer;
  const busiest = (report.cpu ?? []).slice(0, 3).map((row) => `${row.process} ${row.percentOfCore}%`).join(', ');
  return [
    `+${offsetMs} ms`,
    `keys ${session.counts.sends} (${session.counts.unansweredSends} unanswered, ${renderer.slowKeys} slow)`,
    `keyToPainted ${stat(renderer.keyToPainted)}`,
    `keyToSend ${stat(renderer.keyToSend)}`,
    `toHost ${stat(session.transportLegs?.toHost)}`,
    `agentResponse ${stat(session.host?.agentResponse)}`,
    `toRenderer ${stat(session.transportLegs?.toRenderer)}`,
    `parsedToPainted ${stat(renderer.parsedToPainted)}`,
    `longFrames ${report.rendererLongFrames?.count ?? 0} (max ${report.rendererLongFrames?.maxMs ?? 0})`,
    `hostLoop max ${report.hostEventLoopDelay?.maxMs ?? 'none'}`,
    `cpu ${busiest}`,
  ].join(' | ');
}

const IPC_CHANNELS = ['agent:list', 'accounts:list', 'accounts:refreshUsage'];

/**
 * Every IPC log this app writes. The recorder writes beside the open project,
 * and a preview's project is a clone under its data folder, so the bridge's
 * `/ipc-log` (which reads beside the worktree) finds nothing there.
 */
function ipcLogFiles() {
  const folders = [path.join(worktree, '.kangentic', 'logs')];
  const clones = path.join(worktree, '.kangentic', 'data', 'preview-projects');
  try {
    for (const clone of fs.readdirSync(clones)) folders.push(path.join(clones, clone, '.kangentic', 'logs'));
  } catch {
    // Not an ephemeral preview: the app's own project folder holds the log.
  }
  const files = [];
  for (const folder of folders) {
    try {
      for (const name of fs.readdirSync(folder)) {
        if (/^ipc-.*\.jsonl(\.1)?$/.test(name)) files.push(path.join(folder, name));
      }
    } catch {
      // No log folder yet.
    }
  }
  return files;
}

/** How long each boot call took since `sinceIso`, per channel, in the order made. */
function readIpcDurations(sinceIso) {
  const durations = Object.fromEntries(IPC_CHANNELS.map((channel) => [channel, []]));
  for (const file of ipcLogFiles()) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"channel"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!IPC_CHANNELS.includes(entry.channel) || entry.direction === 'out') continue;
      if (typeof entry.ts !== 'string' || entry.ts < sinceIso || typeof entry.durationMs !== 'number') continue;
      durations[entry.channel].push({ at: entry.ts, durationMs: Math.round(entry.durationMs) });
    }
  }
  for (const channel of IPC_CHANNELS) durations[channel].sort((left, right) => left.at.localeCompare(right.at));
  return durations;
}

async function main() {
  const before = readLock();
  if (!before) fail(`No preview is running here (${lockPath} is missing). Start one with /preview.`);

  let port = before.port;
  const startedAt = Date.now();
  let bridgeUpMs = 0;

  if (restart) {
    console.log(`[launch-echo] restarting pid ${before.pid} on port ${before.port}`);
    // The app quits under the request, so a dropped connection is the expected answer.
    await evaluate(port, 'void window.electronAPI.app.restart()').catch(() => undefined);
    const deadline = Date.now() + 120_000;
    let up = false;
    while (Date.now() < deadline) {
      const lock = readLock();
      if (lock && lock.pid !== before.pid) {
        try {
          await bridge(lock.port, 'GET', '/info', undefined, 1000);
          port = lock.port;
          up = true;
          break;
        } catch {
          // Not listening yet.
        }
      }
      await wait(100);
    }
    if (!up) fail('The restarted app never wrote a lockfile whose bridge answered.');
    bridgeUpMs = Date.now() - startedAt;
    console.log(`[launch-echo] bridge up ${bridgeUpMs} ms after the restart`);
  }

  // Wait for a resumed agent's terminal: mounted, and drawing its own screen.
  let target = null;
  let visibilityAtStart = 'unknown';
  const mountDeadline = Date.now() + 90_000;
  while (Date.now() < mountDeadline) {
    try {
      const state = await evaluate(port, READ_TERMINALS, 3000);
      visibilityAtStart = state.visibility;
      target = pickTarget(state);
      if (target) break;
    } catch {
      // No window, or the debugger is not attached yet.
    }
    await wait(150);
  }
  if (!target) fail('No running agent terminal reached the alternate screen within 90 s.');
  if (visibilityAtStart !== 'visible') {
    // A covered or minimized window paints nothing, so `keyToPainted` reads empty.
    // The host's legs do not pass through the page and stay good.
    if (!allowHidden) fail(`The window is ${visibilityAtStart}: a hidden page paints nothing. Pass --allow-hidden to time the host's legs alone.`);
    console.log(`[launch-echo] the window is ${visibilityAtStart}: paint times will read empty, agentResponse is the leg to read`);
  }
  const typingStartMs = Date.now() - startedAt;
  console.log(`[launch-echo] typing into ${target.sessionId} (${target.surface}) ${typingStartMs} ms after the ${restart ? 'restart' : 'start'}`);

  // Several short windows back to back, not one long one: a report holds
  // percentiles for its whole window, and the lag being looked for sits in the
  // first seconds of a launch, where a 100 s window would average it away.
  const windowMs = ticks * 2 * intervalMs + settleMs;
  const windows = [];
  for (let index = 0; index < windowCount; index++) {
    const offsetMs = Date.now() - startedAt;
    const report = await bridge(
      port,
      'POST',
      '/scroll-latency',
      { sessionId: target.sessionId, drive: { kind: 'keys', ticks, intervalMs, settleMs } },
      windowMs + 60_000,
    );
    windows.push({ offsetMs, report });
    console.log(`[launch-echo] ${summaryLine(offsetMs, report, target.sessionId)}`);
  }

  const after = await evaluate(port, READ_TERMINALS, 5000).catch(() => null);
  const ipc = readIpcDurations(new Date(startedAt).toISOString());

  const result = {
    label,
    restarted: restart,
    startedAt: new Date(startedAt).toISOString(),
    bridgeUpMs,
    typingStartMs,
    sessionId: target.sessionId,
    surface: target.surface,
    visibility: { atStart: visibilityAtStart, atEnd: after?.visibility ?? 'unknown' },
    runningSessions: after?.sessions.filter((session) => session.status === 'running').length ?? null,
    drive: { ticks, intervalMs, settleMs, windows: windowCount },
    ipc,
    windows,
  };

  fs.mkdirSync(outputFolder, { recursive: true });
  const file = path.join(outputFolder, `launch-echo-${label}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[launch-echo] saved ${file}`);
  console.log(`[launch-echo] ipc ${JSON.stringify(ipc)} visibility ${JSON.stringify(result.visibility)}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
