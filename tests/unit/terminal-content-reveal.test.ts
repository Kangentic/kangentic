/**
 * Unit tests for resolveContentAction, the pure decision behind whether the bottom
 * terminal panel reveals or hides its mounted xterm content when its collapsed state
 * changes (see src/renderer/hooks/useTerminalResize.ts).
 *
 * The load-bearing case is 'reveal-immediately': an expand with no height transition
 * running on the panel container has nothing to wait for, so the content must be revealed
 * now. That covers a container that mounts already expanded (back from Workflows), no
 * container at all (Backlog), and a project-switch snap. If that branch regressed to
 * waiting for a transition, each of those would leave the panel expanded and blank. The
 * hook reads "is a transition running" from the container itself; the UI tier
 * (tests/ui/terminal-panel-reveal.spec.ts) covers that half.
 */
import { describe, it, expect } from 'vitest';
import { resolveContentAction } from '../../src/renderer/hooks/useTerminalResize';

describe('resolveContentAction', () => {
  it('does nothing when the collapsed state did not change', () => {
    expect(resolveContentAction(false, false, false)).toBe('none');
    expect(resolveContentAction(true, true, false)).toBe('none');
    // a running transition is irrelevant when nothing changed
    expect(resolveContentAction(true, true, true)).toBe('none');
    expect(resolveContentAction(false, false, true)).toBe('none');
  });

  it('hides content after the collapse animation when collapsing', () => {
    expect(resolveContentAction(false, true, false)).toBe('hide-after-collapse');
    expect(resolveContentAction(false, true, true)).toBe('hide-after-collapse');
  });

  it('waits for a running height transition to settle on an animated expand', () => {
    expect(resolveContentAction(true, false, true)).toBe('reveal-when-transition-settles');
  });

  it('reveals content immediately when an expand has no height transition running', () => {
    // The blank-panel guard: nothing will settle, so waiting would never reveal.
    expect(resolveContentAction(true, false, false)).toBe('reveal-immediately');
  });
});
