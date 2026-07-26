/**
 * Unit tests for the updater store (`src/renderer/stores/updater-store.ts`).
 *
 * tests/ui/release-notes-modal.spec.ts already exercises this store end to
 * end through the real ReleaseNotesDialog + TitleBar and a headless
 * mock-electron-api, but only through the branches those components render a
 * clickable path for. Two branches are unreachable from the UI entirely:
 *   - `openModal()` when `pendingUpdate` is null - the title-bar indicator
 *     button that calls it only renders when `pendingUpdate` is truthy, so
 *     the early-return guard has no UI path to exercise it.
 *   - `dismiss()` when `pendingUpdate` is null - "Later" only renders inside
 *     the modal, which only opens when `pendingUpdate` is set.
 * This file drives the store directly to pin those guards, plus the
 * `receiveUpdate()` state-machine branches (fresh version / already-seen
 * version / no-notes fallback / a second no-notes push clearing a PRIOR
 * notes-bearing pendingUpdate - the exact staleness hazard called out in the
 * store's own comment) and the fire-and-forget persistence + toast action
 * wiring, mirroring the direct-store-drive pattern in mobile-store.test.ts
 * and the vi.mock cross-store pattern in auto-name-scheduler.test.ts.
 *
 * window.electronAPI.updater.installUpdate is stubbed globally before
 * importing the store (Node, non-jsdom unit tier); useConfigStore and
 * useToastStore are vi.mock'd so this file asserts on the exact calls the
 * updater store makes into them without depending on either store's own
 * internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, type UpdateDownloadedInfo } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted store mocks - declared via vi.hoisted so the vi.mock factories
// below (which run before this file's top-level body) can see them.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  useConfigStore: { getState: vi.fn() },
  useToastStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: mocks.useConfigStore }));
vi.mock('../../src/renderer/stores/toast-store', () => ({ useToastStore: mocks.useToastStore }));

const { useConfigStore, useToastStore } = mocks;

const installUpdateMock = vi.fn();
(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    updater: {
      installUpdate: installUpdateMock,
    },
  },
};

// Imported after the mocks/stub so the store module sees them.
import { useUpdaterStore } from '../../src/renderer/stores/updater-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUpdateInfo(overrides: Partial<UpdateDownloadedInfo> = {}): UpdateDownloadedInfo {
  return {
    version: '9.9.9',
    releaseNotes: '## What\'s New\n\n- A brand new thing',
    ...overrides,
  };
}

function resetStore(): void {
  useUpdaterStore.setState({ pendingUpdate: null, isModalOpen: false, autoOpened: false });
}

let addToastMock: ReturnType<typeof vi.fn>;
let updateConfigMock: ReturnType<typeof vi.fn>;
let lastSeenReleaseNotesVersion: string;

beforeEach(() => {
  resetStore();
  installUpdateMock.mockReset();

  lastSeenReleaseNotesVersion = '';
  addToastMock = vi.fn();
  updateConfigMock = vi.fn().mockResolvedValue(undefined);

  useConfigStore.getState.mockReset().mockImplementation(() => ({
    config: { ...DEFAULT_CONFIG, lastSeenReleaseNotesVersion },
    updateConfig: updateConfigMock,
  }));
  useToastStore.getState.mockReset().mockImplementation(() => ({
    addToast: addToastMock,
  }));
});

// ---------------------------------------------------------------------------
// receiveUpdate()
// ---------------------------------------------------------------------------

describe('receiveUpdate()', () => {
  it('a fresh version with notes auto-opens the modal', () => {
    const info = makeUpdateInfo({ version: '1.2.3' });

    useUpdaterStore.getState().receiveUpdate(info);

    expect(useUpdaterStore.getState().pendingUpdate).toEqual(info);
    expect(useUpdaterStore.getState().isModalOpen).toBe(true);
    expect(useUpdaterStore.getState().autoOpened).toBe(true);
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('an already-seen version (matches config.lastSeenReleaseNotesVersion) stores the update but does not auto-open', () => {
    lastSeenReleaseNotesVersion = '1.2.3';
    const info = makeUpdateInfo({ version: '1.2.3' });

    useUpdaterStore.getState().receiveUpdate(info);

    expect(useUpdaterStore.getState().pendingUpdate).toEqual(info);
    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    expect(useUpdaterStore.getState().autoOpened).toBe(false);
  });

  it('empty release notes falls back to the persistent toast instead of the modal', () => {
    const info = makeUpdateInfo({ version: '1.2.3', releaseNotes: '' });

    useUpdaterStore.getState().receiveUpdate(info);

    expect(useUpdaterStore.getState().pendingUpdate).toBeNull();
    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    expect(useUpdaterStore.getState().autoOpened).toBe(false);
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith({
      message: 'Version 1.2.3 is ready to install',
      variant: 'info',
      duration: 0,
      action: {
        label: 'Restart to update',
        onClick: expect.any(Function),
      },
    });
  });

  it('whitespace-only release notes also falls back to the toast (notes are trimmed before the check)', () => {
    const info = makeUpdateInfo({ version: '1.2.3', releaseNotes: '   \n  ' });

    useUpdaterStore.getState().receiveUpdate(info);

    expect(useUpdaterStore.getState().pendingUpdate).toBeNull();
    expect(addToastMock).toHaveBeenCalledTimes(1);
  });

  it('the toast action calls window.electronAPI.updater.installUpdate()', () => {
    useUpdaterStore.getState().receiveUpdate(makeUpdateInfo({ releaseNotes: '' }));

    const call = addToastMock.mock.calls[0][0] as { action: { onClick: () => void } };
    call.action.onClick();

    expect(installUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('a second no-notes push clears a PRIOR notes-bearing pendingUpdate, so the indicator does not offer a stale version', () => {
    // First update has real notes: pendingUpdate is set and the modal auto-opens.
    useUpdaterStore.getState().receiveUpdate(makeUpdateInfo({ version: '1.0.0' }));
    expect(useUpdaterStore.getState().pendingUpdate?.version).toBe('1.0.0');

    // A second, newer update lands with no notes (e.g. a patch release).
    useUpdaterStore.getState().receiveUpdate(makeUpdateInfo({ version: '1.0.1', releaseNotes: '' }));

    expect(useUpdaterStore.getState().pendingUpdate).toBeNull();
    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    expect(useUpdaterStore.getState().autoOpened).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openModal()
// ---------------------------------------------------------------------------

describe('openModal()', () => {
  it('is a no-op when there is no pendingUpdate (unreachable from the UI, but must stay safe)', () => {
    expect(useUpdaterStore.getState().pendingUpdate).toBeNull();

    useUpdaterStore.getState().openModal();

    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
  });

  it('opens the modal for the pending update without re-marking it as auto-opened', () => {
    useUpdaterStore.setState({ pendingUpdate: makeUpdateInfo(), isModalOpen: false, autoOpened: true });

    useUpdaterStore.getState().openModal();

    expect(useUpdaterStore.getState().isModalOpen).toBe(true);
    expect(useUpdaterStore.getState().autoOpened).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dismiss()
// ---------------------------------------------------------------------------

describe('dismiss()', () => {
  it('closes the modal and persists the pending update version as seen', async () => {
    const info = makeUpdateInfo({ version: '1.2.3' });
    useUpdaterStore.setState({ pendingUpdate: info, isModalOpen: true, autoOpened: true });

    useUpdaterStore.getState().dismiss();

    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    // updateConfig is fired-and-forgotten (not awaited by dismiss()); flush
    // the microtask queue before asserting the call landed.
    await Promise.resolve();
    await Promise.resolve();
    expect(updateConfigMock).toHaveBeenCalledWith({ lastSeenReleaseNotesVersion: '1.2.3' });
  });

  it('does not call updateConfig when there is no pendingUpdate (unreachable from the UI, but must stay safe)', async () => {
    expect(useUpdaterStore.getState().pendingUpdate).toBeNull();
    useUpdaterStore.setState({ isModalOpen: true });

    useUpdaterStore.getState().dismiss();

    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('swallows a rejected updateConfig instead of throwing (dismissal must not fail on a persistence error)', async () => {
    // A vi.fn() built via mockRejectedValue has its returned promise
    // instrumented internally (for mock.results tracking), which itself
    // attaches a handler and would mask a missing `.catch()` in the store -
    // the assertion below would stay green either way. Use a PLAIN rejecting
    // function instead so the only thing that can attach a handler to its
    // promise is the store's own `dismiss()` implementation.
    const rejectingUpdateConfig = () => Promise.reject(new Error('disk full'));
    useConfigStore.getState.mockReturnValue({
      config: { ...DEFAULT_CONFIG, lastSeenReleaseNotesVersion: '' },
      updateConfig: rejectingUpdateConfig,
    });
    useUpdaterStore.setState({ pendingUpdate: makeUpdateInfo({ version: '1.2.3' }), isModalOpen: true });

    // dismiss() does not await updateConfig(), so a synchronous throw/not-throw
    // assertion here would pass whether or not the rejection is actually
    // caught. Listen for Node's 'unhandledRejection' instead: it only fires if
    // dismiss()'s `.catch(() => undefined)` is missing or broken, which is the
    // real thing this test guards.
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      useUpdaterStore.getState().dismiss();
      expect(useUpdaterStore.getState().isModalOpen).toBe(false);

      // Cross a macrotask boundary so Node's unhandled-rejection check (which
      // runs after the microtask queue drains) has a chance to fire before we
      // assert on it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });
});
