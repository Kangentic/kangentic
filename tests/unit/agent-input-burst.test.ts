/**
 * Unit tests for end-of-burst debouncing in
 * src/main/browser/agent-input-signal.ts.
 *
 * WHAT THIS PROTECTS. An agent drives a pane with tool calls back to back - one
 * measured run made roughly 1500 in 90 seconds. Announcing the end of EACH call
 * made the pane hand the user's focus back between every pair, so focus
 * oscillated between the guest and the terminal about five times per round (810
 * trusted `focusin` events on the terminal, measured in a single drive). Every
 * one of those restores opened a window in which the next call's keystrokes were
 * delivered to whatever held focus - the user's terminal - rather than to the
 * guest. That is how the agent's own text ended up in a live shell while the page
 * input was missing exactly those characters.
 *
 * The renderer must therefore see a BURST, not a call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  beginAgentInput,
  endAgentInput,
  isAgentDriving,
  setAgentInputSender,
  resetAgentInputSignalForTests,
  AGENT_INPUT_BURST_QUIET_MS,
} from '../../src/main/browser/agent-input-signal';

function guest(id: number): WebContents {
  return { id } as unknown as WebContents;
}

describe('agent input burst debouncing', () => {
  let announced: { guestId: number; active: boolean }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    resetAgentInputSignalForTests();
    announced = [];
    setAgentInputSender((target, active) => announced.push({ guestId: target.id, active }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces one begin for a run of back-to-back calls', () => {
    for (let call = 0; call < 5; call += 1) {
      beginAgentInput(guest(1));
      endAgentInput(guest(1));
      vi.advanceTimersByTime(20);
    }
    expect(announced).toEqual([{ guestId: 1, active: true }]);
  });

  it('announces the end only once the burst goes quiet', () => {
    beginAgentInput(guest(1));
    endAgentInput(guest(1));

    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS - 1);
    expect(announced).toEqual([{ guestId: 1, active: true }]);

    vi.advanceTimersByTime(2);
    expect(announced).toEqual([
      { guestId: 1, active: true },
      { guestId: 1, active: false },
    ]);
  });

  it('a call arriving inside the quiet window continues the same burst', () => {
    // The exact case that produced the oscillation: consecutive tool calls are
    // tens of milliseconds apart, well inside the window.
    beginAgentInput(guest(1));
    endAgentInput(guest(1));
    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS / 2);
    beginAgentInput(guest(1));
    endAgentInput(guest(1));
    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS / 2);

    // Still one begin, and no end yet - the second call cancelled the pending one.
    expect(announced).toEqual([{ guestId: 1, active: true }]);

    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS);
    expect(announced).toEqual([
      { guestId: 1, active: true },
      { guestId: 1, active: false },
    ]);
  });

  it('reports driving for the WHOLE burst, including the quiet tail', () => {
    // The interception keys off this, and the pane keeps the guest's focus until
    // the burst is announced as over. Ending it with the in-flight call left the
    // tail unguarded, and the user's keystrokes landed in the page: measured at a
    // realistic agent cadence, 11 of their ~62 keystrokes.
    beginAgentInput(guest(1));
    expect(isAgentDriving(1)).toBe(true);
    endAgentInput(guest(1));
    expect(isAgentDriving(1)).toBe(true);

    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS + 1);
    expect(isAgentDriving(1)).toBe(false);
  });

  it('tracks bursts per guest independently', () => {
    beginAgentInput(guest(1));
    endAgentInput(guest(1));
    beginAgentInput(guest(2));
    endAgentInput(guest(2));
    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS + 1);

    expect(announced.filter((entry) => entry.guestId === 1)).toEqual([
      { guestId: 1, active: true },
      { guestId: 1, active: false },
    ]);
    expect(announced.filter((entry) => entry.guestId === 2)).toEqual([
      { guestId: 2, active: true },
      { guestId: 2, active: false },
    ]);
  });

  it('does not announce an end while a call is still in flight', () => {
    // Overlapping drives on one pane: the refcount holds, and the pending end
    // must not fire underneath a live call.
    beginAgentInput(guest(1));
    beginAgentInput(guest(1));
    endAgentInput(guest(1));
    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS + 1);
    expect(announced).toEqual([{ guestId: 1, active: true }]);

    endAgentInput(guest(1));
    vi.advanceTimersByTime(AGENT_INPUT_BURST_QUIET_MS + 1);
    expect(announced).toEqual([
      { guestId: 1, active: true },
      { guestId: 1, active: false },
    ]);
  });
});
