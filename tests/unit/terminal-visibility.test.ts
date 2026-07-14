/**
 * Unit tests for the pure terminal-visibility planner
 * (`src/renderer/utils/terminal-visibility.ts`): which sessions are parked
 * (Backlog-parked board layer, maximized-over occlusion) and which terminals
 * win one of the budgeted live WebGL attachments (panel first, then top-K by
 * focus recency: command layer over board layer, MRU order index within one).
 */
import { describe, it, expect } from 'vitest';
import {
  computeOccludedWindowIds,
  planTerminalVisibility,
  type TerminalVisibilityWindowInput,
  type TerminalVisibilityInput,
} from '../../src/renderer/utils/terminal-visibility';

function makeWindow(
  overrides: Partial<TerminalVisibilityWindowInput> = {},
): TerminalVisibilityWindowInput {
  return {
    windowId: 'w-default',
    sessionId: 'sess-default',
    hasTerminal: true,
    state: 'floating',
    zIndex: 1,
    orderIndex: 0,
    layer: 'board',
    ...overrides,
  };
}

function makeInput(overrides: Partial<TerminalVisibilityInput> = {}): TerminalVisibilityInput {
  return {
    boardLayerParked: false,
    windows: [],
    panelSessionId: null,
    webglBudget: 8,
    ...overrides,
  };
}

describe('computeOccludedWindowIds', () => {
  it('returns nothing when no window is maximized', () => {
    const occluded = computeOccludedWindowIds([
      makeWindow({ windowId: 'w1', zIndex: 1 }),
      makeWindow({ windowId: 'w2', zIndex: 2 }),
    ]);
    expect(occluded.size).toBe(0);
  });

  it('occludes only lower-z windows in the same layer as the maximized window', () => {
    const occluded = computeOccludedWindowIds([
      makeWindow({ windowId: 'w-under', zIndex: 1 }),
      makeWindow({ windowId: 'w-max', state: 'maximized', zIndex: 2 }),
      makeWindow({ windowId: 'w-above', zIndex: 3 }),
      makeWindow({ windowId: 'w-other-layer', zIndex: 0, layer: 'command' }),
    ]);
    expect([...occluded]).toEqual(['w-under']);
  });

  it('a maximized window occludes a lower-z maximized window', () => {
    const occluded = computeOccludedWindowIds([
      makeWindow({ windowId: 'w-max-low', state: 'maximized', zIndex: 1 }),
      makeWindow({ windowId: 'w-max-high', state: 'maximized', zIndex: 2 }),
    ]);
    expect([...occluded]).toEqual(['w-max-low']);
  });

  it('a maximized window without a terminal still occludes', () => {
    const occluded = computeOccludedWindowIds([
      makeWindow({ windowId: 'w-term', zIndex: 1 }),
      makeWindow({ windowId: 'w-conversation', hasTerminal: false, state: 'maximized', zIndex: 2 }),
    ]);
    expect([...occluded]).toEqual(['w-term']);
  });

  it('evaluates layers independently', () => {
    const occluded = computeOccludedWindowIds([
      makeWindow({ windowId: 'b-under', zIndex: 1, layer: 'board' }),
      makeWindow({ windowId: 'b-max', state: 'maximized', zIndex: 2, layer: 'board' }),
      makeWindow({ windowId: 'c-under', zIndex: 1, layer: 'command' }),
      makeWindow({ windowId: 'c-max', state: 'maximized', zIndex: 2, layer: 'command' }),
    ]);
    expect([...occluded].sort()).toEqual(['b-under', 'c-under']);
  });
});

describe('planTerminalVisibility', () => {
  it('parks every board-layer terminal session while the board layer is parked', () => {
    const plan = planTerminalVisibility(
      makeInput({
        boardLayerParked: true,
        windows: [
          makeWindow({ windowId: 'b1', sessionId: 'sess-b1', layer: 'board' }),
          makeWindow({ windowId: 'b2', sessionId: 'sess-b2', layer: 'board' }),
          makeWindow({ windowId: 'c1', sessionId: 'sess-c1', layer: 'command' }),
        ],
      }),
    );
    expect(plan.parkedSessionIds.sort()).toEqual(['sess-b1', 'sess-b2']);
    expect(plan.webglAttachSessionIds).toEqual(['sess-c1']);
    expect(plan.webglSuspendSessionIds.sort()).toEqual(['sess-b1', 'sess-b2']);
  });

  it('parks sessions occluded by a maximized same-layer window', () => {
    const plan = planTerminalVisibility(
      makeInput({
        windows: [
          makeWindow({ windowId: 'w-under', sessionId: 'sess-under', zIndex: 1 }),
          makeWindow({ windowId: 'w-max', sessionId: 'sess-max', state: 'maximized', zIndex: 2 }),
        ],
      }),
    );
    expect(plan.parkedSessionIds).toEqual(['sess-under']);
    expect(plan.webglAttachSessionIds).toEqual(['sess-max']);
    expect(plan.webglSuspendSessionIds).toEqual(['sess-under']);
  });

  it('conversation windows occlude but never enter the park or attach sets', () => {
    const plan = planTerminalVisibility(
      makeInput({
        windows: [
          makeWindow({ windowId: 'w-term', sessionId: 'sess-term', zIndex: 1 }),
          makeWindow({
            windowId: 'w-conversation',
            sessionId: null,
            hasTerminal: false,
            state: 'maximized',
            zIndex: 2,
          }),
        ],
      }),
    );
    expect(plan.parkedSessionIds).toEqual(['sess-term']);
    expect(plan.webglAttachSessionIds).toEqual([]);
    expect(plan.webglSuspendSessionIds).toEqual(['sess-term']);
  });

  it('ignores windows with no live session', () => {
    const plan = planTerminalVisibility(
      makeInput({
        boardLayerParked: true,
        windows: [makeWindow({ windowId: 'w-suspended', sessionId: null })],
      }),
    );
    expect(plan.parkedSessionIds).toEqual([]);
    expect(plan.webglAttachSessionIds).toEqual([]);
    expect(plan.webglSuspendSessionIds).toEqual([]);
  });

  it('ranks command-layer terminals above board-layer terminals for the budget', () => {
    const plan = planTerminalVisibility(
      makeInput({
        webglBudget: 2,
        windows: [
          makeWindow({ windowId: 'b1', sessionId: 'sess-b1', layer: 'board', orderIndex: 5 }),
          makeWindow({ windowId: 'c1', sessionId: 'sess-c1', layer: 'command', orderIndex: 0 }),
          makeWindow({ windowId: 'c2', sessionId: 'sess-c2', layer: 'command', orderIndex: 1 }),
        ],
      }),
    );
    expect(plan.webglAttachSessionIds).toEqual(['sess-c2', 'sess-c1']);
    expect(plan.webglSuspendSessionIds).toEqual(['sess-b1']);
  });

  it('picks top-K by MRU order index within a layer (front-most never evicted)', () => {
    const plan = planTerminalVisibility(
      makeInput({
        webglBudget: 2,
        windows: [
          makeWindow({ windowId: 'w1', sessionId: 'sess-1', orderIndex: 0 }),
          makeWindow({ windowId: 'w2', sessionId: 'sess-2', orderIndex: 1 }),
          makeWindow({ windowId: 'w3', sessionId: 'sess-3', orderIndex: 2 }),
        ],
      }),
    );
    // orderIndex 2 is the front-most (most recently focused) window.
    expect(plan.webglAttachSessionIds).toEqual(['sess-3', 'sess-2']);
    expect(plan.webglSuspendSessionIds).toEqual(['sess-1']);
  });

  it('always attaches the panel session first and never parks it', () => {
    const plan = planTerminalVisibility(
      makeInput({
        webglBudget: 2,
        panelSessionId: 'sess-panel',
        windows: [
          makeWindow({ windowId: 'w1', sessionId: 'sess-1', orderIndex: 0 }),
          makeWindow({ windowId: 'w2', sessionId: 'sess-2', orderIndex: 1 }),
        ],
      }),
    );
    expect(plan.webglAttachSessionIds).toEqual(['sess-panel', 'sess-2']);
    expect(plan.parkedSessionIds).toEqual([]);
    expect(plan.webglSuspendSessionIds).toEqual(['sess-1']);
  });

  it('never plans more attachments than the budget', () => {
    const windows = Array.from({ length: 12 }, (unused, index) =>
      makeWindow({ windowId: `w${index}`, sessionId: `sess-${index}`, orderIndex: index }),
    );
    const plan = planTerminalVisibility(makeInput({ webglBudget: 8, windows }));
    expect(plan.webglAttachSessionIds).toHaveLength(8);
    expect(plan.webglSuspendSessionIds).toHaveLength(4);
    // Attach + suspend together cover every known session exactly once.
    const union = [...plan.webglAttachSessionIds, ...plan.webglSuspendSessionIds].sort();
    expect(union).toEqual(windows.map((window) => window.sessionId).sort());
  });

  it('parked sessions are never in the attach set even when the budget has room', () => {
    const plan = planTerminalVisibility(
      makeInput({
        boardLayerParked: true,
        webglBudget: 8,
        windows: [makeWindow({ windowId: 'w1', sessionId: 'sess-1' })],
      }),
    );
    expect(plan.webglAttachSessionIds).toEqual([]);
    expect(plan.webglSuspendSessionIds).toEqual(['sess-1']);
  });

  it('does not attach the panel session when it is also a parked window session (parked wins over panel-first)', () => {
    const plan = planTerminalVisibility(
      makeInput({
        boardLayerParked: true,
        webglBudget: 8,
        // derivePanelSessionId is window-blind, so panelSessionId can resolve to
        // a session a task-detail window already owns - here that window is
        // Backlog-parked. The parked classification must win: no live WebGL
        // context for an off-view terminal.
        panelSessionId: 'sess-shared',
        windows: [makeWindow({ windowId: 'w1', sessionId: 'sess-shared' })],
      }),
    );
    expect(plan.parkedSessionIds).toEqual(['sess-shared']);
    expect(plan.webglAttachSessionIds).not.toContain('sess-shared');
    expect(plan.webglSuspendSessionIds).toContain('sess-shared');
  });
});
