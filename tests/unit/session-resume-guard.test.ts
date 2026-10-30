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
 *       resume share) actually calls it before the lock and at both locked
 *       lane checks. (a) alone is
 *       green the moment it is written and says nothing about the handler
 *       where the bug lived, so (b) is the regression guard.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RESUME_HIDDEN_ROLES,
  isPauseOffered,
  isPausedTaskSession,
  isResumeOffered,
  isSessionToggleLive,
  isTaskPaused,
  pausedTaskIdsOf,
  resumeBlockMessage,
  resumeBlockReason,
  resumeBlockReasonForTask,
  resumeBlockReasonOfMessage,
  resumeBlockRefusal,
  resumeBlockToastBody,
  sessionToggleOffer,
  taskSessionStatesOf,
  type SessionLifecyclePhase,
} from '../../src/shared/session-resume-eligibility';
import { englishText } from '../../src/shared/i18n/english';
import { translateText } from '../../src/renderer/i18n/translate';
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
    // The message reaches the phone and the disabled Resume row's tooltip
    // verbatim, read with nothing beside it, so it names the move. The toast
    // body sits under a "Couldn't resume session" title, so it is one sentence.
    for (const reason of ['todo', 'done', 'archived'] as const) {
      const message = resumeBlockMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // Built from its code point so this assertion is not itself an authored
      // long dash (see .claude/rules/writing-style.md).
      expect(message).not.toContain(String.fromCharCode(0x2014));
      expect(message).not.toContain('--');
      expect(message).toMatch(/\bMove it\b|\bRestore it\b/);
      expect(englishText(resumeBlockToastBody(reason))).toMatch(/^[A-Z][^.!?]*\.$/);
    }
  });

  // The sentences are typed out from the pre-change module (`git show
  // HEAD:src/shared/session-resume-eligibility.ts`), which returned these literals from a
  // `switch`. Reading one map through two accessors cannot fail on its own, so each
  // accessor is held to the literal.
  const REFUSAL_SENTENCES = {
    todo: 'This task is in To Do. Move it to another column to start its agent.',
    done: 'This task is complete. Move it out of Done to continue working on it.',
    archived: 'This task is archived. Restore it to the board to continue working on it.',
  } as const;
  const TOAST_BODIES = {
    todo: 'The task is in To Do.',
    done: 'The task is in Done.',
    archived: 'The task is archived.',
  } as const;

  it.each(['todo', 'done', 'archived'] as const)('%s: main throws the pre-change sentence', (reason) => {
    expect(resumeBlockMessage(reason)).toBe(REFUSAL_SENTENCES[reason]);
  });

  it.each(['todo', 'done', 'archived'] as const)('%s: the card menu\'s message is that same sentence in English', (reason) => {
    expect(englishText(resumeBlockRefusal(reason))).toBe(resumeBlockMessage(reason));
    expect(englishText(resumeBlockRefusal(reason))).toBe(REFUSAL_SENTENCES[reason]);
    // An English session shows it unchanged.
    expect(translateText(resumeBlockRefusal(reason))).toBe(REFUSAL_SENTENCES[reason]);
  });

  it.each(['todo', 'done', 'archived'] as const)('%s: the toast body is its own short sentence', (reason) => {
    expect(englishText(resumeBlockToastBody(reason))).toBe(TOAST_BODIES[reason]);
    expect(translateText(resumeBlockToastBody(reason))).toBe(TOAST_BODIES[reason]);
    // Not the full sentence: the toast sits under a title and beside the card.
    expect(resumeBlockToastBody(reason).id).not.toBe(resumeBlockRefusal(reason).id);
  });

  it('reads main\'s thrown refusal back to its reason, and nothing else', () => {
    for (const reason of ['todo', 'done', 'archived'] as const) {
      expect(resumeBlockReasonOfMessage(resumeBlockMessage(reason))).toBe(reason);
    }
    expect(resumeBlockReasonOfMessage('The worktree is missing.')).toBeNull();
    expect(resumeBlockReasonOfMessage('')).toBeNull();
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

  it('checks eligibility before the lock and at BOTH the Phase 1 and Phase 3 lane checks', () => {
    // The pre-check (`resumeRefusalBeforeLock`) answers a refusal the row
    // already shows without queueing behind a Done move's teardown. Phase 2
    // (worktree git I/O) runs unlocked, so Phase 3 must re-check against the
    // re-read row: a concurrent move to Done archives the task in that gap.
    const callSites = source.match(/resumeBlockReasonForTask\(/g) ?? [];
    expect(callSites).toHaveLength(3);
  });

  it('hands the row to the predicate at the locked call sites, the re-read one in Phase 3', () => {
    // The predicate reads archived_at itself, so passing the row is what makes
    // the archive state count. Phase 3 must pass the row it re-read under the
    // lock, not the Phase 1 snapshot, or a move to Done in the gap goes unseen.
    // Its role comes off the column's own row: the profile fold passes `role`
    // through, and the check has to run before the try that reports failures.
    expect(source.match(/resumeBlockReasonForTask\(\{ task, laneRole: lane\?\.role \}\)/g) ?? []).toHaveLength(2);
    expect(source).toMatch(/resumeBlockReasonForTask\(\{ task: current, laneRole: currentRow\?\.role \}\)/);
  });

  it('keeps the self-heal early return ahead of the Phase 1 eligibility check', () => {
    // Handing back a PTY that already exists spawns nothing, and it is the only
    // path that re-attaches a renderer whose view drifted to 'suspended'.
    // Ordering it after the check would strand that renderer on an archived task.
    const phase1Start = source.indexOf('const phase1Result = await withTaskLock(');
    const selfHealIndex = source.indexOf("return { kind: 'live' as const, session: liveSession }");
    const phase1GuardIndex = source.indexOf('resumeBlockReasonForTask(', phase1Start);
    expect(phase1Start).toBeGreaterThan(-1);
    expect(selfHealIndex).toBeGreaterThan(phase1Start);
    expect(phase1GuardIndex).toBeGreaterThan(selfHealIndex);
  });

  it('lets a live session through the pre-check, so the self-heal still answers it', () => {
    // The same contract, before the lock: a task with a live PTY is never
    // refused there, even archived, because Phase 1 hands that PTY back.
    const preCheckStart = source.indexOf('export function resumeRefusalBeforeLock(');
    const liveCheckIndex = source.indexOf('findLiveSessionByTaskId(taskId)) return null', preCheckStart);
    const preCheckGuardIndex = source.indexOf('resumeBlockReasonForTask(', preCheckStart);
    expect(preCheckStart).toBeGreaterThan(-1);
    expect(liveCheckIndex).toBeGreaterThan(preCheckStart);
    expect(preCheckGuardIndex).toBeGreaterThan(liveCheckIndex);
  });

  it('runs the pre-check before it cancels an in-flight resume or queues on the lock', () => {
    // A refused click must not cancel another resume, and a move to Done
    // holds the lock through its whole teardown.
    const bodyStart = source.indexOf('export function resumeTaskSession(');
    const preCheckCall = source.indexOf('resumeRefusalBeforeLock(context,', bodyStart);
    expect(preCheckCall).toBeGreaterThan(bodyStart);
    expect(source.indexOf('abortInFlightResume(taskId)', bodyStart)).toBeGreaterThan(preCheckCall);
    expect(source.indexOf('withTaskLock(', bodyStart)).toBeGreaterThan(preCheckCall);
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

  it('taskSessionStatesOf yields the live and the paused tasks from one scan, never the same task in both', () => {
    const sessions = [
      { id: 'session-running', taskId: 'task-running', status: 'running' as const },
      { id: 'session-queued', taskId: 'task-queued', status: 'queued' as const },
      { id: 'session-paused', taskId: 'task-paused', status: 'suspended' as const },
      // A queued successor beside the paused row it will replace: live, not paused.
      { id: 'session-paused-before-successor', taskId: 'task-paused-with-queued-successor', status: 'suspended' as const },
      { id: 'session-queued-successor', taskId: 'task-paused-with-queued-successor', status: 'queued' as const },
      { id: 'session-exited', taskId: 'task-exited', status: 'exited' as const },
      { id: 'session-command-terminal', taskId: 'task-command-terminal', status: 'suspended' as const, transient: true },
      { id: 'session-no-task', taskId: '', status: 'running' as const },
    ];
    const { liveTaskIds, pausedTaskIds, pausedSessionIdByTaskId } = taskSessionStatesOf(sessions);
    expect([...liveTaskIds].sort()).toEqual(['task-paused-with-queued-successor', 'task-queued', 'task-running']);
    expect([...pausedTaskIds].sort()).toEqual(['task-paused']);
    for (const taskId of liveTaskIds) expect(pausedTaskIds.has(taskId)).toBe(false);
    // The paused row's own registry id, for exactly the paused tasks.
    expect(Object.fromEntries(pausedSessionIdByTaskId)).toEqual({ 'task-paused': 'session-paused' });
    // pausedTaskIdsOf is the same scan's paused half.
    expect([...pausedTaskIdsOf(sessions)].sort()).toEqual([...pausedTaskIds].sort());
  });

  it('taskSessionStatesOf names the later paused row of a task that holds two, whichever way the live rows fall', () => {
    const { pausedTaskIds, pausedSessionIdByTaskId } = taskSessionStatesOf([
      { id: 'session-older', taskId: 'task-paused-twice', status: 'suspended' },
      { id: 'session-newer', taskId: 'task-paused-twice', status: 'suspended', transient: false },
      // A live row listed first still unpauses the task, id and all.
      { id: 'session-live', taskId: 'task-paused-with-running-successor', status: 'running' },
      { id: 'session-left-behind', taskId: 'task-paused-with-running-successor', status: 'suspended' },
    ]);
    expect(Object.fromEntries(pausedSessionIdByTaskId)).toEqual({ 'task-paused-twice': 'session-newer' });
    // Its keys are exactly the paused set.
    expect([...pausedSessionIdByTaskId.keys()].sort()).toEqual([...pausedTaskIds].sort());
  });

  it('isPauseOffered needs a live session and a column other than To Do, and keeps Pause in Done', () => {
    expect(isPauseOffered({ hasLiveSession: true, laneRole: null })).toBe(true);
    // Done keeps Pause, as the task view does: it is the only stop for a live
    // agent a failed Done-move suspend left behind.
    expect(isPauseOffered({ hasLiveSession: true, laneRole: 'done' })).toBe(true);
    expect(isPauseOffered({ hasLiveSession: true, laneRole: 'todo' })).toBe(false);
    expect(isPauseOffered({ hasLiveSession: false, laneRole: null })).toBe(false);
    expect(isPauseOffered({ hasLiveSession: false, laneRole: 'done' })).toBe(false);
  });

  // The one rule behind the task detail's pill and kebab item, the card menu's
  // row, and the phone's pausable / resumable. The detail and the menu used to
  // compute it inline and the phone restated it, so the table pins every cell.
  it.each<[SessionLifecyclePhase, string | null, string | null | undefined, ReturnType<typeof sessionToggleOffer>]>([
    // phase, laneRole, archived_at, offer
    ['active', null, null, { direction: 'pause' }],
    ['active', 'done', null, { direction: 'pause' }],
    ['active', null, '2026-01-01T00:00:00.000Z', { direction: 'pause' }],
    ['active', 'todo', null, null],
    ['paused', null, null, { direction: 'resume', blockReason: null }],
    ['paused', 'done', null, { direction: 'resume', blockReason: 'done' }],
    ['paused', null, '2026-01-01T00:00:00.000Z', { direction: 'resume', blockReason: 'archived' }],
    // Done outranks archived: its message names the move that restores the task.
    ['paused', 'done', '2026-01-01T00:00:00.000Z', { direction: 'resume', blockReason: 'done' }],
    // A row assembled without the column carries `undefined`: not archived.
    ['paused', null, undefined, { direction: 'resume', blockReason: null }],
    ['paused', 'todo', null, null],
    ['ended', null, null, null],
    ['ended', 'done', null, null],
  ])('sessionToggleOffer(%s, lane %s, archived_at %s)', (phase, laneRole, archivedAt, expected) => {
    const task = { archived_at: archivedAt } as Pick<Task, 'archived_at'>;
    expect(sessionToggleOffer({ phase, laneRole, task })).toEqual(expected);
  });

  it('isSessionToggleLive is any Pause, or a Resume nothing refuses', () => {
    expect(isSessionToggleLive(null)).toBe(false);
    expect(isSessionToggleLive({ direction: 'pause' })).toBe(true);
    expect(isSessionToggleLive({ direction: 'resume', blockReason: null })).toBe(true);
    expect(isSessionToggleLive({ direction: 'resume', blockReason: 'done' })).toBe(false);
    expect(isSessionToggleLive({ direction: 'resume', blockReason: 'archived' })).toBe(false);
  });

  it('the phone\'s wrappers agree with sessionToggleOffer in every lane', () => {
    const lanes = [null, 'todo', 'done'];
    const tasks = [{ archived_at: null }, { archived_at: '2026-01-01T00:00:00.000Z' }];
    for (const laneRole of lanes) {
      for (const task of tasks) {
        for (const live of [true, false]) {
          const offer = sessionToggleOffer({ phase: live ? 'active' : 'ended', laneRole, task });
          expect(isPauseOffered({ hasLiveSession: live, laneRole })).toBe(offer?.direction === 'pause');
        }
        for (const paused of [true, false]) {
          const offer = sessionToggleOffer({ phase: paused ? 'paused' : 'ended', laneRole, task });
          expect(isResumeOffered({ hasPausedSession: paused, task, laneRole }))
            .toBe(offer?.direction === 'resume' && isSessionToggleLive(offer));
        }
      }
    }
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
  // one scan: read-board over every task (taskSessionStatesOf, which also
  // yields the live set behind `pausable`), start-session and read-stream over
  // one task through isTaskPaused, which wraps it. read-stream also checks the
  // one session it streams.
  it.each([
    ['src/main/ipc/handlers/session-start.ts', [/isTaskPaused\(/]],
    ['src/main/mobile-bridge/handlers/read-board.ts', [/taskSessionStatesOf\(/, /isPauseOffered\(/]],
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
