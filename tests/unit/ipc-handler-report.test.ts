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

const { installIpcHandlerReporting, resetIpcHandlerReportingForTests, rejectionToRethrow, IPC_HANDLER_KEY_CAP } = await import('../../src/main/analytics/ipc-handler-report');
const { markReported, sendHandledFailure } = await import('../../src/main/analytics/handled-report');
const { REPORTED_FAILURE_MARKER } = await import('../../src/shared/reported-failure-marker');
const { RefusalError } = await import('../../src/shared/refusal');
const { IPC_REJECTION_DUPLICATE_PATTERN } = await import('../../src/shared/ipc-rejection');
const { GitCommandError } = await import('../../src/main/git/git-command-error');

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

  // Sentry DESKTOP-4A: `git:diffFiles` failed, and the event said only `Error`.
  // Every git failure throws from one line, so only the cause tells two apart.
  it('names what git refused on, once per cause, and sends nothing git wrote', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    const refusal = (stderr: string): Error => new GitCommandError({ stdout: '', stderr, exitCode: 128 });
    const unbornHead = "fatal: ambiguous argument 'fix-acme-billing': unknown revision or path not in the working tree.\n";
    const failures = [refusal(unbornHead), refusal(unbornHead), refusal('fatal: bad object deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n')];
    target.handle('git:diffFiles', () => { throw failures.shift(); });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(target.registered.get('git:diffFiles')?.({})).rejects.toBeInstanceOf(GitCommandError);
    }

    expect(reportHandledError).toHaveBeenCalledTimes(2);
    const calls = reportHandledError.mock.calls as Array<[Error, Record<string, string>]>;
    expect(calls[0][0].message).toBe('Handled ipc_handler failure: GitCommandError');
    expect(calls[0][1]).toMatchObject({ source: 'ipc_handler', channel: 'git:diffFiles', error_name: 'GitCommandError', git_cause: 'unknown_revision' });
    expect(calls[1][1]).toMatchObject({ git_cause: 'missing_object' });
    expect(JSON.stringify(calls.map(([sent, tags]) => [sent.message, sent.stack, tags]))).not.toMatch(/acme|deadbeef|fatal/);
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

  it('reports past the default 25 keys and stops at IPC_HANDLER_KEY_CAP', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    const total = IPC_HANDLER_KEY_CAP + 5;
    for (let index = 0; index < total; index += 1) {
      target.handle(`channel:${index}`, () => { throw new TypeError('defect'); });
      await expect(target.registered.get(`channel:${index}`)?.({})).rejects.toBeInstanceOf(TypeError);
    }
    expect(IPC_HANDLER_KEY_CAP).toBeGreaterThan(25);
    expect(reportHandledError).toHaveBeenCalledTimes(IPC_HANDLER_KEY_CAP);
  });

  it('passes a result through untouched', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    target.handle('config:get', (_event, key) => ({ key }));
    await expect(target.registered.get('config:get')?.({}, 'theme')).resolves.toEqual({ key: 'theme' });
  });

  // #1188: the renderer's failure toast says the issue was reported only when
  // the rejection carries the marker, and the marker means Sentry took it.
  it('marks a rejection whose report Sentry took, its latched repeat too, and nothing else', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    reportHandledError.mockReturnValue(true);
    const throwSite = (): Error => new TypeError('handler defect');
    target.handle('session:resume', () => { throw throwSite(); });

    const first = await target.registered.get('session:resume')?.({}).catch((error: unknown) => error);
    const repeat = await target.registered.get('session:resume')?.({}).catch((error: unknown) => error);
    expect((first as Error).message).toBe(`handler defect${REPORTED_FAILURE_MARKER}`);
    expect((repeat as Error).message).toBe(`handler defect${REPORTED_FAILURE_MARKER}`);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
  });

  it('leaves the rejection unmarked when reporting is off, for a refusal, and for a thrown string', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    reportHandledError.mockReturnValue(false);
    target.handle('task:move', () => { throw new TypeError('reporting off'); });
    const unsent = await target.registered.get('task:move')?.({}).catch((error: unknown) => error);
    expect((unsent as Error).message).toBe('reporting off');

    reportHandledError.mockReturnValue(true);
    target.handle('session:resumeDone', () => { throw new RefusalError('The task is in Done.'); });
    const refused = await target.registered.get('session:resumeDone')?.({}).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('The task is in Done.');

    target.handle('legacy:string', () => { throw 'plain text'; });
    await expect(target.registered.get('legacy:string')?.({})).rejects.toBe('plain text');
  });

  it('marks an error an inner reporter sent, as a copy that leaves the original as it was', async () => {
    const target = fakeIpcMain();
    installIpcHandlerReporting(target as never);
    reportHandledError.mockReturnValue(true);
    const inner = new TypeError('sent by the workflow reporter');
    sendHandledFailure('workflow', inner);
    reportHandledError.mockClear();
    target.handle('workflows:start', () => { throw inner; });
    const rejection = await target.registered.get('workflows:start')?.({}).catch((error: unknown) => error);
    expect(rejection).not.toBe(inner);
    expect(String(rejection)).toBe(`TypeError: sent by the workflow reporter${REPORTED_FAILURE_MARKER}`);
    expect(inner.message).toBe('sent by the workflow reporter');
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('rejectionToRethrow', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetIpcHandlerReportingForTests();
  });

  it('returns the same object for an error that was not sent, one already marked, and a non-Error', () => {
    const unsent = new TypeError('never sent');
    expect(rejectionToRethrow(unsent)).toBe(unsent);

    reportHandledError.mockReturnValue(true);
    const alreadyMarked = new TypeError(`sent and marked${REPORTED_FAILURE_MARKER}`);
    sendHandledFailure('workflow', alreadyMarked);
    expect(rejectionToRethrow(alreadyMarked)).toBe(alreadyMarked);

    const plainObject = { message: 'not an error' };
    expect(rejectionToRethrow(plainObject)).toBe(plainObject);
    expect(rejectionToRethrow('text')).toBe('text');
  });

  it('returns a marked copy of a sent error that keeps its name and stack', () => {
    reportHandledError.mockReturnValue(true);
    const sent = new RangeError('sent once');
    sendHandledFailure('workflow', sent);

    const copy = rejectionToRethrow(sent) as Error;

    expect(copy).not.toBe(sent);
    expect(copy.message).toBe(`sent once${REPORTED_FAILURE_MARKER}`);
    expect(copy.name).toBe(sent.name);
    expect(copy.stack).toBe(sent.stack);
    expect(sent.message).toBe('sent once');
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

  it('wraps every handler: none registers at import time, ahead of the patch, and none uses handleOnce', () => {
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/\bipcMain\.handleOnce\(/.test(text)) offenders.push(`${full}: handleOnce, which the patch does not wrap`);
        // A column-0 registration runs when the module is imported, which is before
        // index.ts's body installs the patch, except in index.ts itself after it.
        if (!full.endsWith(path.join('src', 'main', 'index.ts')) && /^ipcMain\.handle\(/m.test(text)) {
          offenders.push(`${full}: registers at import time`);
        }
      }
    };
    walk(path.join(__dirname, '../../src/main'));
    expect(offenders).toEqual([]);
    const firstTopLevelHandle = indexSource.search(/^ipcMain\.handle\(/m);
    expect(firstTopLevelHandle).toBeGreaterThan(indexSource.indexOf('installIpcHandlerReporting(ipcMain);'));
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
