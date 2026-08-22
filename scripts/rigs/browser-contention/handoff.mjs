/**
 * Scenario E, standalone: the #542 fix.
 *
 * An agent is driving its task's Browser pane. The USER closes the task-detail
 * window. Does the agent keep a browser?
 *
 * Deliberately run on a clean preview with NO other lanes: the implicit-target
 * path is what an agent actually uses, and it refuses with `multiple-panes`
 * when several panes match the task, so leftover lanes from another scenario
 * would make the result unreadable.
 */
import { evalInPreview, runCommand, McpClient, startPageServer, ok, fail, info, WORKTREE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RIG_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');

const projectId = await evalInPreview('window.electronAPI.projects.list().then(p => p[0].id)');
const projectPath = await evalInPreview('window.electronAPI.projects.list().then(p => p[0].path)');
await evalInPreview(
  'window.electronAPI.config.get().then(c => window.electronAPI.config.set({ ...c, developer: { ...(c.developer||{}), persistConsoleLogs: true } }))',
);

const created = await runCommand('create_task', { title: 'handoff probe', column: 'To Do' });
const taskId = created.data.taskId;
const reserved = await runCommand('reserve_dev_ports', { taskId, count: 1 });
const port = reserved.data.ports[0];
const pageServer = await startPageServer(port);
const pageUrl = `http://127.0.0.1:${port}/`;
info(`task ${created.data.displayId}, page on ${port}`);

const session = await evalInPreview(
  `window.electronAPI.sessions.spawn({ taskId: ${JSON.stringify(taskId)}, `
  + `command: ${JSON.stringify(`node "${RIG_DIR}/mock-tui.js"`)}, cwd: ${JSON.stringify(WORKTREE)} }, `
  + `${JSON.stringify(projectId)}).then(s => s && (s.id || s.sessionId))`,
);
info(`mock session ${String(session).slice(0, 8)}`);

const config = JSON.parse(fs.readFileSync(path.join(projectPath, '.kangentic', 'mcp-config.json'), 'utf8'));
const client = new McpClient({
  url: `${config.mcpServers.kangentic.url}/${session}`,
  token: config.mcpServers.kangentic.headers['X-Kangentic-Token'],
  label: 'agent',
});

async function paneSummary() {
  const parsed = JSON.parse((await client.call('kangentic_browser_list_panes', {})).text);
  return parsed.panes.filter((pane) => pane.taskId === taskId);
}

try {
  console.log('\n=== E. the user closes the task window while the agent drives ===');

  // The first open on a cold preview can exceed the tool's own 10s bound while
  // the window and its webview mount; a retry finds the pane already up.
  let opened = await client.call('kangentic_browser_open_pane', { url: pageUrl });
  if (opened.isError) {
    info('first open_pane timed out (cold mount), retrying once');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    opened = await client.call('kangentic_browser_open_pane', { url: pageUrl });
  }
  if (opened.isError) throw new Error(`open_pane: ${opened.text.slice(0, 300)}`);
  const before = await paneSummary();
  info(`before: ${before.map((p) => `${p.kind}:${p.sessionId.slice(0, 12)}`).join(', ')}`);
  if (!before.some((pane) => pane.kind === 'pane')) throw new Error('no real pane registered');

  const drive = await client.call('kangentic_browser_query_dom', { selector: '#lane' });
  if (drive.isError) throw new Error(`pre-close drive: ${drive.text.slice(0, 200)}`);
  ok('the agent can drive its pane while the window is open');

  // Close the TASK-DETAIL window, by its testid. NOT by title: the OS window
  // close button is also titled "Close", and clicking that one quits the app -
  // which is exactly what happened on the first attempt.
  const closeExpression =
    '(() => {'
    + '  const button = Array.from(document.querySelectorAll("button"))'
    + '    .find(b => b.dataset && b.dataset.testid === "task-detail-close");'
    + '  if (!button) return "no task-detail-close button";'
    + '  button.click();'
    + '  return "clicked task-detail-close";'
    + '})()';
  const closeResult = await evalInPreview(closeExpression);
  info(`close: ${closeResult}`);
  if (String(closeResult).startsWith('no ')) throw new Error('could not find the task-detail close control');

  await new Promise((resolve) => setTimeout(resolve, 4000));

  const after = await paneSummary();
  info(`after:  ${after.map((p) => `${p.kind}:${p.sessionId.slice(0, 12)}`).join(', ') || '(none)'}`);

  const realPaneGone = !after.some((pane) => pane.kind === 'pane');
  if (realPaneGone) ok('the user\'s pane is gone, as they asked');
  else fail('the user\'s pane is gone', 'a pane is still registered after closing the window');

  const handoffLane = after.find((pane) => pane.kind === 'lane' && pane.alive);
  if (handoffLane) ok(`a hand-off lane took over (${handoffLane.sessionId})`);
  else fail('a hand-off lane took over', 'no live lane for this task after the window closed');

  const stillDriving = await client.call('kangentic_browser_query_dom', { selector: '#lane' });
  if (!stillDriving.isError) ok('THE AGENT CAN STILL DRIVE after the user closed the window');
  else fail('the agent can still drive', stillDriving.text.slice(0, 250));

  const day = new Date().toISOString().slice(0, 10);
  const text = fs.readFileSync(path.join(projectPath, '.kangentic', 'logs', `${day}.log`), 'utf8');
  const lines = (text.match(/\[browser-pane\][^\n]*handoff[^\n]*/g) || []).slice(-2);
  if (lines.length) { ok('the hand-off is logged'); lines.forEach((line) => info(line.slice(0, 160))); }
  else fail('the hand-off is logged', 'no [browser-pane] handoff line');
} catch (error) {
  fail('scenario E', error.message);
} finally {
  await evalInPreview(`window.electronAPI.sessions.kill(${JSON.stringify(session)})`).catch(() => {});
  await runCommand('delete_task', { taskId }).catch(() => {});
  await pageServer.close();
  console.log(process.exitCode ? '\nRESULT: failures above\n' : '\nRESULT: passed\n');
}
