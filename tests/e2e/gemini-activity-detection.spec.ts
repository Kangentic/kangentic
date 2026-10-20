/**
 * E2E test for Gemini activity detection.
 *
 * Gemini uses `ActivityDetection.hooksAndPty()` -- hooks are the primary
 * signal (delivered via `.gemini/settings.json` BeforeTool/AfterAgent
 * hooks) with PTY silence as a fallback. This spec verifies, in a single
 * self-contained test, that:
 *  - The merged `.gemini/settings.json` is written with Kangentic
 *    event-bridge hooks that name the session's events.jsonl through the
 *    `KANGENTIC_EVENTS_PATH` environment variable
 *  - Writing a tool_start event to that file transitions activity to
 *    'thinking' (hook primary path)
 *  - Writing an idle event transitions back to 'idle'
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
  setProjectDefaultAgent,
  waitForScrollback,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState } from '../../src/shared/types';
import type { GeminiHookEntry } from '../../src/main/agent/adapters/gemini/hook-manager';

const TEST_NAME = 'gemini-activity-detection';
const runId = Date.now();
const PROJECT_NAME = `Gemini Activity Test ${runId}`;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

interface GeminiSettingsFile {
  hooks?: Record<string, GeminiHookEntry[]>;
}

/** Read the merged Gemini settings written into the project cwd. */
function readGeminiSettings(): GeminiSettingsFile | null {
  const settingsPath = path.join(tmpDir, '.gemini', 'settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as GeminiSettingsFile;
}

/**
 * The session's events.jsonl. The folder-shared settings file names no
 * session's path (task #859): its hook commands say `env:KANGENTIC_EVENTS_PATH`
 * and each session spawn sets that variable, so the file is found under
 * `<project>/.kangentic/sessions/<id>/`, the newest one.
 */
function findEventsOutputPath(): string | null {
  const sessionsDir = path.join(tmpDir, '.kangentic', 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  const candidates = fs.readdirSync(sessionsDir)
    .map((sessionId) => path.join(sessionsDir, sessionId, 'events.jsonl'))
    .filter((eventsPath) => fs.existsSync(eventsPath))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

/** Every event-bridge hook command in the merged settings names the events file through the environment. */
function hookCommandsUseEnvironmentEventsPath(settings: GeminiSettingsFile): boolean {
  const commands = Object.values(settings.hooks ?? {})
    .flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)))
    .filter((command) => command.includes('event-bridge') && !command.includes('background-shell-hint-bridge'));
  return commands.length > 0 && commands.every((command) => command.includes('env:KANGENTIC_EVENTS_PATH'));
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      agent: {
        cliPaths: { gemini: mockAgentPath('gemini') },
        permissionMode: 'acceptEdits',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
  await setProjectDefaultAgent(page, 'gemini');
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
  cleanupTestDataDir(TEST_NAME);
});

test.describe('Gemini Agent -- Activity Detection (hooks + PTY)', () => {
  test('hooks plumbing drives thinking -> idle activity transitions', async () => {
    const title = `Gemini Activity ${runId}`;
    await createTask(page, title, 'Verify hook-driven activity transitions');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_GEMINI_SESSION:');

    // Verify the merged settings file was written, its hooks route events
    // through the session environment, and the session's events.jsonl exists
    // inside .kangentic/sessions/<id>/.
    const settings = readGeminiSettings();
    expect(settings).toBeTruthy();
    expect(settings!.hooks).toBeTruthy();
    expect(hookCommandsUseEnvironmentEventsPath(settings!)).toBe(true);

    const eventsPath = findEventsOutputPath();
    expect(eventsPath).toBeTruthy();
    expect(eventsPath!).toMatch(/\.kangentic[/\\]sessions[/\\].*events\.jsonl/);

    // Hook primary path: write a tool_start event into the events file
    // (simulating a Gemini BeforeTool hook firing) and assert the activity
    // map transitions to 'thinking'.
    fs.mkdirSync(path.dirname(eventsPath!), { recursive: true });
    fs.appendFileSync(eventsPath!, JSON.stringify({
      ts: Date.now(),
      type: 'tool_start',
      tool: 'Read',
    }) + '\n');

    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 5000 }).toContain('thinking');

    // Now write an idle event (simulating Gemini AfterAgent hook) and
    // verify the activity transitions back to 'idle'.
    fs.appendFileSync(eventsPath!, JSON.stringify({
      ts: Date.now(),
      type: 'idle',
    }) + '\n');

    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 5000 }).toContain('idle');
  });
});
