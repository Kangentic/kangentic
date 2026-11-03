/**
 * E2E test for Claude's REAL hook path.
 *
 * The wiring a mock cannot stand in for: the command builder writes hook
 * commands into the session's `--settings` file, Claude hands each one to a
 * shell with a payload on stdin, the real `event-bridge.js` turns the payload
 * into a line of `events.jsonl`, the file watcher reads it, and the activity
 * engine follows. Every other Claude spec skips the middle: `mock-claude.js`
 * writes `events.jsonl` itself, so the commands in `settings.json` never run and
 * a broken quote, a wrong bridge path or a mangled directive would stay green.
 *
 * With MOCK_CLAUDE_RUN_HOOKS=1 the mock reads the hooks from the `--settings`
 * file the real builder wrote and runs the bridge commands for SessionStart,
 * UserPromptSubmit, PreToolUse, PostToolUse and Stop in the shell Claude uses
 * (`sh -c`, or Git Bash on Windows). Its own branch reads the `--settings`
 * argument, so nothing here depends on the other modes of the mock.
 *
 * The unit tier owns the bridge's directive cases (event-bridge.test.ts) and the
 * hook command strings (claude-hook-manager tests). This spec keeps one test
 * that proves they connect.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  waitForTaskScrollback,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const TEST_NAME = 'claude-hook-path';
const runId = Date.now();
const PROJECT_NAME = `Claude Hook Path ${runId}`;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockAgentPath('claude'),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
      },
      git: { worktreesEnabled: false },
    }),
  );

  const result = await launchApp({ dataDir, extraEnv: { MOCK_CLAUDE_RUN_HOOKS: '1' } });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
  cleanupTestDataDir(TEST_NAME);
});

/** What the mock recorded for each hook it ran, for a failure message. */
function readHookBreadcrumbs(sessionId: string): string {
  const breadcrumbPath = path.join(tmpDir, '.kangentic', 'sessions', sessionId, 'hook-run.jsonl');
  return fs.existsSync(breadcrumbPath) ? fs.readFileSync(breadcrumbPath, 'utf-8') : '(no hook-run.jsonl: the mock never ran a hook)';
}

test('hook commands from settings.json run through a shell and drive the activity state', async () => {
  const title = `Hook Path ${runId}`;
  await createTask(page, title, 'Run the real hook commands');

  const swimlaneIds = await getSwimlaneIds(page);
  const taskId = await getTaskIdByTitle(page, title);
  await moveTaskIpc(page, taskId, swimlaneIds.planning);

  // The mock prints this after it has run its last hook (Stop). It names the
  // task's own session, so no other test's session can satisfy it.
  const { sessionId } = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_HOOKS_DONE:', 25000);

  const readEvents = async (): Promise<SessionEvent[]> => {
    const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
    return (eventsMap as Record<string, SessionEvent[]>)[sessionId] ?? [];
  };

  await expect.poll(async () => {
    const events = await readEvents();
    return events.map((event) => event.type);
  }, {
    timeout: 15000,
    message: `Expected session_start, prompt, tool_start, tool_end and idle in the events cache. Hook breadcrumbs:\n${readHookBreadcrumbs(sessionId)}`,
  }).toEqual(expect.arrayContaining(['session_start', 'prompt', 'tool_start', 'tool_end', 'idle']));

  const events = await readEvents();
  const toolStart = events.find((event) => event.type === 'tool_start');
  const toolEnd = events.find((event) => event.type === 'tool_end');
  // The directives travelled through the shell as single tokens: the tool name,
  // the correlation id and the nested file path all came out of the payload.
  expect(toolStart).toMatchObject({ tool: 'Read', toolId: 'toolu_mock_hook_path_1', detail: 'hello.txt' });
  expect(toolEnd).toMatchObject({ tool: 'Read', toolId: 'toolu_mock_hook_path_1' });
  // Stop closed the turn after the tool did.
  const order = events.map((event) => event.type);
  expect(order.lastIndexOf('idle')).toBeGreaterThan(order.indexOf('tool_end'));

  // The raw line session_start wrote carries the hook payload, with the session
  // id the mock was started with.
  const eventsFile = path.join(tmpDir, '.kangentic', 'sessions', sessionId, 'events.jsonl');
  const sessionStartLine = fs.readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type: string; hookContext?: string })
    .find((record) => record.type === 'session_start');
  expect(sessionStartLine?.hookContext).toContain('"hook_event_name":"SessionStart"');

  // The activity engine followed the Stop hook to idle.
  await expect.poll(async () => {
    const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
    return (activity as Record<string, ActivityState>)[sessionId];
  }, { timeout: 15000, message: 'Expected the session to be idle after the Stop hook' }).toBe('idle');
});
