/**
 * The shared session-track pairing rule.
 *
 * `snapSpawnStrategyToTarget` is the one copy of "an isolated column runs a
 * fresh pass each entry" that both writers use: the Column Manager's Session
 * select and the MCP create/update column handlers. `resolveForceFresh` states
 * the same default but cannot apply it, because both DB columns are NOT NULL
 * with a literal DEFAULT and its `??` fallback never evaluates for a stored
 * lane. So these cases are the behavior, not a restatement of the resolver's.
 */

import { describe, it, expect } from 'vitest';
import { snapSpawnStrategyToTarget } from '../../src/shared/session-track';

describe('snapSpawnStrategyToTarget', () => {
  it('sends an isolated column to a fresh session per entry', () => {
    expect(snapSpawnStrategyToTarget('main', 'isolated', 'create_or_resume')).toBe('always_spawn_new');
  });

  it('returns a main-session column to resuming', () => {
    expect(snapSpawnStrategyToTarget('isolated', 'main', 'always_spawn_new')).toBe('create_or_resume');
  });

  it('preserves a persistent isolated track', () => {
    // isolated + create_or_resume is one deliberate setting (a side conversation
    // that accumulates), not a value to be helpfully corrected. Nothing moves it
    // because the strategy is not sitting at the outgoing track's default.
    expect(snapSpawnStrategyToTarget('isolated', 'main', 'create_or_resume')).toBe('create_or_resume');
    expect(snapSpawnStrategyToTarget('main', 'isolated', 'always_spawn_new')).toBe('always_spawn_new');
  });

  it('does nothing when the target is restated rather than changed', () => {
    // The guard the renderer does not need and the MCP handlers do: a <select>
    // fires only on a real change, but an agent can pass sessionTarget:
    // "isolated" for a column that is already isolated. Without this, that
    // no-op call would overwrite a deliberate create_or_resume.
    expect(snapSpawnStrategyToTarget('isolated', 'isolated', 'create_or_resume')).toBe('create_or_resume');
    expect(snapSpawnStrategyToTarget('main', 'main', 'always_spawn_new')).toBe('always_spawn_new');
  });
});
