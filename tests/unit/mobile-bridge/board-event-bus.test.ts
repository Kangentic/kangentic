/**
 * Unit tests for src/main/mobile-bridge/board-event-bus.ts.
 *
 * The consolidated board-changed event stream fed by
 * mcp-project-context.ts's six callbacks and pr-linking.ts, and consumed by
 * the mobile bridge's read-board handler. mcp-project-context.test.ts and
 * read-board.test.ts each mock context.boardEvents at their own seam
 * (emitBoardChanged as a bare vi.fn() on the emitter side, onBoardChanged
 * returning a captured listener on the consumer side), so the REAL
 * BoardEventBus class - the thing that actually connects those two mocks in
 * production - is never exercised end to end by either suite. This file
 * closes that gap directly, mirroring subscription-registry.test.ts's
 * pattern for the sibling thin wrapper class.
 */
import { describe, it, expect, vi } from 'vitest';
import { BoardEventBus, type BoardChangedEvent } from '../../../src/main/mobile-bridge/board-event-bus';

describe('BoardEventBus', () => {
  it('emitBoardChanged() delivers the event to a subscribed listener', () => {
    const bus = new BoardEventBus();
    const listener = vi.fn();
    bus.onBoardChanged(listener);

    const event: BoardChangedEvent = { projectId: 'proj-1', change: 'task-created', ids: ['task-1'] };
    bus.emitBoardChanged(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('fans a single emit out to every subscribed listener', () => {
    const bus = new BoardEventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.onBoardChanged(first);
    bus.onBoardChanged(second);

    bus.emitBoardChanged({ projectId: 'proj-1', change: 'backlog-changed', ids: [] });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('the teardown returned by onBoardChanged() removes only that listener', () => {
    const bus = new BoardEventBus();
    const staying = vi.fn();
    const leaving = vi.fn();
    bus.onBoardChanged(staying);
    const unsubscribeLeaving = bus.onBoardChanged(leaving);

    unsubscribeLeaving();
    bus.emitBoardChanged({ projectId: 'proj-1', change: 'task-deleted', ids: ['task-2'] });

    expect(staying).toHaveBeenCalledTimes(1);
    expect(leaving).not.toHaveBeenCalled();
  });

  it('emitting with no subscribers does not throw', () => {
    const bus = new BoardEventBus();
    expect(() => bus.emitBoardChanged({ projectId: 'proj-1', change: 'swimlane-updated', ids: ['lane-1'] })).not.toThrow();
  });

  it('an unsubscribed listener stays silent on later events, even after a fresh subscription is added', () => {
    const bus = new BoardEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.onBoardChanged(listener);
    unsubscribe();

    bus.onBoardChanged(vi.fn());
    bus.emitBoardChanged({ projectId: 'proj-1', change: 'task-updated', ids: ['task-3'] });

    expect(listener).not.toHaveBeenCalled();
  });
});
