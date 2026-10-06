/**
 * SESSION_RESUME eligibility guard.
 *
 * A task moved to Done is archived, its session suspended and its worktree
 * deleted. Resume used to reject only `role === 'todo'` and never read
 * `archived_at`, so clicking Resume on a completed task in Done recreated the
 * worktree Done had just deleted and spawned a live `--resume` agent on a task
 * with no board card: archived AND running at the same time, a state no other
 * code path produces, burning quota with nothing on the board to notice it.
 *
 * Two halves, deliberately:
 *
 *   (a) the CONTRACT - the pure predicate every consumer reads;
 *   (b) the STRUCTURAL parity check - that `resumeTaskSession`
 *       (`handlers/session-resume.ts`, the body SESSION_RESUME and a phone
 *       resume share) actually calls it at both lane checks. (a) alone is
 *       green the moment it is written and says nothing about the handler
 *       where the bug lived, so (b) is the regression guard.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RESUME_HIDDEN_ROLES,
  isPausedTaskSession,
  isResumeOffered,
  isTaskPaused,
  pausedTaskIdsOf,
  resumeBlockMessage,
  resumeBlockReason,
  resumeBlockReasonForTask,
} from '../../src/shared/session-resume-eligibility';
import type { Task } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SESSIONS_HANDLER = 'src/main/ipc/handlers/sessions.ts';
const SESSION_RESUME_BODY = 'src/main/ipc/handlers/session-resume.ts';
const RESUME_SUSPENDED = 'src/main/transition-engine/session-startup/resume-suspended.ts';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('resumeBlockReason', () => {
  it('blocks a task in the To Do column', () => {
    expect(resumeBlockReason({ laneRole: 'todo', isArchived: false })).toBe('todo');
  });

  it('blocks a task in the Done column', () => {
    // The reported bug: Done was absent from the guard entirely.
    expect(resumeBlockReason({ laneRole: 'done', isArchived: false })).toBe('done');
  });

  it('blocks an archived task, reporting Done when it sits in Done', () => {
    // The real shape of a completed task: both flags set. The Done message is
    // the actionable one (it names the move that restores the task).
    expect(resumeBlockReason({ laneRole: 'done', isArchived: true })).toBe('done');
  });

  it('blocks an archived task in any other column', () => {
    // Legacy rows: archived without a Done-role lane, or the lane was deleted.
    expect(resumeBlockReason({ laneRole: null, isArchived: true })).toBe('archived');
    expect(resumeBlockReason({ laneRole: undefined, isArchived: true })).toBe('archived');
    expect(resumeBlockReason({ laneRole: 'In Progress', isArchived: true })).toBe('archived');
  });

  it('allows a live task in a custom column', () => {
    expect(resumeBlockReason({ laneRole: null, isArchived: false })).toBeNull();
    expect(resumeBlockReason({ laneRole: undefined, isArchived: false })).toBeNull();
  });

  it('exposes exactly the two roles that hide Resume', () => {
    expect([...RESUME_HIDDEN_ROLES].sort()).toEqual(['done', 'todo']);
  });

  it('resumeBlockReasonForTask reads archived_at by truthiness, so a row assembled without the column is not archived', () => {
    // A mock, wire-mapped or MCP-constructed Task can carry `undefined` here.
    // `!== null` would read that as ARCHIVED and refuse every resume.
    const rowWithoutColumn = {} as Pick<Task, 'archived_at'>;
    expect(resumeBlockReasonForTask({ task: rowWithoutColumn, laneRole: null })).toBeNull();
    expect(resumeBlockReasonForTask({ task: { archived_at: null }, laneRole: null })).toBeNull();
    expect(resumeBlockReasonForTask({ task: { archived_at: '2026-01-01T00:00:00.000Z' }, laneRole: null })).toBe('archived');
    // Done still wins over archived, as resumeBlockReason orders them.
    expect(resumeBlockReasonForTask({ task: { archived_at: '2026-01-01T00:00:00.000Z' }, laneRole: 'done' })).toBe('done');
  });

  it('phrases every refusal as user-facing guidance', () => {
    // These strings reach the user verbatim through the task detail's
    // "Failed to resume session: <reason>" toast.
    for (const reason of ['todo', 'done', 'archived'] as const) {
      const message = resumeBlockMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // Built from its code point so this assertion is not itself an authored
      // long dash (see .claude/rules/writing-style.md).
      expect(message).not.toContain(String.fromCharCode(0x2014));
      expect(message).not.toContain('--');
    }
  });
});

describe('SESSION_RESUME routes both lane checks through the shared predicate', () => {
  const source = readSource(SESSION_RESUME_BODY);

  it('the SESSION_RESUME handler delegates to the shared body, so these checks cover it', () => {
    // The body moved out of sessions.ts so the phone's start-session could
    // call the same function. Red if the handler grows its own copy again.
    const handlerSource = readSource(SESSIONS_HANDLER);
    expect(handlerSource).toMatch(/ipcMain\.handle\(IPC\.SESSION_RESUME,[\s\S]{0,200}resumeTaskSession\(/);
    expect(handlerSource).not.toMatch(/resumeSuspendedSession\(/);
  });

  it('imports the shared eligibility predicate', () => {
    expect(source).toMatch(/from '\.\.\/\.\.\/\.\.\/shared\/session-resume-eligibility'/);
  });

  it('has no hand-rolled lane rejection left', () => {
    // The exact shape of the bug: a bare role comparison that knows about To Do
    // and nothing else. Any new terminal state has to be taught to the shared
    // predicate, where all three consumers see it.
    const bareRoleCheck = /role\s*===\s*'(todo|done)'/g;
    expect(source.match(bareRoleCheck) ?? []).toEqual([]);
  });

  it('checks eligibility at BOTH the Phase 1 and Phase 3 lane checks', () => {
    // Phase 2 (worktree git I/O) runs unlocked, so Phase 3 must re-check against
    // the re-read row: a concurrent move to Done archives the task in that gap.
    const callSites = source.match(/resumeBlockReasonForTask\(/g) ?? [];
    expect(callSites).toHaveLength(2);
  });

  it('hands the row to the predicate at both call sites, the re-read one in Phase 3', () => {
    // The predicate reads archived_at itself, so passing the row is what makes
    // the archive state count. Phase 3 must pass the row it re-read under the
    // lock, not the Phase 1 snapshot, or a move to Done in the gap goes unseen.
    // Its role comes off the column's own row: the profile fold passes `role`
    // through, and the check has to run before the try that reports failures.
    expect(source).toMatch(/resumeBlockReasonForTask\(\{ task, laneRole: lane\?\.role \}\)/);
    expect(source).toMatch(/resumeBlockReasonForTask\(\{ task: current, laneRole: currentRow\?\.role \}\)/);
  });

  it('keeps the self-heal early return ahead of the eligibility check', () => {
    // Handing back a PTY that already exists spawns nothing, and it is the only
    // path that re-attaches a renderer whose view drifted to 'suspended'.
    // Ordering it after the check would strand that renderer on an archived task.
    const selfHealIndex = source.indexOf("return { kind: 'live' as const, session: liveSession }");
    const firstGuardIndex = source.indexOf('resumeBlockReasonForTask(');
    expect(selfHealIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeGreaterThan(selfHealIndex);
  });
});

describe('the paused-session definition behind the phone\'s Resume promise', () => {
  it('isPausedTaskSession is a suspended row that is not a Command Terminal', () => {
    expect(isPausedTaskSession({ status: 'suspended' })).toBe(true);
    expect(isPausedTaskSession({ status: 'suspended', transient: false })).toBe(true);
    expect(isPausedTaskSession({ status: 'suspended', transient: true })).toBe(false);
    for (const status of ['running', 'queued', 'exited'] as const) {
      expect(isPausedTaskSession({ status })).toBe(false);
    }
  });

  it('pausedTaskIdsOf keeps each task with a paused row and no live one once, and nothing else', () => {
    const taskIds = pausedTaskIdsOf([
      { taskId: 'task-paused', status: 'suspended' },
      // A queued successor beside the paused row it will replace: the desktop
      // shows the queued session and offers no Resume, so the task is not paused.
      { taskId: 'task-paused-with-queued-successor', status: 'suspended' },
      { taskId: 'task-paused-with-queued-successor', status: 'queued' },
      // The live row listed first must not matter.
      { taskId: 'task-paused-with-running-successor', status: 'running' },
      { taskId: 'task-paused-with-running-successor', status: 'suspended' },
      { taskId: 'task-paused-twice', status: 'suspended' },
      { taskId: 'task-paused-twice', status: 'suspended', transient: false },
      { taskId: 'task-running', status: 'running' },
      { taskId: 'task-queued', status: 'queued' },
      { taskId: 'task-exited', status: 'exited' },
      // A Command Terminal row is never a task's pause, even carrying its id.
      { taskId: 'task-command-terminal', status: 'suspended', transient: true },
      // A Command Terminal with no task, which carries an empty id.
      { taskId: '', status: 'suspended' },
    ]);
    expect([...taskIds].sort()).toEqual(['task-paused', 'task-paused-twice']);
  });

  it('isTaskPaused answers pausedTaskIdsOf for one task, ignoring every other task\'s rows', () => {
    const sessions = [
      { taskId: 'task-paused', status: 'suspended' as const },
      { taskId: 'task-paused-with-queued-successor', status: 'suspended' as const },
      { taskId: 'task-paused-with-queued-successor', status: 'queued' as const },
      // Another task's live row must not unpause this one.
      { taskId: 'task-running', status: 'running' as const },
      { taskId: 'task-command-terminal', status: 'suspended' as const, transient: true },
    ];
    expect(isTaskPaused(sessions, 'task-paused')).toBe(true);
    expect(isTaskPaused(sessions, 'task-paused-with-queued-successor')).toBe(false);
    expect(isTaskPaused(sessions, 'task-running')).toBe(false);
    expect(isTaskPaused(sessions, 'task-command-terminal')).toBe(false);
    expect(isTaskPaused(sessions, 'task-unknown')).toBe(false);
  });

  it('isResumeOffered needs a paused session AND a column and archive state that allow Resume', () => {
    const liveTask = { archived_at: null };
    const archivedTask = { archived_at: '2026-01-01T00:00:00.000Z' };
    expect(isResumeOffered({ hasPausedSession: true, task: liveTask, laneRole: null })).toBe(true);
    expect(isResumeOffered({ hasPausedSession: false, task: liveTask, laneRole: null })).toBe(false);
    expect(isResumeOffered({ hasPausedSession: true, task: liveTask, laneRole: 'todo' })).toBe(false);
    expect(isResumeOffered({ hasPausedSession: true, task: liveTask, laneRole: 'done' })).toBe(false);
    expect(isResumeOffered({ hasPausedSession: true, task: archivedTask, laneRole: null })).toBe(false);
  });

  // The archive half of the check had four hand-written copies, each carrying
  // the same "truthiness, not `!== null`" warning. The predicates own that read
  // now; a site that derives `isArchived` again is the drift this pins.
  it.each([
    'src/main/ipc/handlers/session-start.ts',
    'src/main/ipc/handlers/session-resume.ts',
    'src/main/mobile-bridge/handlers/read-board.ts',
    'src/main/mobile-bridge/handlers/read-stream.ts',
  ])('%s leaves the archived_at read to the shared predicate', (relativePath) => {
    const source = readSource(relativePath);
    expect(source).not.toMatch(/isArchived:/);
    expect(source).not.toMatch(/archived_at !== null/);
  });

  // start-session's resume path and the `resumable` flag the phone gates
  // Resume on must agree on what "paused" means, or the flag promises a resume
  // the verb does not deliver. Each site wrote it out by hand before, and
  // start-session's copy missed the Command Terminal exclusion. All three run
  // one scan: read-board over every task, start-session and read-stream over
  // one task through isTaskPaused, which wraps it. read-stream also checks the
  // one session it streams.
  it.each([
    ['src/main/ipc/handlers/session-start.ts', [/isTaskPaused\(/]],
    ['src/main/mobile-bridge/handlers/read-board.ts', [/pausedTaskIdsOf\(/]],
    ['src/main/mobile-bridge/handlers/read-stream.ts', [/isPausedTaskSession\(/, /isTaskPaused\(/]],
  ])('%s decides "paused" through the shared definition, with no hand-rolled suspended comparison', (relativePath, sharedCalls) => {
    const source = readSource(relativePath);
    for (const sharedCall of sharedCalls) expect(source).toMatch(sharedCall);
    expect(source.match(/[!=]==\s*'suspended'/g) ?? []).toEqual([]);
  });
});

describe('RESUME_HIDDEN_ROLES has a single definition', () => {
  it('is not redeclared in startup recovery', () => {
    // Startup recovery and the IPC guard disagreeing about which columns hide
    // Resume is exactly how Done ended up guarded in one place and not the other.
    const source = readSource(RESUME_SUSPENDED);
    expect(source).not.toMatch(/const RESUME_HIDDEN_ROLES/);
    expect(source).toMatch(/import \{ RESUME_HIDDEN_ROLES \} from '.*session-resume-eligibility'/);
  });
});
