/**
 * E2E guard for the task process reap: a process an agent detached outlives its
 * session, survives a mid-board suspend, and dies when the task reaches Done.
 *
 * Every task session PTY is spawned with KANGENTIC_TASK_ID=<taskId>, and every
 * process the agent starts inherits it. A TERMINAL transition (Done, To Do,
 * Backlog demote, delete) asks the pty host to kill every process carrying the
 * task's tag, after the session has exited. A mid-board suspend (a move into a
 * column with auto_spawn off, or Pause) deliberately does NOT reap: the process
 * keeps running and is reaped at the later terminal transition.
 *
 * Why this is an E2E and not a unit test. The pieces each have unit tests (the
 * reap plan, the per-platform readers, the tag helper). What nothing else proves
 * is the wiring between them, with real processes: the tag reaches the PTY's
 * environment, an orphan with no live parent still carries it, the host's scan
 * finds it, and Kangentic's own-process-tree protection does not swallow it. A
 * rename of the env var, a dropped reap call in the Done branch, or a protected
 * set that is too wide passes every unit test and fails here.
 *
 * Fixture. mock-claude.js, gated by MOCK_CLAUDE_FAST_DETACH_RESULT_FILE, starts
 * tests/fixtures/detached-survivor-launcher.js on its first fresh start. The
 * launcher spawns a long-lived node process (detached: true, stdio ignored) and
 * exits at once, so the survivor has no live parent: on POSIX it is re-parented
 * to init, on Windows its ppid names a dead process. The launcher hands the pids
 * back through the result file as JSON, written atomically:
 *   { agentPid, launcherPid, survivorPid, tag }
 * `tag` is the KANGENTIC_TASK_ID the launcher saw, so a missing tag fails with
 * its own message instead of a generic "still alive" at the end.
 *
 * Worktrees are on, as they are by default, so the agent and the survivor work
 * in the task's worktree. That is the case the reap exists for: a leftover
 * holding the worktree as its cwd is what made the Done removal fail on Windows.
 *
 * Flow:
 *   1. To Do -> Executing creates the worktree and spawns the agent, which
 *      fast-detaches the survivor.
 *   2. Executing -> a column with auto_spawn off suspends the session. The agent
 *      process is gone and the survivor is STILL alive (the keep-running decision).
 *   3. Back to Executing resumes the session. The survivor is still alive.
 *   4. Executing -> Done. The survivor dies, and the worktree is removed after
 *      it. The death is the assertion that proves the reap; it is never weakened
 *      to "eventually" without a bound.
 *
 * Red-green. The spec was shown to fail when the survivor is started with
 * KANGENTIC_TASK_ID deleted from its environment (the documented opt-out): the
 * survivor then stays alive through Done and step 4 fails.
 *
 * Running locally:
 *   npm run build
 *   npx playwright test tests/e2e/task-process-reap.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  mockAgentPath,
  getTaskIdByTitle,
  isProcessAlive,
  readLinuxProcessStat,
  moveTaskIpc,
  waitForTaskSession,
  waitForTaskSessionNotRunning,
} from './helpers';

const TEST_NAME = 'task-process-reap';
const runId = Date.now();
const PARKING_COLUMN_NAME = 'Parking';
/**
 * How long the survivor must stay alive after a suspend or a resume. A reap is
 * a scan, a graceful kill, a one second wait and a second scan, so a wrongly
 * wired one finishes well inside this.
 */
const SURVIVOR_HOLD_WINDOW_MS = 3_000;
const SURVIVOR_SAMPLE_INTERVAL_MS = 250;

interface FastDetachRecord {
  agentPid: number;
  launcherPid: number;
  survivorPid: number;
  tag: string | null;
}

interface LaneIds {
  executing: string;
  done: string;
  parking: string;
}

test.describe('Task process reap', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;
  let resultFile: string;
  let lanes: LaneIds;
  let survivorPid: number | null = null;
  /** Linux only: the survivor's start time when its record arrived, so cleanup can tell it from a process that reused its pid. */
  let survivorStartTicks: string | null = null;
  let survivorKnownDead = false;
  const mainProcessLines: string[] = [];

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    // Outside the project, so nothing the fixture writes dirties the temp repo.
    resultFile = path.join(dataDir, 'fast-detach-result.json');

    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        claude: {
          cliPath: mockAgentPath('claude'),
          permissionMode: 'default',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: true },
      }),
    );

    const result = await launchApp({
      dataDir,
      extraEnv: { MOCK_CLAUDE_FAST_DETACH_RESULT_FILE: resultFile },
    });
    app = result.app;
    page = result.page;
    await createProject(page, `Task Process Reap ${runId}`, tmpDir);

    // Diagnostics for a failed run: the reap and move lines main prints. The pty
    // host's own output is not piped to main, so a successful kill is proven by
    // the process being gone, not by a log line.
    try {
      const collectLines = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
          if (line.includes('[TASK-REAP]') || line.includes('[TASK_MOVE]')) mainProcessLines.push(line);
        }
      };
      app.process().stdout?.on('data', collectLines);
      app.process().stderr?.on('data', collectLines);
    } catch {
      // Diagnostics only. A missing process handle must not fail the spec.
    }

    // No default mid-board column has auto_spawn off (only To Do and Done do, and
    // both are role columns with their own terminal behavior), so make one. Read it
    // back: a create that silently kept auto_spawn on would turn the suspend step
    // into a keep-alive and pin nothing.
    lanes = await page.evaluate(async (parkingName) => {
      const parking = await window.electronAPI.swimlanes.create({ name: parkingName, auto_spawn: false });
      const swimlanes = await window.electronAPI.swimlanes.list();
      const executing = swimlanes.find((swimlane) => swimlane.name === 'Executing');
      const done = swimlanes.find((swimlane) => swimlane.role === 'done');
      const parkingRow = swimlanes.find((swimlane) => swimlane.id === parking.id);
      if (!executing || !done || !parkingRow) throw new Error('Board is missing Executing, Done, or the new parking column');
      if (parkingRow.auto_spawn !== false) throw new Error('The parking column kept auto_spawn on');
      return { executing: executing.id, done: done.id, parking: parkingRow.id };
    }, PARKING_COLUMN_NAME);
  });

  test.beforeEach(() => {
    survivorPid = null;
    survivorStartTicks = null;
    survivorKnownDead = false;
    // afterEach may read this file for a pid; only this test's record may be there.
    fs.rmSync(resultFile, { force: true });
  });

  test.afterEach(() => {
    // A run that failed before reading the fixture's record never learned the
    // survivor's pid; read it once more so that survivor is killed too.
    if (survivorPid === null) {
      try {
        const record = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as Partial<FastDetachRecord>;
        if (typeof record.survivorPid === 'number' && Number.isInteger(record.survivorPid)) survivorPid = record.survivorPid;
      } catch {
        // Never written: there is no survivor to kill.
      }
    }
    // A failed run can leave the survivor alive. Kill only a pid this test saw alive
    // and never saw die, so a recycled pid is never signalled. A survivor reaped
    // before the test failed was never seen dying, so on Linux the start time read
    // when its record arrived must still match as well. The launcher and the agent
    // pids are deliberately not touched: both are long dead by now and a recycled
    // pid would name an unrelated process.
    if (survivorPid !== null && !survivorKnownDead && isProcessAlive(survivorPid) && stillTheSurvivor(survivorPid)) {
      try {
        process.kill(survivorPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    try {
      fs.rmSync(resultFile, { force: true });
    } catch {
      // Best effort.
    }
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  /** Poll the fixture's result file until it holds a complete record. */
  async function waitForFastDetachRecord(): Promise<FastDetachRecord> {
    let record: FastDetachRecord | null = null;
    await expect
      .poll(
        () => {
          try {
            const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as FastDetachRecord;
            if (Number.isInteger(parsed.survivorPid) && parsed.survivorPid > 0) {
              record = parsed;
              return true;
            }
          } catch {
            // Not written yet, or the fixture could not start a survivor.
          }
          return false;
        },
        {
          timeout: 15_000,
          intervals: [100, 250, 500],
          message: `The agent never reported a detached survivor in ${resultFile} (mock-claude fast-detach branch did not run, or the launcher failed).`,
        },
      )
      .toBe(true);
    return record as unknown as FastDetachRecord;
  }

  /** The task's row, active or archived. */
  async function taskRow(taskId: string): Promise<{ worktree_path: string | null; archived_at: string | null } | null> {
    return page.evaluate(async (id) => {
      const active = await window.electronAPI.tasks.list();
      const archived = await window.electronAPI.tasks.listArchived();
      return [...active, ...archived].find((task) => task.id === id) ?? null;
    }, taskId);
  }

  /**
   * Whether `pid` still has the start time the survivor had when its record
   * arrived. True where there is no reading to compare: off Linux, or when the
   * pid came from the record file after a failure.
   */
  function stillTheSurvivor(pid: number): boolean {
    if (process.platform !== 'linux' || survivorStartTicks === null) return true;
    return readLinuxProcessStat(pid)?.startTicks === survivorStartTicks;
  }

  function diagnostics(record: FastDetachRecord): string {
    const lines = [
      `survivor pid ${record.survivorPid}, tag it saw: ${record.tag}`,
    ];
    if (process.platform === 'linux') {
      const stat = readLinuxProcessStat(record.survivorPid);
      lines.push(
        stat
          ? `survivor state ${stat.state}, parent pid ${stat.parentPid} (a parent under Kangentic's own tree would be protected from the reap)`
          : 'survivor has no /proc entry',
      );
    }
    lines.push('main process lines:', ...(mainProcessLines.length > 0 ? mainProcessLines : ['(none captured)']));
    return lines.join('\n');
  }

  /**
   * Hold "the survivor is alive" over a window. One read taken the moment the
   * agent is gone can land before a reap that was not awaited (one started from
   * the PTY's exit, say) has finished its scan and kill.
   */
  async function expectSurvivorStaysAlive(record: FastDetachRecord, failure: string): Promise<void> {
    const windowEndsAt = Date.now() + SURVIVOR_HOLD_WINDOW_MS;
    for (;;) {
      if (!isProcessAlive(record.survivorPid)) {
        // Seen dead: afterEach must not signal a pid that may since name another process.
        survivorKnownDead = true;
        throw new Error(`${failure}\n${diagnostics(record)}`);
      }
      if (Date.now() >= windowEndsAt) return;
      // Intentional fixed wait: the sampling cadence of the negative window above.
      await page.waitForTimeout(SURVIVOR_SAMPLE_INTERVAL_MS);
    }
  }

  test('a detached process survives a mid-board suspend and is reaped when the task reaches Done', async () => {
    const title = `Reap Survivor ${runId}`;
    await createTask(page, title, 'Agent fast-detaches a long-lived process');
    const taskId = await getTaskIdByTitle(page, title);

    // 1. Spawn. Executing has no plan-mode permission, so the first move spawns
    // the agent directly. The agent fast-detaches the survivor on start.
    await moveTaskIpc(page, taskId, lanes.executing);
    await waitForTaskSession(page, taskId);
    const record = await waitForFastDetachRecord();
    survivorPid = record.survivorPid;
    if (process.platform === 'linux') survivorStartTicks = readLinuxProcessStat(record.survivorPid)?.startTicks ?? null;

    // The session PTY carried the task tag, and the survivor inherited it. Without
    // this the end of the spec could only say "still alive" and not why.
    expect(record.tag, 'the agent saw no KANGENTIC_TASK_ID: the PTY was not tagged').toBe(taskId);

    // The agent runs in the task's worktree, so the survivor holds it as its cwd.
    const worktreePath = (await taskRow(taskId))?.worktree_path ?? null;
    expect(worktreePath, 'the Executing move should have created a worktree').toBeTruthy();
    expect(fs.existsSync(worktreePath!), `worktree dir should exist on disk: ${worktreePath}`).toBe(true);

    // The detach really was fast: the launcher is gone, so the survivor has no live
    // parent in the PTY tree, and it is itself alive.
    await expect
      .poll(() => isProcessAlive(record.launcherPid), {
        timeout: 10_000,
        message: 'the launcher should have exited right after starting the survivor',
      })
      .toBe(false);
    expect(isProcessAlive(record.survivorPid), 'the survivor died on its own right after detaching').toBe(true);

    // 2. Mid-board suspend. Moving into a column with auto_spawn off parks the
    // session, so a suspend (not a keep-alive) must have happened.
    await moveTaskIpc(page, taskId, lanes.parking);
    await waitForTaskSessionNotRunning(page, taskId);
    // A young session's kill is deferred for its exit grace, so the agent process
    // going away is the signal that the teardown landed.
    await expect
      .poll(() => isProcessAlive(record.agentPid), {
        timeout: 15_000,
        message: 'the agent process should be gone once the session is suspended',
      })
      .toBe(false);
    // The pinned decision: a suspend must not reap.
    await expectSurvivorStaysAlive(record, 'a mid-board suspend killed the survivor, but only a terminal transition may reap');

    // 3. Resume into a spawning column. Still no reap.
    await moveTaskIpc(page, taskId, lanes.executing);
    await waitForTaskSession(page, taskId);
    await expectSurvivorStaysAlive(record, 'resuming the session killed the survivor');

    // 4. Terminal transition. The reap runs after the session exits and is a scan,
    // a graceful kill, a one second wait, a second scan and a force kill, so give
    // it room and poll the actual condition.
    await moveTaskIpc(page, taskId, lanes.done);
    await expect
      .poll(
        () =>
          page.evaluate(async (id) => {
            const archived = await window.electronAPI.tasks.listArchived();
            return archived.some((task) => task.id === id);
          }, taskId),
        { timeout: 10_000, message: 'the task never reached Done' },
      )
      .toBe(true);

    try {
      await expect
        .poll(() => isProcessAlive(record.survivorPid), {
          timeout: 20_000,
          intervals: [250, 500],
          message: 'the survivor should be dead once the task is Done',
        })
        .toBe(false);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${diagnostics(record)}`, { cause: error });
    }
    survivorKnownDead = true;

    // 5. The user is told: one toast for the move, counts only, and Review lists
    // the survivor by pid as stopped. This is the whole report path for real:
    // the host's plan and label, main's burst collector, the push, the toast.
    // Checked before the worktree poll below: a report of stopped processes only
    // is a timed toast, and the removal can outlast its default 4 s.
    const toast = page.locator('[data-testid="toast"]', { hasText: new RegExp(`leftover process(es)? from "${title}"`) });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/Stopped \d+ leftover process(es)? from/);
    await toast.getByRole('button', { name: 'Review' }).click();
    const survivorRow = page.locator('[data-testid="leftover-processes-stopped"] [data-testid="leftover-process-row"]', {
      hasText: `PID ${record.survivorPid}`,
    });
    await expect(survivorRow).toBeVisible({ timeout: 5_000 });
    await expect(survivorRow).toHaveAttribute('data-state', 'stopped');
    await page.locator('[data-testid="leftover-processes-close"]').click();

    // 6. The Done move removes the worktree the survivor held as its cwd. The reap
    // runs first, so on Windows nothing the agent left locks the directory. Linux
    // removes a directory that is a live process's cwd, so there this pins the
    // removal, not the order; session-leftover-reap-wiring.test.ts pins the order.
    await expect
      .poll(
        async () => {
          const task = await taskRow(taskId);
          return { worktreePathCleared: task?.worktree_path === null, worktreeDirGone: !fs.existsSync(worktreePath!) };
        },
        { timeout: 15_000, message: `the Done move should remove the worktree at ${worktreePath}` },
      )
      .toEqual({ worktreePathCleared: true, worktreeDirGone: true });
  });
});
