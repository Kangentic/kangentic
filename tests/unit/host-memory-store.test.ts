/**
 * Unit tests for the host memory pressure store
 * (`src/renderer/stores/host-memory-store.ts`, Sentry DESKTOP-16).
 *
 * `useToastStore` is vi.mock'd, mirroring updater-store.test.ts, so this file
 * asserts on the exact toast call the store makes without depending on
 * toast-store's own internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostMemoryPressureEvent, HostMemorySample } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  useToastStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/toast-store', () => ({ useToastStore: mocks.useToastStore }));

const { useToastStore } = mocks;

import { useHostMemoryStore } from '../../src/renderer/stores/host-memory-store';

function makeSample(overrides: Partial<HostMemorySample> = {}): HostMemorySample {
  return {
    ts: '2026-09-16T14:24:24.000Z',
    platform: 'win32',
    commitLimitBytes: 96_432_717_824,
    commitRemainingBytes: 2_256_896,
    physicalTotalBytes: 34_060_931_072,
    physicalFreeBytes: 5_005_045_760,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<HostMemoryPressureEvent> = {}): HostMemoryPressureEvent {
  return {
    sample: makeSample(),
    activeAgentCount: 3,
    ...overrides,
  };
}

let addToastMock: ReturnType<typeof vi.fn>;
let dismissToastMock: ReturnType<typeof vi.fn>;
let nextToastId: number;

beforeEach(() => {
  useHostMemoryStore.setState({ lastEvent: null, pressureToastId: null });
  nextToastId = 0;
  addToastMock = vi.fn(() => `toast-${++nextToastId}`);
  dismissToastMock = vi.fn();
  useToastStore.getState.mockReturnValue({ addToast: addToastMock, dismissToast: dismissToastMock });
});

describe('useHostMemoryStore.receivePressureEvent', () => {
  it('stores the event and raises a persistent warning toast', () => {
    const event = makeEvent();
    useHostMemoryStore.getState().receivePressureEvent(event);

    expect(useHostMemoryStore.getState().lastEvent).toEqual(event);
    expect(addToastMock).toHaveBeenCalledTimes(1);
    const toast = addToastMock.mock.calls[0][0];
    expect(toast.variant).toBe('warning');
    // Persistent: a machine about to run out of memory must not have its
    // warning vanish on its own after a few seconds.
    expect(toast.duration).toBe(0);
  });

  it('reports the headroom in gigabytes and the agent count in the message', () => {
    useHostMemoryStore.getState().receivePressureEvent(
      makeEvent({ sample: makeSample({ commitRemainingBytes: 2 * 1024 * 1024 * 1024 }), activeAgentCount: 5 })
    );
    const message = addToastMock.mock.calls[0][0].message as string;
    expect(message).toContain('2.0 GB');
    expect(message).toContain('5 agents');
  });

  it('uses singular phrasing for exactly one agent', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent({ activeAgentCount: 1 }));
    const message = addToastMock.mock.calls[0][0].message as string;
    expect(message).toContain('1 agent is');
    expect(message).not.toContain('1 agents');
  });

  it('reports unknown headroom rather than a wrong number when the platform has no commit reading', () => {
    useHostMemoryStore.getState().receivePressureEvent(
      makeEvent({ sample: makeSample({ platform: 'darwin', commitRemainingBytes: null }) })
    );
    const message = addToastMock.mock.calls[0][0].message as string;
    expect(message).toContain('unknown');
  });

  it('stores the returned toast id so a later recovery can dismiss it', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    expect(useHostMemoryStore.getState().pressureToastId).toBe('toast-1');
  });

  it('replaces rather than stacks: a second pressure event dismisses the first toast before adding a second', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    const firstToastId = useHostMemoryStore.getState().pressureToastId;
    expect(firstToastId).not.toBeNull();

    useHostMemoryStore.getState().receivePressureEvent(makeEvent());

    // Order matters: dismiss-before-add, not add-then-dismiss, because
    // addToast trims to a configurable maxCount that can be as low as 1 - an
    // add-then-dismiss ordering could evict the new toast and then dismiss
    // the stale one, leaving nothing on screen.
    expect(dismissToastMock).toHaveBeenCalledTimes(1);
    expect(dismissToastMock).toHaveBeenCalledWith(firstToastId);
    const dismissOrder = dismissToastMock.mock.invocationCallOrder[0];
    const secondAddOrder = addToastMock.mock.invocationCallOrder[1];
    expect(dismissOrder).toBeLessThan(secondAddOrder);

    expect(addToastMock).toHaveBeenCalledTimes(2);
    expect(useHostMemoryStore.getState().pressureToastId).toBe('toast-2');
  });
});

describe('useHostMemoryStore.receiveRecovery', () => {
  it('dismisses exactly the toast id raised by the pressure event, and clears state', () => {
    useHostMemoryStore.getState().receivePressureEvent(makeEvent());
    const toastId = useHostMemoryStore.getState().pressureToastId;

    useHostMemoryStore.getState().receiveRecovery();

    expect(dismissToastMock).toHaveBeenCalledTimes(1);
    expect(dismissToastMock).toHaveBeenCalledWith(toastId);
    expect(useHostMemoryStore.getState().pressureToastId).toBeNull();
    expect(useHostMemoryStore.getState().lastEvent).toBeNull();
  });

  it('does not call dismissToast and does not throw when no toast was ever raised', () => {
    expect(() => useHostMemoryStore.getState().receiveRecovery()).not.toThrow();
    expect(dismissToastMock).not.toHaveBeenCalled();
    expect(useHostMemoryStore.getState().pressureToastId).toBeNull();
  });

  it('nulls a stale pressureToastId even when the dismiss matches nothing on screen', () => {
    // Simulates the toast having already been evicted by maxCount or
    // dismissed by hand: the id in the store is stale, but the store's own
    // invariant must self-repair rather than drift from what is on screen.
    useHostMemoryStore.setState({ pressureToastId: 'stale-toast-id' });

    useHostMemoryStore.getState().receiveRecovery();

    expect(dismissToastMock).toHaveBeenCalledWith('stale-toast-id');
    expect(useHostMemoryStore.getState().pressureToastId).toBeNull();
  });
});
