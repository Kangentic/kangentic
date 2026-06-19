/**
 * Consolidated E2E coverage for the session-ID capture pipeline across every
 * agent that supports it. Replaces five single-test specs (codex/droid/gemini/
 * kimi/opencode) with two parameterised describe blocks, each sharing one
 * Electron launch.
 *
 * Each agent's capture path is exercised end-to-end via suspend/resume:
 *   capture path -> notifyAgentSessionId -> DB update -> resume command
 *
 * Per-agent capture path:
 *   - codex:     fromFilesystem (planted rollout JSONL with known UUID)
 *   - droid:     fromFilesystem (mock writes ~/.factory/sessions/<slug>/<uuid>.jsonl)
 *   - gemini:    fromHook       (planted SessionStart event with known UUID)
 *   - kimi:      fromOutput     ("Session: <uuid>" banner regex)
 *   - kimi-fs:   fromFilesystem (mtime-windowed scan of ~/.kimi/sessions/<hash>)
 *   - opencode:  fromOutput     ("session id: ses_..." regex)
 *
 * Layout:
 *   Describe 1 launches Electron with codex/gemini suppressors set in env so
 *     those mocks skip their default capture surfaces (header/rollout/session
 *     file) and the test exercises the alternate capture pipeline.
 *   Describe 2 launches a second Electron with MOCK_KIMI_NO_BANNER=1 so the
 *     PTY anchor never fires for the filesystem-fallback case (one of the
 *     two paths kimi supports).
 *
 * Suppressor env vars are agent-prefixed (MOCK_CODEX_*, MOCK_GEMINI_*) and
 * have no effect on the other mock binaries, so it is safe to set them
 * globally for the first describe.
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
  waitForTaskSessionNotRunning,
  waitForAgentSessionId,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  type AgentName,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Session } from '../../src/shared/types';
import type { GeminiHookEntry } from '../../src/main/agent/adapters/gemini/hook-manager';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// The two describe blocks each launch an isolated Electron app with unique
// TEST_NAMEs ('agent-session-id-capture', 'kimi-fs-capture'). Describe 1
// passes suppressor env vars into the Electron process (MOCK_CODEX_NO_HEADER
// etc.) via launchApp({ extraEnv }), so the env mutation is contained inside
// the spawned Electron process, not in process.env. Running the blocks in
// parallel shaves the sequential second-launch overhead on whichever shard
// this file lands.
test.describe.configure({ mode: 'parallel' });

const runId = Date.now();

// UUIDs that the Codex / Gemini cases plant explicitly. Mock binaries echo
// whatever the resume command passes them, so a planted UUID is the truth
// value the test asserts against.
const KNOWN_CODEX_UUID = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
const KNOWN_GEMINI_UUID = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
const MOCK_OPENCODE_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';

// --- Per-agent helpers (file/hook plant routines) --------------------------

function codexSessionsDirForToday(): string {
  const iso = new Date().toISOString();
  return path.join(os.homedir(), '.codex', 'sessions', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
}

function writeCodexRolloutFile(cwd: string): string {
  const directory = codexSessionsDirForToday();
  fs.mkdirSync(directory, { recursive: true });
  const isoTimestamp = new Date().toISOString();
  const fileName = `rollout-${isoTimestamp.replace(/[:.]/g, '-').replace('Z', '')}-${KNOWN_CODEX_UUID}.jsonl`;
  const filepath = path.join(directory, fileName);
  fs.writeFileSync(filepath, JSON.stringify({
    timestamp: isoTimestamp,
    type: 'session_meta',
    payload: { id: KNOWN_CODEX_UUID, cli_version: '0.118.0', cwd, timestamp: isoTimestamp },
  }) + '\n');
  return filepath;
}

interface GeminiSettingsFile { hooks?: Record<string, GeminiHookEntry[]>; }

function findGeminiEventsOutputPath(projectDir: string): string | null {
  const settingsPath = path.join(projectDir, '.gemini', 'settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as GeminiSettingsFile;
  if (!settings?.hooks) return null;
  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        const match = hook.command.match(/["']([^"']+events\.jsonl)["']/);
        if (match) return match[1].replace(/\//g, path.sep);
      }
    }
  }
  return null;
}

function injectGeminiSessionStart(eventsPath: string, sessionId: string): void {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(eventsPath, JSON.stringify({
    ts: Date.now(),
    type: 'session_start',
    hookContext: JSON.stringify({ session_id: sessionId }),
  }) + '\n');
}

// --- Shared test runner ----------------------------------------------------

interface CaptureCase {
  /** Adapter name, also drives the project default agent. */
  agent: AgentName;
  /** Marker the mock prints once on spawn (used to confirm the PTY came up). */
  spawnMarker: string;
  /** Marker the mock prints once on resume; carries the resumed UUID. */
  resumeMarker: string;
  /** Regex pattern that extracts a UUID from the resume marker line. */
  uuidPattern: RegExp;
  /**
   * Per-agent capture-time work after spawn, before suspend. Plants files,
   * injects hook events, or extracts a session marker. Returns the UUID
   * the resume command MUST pass back. Receives the spawn-time scrollback
   * so agents that capture from PTY output can extract the truth UUID.
   */
  resolveExpectedUuid(ctx: {
    tmpDir: string;
    spawnScrollback: string;
    page: Page;
  }): Promise<string> | string;
  /** Best-effort cleanup of any planted files. */
  cleanup?(tmpDir: string): void;
}

async function runCaptureCase(
  page: Page,
  tmpDir: string,
  captureCase: CaptureCase,
  taskTitle: string,
): Promise<void> {
  await setProjectDefaultAgent(page, captureCase.agent);

  await createTask(page, taskTitle, `Capture pipeline for ${captureCase.agent}`);
  const swimlaneIds = await getSwimlaneIds(page);
  const taskId = await getTaskIdByTitle(page, taskTitle);

  await moveTaskIpc(page, taskId, swimlaneIds.planning);
  await waitForRunningSession(page);
  const spawnScrollback = await waitForScrollback(page, captureCase.spawnMarker);

  const expectedUuid = await captureCase.resolveExpectedUuid({
    tmpDir,
    spawnScrollback,
    page,
  });

  // Conditional wait (replaces fixed post-plant sleeps): block until the
  // capture pipeline has round-tripped the expected ID onto the live session.
  // This is exactly the precondition the suspend->resume below depends on, so
  // waiting for it directly removes both the flake and the wasted fixed delay.
  await waitForAgentSessionId(page, taskId, expectedUuid);

  await moveTaskIpc(page, taskId, swimlaneIds.done);
  // Scope the suspend-completion wait to THIS task so the assertion is not
  // coupled to other cases' still-alive keep-alive mocks in the shared run.
  await waitForTaskSessionNotRunning(page, taskId);

  await page.evaluate(async ({ taskId: id, swimlaneId }) => {
    await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
  }, { taskId, swimlaneId: swimlaneIds.planning });

  await waitForRunningSession(page);
  // Poll on the full UUID regex against this task's session only. Polling on
  // the regex (not the bare marker) avoids the race where the marker prefix
  // lands in scrollback before the rest of the line flushes. Scoping to the
  // task's session avoids cross-test contamination from earlier agents'
  // resume markers in the same shared Electron run.
  let resumedMatch: RegExpMatchArray | null = null;
  await expect.poll(async () => {
    const scrollback = await page.evaluate(async (id) => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      const session = sessions.find((candidate) => candidate.taskId === id);
      if (!session) return '';
      return window.electronAPI.sessions.getScrollback(session.id);
    }, taskId);
    resumedMatch = scrollback.match(captureCase.uuidPattern);
    return resumedMatch !== null;
  }, {
    timeout: 15000,
    intervals: [200, 500, 1000],
    message: `Expected ${captureCase.resumeMarker} with extractable UUID for ${captureCase.agent}`,
  }).toBe(true);

  expect(resumedMatch).toBeTruthy();
  expect(resumedMatch![1]).toBe(expectedUuid);

  // Tear down the resumed keep-alive mock before the next case runs. Each mock
  // stays alive ~30s; without this, resumed PTYs accumulate across cases and
  // can approach maxConcurrentSessions, and leave a running session that would
  // confuse a later global wait. Move back to Done and wait (scoped) for it to
  // suspend.
  await moveTaskIpc(page, taskId, swimlaneIds.done);
  await waitForTaskSessionNotRunning(page, taskId);

  captureCase.cleanup?.(tmpDir);
}

// --- Describe 1: codex / droid / gemini / kimi-banner / opencode -----------

test.describe('Agent session-ID capture pipeline', () => {
  const TEST_NAME = 'agent-session-id-capture';
  const PROJECT_NAME = `Agent Capture Test ${runId}`;

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
            droid: mockAgentPath('droid'),
            gemini: mockAgentPath('gemini'),
            kimi: mockAgentPath('kimi'),
            opencode: mockAgentPath('opencode'),
          },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );
    const result = await launchApp({
      dataDir,
      // Codex/Gemini suppressors are agent-prefixed so they have no effect
      // on the droid/kimi/opencode mocks in the same Electron run.
      extraEnv: {
        MOCK_CODEX_NO_HEADER: '1',
        MOCK_CODEX_NO_ROLLOUT: '1',
        MOCK_GEMINI_NO_HEADER: '1',
        MOCK_GEMINI_NO_SESSION_FILE: '1',
      },
    });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('Codex: planted rollout JSONL is captured and used on resume', async () => {
    let plantedPath: string | null = null;
    await runCaptureCase(page, tmpDir, {
      agent: 'codex',
      spawnMarker: 'MOCK_CODEX_SESSION:',
      resumeMarker: 'MOCK_CODEX_RESUMED:',
      uuidPattern: /MOCK_CODEX_RESUMED:([a-f0-9-]+)/,
      resolveExpectedUuid: ({ tmpDir }) => {
        plantedPath = writeCodexRolloutFile(tmpDir);
        return KNOWN_CODEX_UUID;
      },
      cleanup: () => {
        if (plantedPath) {
          try { fs.unlinkSync(plantedPath); } catch { /* ignore */ }
        }
      },
    }, `Codex Capture ${runId}`);
  });

  test('Droid: filesystem scanner picks up the session ID for resume', async () => {
    await runCaptureCase(page, tmpDir, {
      agent: 'droid',
      spawnMarker: 'MOCK_DROID_SESSION:',
      resumeMarker: 'MOCK_DROID_RESUMED:',
      uuidPattern: /MOCK_DROID_RESUMED:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      resolveExpectedUuid: ({ spawnScrollback }) => {
        const match = spawnScrollback.match(
          /MOCK_DROID_SESSION:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        if (!match) throw new Error('mock-droid did not emit a session UUID marker');
        return match[1];
      },
    }, `Droid Capture ${runId}`);
  });

  test('Gemini: hook-injected SessionStart UUID flows through to resume', async () => {
    await runCaptureCase(page, tmpDir, {
      agent: 'gemini',
      spawnMarker: 'MOCK_GEMINI_SESSION:',
      resumeMarker: 'MOCK_GEMINI_RESUMED:',
      uuidPattern: /MOCK_GEMINI_RESUMED:([a-f0-9-]+)/,
      resolveExpectedUuid: ({ tmpDir }) => {
        const eventsPath = findGeminiEventsOutputPath(tmpDir);
        if (!eventsPath) throw new Error('Gemini settings missing events.jsonl hook path');
        injectGeminiSessionStart(eventsPath, KNOWN_GEMINI_UUID);
        return KNOWN_GEMINI_UUID;
      },
    }, `Gemini Capture ${runId}`);
  });

  test('Kimi: PTY banner UUID flows through to resume', async () => {
    await runCaptureCase(page, tmpDir, {
      agent: 'kimi',
      spawnMarker: 'MOCK_KIMI_SESSION:',
      resumeMarker: 'MOCK_KIMI_RESUMED:',
      uuidPattern: /MOCK_KIMI_RESUMED:([a-f0-9-]+)/,
      resolveExpectedUuid: ({ spawnScrollback }) => {
        const match = spawnScrollback.match(/MOCK_KIMI_SESSION:([a-f0-9-]+)/);
        if (!match) throw new Error('mock-kimi did not emit a session marker');
        return match[1];
      },
    }, `Kimi Banner Capture ${runId}`);
  });

  test('OpenCode: PTY-emitted session ID is captured and used on resume', async () => {
    await runCaptureCase(page, tmpDir, {
      agent: 'opencode',
      spawnMarker: 'MOCK_OPENCODE_SESSION:' + MOCK_OPENCODE_SESSION_ID,
      resumeMarker: 'MOCK_OPENCODE_RESUMED:',
      uuidPattern: /MOCK_OPENCODE_RESUMED:(ses_[A-Za-z0-9_-]+)/,
      resolveExpectedUuid: () => MOCK_OPENCODE_SESSION_ID,
    }, `OpenCode Capture ${runId}`);
  });
});

// --- Describe 2: kimi filesystem fallback (banner suppressed) --------------

test.describe('Kimi filesystem fallback session-ID capture', () => {
  const TEST_NAME = 'kimi-fs-capture';
  const PROJECT_NAME = `Kimi FS Capture Test ${runId}`;

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
          cliPaths: { kimi: mockAgentPath('kimi') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );
    const result = await launchApp({
      dataDir,
      extraEnv: { MOCK_KIMI_NO_BANNER: '1' },
    });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('filesystem fallback captures session UUID when banner is suppressed', async () => {
    await runCaptureCase(page, tmpDir, {
      agent: 'kimi',
      spawnMarker: 'MOCK_KIMI_SESSION:',
      resumeMarker: 'MOCK_KIMI_RESUMED:',
      uuidPattern: /MOCK_KIMI_RESUMED:([a-f0-9-]+)/,
      resolveExpectedUuid: ({ spawnScrollback }) => {
        const match = spawnScrollback.match(/MOCK_KIMI_SESSION:([a-f0-9-]+)/);
        if (!match) throw new Error('mock-kimi did not emit a session marker');
        return match[1];
      },
    }, `Kimi FS Capture ${runId}`);
  });
});
