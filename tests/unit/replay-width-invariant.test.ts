/**
 * Unit coverage for the two halves of one guarantee: a scrollback replay must
 * never leave a frame laid out for a width the grid does not have.
 *
 * THE INCIDENT. A task-detail window's terminal came back hard-wrapped from a
 * Board -> Backlog -> Board round trip: a 210-column agent frame rendered as if
 * the grid were 191, with the TUI's full-width rules spilling onto a second row.
 * It never self-corrected, because the frame lives in xterm's ALTERNATE buffer
 * and xterm reflows the normal buffer on resize and never the alternate one.
 *
 * THE CAUSE, measured from the merged devtools trace on a 1483px window:
 *
 *   terminal-park
 *   webgl-suspend      reason: budget
 *   terminal-reveal
 *   fit  reload-initial     cols 191  colsBefore 210  hostWidth 1482.796875
 *   replay-write            cols 191                       <-- 210-col frame
 *   fit  reload-after-replay cols 210 colsBefore 191 hostWidth 1482.796875
 *   webgl-resume       attached: true
 *
 * The container never moved (hostWidth is byte-identical across all three), so
 * this is a CELL METRIC change, not a layout one. FitAddon derives columns from
 * `_renderService.dimensions.css.cell.width`, and parking a terminal disposes
 * its WebGL addon for the GPU budget; the DOM renderer it falls back to measures
 * a wider cell, so the same box proposes fewer columns. The reveal's fit ran on
 * a renderer the terminal was about to stop using.
 *
 * TWO GUARDS, because they fail differently:
 *
 * 1. PREVENTION (the ordering scan below). Attach the renderer before publishing
 *    the reveal, so a fit is only ever taken on the renderer the terminal keeps.
 *    This is the fix; it is one statement order in one file and trivially
 *    undone, which is why it is pinned mechanically.
 * 2. BACKSTOP (`resolveReplayWidthAction`). Even with the ordering right, the
 *    width can move across a replay's async gap for reasons this fix does not
 *    cover (a live container resize, a font apply). The backstop re-issues the
 *    replay once, so the bug class stays self-healing rather than depending on
 *    guard 1 alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveReplayWidthAction,
  type ReplayWidthInput,
} from '../../src/renderer/hooks/useTerminal';

function makeInput(overrides: Partial<ReplayWidthInput> = {}): ReplayWidthInput {
  return {
    // The incident geometry: main's 210-column frame written into the grid the
    // suspended-WebGL fit produced.
    colsAtWrite: 191,
    colsNow: 210,
    altScreen: true,
    attempts: 0,
    ...overrides,
  };
}

describe('resolveReplayWidthAction', () => {
  it('re-issues when an alt-screen frame was written at a width the grid no longer has', () => {
    // THE regression guard, at the exact widths the trace recorded.
    expect(resolveReplayWidthAction(makeInput())).toEqual({ action: 'replay', nextAttempts: 1 });
  });

  it('accepts when the write width held', () => {
    // The overwhelmingly common case.
    expect(resolveReplayWidthAction(makeInput({ colsAtWrite: 210 }))).toEqual({
      action: 'accept',
      reason: 'width-held',
      refundBudget: true,
    });
  });

  it('accepts a widened NORMAL buffer: xterm already reflowed it', () => {
    // RED: dropping the altScreen guard makes this 'replay', which pays a full
    // round trip to redraw a frame the terminal has already re-wrapped itself.
    expect(resolveReplayWidthAction(makeInput({ altScreen: false }))).toEqual({
      action: 'accept',
      reason: 'normal-buffer',
      refundBudget: true,
    });
  });

  it('accepts a NARROWED grid too: the direction of the mismatch does not matter', () => {
    // A frame drawn for 191 sitting in a 210 grid leaves a ragged right edge
    // rather than a wrap, but it is just as stale and just as unrecoverable.
    expect(resolveReplayWidthAction(makeInput({ colsAtWrite: 210, colsNow: 191 })))
      .toEqual({ action: 'replay', nextAttempts: 1 });
  });

  it('stops at the budget instead of looping, and does NOT refund it', () => {
    // Two surfaces disagreeing about the width would otherwise re-issue forever,
    // each re-issue re-triggering the next. RED: refunding here turns the cap
    // into a no-op WITHIN a chain, since the re-issue it just capped would start
    // from zero again. Across chains the counter is reset by the caller instead:
    // reloadScrollback zeroes it on every fresh (non-`reissue`) request, so a
    // spent cap cannot deny a later, unrelated mismatch its own attempt.
    expect(resolveReplayWidthAction(makeInput({ attempts: 1 }))).toEqual({
      action: 'accept',
      reason: 'attempt-cap',
      refundBudget: false,
    });
  });

  it('accepts when either width is unknown (the terminal went away mid-replay)', () => {
    expect(resolveReplayWidthAction(makeInput({ colsAtWrite: null }))).toEqual({
      action: 'accept',
      reason: 'unknown-width',
      refundBudget: true,
    });
    expect(resolveReplayWidthAction(makeInput({ colsNow: null }))).toEqual({
      action: 'accept',
      reason: 'unknown-width',
      refundBudget: true,
    });
  });

  it('refunds the budget on every HEALTHY accept, not only width-held', () => {
    // The trap this pins: refunding only on 'width-held' leaves the counter
    // spent after an ordinary normal-buffer or terminal-went-away accept, so the
    // NEXT genuine alt-screen mismatch gets one attempt and is then capped. The
    // cap is meant to bound a fight, not to be reached by a healthy terminal.
    const healthy = [
      resolveReplayWidthAction(makeInput({ colsAtWrite: 210 })),
      resolveReplayWidthAction(makeInput({ altScreen: false })),
      resolveReplayWidthAction(makeInput({ colsNow: null })),
    ];
    for (const decision of healthy) {
      expect(decision.action).toBe('accept');
      expect(decision.action === 'accept' && decision.refundBudget).toBe(true);
    }
  });

  it('converges: a mismatch then a clean pass leaves a full budget behind', () => {
    // The sequence a real reveal produces.
    expect(resolveReplayWidthAction(makeInput({ attempts: 0 })))
      .toEqual({ action: 'replay', nextAttempts: 1 });
    expect(resolveReplayWidthAction(makeInput({ colsAtWrite: 210, attempts: 1 })))
      .toEqual({ action: 'accept', reason: 'width-held', refundBudget: true });
  });
});

describe('useFocusedSessionsSync attaches the renderer before publishing the reveal', () => {
  // A source-order scan rather than a behavioral test on purpose: reproducing
  // this needs a real WebGL context swap under a real xterm, which the UI tier
  // cannot provide (tests/ui/window-park-reveal.spec.ts launches with WebGL
  // disabled precisely so its content is assertable as text). The ordering is a
  // one-line move, so pin the one line.
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/hooks/useFocusedSessionsSync.ts'),
    'utf8',
  );

  it('calls applyWebglAttachmentPlan before syncParkedTerminals', () => {
    // Anchored on the plan ASSIGNMENT, which appears exactly once and only in
    // the coordinator effect. A bare indexOf on the call would match the FIRST
    // of two: the coordinator's, and the onWebglAttachmentsChanged re-apply
    // effect further down. Today that is the right one, but only because of the
    // order the two effects happen to sit in - swap them and the scan would read
    // the re-apply's call, which is already after the park publish, and pass on
    // a file whose coordinator had the incident ordering.
    const planAssignedAt = source.indexOf('lastWebglPlanRef.current = {');
    expect(planAssignedAt, 'the lastWebglPlanRef assignment was not found').toBeGreaterThan(-1);
    const applyAt = source.indexOf('applyWebglAttachmentPlan(lastWebglPlanRef.current)', planAssignedAt);
    const parkAt = source.indexOf('syncParkedTerminals(parkedSessionIds)');
    expect(applyAt, 'no applyWebglAttachmentPlan call follows the plan assignment').toBeGreaterThan(-1);
    expect(parkAt, 'syncParkedTerminals(parkedSessionIds) call not found').toBeGreaterThan(-1);
    // RED: moving the WebGL apply back below the parked publish reproduces the
    // incident - the reveal listener fits synchronously against the DOM
    // fallback and writes main's frame at the narrower width. Confirmed live:
    // reverting the order fails tests/ui/window-reveal-grid-width.spec.ts too.
    expect(applyAt).toBeLessThan(parkAt);
  });
});
