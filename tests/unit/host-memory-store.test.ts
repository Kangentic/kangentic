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

beforeEach(() => {
  useHostMemoryStore.setState({ lastEvent: null });
  addToastMock = vi.fn();
  useToastStore.getState.mockReturnValue({ addToast: addToastMock });
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
});
