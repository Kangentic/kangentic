/**
 * `window.electronAPI.dictation.onWindowBlur` is how the renderer hears the OS
 * window lose focus (push-to-talk ends its hold on it). It must subscribe to
 * TRANSCRIBE_WINDOW_BLUR, call the callback without leaking the IPC event, and
 * return an unsubscribe that removes that same handler, or a remounted
 * `useDictation` would stack listeners and end a later hold twice.
 *
 * Loads the real preload module under a mocked `electron`, as
 * preload-track-renderer-error-context.test.ts does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronAPI } from '../../src/shared/types';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    send: vi.fn(),
    on: electron.on,
    invoke: vi.fn(),
    removeListener: electron.removeListener,
  },
  webUtils: { getPathForFile: vi.fn() },
}));
vi.mock('../../src/preload/diagnostics/console-capture', () => ({
  installConsoleCapture: vi.fn(),
  reportPushCallbackFailure: vi.fn(),
}));

async function loadExposedApi(): Promise<ElectronAPI> {
  vi.resetModules();
  await import('../../src/preload/preload');
  const exposure = electron.exposeInMainWorld.mock.calls.find((call) => call[0] === 'electronAPI');
  if (!exposure) throw new Error('the preload never exposed window.electronAPI');
  return exposure[1] as ElectronAPI;
}

/** The handler the preload registered on the blur channel, from the last call. */
function registeredBlurHandler(): (...args: unknown[]) => void {
  const calls = electron.on.mock.calls.filter((call) => call[0] === IPC.TRANSCRIBE_WINDOW_BLUR);
  const last = calls[calls.length - 1];
  if (!last) throw new Error('no listener on the window blur channel');
  return last[1] as (...args: unknown[]) => void;
}

describe('preload dictation.onWindowBlur', () => {
  beforeEach(() => {
    electron.exposeInMainWorld.mockClear();
    electron.on.mockClear();
    electron.removeListener.mockClear();
  });

  it('calls the callback with no arguments when main sends the blur', async () => {
    const api = await loadExposedApi();
    const callback = vi.fn();
    api.dictation.onWindowBlur(callback);

    registeredBlurHandler()({ sender: 'ipc-event' });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith();
  });

  it('returns an unsubscribe that removes the very handler it registered', async () => {
    const api = await loadExposedApi();
    const unsubscribe = api.dictation.onWindowBlur(vi.fn());
    const handler = registeredBlurHandler();
    expect(electron.removeListener).not.toHaveBeenCalled();

    unsubscribe();

    expect(electron.removeListener).toHaveBeenCalledTimes(1);
    expect(electron.removeListener).toHaveBeenCalledWith(IPC.TRANSCRIBE_WINDOW_BLUR, handler);
  });
});
