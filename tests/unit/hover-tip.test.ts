/**
 * Pins the pure half of HoverTip (src/renderer/utils/hover-tip.ts) and the one structural claim
 * a static render can prove: HoverTip adds no element around its trigger.
 *
 * The open state (hover dwell, focus, Escape, clamping on screen) needs a browser and lives in
 * tests/ui/hover-tip.spec.ts. What is here is the arithmetic that spec cannot isolate: where a
 * tip sits at both window edges and when there is no room above, what a screen reader is told,
 * and the warm window with the clock injected.
 *
 * `react-dom/server`, no jsdom, the same pattern as data-table-colgroup.test.ts. The description
 * is an attribute on the trigger (`aria-description`), so a static render shows it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HOVER_TIP_WARM_MS,
  TIP_OFFSET,
  VIEWPORT_PADDING,
  claimTip,
  isTipWarm,
  placeTip,
  releaseTip,
  repeatsTriggerName,
  resetTipStateForTests,
  tipDescription,
} from '../../src/renderer/utils/hover-tip';
import { HoverTip } from '../../src/renderer/components/HoverTip';

const VIEWPORT = { width: 1000, height: 800 };

function anchorAt(left: number, top: number, width = 30, height = 30) {
  return { left, top, bottom: top + height, width };
}

describe('placeTip', () => {
  it('centres the tip above the trigger when there is room', () => {
    const placement = placeTip(anchorAt(485, 400), { width: 100, height: 24 }, VIEWPORT);
    expect(placement).toEqual({ left: 450, top: 400 - TIP_OFFSET - 24, side: 'above' });
  });

  it('clamps to the left padding for a trigger at the left edge', () => {
    const placement = placeTip(anchorAt(0, 400), { width: 200, height: 24 }, VIEWPORT);
    expect(placement.left).toBe(VIEWPORT_PADDING);
  });

  it('clamps to the right padding for a trigger at the right edge', () => {
    const placement = placeTip(anchorAt(970, 400), { width: 200, height: 24 }, VIEWPORT);
    expect(placement.left + 200).toBe(VIEWPORT.width - VIEWPORT_PADDING);
  });

  it('flips below when the space above is shorter than the tip', () => {
    const placement = placeTip(anchorAt(485, 20), { width: 100, height: 24 }, VIEWPORT);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(50 + TIP_OFFSET);
  });

  it('keeps a tip that fits neither side inside the window', () => {
    const placement = placeTip(anchorAt(485, 20, 30, 760), { width: 100, height: 300 }, VIEWPORT);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(VIEWPORT.height - VIEWPORT_PADDING - 300);
  });

  it('starts a tip wider than the window at the left padding', () => {
    const placement = placeTip(anchorAt(485, 400), { width: 1200, height: 24 }, VIEWPORT);
    expect(placement.left).toBe(VIEWPORT_PADDING);
  });
});

describe('tipDescription', () => {
  it('is empty for an icon button whose tip is its own name and which has no shortcut', () => {
    expect(repeatsTriggerName('Close', 'Close')).toBe(true);
    expect(tipDescription({ label: 'Close', readLabel: false, combo: '' })).toBe('');
  });

  it('is the shortcut alone when the label is the trigger\'s name', () => {
    expect(tipDescription({ label: 'Close', readLabel: false, combo: 'Ctrl+Shift+W' })).toBe('Ctrl+Shift+W');
  });

  it('is the reason for a disabled control named for its action', () => {
    expect(repeatsTriggerName('No conversation history for this task yet', 'View conversation')).toBe(false);
    expect(tipDescription({ label: 'No conversation history for this task yet', readLabel: true, combo: '' }))
      .toBe('No conversation history for this task yet');
  });

  it('carries the label with its shortcut, and the detail on its own line', () => {
    expect(tipDescription({ label: 'Show changes', readLabel: true, combo: 'Ctrl+Shift+G', detail: 'Uncommitted only' }))
      .toBe('Show changes (Ctrl+Shift+G)\nUncommitted only');
  });

  it('compares names without case or extra whitespace', () => {
    expect(repeatsTriggerName('  Pop   out ', 'pop out')).toBe(true);
    expect(repeatsTriggerName('Pop out', undefined)).toBe(false);
  });
});

describe('the warm window', () => {
  beforeEach(() => resetTipStateForTests());

  it('is warm while a tip shows and for HOVER_TIP_WARM_MS after a warm close', () => {
    const close = (): void => {};
    expect(isTipWarm(1000)).toBe(false);
    claimTip(close);
    expect(isTipWarm(1000)).toBe(true);
    releaseTip(close, true, 1000);
    expect(isTipWarm(1000 + HOVER_TIP_WARM_MS - 1)).toBe(true);
    expect(isTipWarm(1000 + HOVER_TIP_WARM_MS)).toBe(false);
  });

  it('is cold right after a cold close (Escape, a press)', () => {
    const close = (): void => {};
    claimTip(close);
    releaseTip(close, false, 1000);
    expect(isTipWarm(1001)).toBe(false);
  });

  it('closes the tip on screen when another claims the slot', () => {
    let firstClosed = false;
    const closeFirst = (): void => {
      firstClosed = true;
      releaseTip(closeFirst, true, 1000);
    };
    claimTip(closeFirst);
    claimTip(() => {});
    expect(firstClosed).toBe(true);
    expect(isTipWarm(1000)).toBe(true);
  });

  it('ignores a release from a tip that no longer holds the slot', () => {
    const stale = (): void => {};
    const current = (): void => {};
    claimTip(current);
    releaseTip(stale, false, 1000);
    expect(isTipWarm(5000)).toBe(true);
  });
});

describe('HoverTip markup', () => {
  it('adds no element around its trigger', () => {
    const markup = renderToStaticMarkup(
      createElement(HoverTip, { label: 'Close' }, createElement('button', { 'aria-label': 'Close', className: 'flex-1' })),
    );
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('class="flex-1"');
    expect(markup).not.toContain('aria-description');
  });

  it('describes a trigger whose tip says more than its name', () => {
    const markup = renderToStaticMarkup(
      createElement(HoverTip, { label: 'Why it is off' }, createElement('button', { 'aria-label': 'Action', disabled: true })),
    );
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('aria-description="Why it is off"');
  });

  it('keeps the trigger\'s own props beside the ones it adds', () => {
    const markup = renderToStaticMarkup(
      createElement(HoverTip, { label: 'More' }, createElement('button', { 'aria-label': 'Action', 'data-testid': 'own' })),
    );
    expect(markup).toContain('data-testid="own"');
    expect(markup).toContain('aria-label="Action"');
    expect(markup).toContain('aria-description="More"');
  });
});
