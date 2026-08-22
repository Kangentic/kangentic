/**
 * Scenario F: do lanes actually die with the session that owns them?
 *
 * `markRecordExited` calls `destroyLanesForSession(recordId)` and the comment
 * above it calls that "the GUARANTEE that lanes cannot leak". Each lane is an
 * offscreen BrowserWindow, so a leak is a renderer process held for the life of
 * the app - worth proving rather than assuming, especially since this branch
 * already shipped `destroyLanesForSession` and `touchLane` uncalled once each.
 *
 * ## Why this spawns through the BOARD, not sessions.spawn
 *
 * The first version of this probe used the raw `SESSION_SPAWN` passthrough with
 * a mock command, the way the contention rig does. It reported three leaked
 * lanes - and that was the RIG's bug, not the product's.
 *
 * The raw passthrough creates a registry session with NO row in the `sessions`
 * table. `markRecordExited` resolves its record via `sessionRepo.findByAnyId`,
 * so with no row there is no record, the CAS never runs, and the cleanup call
 * is never reached. `spawn-entry-point-parity.md` says as much: the raw
 * passthrough is explicitly allowlisted as NOT a task-agent spawn.
 *
 * A real agent always has a record. So this probe points the claude CLI at the
 * repo's mock (zero quota) and moves a task into a spawning column, which is
 * the production entry point and does create one. Testing cleanup against a
 * session shape no agent ever has would prove nothing either way.
 *
 * Run on a CLEAN preview - leftover lanes make the counts unreadable.
 */
import { evalInPreview, runCommand, McpClient, startPageServer, ok, fail, info, WORKTREE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LANES = 3;
const SPAWN_COLUMN = 'Executing';
const MOCK_CLI = `${WORKTREE}/tests/fixtures/mock-claude.cmd`;

const projectPath = await evalInPreview('window.electronAPI.projects.list().then(p => p[0].path)');

await evalInPreview(
  'window.electronAPI.config.get().then(c => window.electronAPI.config.set({ ...c, '
  + `agent: { ...(c.agent||{}), cliPaths: { ...((c.agent||{}).cliPaths||{}), claude: ${JSON.stringify(MOCK_CLI)} } }, `
  + 'developer: { ...(c.developer||{}), persistConsoleLogs: true } }))',
);

const created = await runCommand('create_task', { title: 'lane lifecycle probe', column: 'To Do' });
const taskId = created.data.taskId;
const reserved = await runCommand('reserve_dev_ports', { taskId, count: 1 });
const port = reserved.data.ports[0];
const pageServer = await startPageServer(port);
const pageUrl = `http://127.0.0.1:${port}/`;

/** Wait for the board spawn to produce a running record for this task. */
async function waitForSession(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await runCommand('query_db', {
      sql: `SELECT id FROM sessions WHERE task_id = '${taskId}' AND status = 'running' LIMIT 1`,
    });
    const row = rows.data?.[0];
    if (row) return row.id;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

let session = null;
try {
  console.log('\n=== F. lanes die with the session that owns them ===');

  await runCommand('move_task', { taskId, column: SPAWN_COLUMN });
  session = await waitForSession();
  if (!session) throw new Error(`no running session record appeared after moving to ${SPAWN_COLUMN}`);
  ok(`the board spawn produced a real session RECORD (${session.slice(0, 8)})`);

  const client = new McpClient({
    url: `${JSON.parse(fs.readFileSync(path.join(projectPath, '.kangentic', 'mcp-config.json'), 'utf8')).mcpServers.kangentic.url}/${session}`,
    token: JSON.parse(fs.readFileSync(path.join(projectPath, '.kangentic', 'mcp-config.json'), 'utf8')).mcpServers.kangentic.headers['X-Kangentic-Token'],
    label: 'agent',
  });
  const allPanes = async () =>
    JSON.parse((await client.call('kangentic_browser_list_panes', {})).text).panes;

  const starting = await allPanes();
  if (starting.length > 0) info(`WARNING: ${starting.length} pane(s) already registered - use a clean preview`);

  for (let index = 0; index < LANES; index += 1) {
    const opened = await client.call('kangentic_browser_open_pane', { isolated: true, url: pageUrl });
    if (opened.isError) throw new Error(`open lane ${index}: ${opened.text.slice(0, 200)}`);
  }
  const live = (await allPanes()).filter((pane) => pane.kind === 'lane' && pane.alive);
  if (live.length === LANES) ok(`${LANES} lanes are open and alive`);
  else fail(`${LANES} lanes are open`, `saw ${live.length}`);

  info('killing the session...');
  await evalInPreview(`window.electronAPI.sessions.kill(${JSON.stringify(session)})`);
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const status = await runCommand('query_db', {
    sql: `SELECT status FROM sessions WHERE id = '${session}'`,
  });
  info(`session record status after kill: ${status.data?.[0]?.status ?? 'gone'}`);

  const survivors = (await allPanes()).filter((pane) => pane.kind === 'lane');
  if (survivors.length === 0) {
    ok('EVERY lane was destroyed when its session exited');
  } else {
    fail(
      'every lane was destroyed when its session exited',
      `${survivors.length} survived: ${survivors.map((p) => `${p.sessionId}(alive=${p.alive})`).join(', ')}`,
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  const text = fs.readFileSync(path.join(projectPath, '.kangentic', 'logs', `${day}.log`), 'utf8');
  const laneLines = (text.match(/\[browser-lane\][^\n]*/g) || []).slice(-4);
  console.log('\n--- [browser-lane] log ---');
  console.log(laneLines.length ? laneLines.join('\n') : '(none)');
} catch (error) {
  fail('scenario F', error.stack || error.message);
} finally {
  if (session) await evalInPreview(`window.electronAPI.sessions.kill(${JSON.stringify(session)})`).catch(() => {});
  await runCommand('delete_task', { taskId }).catch(() => {});
  await pageServer.close();
  console.log(process.exitCode ? '\nRESULT: failures above\n' : '\nRESULT: passed\n');
}
