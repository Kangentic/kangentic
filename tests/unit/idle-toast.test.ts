import { describe, it, expect } from 'vitest';
import { endsOwnCallTurn, resolveIdleToast, type IdleToastInput } from '../../src/renderer/utils/idle-toast';
import type { ActivityState } from '../../src/shared/types';

// The toast half of the Agent Idle notification. The desktop half
// (src/main/notifications/desktop-notifier.ts) is level-triggered on purpose: it
// fires only when the window is unfocused or another project is active, so a
// repeat is invisible to the user anyway. The toast has no such cover, which is
// why every case here is about NOT firing.

function input(overrides: Partial<IdleToastInput> = {}): IdleToastInput {
  return {
    state: 'idle',
    previousState: 'thinking',
    enabled: true,
    isCurrentProject: true,
    transient: false,
    ownedByDetailSurface: false,
    taskTitle: 'Fix the drag ghost',
    sessionIdShort: 'a1b2c3d4',
    endsOwnCall: false,
    reason: undefined,
    ...overrides,
  };
}

describe('resolveIdleToast', () => {
  // The agent moved its own task, and the move ends its session once this turn
  // does (#916), so main flags the idle that ends the turn. Nobody is waiting.
  describe('the idle that ends the turn in which the agent moved its own task', () => {
    it('raises no toast', () => {
      expect(resolveIdleToast(input({ endsOwnCall: true }))).toBeNull();
    });

    it('is read off main\'s flag on the idle reason, and only there', () => {
      expect(endsOwnCallTurn({ kind: 'idle', since: 1, inOwnCall: true })).toBe(true);
      expect(endsOwnCallTurn({ kind: 'idle', since: 1 })).toBe(false);
      expect(endsOwnCallTurn({ kind: 'permission', since: 1 })).toBe(false);
      expect(endsOwnCallTurn(undefined)).toBe(false);
      expect(endsOwnCallTurn(null)).toBe(false);
    });
  });

  // The case the whole design turns on. `session:activity` carries a reason-only
  // refresh on the same channel as a real transition, roughly 180 of the former
  // against 3 of the latter across a long turn, so a level check here would toast
  // continuously for as long as the agent kept working.
  describe('edge detection', () => {
    it('does not fire when the state did not move', () => {
      expect(resolveIdleToast(input({ previousState: 'idle', state: 'idle' }))).toBeNull();
      expect(resolveIdleToast(input({ previousState: 'permission', state: 'permission' }))).toBeNull();
    });

    it('does not fire on permission -> idle', () => {
      // The agent asked for approval and then ended its turn. The user was already
      // interacting with it, so this is not a new call for attention.
      expect(resolveIdleToast(input({ previousState: 'permission', state: 'idle' }))).toBeNull();
    });

    it('does not fire on idle -> permission', () => {
      expect(resolveIdleToast(input({ previousState: 'idle', state: 'permission' }))).toBeNull();
    });

    it('fires on a first sighting, where there is no previous state', () => {
      expect(resolveIdleToast(input({ previousState: undefined }))).not.toBeNull();
    });

    it('does not fire when the agent is working', () => {
      expect(resolveIdleToast(input({ previousState: 'idle', state: 'thinking' }))).toBeNull();
      expect(resolveIdleToast(input({ previousState: undefined, state: 'thinking' }))).toBeNull();
    });
  });

  describe('title, message and variant', () => {
    it('names a finished turn for idle', () => {
      expect(resolveIdleToast(input({ state: 'idle' }))).toEqual({
        title: 'Agent finished',
        message: '"Fix the drag ghost" is waiting on you.',
        variant: 'info',
        hasTask: true,
      });
    });

    it('names a question for a question wait, and raises the variant', () => {
      expect(resolveIdleToast(input({ state: 'permission', reason: { kind: 'permission', since: 1, waitKind: 'question' } }))).toEqual({
        title: 'Agent has a question',
        message: '"Fix the drag ghost" is asking you a question.',
        variant: 'warning',
        hasTask: true,
      });
    });

    it('names an approval for an approval wait (a tool or a plan)', () => {
      expect(resolveIdleToast(input({ state: 'permission', reason: { kind: 'permission', since: 1, waitKind: 'approval' } }))).toEqual({
        title: 'Agent needs your approval',
        message: '"Fix the drag ghost" is waiting for your approval.',
        variant: 'warning',
        hasTask: true,
      });
    });

    it('falls back to needing input when the agent did not report the kind', () => {
      const expected = {
        title: 'Agent needs your input',
        message: '"Fix the drag ghost" is waiting on you.',
        variant: 'warning',
        hasTask: true,
      };
      expect(resolveIdleToast(input({ state: 'permission', reason: { kind: 'permission', since: 1 } }))).toEqual(expected);
      // A wait whose reason has not arrived yet reads the same: the state decides it is a wait.
      expect(resolveIdleToast(input({ state: 'permission', reason: undefined }))).toEqual(expected);
    });

    it('labels a session with no task row by its short id in every wait', () => {
      expect(resolveIdleToast(input({ state: 'permission', taskTitle: undefined, reason: { kind: 'permission', since: 1, waitKind: 'question' } }))?.message)
        .toBe('a1b2c3d4 is asking you a question.');
      expect(resolveIdleToast(input({ state: 'permission', taskTitle: undefined, reason: { kind: 'permission', since: 1, waitKind: 'approval' } }))?.message)
        .toBe('a1b2c3d4 is waiting for your approval.');
    });
  });

  describe('gates', () => {
    const suppressing: Array<[string, Partial<IdleToastInput>]> = [
      ['the setting is off', { enabled: false }],
      ['the session is on another project', { isCurrentProject: false }],
      ['the session is a Command Terminal', { transient: true }],
      ['the terminal is already on screen', { ownedByDetailSurface: true }],
    ];

    for (const [reason, overrides] of suppressing) {
      it(`does not fire when ${reason}`, () => {
        // Each case is constructed so everything else would have allowed it, which
        // is what makes the assertion about this gate rather than about the fixture.
        expect(resolveIdleToast(input())).not.toBeNull();
        expect(resolveIdleToast(input(overrides))).toBeNull();
      });
    }
  });

  describe('a session whose task the board has not loaded', () => {
    // The board's tasks only reload on loadBoard(), so a task an agent or the MCP
    // server created can spawn, run, and go idle before this renderer sees it.
    // Staying silent there would drop a real notification.
    it('still fires, labelled with the short session id and no quotes around it', () => {
      expect(resolveIdleToast(input({ taskTitle: undefined }))).toEqual({
        title: 'Agent finished',
        message: 'a1b2c3d4 is waiting on you.',
        variant: 'info',
        hasTask: false,
      });
    });

    it('reports hasTask false so the caller gives the card nothing to open', () => {
      expect(resolveIdleToast(input({ taskTitle: undefined }))?.hasTask).toBe(false);
      expect(resolveIdleToast(input())?.hasTask).toBe(true);
    });
  });

  it('covers every ActivityState as an arrival, so a new variant fails here', () => {
    const arrivals: ActivityState[] = ['thinking', 'idle', 'permission'];
    const fired = arrivals.filter((state) => resolveIdleToast(input({ previousState: 'thinking', state })) !== null);
    expect(fired).toEqual(['idle', 'permission']);
  });
});
