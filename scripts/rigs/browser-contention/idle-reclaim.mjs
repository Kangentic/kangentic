/**
 * Scenario G: the idle-lane reclaim, and the thing it must NOT do.
 *
 * `openLane` sweeps abandoned lanes before counting, so a session that opened
 * and forgot lanes is not refused a new one over renderer processes nothing is
 * using. Opportunistic, not on a timer.
 *
 * TWO assertions, and the second is the important one. `touchLane` shipped
 * UNCALLED at one point on this branch, which would have made the sweep reap
 * lanes an agent was actively driving - a far worse failure than never
 * reclaiming at all. So this checks both that an idle lane goes AND that a
 * driven one stays.
 *
 * Requires LANE_IDLE_RECLAIM_MS to be temporarily shortened, since the real
 * value is 30 minutes:
 *
 *   IDLE_MS=6000 node scripts/rigs/browser-contention/idle-reclaim.mjs
 *
 * and the constant in browser-lane-manager.ts edited to match, with the preview
 * restarted. The script reports the value it was told to expect so a mismatch
 * is obvious rather than silent.
 */
import { evalInPreview, runCommand, McpClient, startPageServer, ok, fail, info, WORKTREE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const IDLE_MS = Number(process.env.IDLE_MS ?? 6000);
const SPAWN_COLUMN = 'Executing';
const MOCK_CLI = `${WORKTREE}/tests/fixtures/mock-claude.cmd`;

const projectPath = await evalInPreview('window.electronAPI.projects.list().then(p => p[0].path)');
await evalInPreview(
  'window.electronAPI.config.get().then(c => window.electronAPI.config.set({ ...c, '
  + `agent: { ...(c.agent||{}), cliPaths: { ...((c.agent||{}).cliPaths||{}), claude: ${JSON.stringify(MOCK_CLI)} } }, `
  + 'developer: { ...(c.developer||{}), persistConsoleLogs: true } }))',
);

const created = await runCommand('create_task', { title: 'idle reclaim probe', column: 'To Do' });
const taskId = created.data.taskId;
const reserved = await runCommand('reserve_dev_ports', { taskId, count: 1 });
const port = reserved.data.ports[0];
const pageServer = await startPageServer(port);
const pageUrl = `http://127.0.0.1:${port}/`;

async function waitForSession(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await runCommand('query_db', {
      sql: `SELECT id FROM sessions WHERE task_id = '${taskId}' AND status = 'running' LIMIT 1`,
    });
    if (rows.data?.[0]) return rows.data[0].id;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

let session = null;
try {
  console.log(`\n=== G. idle reclaim (expecting LANE_IDLE_RECLAIM_MS = ${IDLE_MS}ms) ===`);
  await runCommand('move_task', { taskId, column: SPAWN_COLUMN });
  session = await waitForSession();
  if (!session) throw new Error('no running session record');

  const config = JSON.parse(fs.readFileSync(path.join(projectPath, '.kangentic', 'mcp-config.json'), 'utf8'));
  const client = new McpClient({
    url: `${config.mcpServers.kangentic.url}/${session}`,
    token: config.mcpServers.kangentic.headers['X-Kangentic-Token'],
    label: 'agent',
  });
  const laneIds = async () =>
    JSON.parse((await client.call('kangentic_browser_list_panes', {})).text)
      .panes.filter((pane) => pane.kind === 'lane')
      .map((pane) => pane.sessionId);

  // --- an IDLE lane is reclaimed ---
  const first = await client.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl });
  const idleLane = (/"?(?:laneSessionId|sessionId)"?\s*[:=]\s*"([^"]+)"/.exec(first.text) || [])[1];
  if (!idleLane) throw new Error(`open lane: ${first.text.slice(0, 200)}`);
  info(`idle lane ${idleLane}`);

  await new Promise((resolve) => setTimeout(resolve, IDLE_MS + 2000));

  // Opening another lane is what runs the sweep.
  await client.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl });
  const afterIdle = await laneIds();
  if (!afterIdle.includes(idleLane)) ok('an untouched lane was reclaimed once it went idle');
  else fail('an untouched lane was reclaimed', `${idleLane} is still registered after ${IDLE_MS}ms idle`);

  // --- a DRIVEN lane is NOT reclaimed ---
  // The regression that matters: touchLane shipped uncalled once, which would
  // have reaped lanes an agent was mid-verification on.
  const busyOpen = await client.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl });
  const busyLane = (/"?(?:laneSessionId|sessionId)"?\s*[:=]\s*"([^"]+)"/.exec(busyOpen.text) || [])[1];
  if (!busyLane) throw new Error(`open busy lane: ${busyOpen.text.slice(0, 200)}`);
  info(`busy lane ${busyLane}`);

  // Keep it warm across the idle window by driving it.
  const deadline = Date.now() + IDLE_MS + 2000;
  while (Date.now() < deadline) {
    await client.call('kangentic_browser_query_dom', { sessionId: busyLane, selector: '#lane' });
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, IDLE_MS / 4)));
  }

  await client.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl }).catch(() => {});
  const afterBusy = await laneIds();
  if (afterBusy.includes(busyLane)) ok('a lane being DRIVEN survived the sweep');
  else fail('a lane being driven survived the sweep', `${busyLane} was reaped while in active use`);
} catch (error) {
  fail('scenario G', error.stack || error.message);
} finally {
  if (session) await evalInPreview(`window.electronAPI.sessions.kill(${JSON.stringify(session)})`).catch(() => {});
  await runCommand('delete_task', { taskId }).catch(() => {});
  await pageServer.close();
  console.log(process.exitCode ? '\nRESULT: failures above\n' : '\nRESULT: passed\n');
}
