/**
 * `window.electronAPI.analytics.trackRendererError(message, context)` forwards
 * its context to the main process.
 *
 * Why this needs its own test: TypeScript's structural typing allows a function
 * with FEWER parameters to satisfy an interface that declares an optional
 * trailing parameter - `(message: string) => void` is assignable to
 * `ElectronAPI['analytics']['trackRendererError']`
 * (`(message: string, context?: RendererErrorContext) => void`). So `tsc` would
 * not catch a regression where preload silently stopped forwarding `context`,
 * and neither would the two tests that touch this data flow:
 * `tests/unit/panel-error-boundary.test.ts` stubs the API directly (never loads
 * preload.ts), and `tests/unit/register-all-idempotency.test.ts` invokes the
 * registered `ipcMain.on` callback directly (never reaches `ipcRenderer.send`).
 *
 * This loads the real preload module under a mocked `electron` and calls the API
 * it exposes. Everything the module touches at load (the console capture, the
 * pty port client, the port request) is mocked or harmless here, so the call
 * that carries the error across the process boundary runs for real.
 *
 * Red-green: make the preload's `trackRendererError` drop `context` from its
 * `ipcRenderer.send` call and the first test fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronAPI, RendererErrorContext } from '../../src/shared/types';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    send: electron.send,
    on: vi.fn(),
    invoke: vi.fn(),
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

describe('preload analytics.trackRendererError forwards its context argument', () => {
  beforeEach(() => {
    electron.exposeInMainWorld.mockClear();
    electron.send.mockClear();
  });

  it('sends the channel, the message and the context to the main process, in that order', async () => {
    const api = await loadExposedApi();
    const context: RendererErrorContext = { boundary: 'panel', panel: 'Changes panel' };

    api.analytics.trackRendererError('Cannot read properties of undefined', context);

    expect(electron.send).toHaveBeenCalledWith(IPC.TRACK_RENDERER_ERROR, 'Cannot read properties of undefined', context);
  });

  it('sends an absent context as absent, so main reports a bare error', async () => {
    const api = await loadExposedApi();

    api.analytics.trackRendererError('boom');

    const call = electron.send.mock.calls.find((sent) => sent[0] === IPC.TRACK_RENDERER_ERROR);
    expect(call?.[1]).toBe('boom');
    expect(call?.[2]).toBeUndefined();
  });
});
