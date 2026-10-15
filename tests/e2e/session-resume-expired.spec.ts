/**
 * E2E: a resume whose conversation the agent deleted starts fresh from a recap.
 *
 * Claude Code deletes transcripts older than its `cleanupPeriodDays`. A
 * `--resume` of one prints "No conversation found" and exits, leaving a bare
 * shell. The check (`assessResumeConversation`) proves the file gone before
 * the spawn, and the same spawn starts fresh with a recap as its prompt.
 *
 * The mock CLI writes no status file, so a plain mocked resume still resumes
 * (the "resumes as before" half is session-resume.spec.ts, unchanged). Here the
 * test writes the status file Claude would have: a conversation with turns,
 * whose reported transcript sits under a projects folder that exists and holds
 * no copy of it.
 *
 * Uses the mock Claude CLI's markers: MOCK_CLAUDE_SESSION:<id> for a new
 * session, MOCK_CLAUDE_RESUMED:<id> for a resume, MOCK_CLAUDE_PROMPT:<text>.
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
  closeApp,
  waitForTaskSession,
  waitForTaskSessionNotRunning,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'session-resume-expired';
const runId = Date.now();

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') return path.join(fixturesDir, 'mock-claude.cmd');
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: { cliPath: mockClaudePath(), permissionMode: 'default', maxConcurrentSessions: 5, queueOverflow: 'queue' },
      git: { worktreesEnabled: false },
    }),
  );
}

// The recap is one long prompt line. On local Windows, ConPTY re-renders a
// line longer than the PTY width wrapped at that width, so the raw scrollback
// can carry a line break or a cursor sequence inside any long substring. Every
// match here therefore runs on flattened text: terminal escape sequences
// stripped and ALL whitespace removed, with the needle flattened the same way.
// Linux CI never wraps, so it passes either way.
const ESC = '\u001b';
const BEL = '\u0007';
const TERMINAL_ESCAPES = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC, ended by BEL or ST
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI, with private and intermediate bytes
    `${ESC}[ -/]+[0-~]`, // charset designators and other intermediates
    `${ESC}[0-~]`, // two-character escapes
  ].join('|'),
  'g',
);

function flattenTerminalText(text: string): string {
  return text.replace(TERMINAL_ESCAPES, '').replace(/\s+/g, '');
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID_PATTERN = new RegExp(`MOCK_CLAUDE_SESSION:(${UUID_SOURCE})`);
const PROMPT_MARKER = 'MOCK_CLAUDE_PROMPT:';
const RETENTION_PHRASE = flattenTerminalText('deleted it after its retention period');

/**
 * Everything the mock CLI printed from its own MOCK_CLAUDE_PROMPT: marker on.
 * The shell also echoes the command line, which carries the same recap text, so
 * only text after the mock's marker proves the mock received it as its prompt.
 */
function promptPayload(flat: string): string {
  const markerIndex = flat.indexOf(PROMPT_MARKER);
  return markerIndex === -1 ? '' : flat.slice(markerIndex);
}

/**
 * The mock output of ONE session's own run: from its MOCK_CLAUDE_SETTINGS: line
 * (which names that session's own folder) on.
 *
 * A respawn carries the previous session's scrollback over on purpose
 * (session-spawn-flow.ts), so a new session's scrollback can open with the OLD
 * run's mock output, MOCK_CLAUDE_SESSION:<old id> included. It showed up on one
 * respawn and not another in this file, so anything asserted about the new run
 * is read from here, never from the whole scrollback. The tempered dot keeps
 * the match from running across a marker into the next run's path.
 */
function ownRunOutput(flat: string, sessionId: string): string {
  const ownSettings = new RegExp(
    `MOCK_CLAUDE_SETTINGS:(?:(?!MOCK_CLAUDE_).)*?sessions[\\\\/]${sessionId}[\\\\/]settings\\.json`,
  ).exec(flat);
  return ownSettings ? flat.slice(ownSettings.index) : '';
}

interface FlatScrollback {
  sessionId: string;
  /** The flattened scrollback that satisfied `isReady`. */
  flat: string;
}

interface RecapSession extends FlatScrollback {
  /** `flat`, narrowed to this session's own mock run (see ownRunOutput). */
  ownRun: string;
}

/**
 * Poll one task's session (never `excludeSessionId`, so a suspended earlier
 * session cannot answer for the new one) until its flattened scrollback
 * satisfies `isReady`. Returns the snapshot that satisfied it, so a following
 * assertion reads the same text the poll saw instead of racing the stream.
 */
async function waitForFlatScrollback(
  page: Page,
  taskId: string,
  excludeSessionId: string | null,
  isReady: (flat: string, sessionId: string) => boolean,
  description: string,
): Promise<FlatScrollback> {
  let satisfied: FlatScrollback | null = null;
  await expect.poll(
    async () => {
      const snapshot = await page.evaluate(async ({ id, excluded }) => {
        const sessions = await window.electronAPI.sessions.list();
        const session = sessions.filter((candidate) => candidate.taskId === id && candidate.id !== excluded).at(-1);
        if (!session) return null;
        return { sessionId: session.id, scrollback: await window.electronAPI.sessions.getScrollback(session.id) };
      }, { id: taskId, excluded: excludeSessionId });
      if (!snapshot) return false;
      const flat = flattenTerminalText(snapshot.scrollback);
      if (!isReady(flat, snapshot.sessionId)) return false;
      satisfied = { sessionId: snapshot.sessionId, flat };
      return true;
    },
    { message: `waiting for ${description}`, timeout: 30_000, intervals: [250, 500, 1000] },
  ).toBe(true);
  return satisfied!;
}

/** The conversation id the mock printed for a task's first session. */
async function readConversationId(page: Page, taskId: string): Promise<string> {
  const first = await waitForFlatScrollback(
    page, taskId, null, (flat) => SESSION_ID_PATTERN.test(flat), 'the first session to print its conversation id',
  );
  const conversationId = SESSION_ID_PATTERN.exec(first.flat)?.[1];
  expect(conversationId).toBeTruthy();
  return conversationId!;
}

/** The new session whose own run received the expired-conversation recap as its prompt. */
async function waitForRecapSession(page: Page, taskId: string, firstSessionId: string): Promise<RecapSession> {
  const session = await waitForFlatScrollback(
    page, taskId, firstSessionId,
    (flat, sessionId) => promptPayload(ownRunOutput(flat, sessionId)).includes(RETENTION_PHRASE),
    'a new session whose prompt is the expired-conversation recap',
  );
  return { ...session, ownRun: ownRunOutput(session.flat, session.sessionId) };
}

test.describe('Claude Agent: a resume of a deleted conversation starts fresh from a recap', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);
    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Expired Resume ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('unarchiving into Planning starts a new session whose prompt is the recap', async () => {
    test.slow();
    const title = `Expired ${runId}`;
    await createTask(page, title, 'Fix the login redirect');

    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      return {
        planning: swimlanes.find((swimlane) => swimlane.name === 'Planning')?.id,
        done: swimlanes.find((swimlane) => swimlane.role === 'done')?.id,
      };
    });
    const taskId = await page.evaluate(async (taskTitle) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((candidate) => candidate.title === taskTitle)?.id;
    }, title);
    expect(swimlaneIds.planning && swimlaneIds.done && taskId).toBeTruthy();

    // A first session, with a conversation id the recap will say expired.
    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: swimlaneId, targetPosition: 0 });
    }, { id: taskId!, swimlaneId: swimlaneIds.planning! });
    const { sessionId: firstSessionId } = await waitForTaskSession(page, taskId!);
    const conversationId = await readConversationId(page, taskId!);

    // Suspend it (Done keeps the session folder and archives the task).
    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: swimlaneId, targetPosition: 0 });
    }, { id: taskId!, swimlaneId: swimlaneIds.done! });
    await waitForTaskSessionNotRunning(page, taskId!, 15000);

    // What Claude's status line would have written: turns, and a transcript
    // under a projects folder that exists and holds no copy of it.
    const projectsRoot = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(path.join(projectsRoot, '-some-other-project'), { recursive: true });
    const sessionDir = path.join(tmpDir, '.kangentic', 'sessions', firstSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: conversationId,
      transcript_path: path.join(projectsRoot, '-deleted-project', `${conversationId}.jsonl`),
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      cost: { total_cost_usd: 1.25, total_duration_ms: 90000, total_api_duration_ms: 60000 },
      context_window: {
        total_input_tokens: 52000, total_output_tokens: 3100, context_window_size: 200000,
        current_usage: { input_tokens: 52000, output_tokens: 3100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        used_percentage: 27,
      },
    }));

    // Unarchive into Planning: a resume, which the check turns into a fresh
    // session opening on the recap.
    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { id: taskId!, swimlaneId: swimlaneIds.planning! });

    // A NEW session (never the suspended first one) whose own run received the
    // recap as its prompt. The new session's scrollback may open with the old
    // run's output (carried over on purpose), so what the new run did is read
    // from its own output only; the old run legitimately printed
    // MOCK_CLAUDE_SESSION:<old id>.
    const second = await waitForRecapSession(page, taskId!, firstSessionId);
    // Started fresh under its own conversation id, never a resume of the old one.
    const newConversationId = SESSION_ID_PATTERN.exec(second.ownRun)?.[1];
    expect(newConversationId).toBeTruthy();
    expect(newConversationId).not.toBe(conversationId);
    expect(second.flat).not.toContain(`MOCK_CLAUDE_RESUMED:${conversationId}`);
    expect(second.ownRun).not.toContain(`MOCK_CLAUDE_SESSION:${conversationId}`);
    // The recap points the new agent at the OLD conversation by its id.
    expect(promptPayload(second.ownRun)).toContain(flattenTerminalText(`passing sessionId ${conversationId}`));
  });

  test('decides from the session row once the session folder is gone, as after a quit', async () => {
    // A quit or a removal deletes the session folder. The path the agent
    // reported is kept on the session row as it arrives, and the token totals
    // when the session is suspended, so the check still has its evidence.
    test.slow();
    const title = `Expired Row ${runId}`;
    await createTask(page, title, 'Fix the logout redirect');

    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      return {
        planning: swimlanes.find((swimlane) => swimlane.name === 'Planning')?.id,
        done: swimlanes.find((swimlane) => swimlane.role === 'done')?.id,
      };
    });
    const taskId = await page.evaluate(async (taskTitle) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((candidate) => candidate.title === taskTitle)?.id;
    }, title);
    expect(swimlaneIds.planning && swimlaneIds.done && taskId).toBeTruthy();

    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: swimlaneId, targetPosition: 0 });
    }, { id: taskId!, swimlaneId: swimlaneIds.planning! });
    const { sessionId: firstSessionId } = await waitForTaskSession(page, taskId!);
    const conversationId = await readConversationId(page, taskId!);

    // The status line Claude would write while the session runs.
    const projectsRoot = path.join(tmpDir, 'claude-projects-row');
    fs.mkdirSync(path.join(projectsRoot, '-some-other-project'), { recursive: true });
    const reportedPath = path.join(projectsRoot, '-deleted-project', `${conversationId}.jsonl`);
    const sessionDir = path.join(tmpDir, '.kangentic', 'sessions', firstSessionId);
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: conversationId,
      transcript_path: reportedPath,
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      cost: { total_cost_usd: 0.8, total_duration_ms: 60000, total_api_duration_ms: 40000 },
      context_window: {
        total_input_tokens: 30000, total_output_tokens: 900, context_window_size: 200000,
        current_usage: { input_tokens: 30000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        used_percentage: 15,
      },
    }));
    // Main has read it: the usage it pushes carries the reported path.
    await expect.poll(
      async () => page.evaluate(async (sessionId) => {
        const usage = await window.electronAPI.sessions.getUsage() as Record<string, { transcriptPath?: string }>;
        return usage[sessionId]?.transcriptPath ?? null;
      }, firstSessionId),
      { timeout: 10_000, intervals: [100, 250, 500] },
    ).toBe(reportedPath);

    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: swimlaneId, targetPosition: 0 });
    }, { id: taskId!, swimlaneId: swimlaneIds.done! });
    await waitForTaskSessionNotRunning(page, taskId!, 15000);

    // What a quit does to the session's folder. Retried: on Windows a watcher
    // can still hold it for a moment after the suspend.
    fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { id: taskId!, swimlaneId: swimlaneIds.planning! });

    const second = await waitForRecapSession(page, taskId!, firstSessionId);
    const newConversationId = SESSION_ID_PATTERN.exec(second.ownRun)?.[1];
    expect(newConversationId).toBeTruthy();
    expect(newConversationId).not.toBe(conversationId);
    expect(second.flat).not.toContain(`MOCK_CLAUDE_RESUMED:${conversationId}`);
  });
});
