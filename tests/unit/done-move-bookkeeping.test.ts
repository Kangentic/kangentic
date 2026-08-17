/**
 * Two symmetry bugs around the Done column, both found while verifying the
 * Done/archived resume guard. Neither is reachable through the UI, which is why
 * both survived: the board routes archived cards to TASK_UNARCHIVE and writes
 * suspend status optimistically, so only main-driven callers saw them.
 *
 * 1. `handleTaskMove` archived on the way INTO Done and never unarchived on the
 *    way out. MCP `move_task` therefore left the task archived in a live column:
 *    absent from every board query (`archived_at IS NULL`) while holding a
 *    worktree and, in an auto-spawn column, a running agent. That is the same
 *    "live agent with no card" state the resume guard exists to prevent.
 *
 * 2. `SessionManager.suspend` marked the session suspended, then awaited a
 *    graceful PTY shutdown (up to 1500ms for a natural exit plus 1500ms for kill
 *    propagation) BEFORE telling the renderer. The bottom panel's tab set is
 *    `status === 'running'`, so a task dragged to Done kept a dead terminal
 *    tabbed for seconds after its card was gone.
 *
 * Both are static checks: the first is an absent statement and the second an
 * ordering, neither of which any type or existing test could catch.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('a move out of Done clears the archive flag it set on the way in', () => {
  const source = readSource('src/main/ipc/handlers/task-move.ts');

  it('archives into Done and unarchives out of it, in the same handler', () => {
    expect(source).toContain('tasks.archive(');
    expect(source).toContain('tasks.clearArchived(');
  });

  it('keys the unarchive on the task flag, not the source lane', () => {
    // A legacy archived row parked outside Done must be repaired too, and the
    // guard has to exclude a move WITHIN Done (which keeps its archive).
    //
    // Truthiness, never `!== null`: a Task assembled without the column carries
    // `undefined`, which `!== null` reads as archived. That exact slip made the
    // handler try to unarchive on ordinary moves and shipped as a unit-tier
    // failure across split-lock-cas.
    expect(source).toMatch(/Boolean\(task\.archived_at\) && toLane\?\.role !== 'done'/);
    expect(source).not.toMatch(/task\.archived_at !== null/);
  });

  it('uses the placement-free repository method', () => {
    // `unarchive()` also rewrites swimlane_id and position, which would fight
    // `move()`'s own sibling reordering earlier in the same tick.
    const repository = readSource('src/main/db/repositories/task-repository.ts');
    expect(repository).toMatch(/clearArchived\(id: string\): void/);
    expect(repository).toMatch(/UPDATE tasks SET archived_at = NULL, updated_at = \? WHERE id = \?/);
  });
});

describe('suspend announces before it waits, not after', () => {
  const source = readSource('src/main/pty/session-manager.ts');
  const suspendBody = source.slice(source.indexOf('async suspend(sessionId: string)'));

  it('emits session-changed between marking suspended and the graceful shutdown', () => {
    const marked = suspendBody.indexOf("session.status = 'suspended'");
    const firstEmit = suspendBody.indexOf("this.emit('session-changed'", marked);
    const shutdown = suspendBody.indexOf('await gracefulPtyShutdown(');

    expect(marked).toBeGreaterThan(-1);
    expect(shutdown).toBeGreaterThan(-1);
    expect(firstEmit).toBeGreaterThan(marked);
    // The whole point: the renderer hears about it BEFORE the up-to-3s wait.
    expect(firstEmit).toBeLessThan(shutdown);
  });

  it('still emits after the shutdown, so the recovered session id is published', () => {
    const shutdown = suspendBody.indexOf('await gracefulPtyShutdown(');
    const trailingEmit = suspendBody.indexOf("this.emit('session-changed'", shutdown);
    expect(trailingEmit).toBeGreaterThan(shutdown);
  });
});

describe('the panel tab set is what makes the emit ordering matter', () => {
  it('still keys visible tabs on running status', () => {
    // If this ever stops being the predicate, the ordering guarantee above is
    // guarding the wrong thing and this file should be revisited.
    const source = readSource('src/renderer/utils/panel-sessions.ts');
    expect(source).toMatch(/session\.status === 'running'/);
  });
});
