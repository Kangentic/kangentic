/**
 * `isTurnSettled` (src/main/pty/turn-settled.ts): idle is always settled, and a
 * held turn (only background work it left keeps the session thinking) is
 * settled only for a caller that passes `acceptHeld`.
 */
import { describe, it, expect, vi } from 'vitest';
import { isTurnSettled } from '../../src/main/pty/turn-settled';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ActivityState } from '../../src/shared/types';

const SESSION_ID = 'session-settled-1';

function makeSessionManager(state: ActivityState | undefined, held: boolean) {
  const isTurnHeldByBackgroundWork = vi.fn(() => held);
  const sessionManager: Pick<SessionManager, 'getActivityCache' | 'isTurnHeldByBackgroundWork'> = {
    getActivityCache: () => (state === undefined ? {} : { [SESSION_ID]: state }),
    isTurnHeldByBackgroundWork,
  };
  return { sessionManager, isTurnHeldByBackgroundWork };
}

interface Row {
  name: string;
  state: ActivityState | undefined;
  held: boolean;
  options?: { acceptHeld?: boolean };
  expected: boolean;
}

const rows: Row[] = [
  { name: 'idle, not held, no options', state: 'idle', held: false, expected: true },
  { name: 'idle, not held, acceptHeld', state: 'idle', held: false, options: { acceptHeld: true }, expected: true },
  { name: 'idle, held, no options', state: 'idle', held: true, expected: true },
  { name: 'idle, held, acceptHeld', state: 'idle', held: true, options: { acceptHeld: true }, expected: true },
  { name: 'thinking, held, acceptHeld', state: 'thinking', held: true, options: { acceptHeld: true }, expected: true },
  { name: 'thinking, held, no options', state: 'thinking', held: true, expected: false },
  { name: 'thinking, held, acceptHeld false', state: 'thinking', held: true, options: { acceptHeld: false }, expected: false },
  { name: 'thinking, not held, acceptHeld', state: 'thinking', held: false, options: { acceptHeld: true }, expected: false },
  { name: 'no activity recorded, not held, acceptHeld', state: undefined, held: false, options: { acceptHeld: true }, expected: false },
  { name: 'permission, not held, acceptHeld', state: 'permission', held: false, options: { acceptHeld: true }, expected: false },
  { name: 'permission, not held, no options', state: 'permission', held: false, expected: false },
];

describe('isTurnSettled', () => {
  it.each(rows)('$name -> $expected', ({ state, held, options, expected }) => {
    const { sessionManager } = makeSessionManager(state, held);
    expect(isTurnSettled(sessionManager, SESSION_ID, options)).toBe(expected);
  });

  it('does not consult the held predicate unless the caller asked for it', () => {
    const { sessionManager, isTurnHeldByBackgroundWork } = makeSessionManager('thinking', true);
    isTurnSettled(sessionManager, SESSION_ID);
    expect(isTurnHeldByBackgroundWork).not.toHaveBeenCalled();
    isTurnSettled(sessionManager, SESSION_ID, { acceptHeld: true });
    expect(isTurnHeldByBackgroundWork).toHaveBeenCalledWith(SESSION_ID);
  });

  it('defers permission to the held predicate alone', () => {
    // The function adds no permission exclusion of its own. A permission
    // prompt is never settled because the engine's reason ladder ranks
    // permission above background-shell, so the held predicate is false for it.
    // This pins that contract: a held answer for a permission state is trusted.
    const { sessionManager } = makeSessionManager('permission', true);
    expect(isTurnSettled(sessionManager, SESSION_ID)).toBe(false);
    expect(isTurnSettled(sessionManager, SESSION_ID, { acceptHeld: true })).toBe(true);
  });
});
