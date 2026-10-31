/**
 * Unit tests for `setTransientSessionLabel` on TransientSessionSlice, the
 * renderer end of a Command Terminal rename (`session:setTransientLabel`).
 *
 * The title reads the name off the session replica, so a successful rename
 * needs nothing from the slice but the IPC call. A rejected call is the one
 * outcome the user cannot see otherwise: the title simply does not change. The
 * slice turns it into an error toast whose body is the reason main wrote, with
 * Electron's channel decoration stripped.
 *
 * The action touches neither `set` nor `get`, so the harness builds the slice
 * with stubs for both. `window.electronAPI.sessions.setTransientLabel` is
 * stubbed on globalThis as the sibling suites stub their bridge calls.
 *
 * Red-green: removing the catch makes the rejected rename reject out of the
 * action (the failure case throws); dropping the toast fails its assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: null })),
  },
}));

const addToastSpy = vi.fn();
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: addToastSpy }) },
}));

import { createTransientSessionSlice } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';

function makeSlice() {
  const sliceCreator = createTransientSessionSlice(undefined);
  return sliceCreator(
    vi.fn() as unknown as Parameters<typeof sliceCreator>[0],
    (() => ({})) as unknown as () => SessionStore,
    {} as unknown as Parameters<typeof sliceCreator>[2],
  );
}

function installSetTransientLabel(impl: (sessionId: string, label: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const setTransientLabel = vi.fn(impl);
  const globalWindow = globalThis as unknown as { window?: Record<string, unknown> };
  globalWindow.window = globalWindow.window ?? {};
  globalWindow.window.electronAPI = { sessions: { setTransientLabel } };
  return setTransientLabel;
}

beforeEach(() => {
  addToastSpy.mockReset();
});

describe('setTransientSessionLabel', () => {
  it('sends the name for the terminal and raises no toast when main accepts it', async () => {
    const setTransientLabel = installSetTransientLabel(async () => {});

    await makeSlice().setTransientSessionLabel('term-2', 'Parser work');

    expect(setTransientLabel).toHaveBeenCalledTimes(1);
    expect(setTransientLabel).toHaveBeenCalledWith('term-2', 'Parser work');
    expect(addToastSpy).not.toHaveBeenCalled();
  });

  it('raises an error toast carrying the reason when main rejects the rename, and does not reject itself', async () => {
    installSetTransientLabel(async () => {
      throw new Error("Error invoking remote method 'session:setTransientLabel': Error: Terminal not found");
    });

    // The renderer calls this as `void`, so a rejection leaking out of it would
    // be an unhandled one with no toast.
    await expect(makeSlice().setTransientSessionLabel('term-2', 'Parser work')).resolves.toBeUndefined();

    expect(addToastSpy).toHaveBeenCalledTimes(1);
    expect(addToastSpy).toHaveBeenCalledWith({
      title: "Couldn't rename terminal",
      message: 'Terminal not found.',
      variant: 'error',
    });
  });
});
