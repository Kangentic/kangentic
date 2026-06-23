/**
 * Unit tests for resolveContentAction, the pure decision behind whether the bottom
 * terminal panel reveals or hides its mounted xterm content when its collapsed state
 * changes (see src/renderer/hooks/useTerminalResize.ts).
 *
 * The load-bearing case is 'reveal-immediately': when a project switch snaps the panel
 * open with the height transition suppressed, no `transitionend` event fires, so the
 * content must be revealed without waiting for one. If that branch regressed back to
 * waiting for `transitionend` (the normal expand path), the terminal would stay blank
 * after switching into a project whose panel is expanded. This test pins that guard.
 */
import { describe, it, expect } from 'vitest';
import { resolveContentAction } from '../../src/renderer/hooks/useTerminalResize';

describe('resolveContentAction', () => {
  it('does nothing when the collapsed state did not change', () => {
    expect(resolveContentAction(false, false, false)).toBe('none');
    expect(resolveContentAction(true, true, false)).toBe('none');
    // suppression is irrelevant when nothing changed
    expect(resolveContentAction(true, true, true)).toBe('none');
    expect(resolveContentAction(false, false, true)).toBe('none');
  });

  it('hides content after the collapse animation when collapsing', () => {
    expect(resolveContentAction(false, true, false)).toBe('hide-after-collapse');
    // A suppressed collapse still hides after the timer; content is clipped meanwhile.
    expect(resolveContentAction(false, true, true)).toBe('hide-after-collapse');
  });

  it('waits for the height transition to reveal content on a normal expand', () => {
    expect(resolveContentAction(true, false, false)).toBe('reveal-on-transition-end');
  });

  it('reveals content immediately when expanding with the transition suppressed', () => {
    // The blank-panel guard: a project switch snaps the panel open with no animation,
    // so no transitionend fires; content must be revealed without waiting for it.
    expect(resolveContentAction(true, false, true)).toBe('reveal-immediately');
  });
});
