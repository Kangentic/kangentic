/**
 * Consolidated E2E coverage for the suspend/resume pipeline across every
 * agent that supports `--resume <id>`. Replaces four single-test specs
 * (codex/gemini/kimi/qwen) with one parameterised describe block sharing
 * one Electron launch.
 *
 * For each agent the flow is:
 *   1. Move a task into Planning -> mock prints `MOCK_<AGENT>_SESSION:<uuid>`.
 *   2. Move to Done -> session suspends.
 *   3. Unarchive back to Planning -> resume command passes the captured UUID
 *      to the mock, which echoes `MOCK_<AGENT>_RESUMED:<uuid>`.
 *   4. Assert the resumed UUID matches the original.
 *
 * Gemini and Qwen also assert that the merged `.<agent>/settings.json` file
 * was written into the project cwd by the hook manager - that's the hook
 * plumbing path real CLIs depend on.
 *
 * Qwen has one extra test: the fresh-spawn prompt delivery regression guard.
 * The command builder must emit `-i <prompt>` (interactive) rather than a
 * bare positional argument, otherwise the real CLI would exit immediately
 * in one-shot headless mode. The mock prints `MOCK_QWEN_PROMPT:<text>` only
 * when -i is used, so the assertion is a black-box check on the flag.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  cleanupKimiSessionsForCwd,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  setProjectDefaultAgent,
  waitForScrollback,
  waitForRunningSession,
  waitForNoRunningSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
  type AgentName,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'agent-session-resume';
const runId = Date.now();
const PROJECT_NAME = `Agent Resume Test ${runId}`;

interface ResumeCase {
  agent: AgentName;
  spawnMarker: string;
  resumeMarker: string;
  uuidPattern: RegExp;
  /**
   * Optional sanity check on hook plumbing - settings file must exist with
   * hooks. Default shape is a `hooks` wrapper key (Gemini/Qwen settings.json);
   * `namedHookKey` instead asserts a top-level named hook (Antigravity's
   * hooks.json maps hook names at the root).
   */
  expectSettingsFile?: { relative: string; namedHookKey?: string };
}

const CASES: ResumeCase[] = [
  {
    agent: 'codex',
    spawnMarker: 'MOCK_CODEX_SESSION:',
    resumeMarker: 'MOCK_CODEX_RESUMED:',
    uuidPattern: /MOCK_CODEX_(SESSION|RESUMED):([a-f0-9-]+)/,
  },
  {
    agent: 'gemini',
    spawnMarker: 'MOCK_GEMINI_SESSION:',
    resumeMarker: 'MOCK_GEMINI_RESUMED:',
    uuidPattern: /MOCK_GEMINI_(SESSION|RESUMED):([a-f0-9-]+)/,
    expectSettingsFile: { relative: path.join('.gemini', 'settings.json') },
  },
  {
    agent: 'kimi',
    spawnMarker: 'MOCK_KIMI_SESSION:',
    resumeMarker: 'MOCK_KIMI_RESUMED:',
    uuidPattern: /MOCK_KIMI_(SESSION|RESUMED):([a-f0-9-]+)/,
  },
  {
    agent: 'qwen',
    spawnMarker: 'MOCK_QWEN_SESSION:',
    resumeMarker: 'MOCK_QWEN_RESUMED:',
    uuidPattern: /MOCK_QWEN_(SESSION|RESUMED):([a-f0-9-]+)/,
    expectSettingsFile: { relative: path.join('.qwen', 'settings.json') },
  },
  {
    // Antigravity prints its conversation id ONLY in the graceful-shutdown
    // summary (`agy --conversation=<uuid>`), so this case exercises the
    // suspend-time fromOutput capture path rather than a boot-time header.
    agent: 'antigravity',
    spawnMarker: 'MOCK_AGY_SESSION:',
    resumeMarker: 'MOCK_AGY_RESUMED:',
    uuidPattern: /MOCK_AGY_(SESSION|RESUMED):([a-f0-9-]+)/,
    expectSettingsFile: { relative: path.join('.agents', 'hooks.json'), namedHookKey: 'kangentic-events' },
  },
];

function extractSessionId(
  scrollback: string,
  pattern: RegExp,
  marker: 'SESSION' | 'RESUMED',
): string | null {
  const re = new RegExp(pattern.source.replace(/\(SESSION\|RESUMED\)/, marker));
  const match = scrollback.match(re);
  return match ? match[1] : null;
}

test.describe('Agent suspend/resume pipeline', () => {
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
        agent: {
          cliPaths: {
            codex: mockAgentPath('codex'),
            gemini: mockAgentPath('gemini'),
            kimi: mockAgentPath('kimi'),
            qwen: mockAgentPath('qwen'),
            antigravity: mockAgentPath('antigravity'),
          },
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
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  for (const caseSpec of CASES) {
    test(`${caseSpec.agent}: moving Planning -> Done -> unarchive resumes with same session ID`, async () => {
      await setProjectDefaultAgent(page, caseSpec.agent);

      const taskTitle = `${caseSpec.agent} Resume ${runId}`;
      await createTask(page, taskTitle, `Suspend/resume parity for ${caseSpec.agent}`);

      const swimlaneIds = await getSwimlaneIds(page);
      const taskId = await getTaskIdByTitle(page, taskTitle);

      await moveTaskIpc(page, taskId, swimlaneIds.planning);
      await waitForRunningSession(page);

      const spawnScrollback = await waitForScrollback(page, caseSpec.spawnMarker);
      const originalSessionId = extractSessionId(spawnScrollback, caseSpec.uuidPattern, 'SESSION');
      expect(originalSessionId).toBeTruthy();

      // Hook-plumbing sanity for adapters that write merged settings files
      // into the project cwd. Without these, real CLIs would never fire
      // hooks even with the adapter wired correctly.
      if (caseSpec.expectSettingsFile) {
        const settingsPath = path.join(tmpDir, caseSpec.expectSettingsFile.relative);
        expect(fs.existsSync(settingsPath)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
        const hookValue = caseSpec.expectSettingsFile.namedHookKey
          ? parsed[caseSpec.expectSettingsFile.namedHookKey]
          : parsed.hooks;
        expect(hookValue).toBeTruthy();
      }

      await moveTaskIpc(page, taskId, swimlaneIds.done);
      await waitForNoRunningSession(page);

      // Wait until move-to-Done has committed AND the session-id was
      // persisted before unarchiving, so resume picks up the captured UUID.
      await expect.poll(async () => {
        return page.evaluate(async (id) => {
          const archived: Array<{ id: string }> =
            await window.electronAPI.tasks.listArchived();
          return archived.some((task) => task.id === id);
        }, taskId);
      }, { timeout: 15000, intervals: [200, 500, 1000] }).toBe(true);

      await page.evaluate(async ({ taskId: id, swimlaneId }) => {
        await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
      }, { taskId, swimlaneId: swimlaneIds.planning });

      await waitForRunningSession(page);
      const resumeScrollback = await waitForScrollback(page, caseSpec.resumeMarker);
      const resumedSessionId = extractSessionId(resumeScrollback, caseSpec.uuidPattern, 'RESUMED');
      expect(resumedSessionId).toBeTruthy();
      expect(resumedSessionId).toBe(originalSessionId);
    });
  }

  test('Qwen: fresh spawn with a description delivers -i <prompt> to the mock CLI', async () => {
    // Regression guard for the `-i <prompt>` flag (was once a bare
    // positional, which would trigger Qwen's headless one-shot mode).
    await setProjectDefaultAgent(page, 'qwen');

    const taskTitle = `Qwen Prompt Test ${runId}`;
    const promptText = 'Refactor the auth module';
    await createTask(page, taskTitle, promptText);

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, taskTitle);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    const scrollback = await waitForScrollback(page, 'MOCK_QWEN_PROMPT:');
    const markerIndex = scrollback.indexOf('MOCK_QWEN_PROMPT:');
    const afterMarker = scrollback.slice(markerIndex + 'MOCK_QWEN_PROMPT:'.length);
    const receivedPrompt = afterMarker.split(/[\r\n]/)[0];
    expect(receivedPrompt.length).toBeGreaterThan(0);
    expect(scrollback).toContain('MOCK_QWEN_SESSION:');
  });
});
