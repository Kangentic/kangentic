/**
 * Anti-drift guard for the checkout-occupancy check.
 *
 * The check previously existed twice: canonically in `task-move.ts` and
 * hand-inlined in `agent-spawn.ts` "to avoid circular import with task-move.ts"
 * (a cycle that never existed). The copies drifted, and separately the canonical
 * one drifted from the predicate in `task-git.ts` that decides whether a
 * checkout happens at all. That is what let a custom-branch task check out
 * underneath another task's live agent.
 *
 * There is now exactly one implementation, beside the checkout it protects. This
 * scan fails if a second one appears, in the style of
 * spawn-entry-point-parity.test.ts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIN_ROOT = path.join(__dirname, '..', '..', 'src', 'main');
const CANONICAL_SITE = path.join('ipc', 'helpers', 'task-git.ts');

/** Every .ts file under src/main. */
function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(entryPath, found);
    else if (entry.name.endsWith('.ts')) found.push(entryPath);
  }
  return found;
}

describe('checkout-occupancy guard lives in exactly one place', () => {
  const files = collectSourceFiles(MAIN_ROOT);

  it('scans a plausible number of files (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no second implementation that filters live sessions by task and status', () => {
    // The distinguishing shape of the old inline copies: enumerate sessions,
    // exclude this task, keep the running/queued ones. Reading listSessions for
    // other purposes (counting, lookup by id) is untouched by this.
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(MAIN_ROOT, file);
      if (relative === CANONICAL_SITE) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('listSessions()')) continue;
      const filtersOutOwnTaskAmongLive = /session\.taskId\s*!==/.test(source)
        && /'running'/.test(source)
        && /'queued'/.test(source);
      if (filtersOutOwnTaskAmongLive) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the canonical guard beside the checkout it protects', () => {
    const source = fs.readFileSync(path.join(MAIN_ROOT, CANONICAL_SITE), 'utf8');
    expect(source).toContain('assertNoOtherAgentInDirectory');
    expect(source).toContain('BranchCheckoutBlockedError');
    // Both checkout arms must be covered: the custom-branch arm is the one the
    // old guard missed entirely.
    const guardCallCount = (source.match(/assertNoOtherAgentInDirectory\(context,/g) ?? []).length;
    expect(guardCallCount).toBe(2);
  });

  it('no longer exports the removed handler-side guard', () => {
    const taskMove = fs.readFileSync(path.join(MAIN_ROOT, 'ipc', 'handlers', 'task-move.ts'), 'utf8');
    expect(taskMove).not.toContain('guardActiveNonWorktreeSessions');
  });
});
