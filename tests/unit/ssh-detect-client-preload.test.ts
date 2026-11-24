/**
 * `window.electronAPI.ssh.detectClient(options)` forwards its options to main.
 *
 * Why it needs its own test: a zero-argument `detectClient: () => invoke(channel)` is
 * assignable to `(options?: { refresh?: boolean }) => Promise<...>`, so `tsc` passes if the
 * preload drops the argument. The UI tier runs over the mock bridge, so the SSH tab's
 * `refresh: true` would stop reaching main with every test green, and a client installed
 * while the app runs would read "ssh not found" until a restart.
 *
 * This loads the real preload under a mocked `electron` (same harness as
 * `preload-track-renderer-error-context.test.ts`) and calls the API it exposes.
 *
 * Red-green: make the preload's `detectClient` stop passing `options` to `ipcRenderer.invoke`
 * and the first test fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronAPI } from '../../src/shared/types';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    send: vi.fn(),
    on: vi.fn(),
    invoke: electron.invoke,
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));
// Patches window.console and registers window listeners at module scope.
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

describe('preload ssh.detectClient forwards its options argument', () => {
  beforeEach(() => {
    electron.exposeInMainWorld.mockClear();
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValue({ found: true });
  });

  it('invokes the channel with { refresh: true } unchanged', async () => {
    const api = await loadExposedApi();

    await api.ssh.detectClient({ refresh: true });

    expect(electron.invoke).toHaveBeenCalledWith(IPC.SSH_DETECT_CLIENT, { refresh: true });
  });

  it('invokes the channel with no options when called with none', async () => {
    const api = await loadExposedApi();

    await api.ssh.detectClient();

    const call = electron.invoke.mock.calls.find((invoked) => invoked[0] === IPC.SSH_DETECT_CLIENT);
    expect(call).toBeDefined();
    expect(call?.[1]).toBeUndefined();
  });
});
