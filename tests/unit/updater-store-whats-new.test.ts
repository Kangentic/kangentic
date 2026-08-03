/**
 * Unit tests for the post-update "What's New" state on the updater store.
 *
 * Kept separate from updater-store.test.ts, which pins the pre-restart flow.
 * The behaviour under test here is the interaction between the two surfaces:
 * both are BaseDialogs with their own full-screen backdrop, so at most one may
 * be open, and a downloaded update awaiting restart must win - it is the newer,
 * actionable event, while what's-new describes the version already running. The
 * what's-new marker is written when it OPENS (see useWhatsNewOnLaunch), so being
 * superseded loses nothing and the status-bar version pill reopens it.
 *
 * Same harness as updater-store.test.ts: node tier, no jsdom, so window is
 * stubbed and the config/toast stores are vi.mock'd before the store import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, type UpdateDownloadedInfo } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  useConfigStore: { getState: vi.fn() },
  useToastStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: mocks.useConfigStore }));
vi.mock('../../src/renderer/stores/toast-store', () => ({ useToastStore: mocks.useToastStore }));

const { useConfigStore, useToastStore } = mocks;

(globalThis as Record<string, unknown>).window = {
  electronAPI: { updater: { installUpdate: vi.fn() } },
};

import { useUpdaterStore } from '../../src/renderer/stores/updater-store';

function makeUpdateInfo(overrides: Partial<UpdateDownloadedInfo> = {}): UpdateDownloadedInfo {
  return {
    version: '9.9.9',
    releaseNotes: '## What\'s New\n\n- A brand new thing',
    ...overrides,
  };
}

let lastSeenReleaseNotesVersion: string;

beforeEach(() => {
  useUpdaterStore.setState({
    pendingUpdate: null,
    isModalOpen: false,
    autoOpened: false,
    whatsNewOpen: false,
    whatsNewAutoOpened: false,
  });

  lastSeenReleaseNotesVersion = '';
  useConfigStore.getState.mockReset().mockImplementation(() => ({
    config: { ...DEFAULT_CONFIG, lastSeenReleaseNotesVersion },
    updateConfig: vi.fn().mockResolvedValue(undefined),
  }));
  useToastStore.getState.mockReset().mockImplementation(() => ({ addToast: vi.fn() }));
});

describe('openWhatsNew() / closeWhatsNew()', () => {
  it('an auto-open records that it was unbidden, so the dialog does not trap focus', () => {
    useUpdaterStore.getState().openWhatsNew({ autoOpened: true });

    expect(useUpdaterStore.getState().whatsNewOpen).toBe(true);
    expect(useUpdaterStore.getState().whatsNewAutoOpened).toBe(true);
  });

  it('a user-initiated open from the version pill traps focus normally', () => {
    useUpdaterStore.getState().openWhatsNew({ autoOpened: false });

    expect(useUpdaterStore.getState().whatsNewOpen).toBe(true);
    expect(useUpdaterStore.getState().whatsNewAutoOpened).toBe(false);
  });

  it('closing clears both flags', () => {
    useUpdaterStore.getState().openWhatsNew({ autoOpened: true });
    useUpdaterStore.getState().closeWhatsNew();

    expect(useUpdaterStore.getState().whatsNewOpen).toBe(false);
    expect(useUpdaterStore.getState().whatsNewAutoOpened).toBe(false);
  });

  it('does not write the config marker - that happens when it opens on launch', () => {
    const updateConfigMock = vi.fn().mockResolvedValue(undefined);
    useConfigStore.getState.mockImplementation(() => ({
      config: { ...DEFAULT_CONFIG },
      updateConfig: updateConfigMock,
    }));

    useUpdaterStore.getState().openWhatsNew({ autoOpened: false });
    useUpdaterStore.getState().closeWhatsNew();

    expect(updateConfigMock).not.toHaveBeenCalled();
  });
});

describe('precedence against a downloaded update', () => {
  it('an unseen update takes the screen from an open what\'s-new dialog', () => {
    useUpdaterStore.getState().openWhatsNew({ autoOpened: true });

    useUpdaterStore.getState().receiveUpdate(makeUpdateInfo({ version: '1.2.3' }));

    expect(useUpdaterStore.getState().isModalOpen).toBe(true);
    expect(useUpdaterStore.getState().whatsNewOpen).toBe(false);
    expect(useUpdaterStore.getState().whatsNewAutoOpened).toBe(false);
  });

  it('an already-seen update does not disturb an open what\'s-new dialog', () => {
    // The pre-restart modal does not auto-open for a version already dismissed,
    // so there is nothing to take the screen and nothing to close.
    lastSeenReleaseNotesVersion = '1.2.3';
    useUpdaterStore.getState().openWhatsNew({ autoOpened: true });

    useUpdaterStore.getState().receiveUpdate(makeUpdateInfo({ version: '1.2.3' }));

    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    expect(useUpdaterStore.getState().whatsNewOpen).toBe(true);
    expect(useUpdaterStore.getState().whatsNewAutoOpened).toBe(true);
  });

  it('the no-notes toast fallback leaves an open what\'s-new dialog alone', () => {
    // A toast does not take over the screen, so there is no conflict to resolve.
    useUpdaterStore.getState().openWhatsNew({ autoOpened: true });

    useUpdaterStore.getState().receiveUpdate(makeUpdateInfo({ releaseNotes: '' }));

    expect(useUpdaterStore.getState().whatsNewOpen).toBe(true);
  });
});
