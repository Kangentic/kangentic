/**
 * Unit tests for `loadTaskProfile` in src/main/ipc/helpers/task-profile.ts.
 *
 * `findTaskProfile` / `applyProfileToLane` (the pure profile-fold functions it
 * delegates to) are already thoroughly covered by column-strategy.test.ts.
 * What is NOT covered anywhere is `loadTaskProfile`'s OWN contract as the one
 * accessor every spawn-affecting call site uses:
 *   - fast-path null (and no board-config read at all) when the task carries
 *     no profile_id, so a board with no profiles pays no extra I/O per spawn;
 *   - TOTAL: never throws, even when reading Board Profiles fails (a
 *     mid-write kangentic.json, a missing project, etc.) - it must degrade to
 *     null instead of blocking a spawn;
 *   - forwards the caller's `projectPath` (or `undefined` when omitted/null)
 *     so a startup-recovery task resolves against ITS OWN board rather than
 *     whichever project happens to be active.
 *
 * `loadTaskProfile` only reads from the context, so a minimal typed
 * `IpcContext` stub (cast via `as unknown as IpcContext`, mirroring
 * resolve-project-context.test.ts) is sufficient - no DB, PTY, or Electron
 * process required.
 */

import { describe, it, expect, vi } from 'vitest';
import { loadTaskProfile } from '../../src/main/ipc/helpers/task-profile';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { BoardProfile } from '../../src/shared/types';

function makeContext(getBoardProfiles: (projectPath?: string) => BoardProfile[]): {
  context: IpcContext;
  getBoardProfiles: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(getBoardProfiles);
  const context = {
    boardConfigManager: { getBoardProfiles: mock },
  } as unknown as IpcContext;
  return { context, getBoardProfiles: mock };
}

describe('loadTaskProfile', () => {
  it('returns null without consulting board config when the task has no profile_id', () => {
    const { context, getBoardProfiles } = makeContext(() => [
      { id: 'p1', name: 'Heavy', columns: {} },
    ]);

    const result = loadTaskProfile(context, { id: 'task-1', profile_id: null });

    expect(result).toBeNull();
    expect(getBoardProfiles).not.toHaveBeenCalled();
  });

  it('resolves the matching profile by id when the task carries one', () => {
    const profile: BoardProfile = { id: 'p1', name: 'Heavy', columns: {} };
    const { context } = makeContext(() => [profile]);

    const result = loadTaskProfile(context, { id: 'task-1', profile_id: 'p1' });

    expect(result).toBe(profile);
  });

  it('degrades a dangling profile id to null (Default) instead of throwing', () => {
    const { context } = makeContext(() => [{ id: 'other', name: 'X', columns: {} }]);

    expect(() => loadTaskProfile(context, { id: 'task-1', profile_id: 'missing' })).not.toThrow();
    expect(loadTaskProfile(context, { id: 'task-1', profile_id: 'missing' })).toBeNull();
  });

  it('never throws when reading Board Profiles fails - degrades to null', () => {
    const { context } = makeContext(() => {
      throw new Error('kangentic.json is mid-write');
    });

    expect(() => loadTaskProfile(context, { id: 'task-1', profile_id: 'p1' })).not.toThrow();
    expect(loadTaskProfile(context, { id: 'task-1', profile_id: 'p1' })).toBeNull();
  });

  it("forwards the explicit projectPath, so a startup-recovery task resolves against ITS OWN board, not the active one", () => {
    const { context, getBoardProfiles } = makeContext(() => []);

    loadTaskProfile(context, { id: 'task-1', profile_id: 'p1' }, '/projects/other-project');

    expect(getBoardProfiles).toHaveBeenCalledWith('/projects/other-project');
  });

  it('passes undefined (not null) when projectPath is omitted, so the manager falls back to the active project', () => {
    const { context, getBoardProfiles } = makeContext(() => []);

    loadTaskProfile(context, { id: 'task-1', profile_id: 'p1' });

    expect(getBoardProfiles).toHaveBeenCalledWith(undefined);
  });

  it('passes undefined (not null) when projectPath is explicitly null', () => {
    const { context, getBoardProfiles } = makeContext(() => []);

    loadTaskProfile(context, { id: 'task-1', profile_id: 'p1' }, null);

    expect(getBoardProfiles).toHaveBeenCalledWith(undefined);
  });
});
