/**
 * Scenario G: the idle-lane reclaim, and the thing it must NOT do.
 *
 * `openLane` sweeps abandoned lanes before it opens one, so a lane nobody has
 * used for the whole window does not hold a renderer process for the life of the
 * app. Opportunistic, not on a timer.
 *
 * TWO assertions, and the second is the important one. `touchLane` shipped
 * UNCALLED at one point on this branch, which would have made the sweep reap
 * lanes an agent was actively driving - a far worse failure than never
 * reclaiming at all. So this checks both that an idle lane goes AND that a
 * driven one stays.
 *
 * A task has one surface, so a sweep only ever finds another task's lane. This
 * therefore runs three agents: one lane left idle, one kept warm, and one more
 * that opens last and runs the sweep. Each lane is a real hand-off, since an
 * agent cannot ask for one.
 *
 * Requires LANE_IDLE_RECLAIM_MS to be temporarily shortened, since the real
 * value is 30 minutes:
 *
 *   IDLE_MS=15000 node scripts/rigs/browser-contention/idle-reclaim.mjs
 *
 * and the constant in browser-lane-manager.ts edited to match, with the preview
 * restarted. The script reports the value it was told to expect so a mismatch
 * is obvious rather than silent. Keep the window well above the time one hand-off
 * takes (several seconds), or the second lane's open sweeps the first.
 */
import { evalInPreview, runCommand, McpClient, startPageServer, dropTaskWindow, ok, fail, info, WORKTREE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const IDLE_MS = Number(process.env.IDLE_MS ?? 15000);
const SPAWN_COLUMN = 'Executing';
const MOCK_CLI = `${WORKTREE}/tests/fixtures/mock-claude.cmd`;

const projectPath = await evalInPreview('window.electronAPI.projects.list().then(p => p[0].path)');
await evalInPreview(
  'window.electronAPI.config.get().then(c => window.electronAPI.config.set({ ...c, '
  + `agent: { ...(c.agent||{}), cliPaths: { ...((c.agent||{}).cliPaths||{}), claude: ${JSON.stringify(MOCK_CLI)} } }, `
  + 'developer: { ...(c.developer||{}), persistConsoleLogs: true } }))',
);

const agents = [];

async function waitForSession(taskId, timeoutMs = 30000) {
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

/** A task with a real session record, and an MCP client dialled as its agent. */
async function startAgent(title) {
  const created = await runCommand('create_task', { title, column: 'To Do' });
  const agent = { taskId: created.data.taskId, session: null, client: null };
  agents.push(agent);
  await runCommand('move_task', { taskId: agent.taskId, column: SPAWN_COLUMN });
  agent.session = await waitForSession(agent.taskId);
  if (!agent.session) throw new Error(`no running session record for "${title}"`);
  const config = JSON.parse(fs.readFileSync(path.join(projectPath, '.kangentic', 'mcp-config.json'), 'utf8'));
  agent.client = new McpClient({
    url: `${config.mcpServers.kangentic.url}/${agent.session}`,
    token: config.mcpServers.kangentic.headers['X-Kangentic-Token'],
    label: title,
  });
  return agent;
}

async function lanes(client) {
  return JSON.parse((await client.call('kangentic_browser_list_panes', {})).text)
    .panes.filter((pane) => pane.kind === 'lane');
}

/** Open the agent's pane and destroy its guest, which leaves a lane. */
async function standUpLane(agent, pageUrl) {
  const opened = await agent.client.call('kangentic_browser_open_pane', { url: pageUrl });
  if (opened.isError) throw new Error(`open pane: ${opened.text.slice(0, 200)}`);
  await dropTaskWindow(agent.taskId);
  const lane = (await lanes(agent.client)).find((pane) => pane.taskId === agent.taskId && pane.alive);
  if (!lane) throw new Error(`no lane took over for ${agent.taskId.slice(0, 8)}`);
  return lane.sessionId;
}

let pageServer = null;
try {
  console.log(`\n=== G. idle reclaim (expecting LANE_IDLE_RECLAIM_MS = ${IDLE_MS}ms) ===`);
  const idleAgent = await startAgent('idle reclaim: idle');
  const busyAgent = await startAgent('idle reclaim: busy');
  const sweepAgent = await startAgent('idle reclaim: sweep');

  const reserved = await runCommand('reserve_dev_ports', { taskId: idleAgent.taskId, count: 1 });
  const port = reserved.data.ports[0];
  pageServer = await startPageServer(port);
  const pageUrl = `http://127.0.0.1:${port}/`;

  const idleLane = await standUpLane(idleAgent, pageUrl);
  const busyLane = await standUpLane(busyAgent, pageUrl);
  info(`idle lane ${idleLane}, busy lane ${busyLane}`);

  // The idle window starts here for the idle lane, whatever the hand-offs took.
  await idleAgent.client.call('kangentic_browser_query_dom', { sessionId: idleLane, selector: '#lane' });

  // Keep the busy lane warm across the window by driving it.
  const deadline = Date.now() + IDLE_MS + 2000;
  while (Date.now() < deadline) {
    await busyAgent.client.call('kangentic_browser_query_dom', { sessionId: busyLane, selector: '#lane' });
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, IDLE_MS / 4)));
  }

  // Opening another lane is what runs the sweep.
  await standUpLane(sweepAgent, pageUrl);
  const remaining = (await lanes(sweepAgent.client)).map((pane) => pane.sessionId);

  if (!remaining.includes(idleLane)) ok('an untouched lane was reclaimed once it went idle');
  else fail('an untouched lane was reclaimed', `${idleLane} is still registered after ${IDLE_MS}ms idle`);

  // The regression that matters: touchLane shipped uncalled once, which would
  // have reaped lanes an agent was mid-verification on.
  if (remaining.includes(busyLane)) ok('a lane being DRIVEN survived the sweep');
  else fail('a lane being driven survived the sweep', `${busyLane} was reaped while in active use`);
} catch (error) {
  fail('scenario G', error.stack || error.message);
} finally {
  for (const agent of agents) {
    if (agent.session) await evalInPreview(`window.electronAPI.sessions.kill(${JSON.stringify(agent.session)})`).catch(() => {});
    await runCommand('delete_task', { taskId: agent.taskId }).catch(() => {});
  }
  if (pageServer) await pageServer.close();
  console.log(process.exitCode ? '\nRESULT: failures above\n' : '\nRESULT: passed\n');
}
