/**
 * The IPC wrap (`ipc-handler-report.ts`) is the one place a defect from any of the
 * ~329 `ipcMain.handle` handlers reaches Sentry. These pin that it reports a defect
 * once with no user text, skips a refusal and a marked error, always rethrows, and
 * stays installed in production ahead of the diagnostics recorder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { installIpcHandlerReporting, resetIpcHandlerReportingForTests } = await import('../../src/main/analytics/ipc-handler-report');
const { markReported } = await import('../../src/main/analytics/handled-report');
const { RefusalError } = await import('../../src/shared/refusal');
const { IPC_REJECTION_DUPLICATE_PATTERN } = await import('../../src/shared/ipc-rejection');

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpcMain(): { handle: (channel: string, listener: Listener) => void; registered: Map<string, Listener> } {
  const registered = new Map<string, Listener>();
  return { handle: (channel, listener) => { registered.set(channel, listener); }, registered };
}

describe('installIpcHandlerReporting', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetIpcHandlerReportingForTests();
  });

  it('reports a defect once, tagged with its channel, and rethrows it unchanged', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    const defect = new TypeError("Cannot read properties of undefined (reading 'title') in task Fix Acme billing");
    target.handle('task:move', () => { throw defect; });

    await expect(target.registered.get('task:move')?.({}, 'arg')).rejects.toBe(defect);
    await expect(target.registered.get('task:move')?.({}, 'arg')).rejects.toBe(defect);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(sent.message).toBe('Handled ipc_handler failure: TypeError');
    expect(tags).toMatchObject({ source: 'ipc_handler', channel: 'task:move', error_name: 'TypeError' });
  });

  it('reports a plain Error from a handler, which is read as a defect now that refusals are typed', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    target.handle('session:resume', async () => { throw new Error('Session resume failed - session not in manager'); });
    await expect(target.registered.get('session:resume')?.({})).rejects.toThrow('session not in manager');
    expect(reportHandledError).toHaveBeenCalledTimes(1);
  });

  it('skips a refusal, an abort, the network and an error another reporter sent', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    const marked = new RangeError('already sent');
    markReported(marked);
    const offline = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' });
    const throws: unknown[] = [new RefusalError('No project is currently open'), new DOMException('aborted', 'AbortError'), offline, marked];
    throws.forEach((error, index) => target.handle(`channel:${index}`, () => { throw error; }));

    for (let index = 0; index < throws.length; index += 1) {
      await expect(target.registered.get(`channel:${index}`)?.({})).rejects.toBe(throws[index]);
    }
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('passes a result through untouched', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    target.handle('config:get', (_event, key) => ({ key }));
    await expect(target.registered.get('config:get')?.({}, 'theme')).resolves.toEqual({ key: 'theme' });
  });
});

describe('the production install', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');

  it('is installed on ipcMain, outside any dev gate, before the recorder and every registration', () => {
    const install = indexSource.indexOf('installIpcHandlerReporting(ipcMain);');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(indexSource.indexOf('installDiagnostics({'));
    expect(install).toBeLessThan(indexSource.indexOf('registerAllIpc('));
    // Top level, not inside an `if (__KANGENTIC_DEV__)` block.
    const lineStart = indexSource.lastIndexOf('\n', install) + 1;
    expect(indexSource.slice(lineStart, install)).toBe('');
  });
});

describe('the renderer duplicate filter', () => {
  it.each([
    "Error invoking remote method 'task:move': TypeError: x is not a function",
    "Error invoking remote method 'project:open': RefusalError: No project is currently open",
    "Error invoking remote method 'session:resume': Error: Session resume failed",
  ])('drops a rejection main already saw: %s', (message) => {
    expect(IPC_REJECTION_DUPLICATE_PATTERN.test(message)).toBe(true);
  });

  it.each([
    "Error invoking remote method 'new:channel': Error: No handler registered for 'new:channel'",
    "Error invoking remote method 'board:get': Error: An object could not be cloned.",
    'TypeError: x is not a function',
  ])('keeps what never reached a handler, or is not an IPC rejection: %s', (message) => {
    expect(IPC_REJECTION_DUPLICATE_PATTERN.test(message)).toBe(false);
  });
});
