/**
 * E2E test for concurrent Kimi spawns sharing a single work_dir.
 *
 * Two Kangentic tasks pointing at the same project directory can spawn
 * `kimi` concurrently. Each spawn gets a unique caller-owned session UUID,
 * so the per-session directories `~/.kimi/sessions/<work_dir_hash>/<uuid_a>/`
 * and `<uuid_b>/` are isolated. But the parent `<work_dir_hash>/` directory
 * AND the global `~/.kimi/kimi.json` are shared across spawns.
 *
 * Kangentic's per-task lifecycle lock (withTaskLock) is keyed BY taskId
 * only. Two distinct tasks acquire separate PQueue instances, so their
 * spawn paths run in true wall-clock parallel - exposing any cross-task
 * race against shared Kimi state. There is intentionally NO global or
 * per-project spawn lock at the task-move handler layer.
 *
 * What this spec asserts (per iteration of N=5 to drive cumulative
 * race-hit probability up):
 *   - Two distinct PTY session UUIDs (no session-routing collision).
 *   - Two distinct agent_session_id UUIDs (extracted from
 *     MOCK_KIMI_SESSION:<uuid> scrollback markers).
 *   - Two independent wire.jsonl files with distinct paths AND content,
 *     each with its own `metadata` header line (per-session, not appended).
 *   - `~/.kimi/kimi.json` is parseable JSON with `Array.isArray(work_dirs)`
 *     after both spawns. This is the load-bearing race assertion.
 *
 * The mock kimi-cli is opted into a racy read-modify-write of kimi.json
 * via MOCK_KIMI_WRITE_KIMI_JSON=1 with a 75ms artificial read-write delay
 * (MOCK_KIMI_KIMI_JSON_DELAY_MS) so concurrent invocations interleave
 * deterministically. Kangentic itself never writes kimi.json - only Kimi
 * CLI does - so without this opt-in the assertion would be vacuous.
 *
 * Isolation strategy. Kangentic does NOT read kimi.json (only Kimi CLI
 * does), so the kimi.json race lives entirely between mock and test
 * assertions. The mock writes kimi.json to a test-scoped path via
 * MOCK_KIMI_KIMI_JSON_PATH so the developer's real ~/.kimi/kimi.json is
 * never touched. wire.jsonl still goes to the real ~/.kimi/sessions/<hash>/
 * (so Kangentic's wire-reader pipeline is genuinely exercised); the
 * existing cleanupKimiSessionsForCwd helper wipes that hash directory in
 * afterAll. Redirecting HOME/USERPROFILE for the entire Electron process
 * was tried first and crashed Chromium on Windows because Electron's
 * userData/cache/GPU subsystems consult home-derived paths that don't
 * exist in a synthesized fake home.
 *
 * Mitigation hierarchy if this spec ever fails:
 *   (1) Acknowledge as upstream Kimi CLI's responsibility; document min
 *       version in src/main/agent/adapters/kimi/kimi-adapter.ts.
 *   (2) RECOMMENDED: per-`work_dir_hash` advisory PQueue at the Kimi
 *       adapter spawn layer (mirroring WorktreeManager.projectQueues).
 *       Serializes Kimi spawns sharing a cwd; different cwds still run
 *       fully in parallel.
 *   (3) Cross-process file lock around kimi.json writes - only meaningful
 *       if multiple Kangentic processes share a HOME, which the
 *       single-instance lock prevents. Future work only.
 * This PR does NOT implement any mitigation; the spec is the detector.
 *
 * This spec relies on per-task-only locking. If a future PR adds a
 * project-wide spawn lock around task-move.ts:446, this spec silently
 * degrades to sequential spawns and the race detection becomes vacuous.
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
  getTaskIdByTitle,
  getSwimlaneIds,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

const TEST_NAME = 'kimi-concurrent-spawns';
const runId = Date.now();
const PROJECT_NAME = `Kimi Concurrent ${runId}`;
const ITERATIONS = 5;

test.describe('Kimi Agent - Concurrent Spawns Same Work Dir', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;
  let kimiJsonPath: string;
  let kimiSessionsRoot: string;
  let swimlanePlanningId: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);

    // kimi.json: isolated test-scoped path so we never touch the user's
    // real ~/.kimi/kimi.json. Pre-seeded with an empty work_dirs array so
    // the mock's read-modify-write has a valid starting point.
    kimiJsonPath = path.join(dataDir, 'kimi.json');
    fs.writeFileSync(kimiJsonPath, JSON.stringify({ work_dirs: [] }));

    // wire.jsonl still lives under the real ~/.kimi/sessions/<hash>/ so
    // Kangentic's wire-reader pipeline (session-history-parser.ts uses
    // os.homedir()) is genuinely exercised end-to-end. Cleaned by
    // cleanupKimiSessionsForCwd in afterAll.
    kimiSessionsRoot = path.join(os.homedir(), '.kimi', 'sessions');

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
      extraEnv: {
        MOCK_KIMI_WRITE_KIMI_JSON: '1',
        MOCK_KIMI_KIMI_JSON_PATH: kimiJsonPath,
        MOCK_KIMI_KIMI_JSON_DELAY_MS: '75',
      },
    });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');

    const swimlaneIds = await getSwimlaneIds(page);
    swimlanePlanningId = swimlaneIds.planning;
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('two tasks moved concurrently to Planning each get a distinct session and leave kimi.json parseable', async () => {
    const workDirHash = createHash('md5').update(path.resolve(tmpDir)).digest('hex');

    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const titleA = `Concurrent A ${runId}-${iteration}`;
      const titleB = `Concurrent B ${runId}-${iteration}`;

      await createTask(page, titleA, 'Same-cwd concurrent spawn race');
      await createTask(page, titleB, 'Same-cwd concurrent spawn race');

      const taskIdA = await getTaskIdByTitle(page, titleA);
      const taskIdB = await getTaskIdByTitle(page, titleB);

      // Fire both moves from a SINGLE page.evaluate so the renderer dispatches
      // both IPC calls in parallel. With per-task-only locking in the main
      // process, the two task-move handlers run in true wall-clock parallel.
      // The page.evaluate body executes in the renderer with no closure over
      // outer scope, so the inner parameter names are independent of the
      // Node-side bindings declared above.
      await page.evaluate(async (payload) => {
        await Promise.all([
          window.electronAPI.tasks.move({ taskId: payload.taskIdA, targetSwimlaneId: payload.swimlaneId, targetPosition: 0 }),
          window.electronAPI.tasks.move({ taskId: payload.taskIdB, targetSwimlaneId: payload.swimlaneId, targetPosition: 0 }),
        ]);
      }, { taskIdA, taskIdB, swimlaneId: swimlanePlanningId });

      // Poll for both tasks' sessions to be running AND have output the
      // MOCK_KIMI_SESSION marker. The "running" status fires when the PTY
      // spawns, BEFORE the mock has flushed its banner; the 75ms kimi.json
      // delay further pushes the banner out, so we must wait for the marker
      // rather than just status.
      const targetTaskIds = [taskIdA, taskIdB];
      const pollDeadline = Date.now() + 30000;
      let sessionData: Array<{ id: string; taskId: string; cwd: string; scrollback: string }> = [];
      while (Date.now() < pollDeadline) {
        sessionData = await page.evaluate(async (taskIds: string[]) => {
          const sessions = (await window.electronAPI.sessions.list())
            .filter((session) => session.status === 'running' && taskIds.includes(session.taskId));
          return Promise.all(sessions.map(async (session) => ({
            id: session.id,
            taskId: session.taskId,
            cwd: session.cwd,
            scrollback: await window.electronAPI.sessions.getScrollback(session.id),
          })));
        }, targetTaskIds);
        const ready = sessionData.length === 2
          && sessionData.every((entry) => /MOCK_KIMI_SESSION:[a-f0-9-]+/.test(entry.scrollback));
        if (ready) break;
        await page.waitForTimeout(250);
      }
      expect(sessionData.length, `iteration ${iteration}: expected 2 running sessions, got ${sessionData.length}`).toBe(2);

      // Stable ordering by taskId so iteration logs are reproducible.
      sessionData.sort((a, b) => a.taskId.localeCompare(b.taskId));

      // A. Two running sessions exist.
      expect(sessionData.length).toBe(2);

      // B. PTY session UUIDs are distinct.
      expect(sessionData[0].id).not.toBe(sessionData[1].id);

      // C. Both sessions share the same cwd (worktreesEnabled: false).
      expect(sessionData[0].cwd).toBe(sessionData[1].cwd);

      // D. Each scrollback contains exactly one MOCK_KIMI_SESSION:<uuid> marker.
      const matchA = sessionData[0].scrollback.match(/MOCK_KIMI_SESSION:([a-f0-9-]+)/);
      const matchB = sessionData[1].scrollback.match(/MOCK_KIMI_SESSION:([a-f0-9-]+)/);
      expect(matchA, `iteration ${iteration}: session A scrollback missing MOCK_KIMI_SESSION marker`).toBeTruthy();
      expect(matchB, `iteration ${iteration}: session B scrollback missing MOCK_KIMI_SESSION marker`).toBeTruthy();
      const agentSessionIdA = matchA![1];
      const agentSessionIdB = matchB![1];

      // E. Agent session UUIDs are distinct.
      expect(agentSessionIdA).not.toBe(agentSessionIdB);

      // F. Each agent_session_id has its own wire.jsonl on disk.
      const wirePathA = path.join(kimiSessionsRoot, workDirHash, agentSessionIdA, 'wire.jsonl');
      const wirePathB = path.join(kimiSessionsRoot, workDirHash, agentSessionIdB, 'wire.jsonl');
      expect(fs.existsSync(wirePathA), `iteration ${iteration}: ${wirePathA} missing`).toBe(true);
      expect(fs.existsSync(wirePathB), `iteration ${iteration}: ${wirePathB} missing`).toBe(true);

      // G. wire.jsonl files are independent (paths differ AND content differs).
      expect(wirePathA).not.toBe(wirePathB);
      const wireContentA = fs.readFileSync(wirePathA, 'utf-8');
      const wireContentB = fs.readFileSync(wirePathB, 'utf-8');
      expect(wireContentA).not.toBe(wireContentB);

      // H. Each wire.jsonl first line is a metadata header (per-session, not appended).
      const firstLineA = wireContentA.split('\n')[0];
      const firstLineB = wireContentB.split('\n')[0];
      const headerA = JSON.parse(firstLineA);
      const headerB = JSON.parse(firstLineB);
      expect(headerA.type).toBe('metadata');
      expect(headerB.type).toBe('metadata');

      // I. kimi.json is parseable JSON with Array.isArray(work_dirs).
      // This is the load-bearing race assertion.
      const kimiJsonRaw = fs.readFileSync(kimiJsonPath, 'utf-8');
      let kimiJsonParsed: { work_dirs?: unknown };
      expect(
        () => { kimiJsonParsed = JSON.parse(kimiJsonRaw); },
        `iteration ${iteration}: kimi.json corrupted (unparseable):\n${kimiJsonRaw}`,
      ).not.toThrow();
      expect(Array.isArray(kimiJsonParsed!.work_dirs)).toBe(true);

      // J. kimi.json contains an entry for tmpDir. last_session_id may match
      // either spawn (race-dependent); that's expected and not asserted on.
      const workDirs = (kimiJsonParsed!.work_dirs as Array<{ path?: string; last_session_id?: string }>);
      const tmpDirEntry = workDirs.find((entry) => entry && entry.path === path.resolve(tmpDir));
      expect(tmpDirEntry, `iteration ${iteration}: kimi.json missing entry for tmpDir`).toBeTruthy();

      // Per-iteration cleanup: kill both running sessions, wait for drain.
      await page.evaluate(async (sessionIds) => {
        await Promise.all(sessionIds.map((sessionId) => window.electronAPI.sessions.kill(sessionId)));
      }, sessionData.map((session) => session.id));

      await page.waitForFunction(
        async (targetTaskIds) => {
          const sessions = await window.electronAPI.sessions.list();
          return !sessions.some((session) =>
            session.status === 'running' && targetTaskIds.includes(session.taskId),
          );
        },
        [taskIdA, taskIdB],
        { timeout: 15000 },
      );
    }
  });
});
