/**
 * Unit tests for openAttachmentWithToast
 * (src/renderer/components/dialogs/attachment-utils.ts), the shared failure
 * contract both the task-detail dialog (useAttachments.ts) and the backlog
 * dialog (NewBacklogTaskDialog.tsx) route their attachments.open /
 * backlogAttachments.open invoke through.
 *
 * tests/ui/attachment-open-failure.spec.ts already drives this function
 * end-to-end through both call sites, but only exercises two of its four
 * branches (resolved error string, and a thrown Error) via a full app boot.
 * This file pins all four branches - including the success/no-toast path and
 * the non-Error-thrown fallback, neither of which is covered anywhere else -
 * as a fast, pure-logic unit test. Mirrors the mock scaffold in
 * toast-store-hmr.test.ts: mock config-store (addToast reads
 * config.notifications.toasts), use the real toast-store.
 *
 * Tier: Unit (vitest, no browser, no Electron, no IPC).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({
      config: {
        notifications: {
          toasts: {
            durationSeconds: 4,
            maxCount: 5,
          },
        },
      },
    }),
  },
}));

import { openAttachmentWithToast } from '../../src/renderer/components/dialogs/attachment-utils';
import { useToastStore } from '../../src/renderer/stores/toast-store';

/** Reset the store to empty toasts between tests without re-importing the module. */
function clearToasts(): void {
  const current = useToastStore.getState().toasts;
  for (const toast of current) {
    useToastStore.getState().dismissToast(toast.id);
  }
}

describe('openAttachmentWithToast', () => {
  beforeEach(() => {
    clearToasts();
  });

  it('adds no toast when the invoke resolves "" (success)', async () => {
    await openAttachmentWithToast('report.pdf', async () => '');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('adds one warning toast naming the file, the error, and the reveal-fallback claim on a resolved error string', async () => {
    await openAttachmentWithToast('archive.bin', async () => 'No application is registered for this file type');

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('warning');
    expect(toasts[0].message).toContain('archive.bin');
    expect(toasts[0].message).toContain('No application is registered for this file type');
    expect(toasts[0].message).toContain('Showing it in the file manager instead.');
  });

  it('adds one warning toast with the Error message and no reveal-fallback claim on a thrown Error', async () => {
    await openAttachmentWithToast('notes.bin', async () => {
      throw new Error('Attachment not found');
    });

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('warning');
    expect(toasts[0].message).toContain('notes.bin');
    expect(toasts[0].message).toContain('Attachment not found');
    // Unlike the resolved-error-string branch, the open never got far enough
    // for the main process to have called shell.showItemInFolder, so this
    // path must not claim it did.
    expect(toasts[0].message).not.toContain('file manager');
  });

  it('falls back to String(error) when a non-Error value is thrown', async () => {
    await openAttachmentWithToast('diagram.png', async () => {
      // Deliberately exercising the non-Error fallback branch (a real thunk
      // could reject with a plain object, e.g. via an IPC serialization edge case).
      throw { code: 'WEIRD_REJECTION' };
    });

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('warning');
    expect(toasts[0].message).toContain('diagram.png');
    // String({ code: 'WEIRD_REJECTION' }) === '[object Object]' - distinct from
    // any .message access, which would have thrown or produced 'undefined'.
    expect(toasts[0].message).toContain('[object Object]');
    expect(toasts[0].message).not.toContain('file manager');
  });
});
