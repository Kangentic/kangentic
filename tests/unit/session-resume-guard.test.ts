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
 *   (b) the STRUCTURAL parity check - that `handlers/sessions.ts` actually
 *       calls it at both lane checks. (a) alone is green the moment it is
 *       written and says nothing about the handler where the bug lived, so
 *       (b) is the regression guard.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RESUME_HIDDEN_ROLES,
  resumeBlockMessage,
  resumeBlockReason,
} from '../../src/shared/session-resume-eligibility';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SESSIONS_HANDLER = 'src/main/ipc/handlers/sessions.ts';
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

  it('phrases every refusal as user-facing guidance', () => {
    // These strings reach the user verbatim through the task detail's
    // "Failed to resume session: <reason>" toast.
    for (const reason of ['todo', 'done', 'archived'] as const) {
      const message = resumeBlockMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // Built from its code point so this assertion is not itself an authored
      // long dash (see .claude/rules/text-formatting.md).
      expect(message).not.toContain(String.fromCharCode(0x2014));
      expect(message).not.toContain('--');
    }
  });
});

describe('SESSION_RESUME routes both lane checks through the shared predicate', () => {
  const source = readSource(SESSIONS_HANDLER);

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
    const callSites = source.match(/resumeBlockReason\(/g) ?? [];
    expect(callSites).toHaveLength(2);
  });

  it('reads archived_at at both call sites, not just the lane role', () => {
    const archivedReads = source.match(/archived_at !== null/g) ?? [];
    expect(archivedReads).toHaveLength(2);
  });

  it('keeps the self-heal early return ahead of the eligibility check', () => {
    // Handing back a PTY that already exists spawns nothing, and it is the only
    // path that re-attaches a renderer whose view drifted to 'suspended'.
    // Ordering it after the check would strand that renderer on an archived task.
    const selfHealIndex = source.indexOf("return { kind: 'live' as const, session: liveSession }");
    const firstGuardIndex = source.indexOf('resumeBlockReason(');
    expect(selfHealIndex).toBeGreaterThan(-1);
    expect(firstGuardIndex).toBeGreaterThan(selfHealIndex);
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
