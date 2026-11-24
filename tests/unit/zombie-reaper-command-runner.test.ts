import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));

vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>()),
  execFileAsync: execFileAsyncMock,
}));

import { scanAllProcesses, scanLivePids } from '../../src/main/git/zombie-reaper';

/**
 * `runCommandWithTimeout` is private. `scanAllProcesses` is the exported path that lets
 * its mapped error out (it has no catch), and it runs `powershell` on Windows and `ps`
 * elsewhere. The rejections below have the shape `execFileAsync` rejects with in
 * `off-main-exec.ts` (`toError`): an Error with code, killed, signal and stderr.
 */
const EXPECTED_COMMAND = process.platform === 'win32' ? 'powershell' : 'ps';
const ONE_PROCESS_STDOUT = process.platform === 'win32'
  ? '[{"ProcessId":123,"ParentProcessId":1,"CommandLine":"node worker.js"}]'
  : '123 1 node worker.js\n';
const SCAN_TIMEOUT_MS = 4321;

function rejection(fields: { code?: number | string; killed?: boolean; signal?: string | null; stderr?: string }): Error {
  const error = new Error('Command failed') as Error & {
    code?: number | string;
    killed?: boolean;
    signal?: string | null;
    stderr?: string;
  };
  error.code = fields.code;
  error.killed = fields.killed ?? false;
  error.signal = fields.signal ?? null;
  error.stderr = fields.stderr ?? '';
  return error;
}

describe('zombie-reaper command runner (through scanAllProcesses)', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns stdout to the parser and hands execFileAsync the command, args and options', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: ONE_PROCESS_STDOUT, stderr: '' });

    const rows = await scanAllProcesses(SCAN_TIMEOUT_MS);

    expect(rows.map((row) => row.pid)).toEqual([123]);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileAsyncMock.mock.calls[0];
    expect(command).toBe(EXPECTED_COMMAND);
    expect(Array.isArray(args)).toBe(true);
    expect(options).toEqual({
      timeout: SCAN_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  });

  it('maps a timeout to "<command> timed out after <ms>ms" and keeps the original as cause', async () => {
    const original = rejection({ killed: true, signal: 'SIGTERM' });
    execFileAsyncMock.mockRejectedValue(original);

    const failure = await scanAllProcesses(SCAN_TIMEOUT_MS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`${EXPECTED_COMMAND} timed out after ${SCAN_TIMEOUT_MS}ms`);
    expect((failure as Error).cause).toBe(original);
  });

  it('maps a non-zero exit to "<command> exited with code <n>: <trimmed stderr>" and keeps the cause', async () => {
    const original = rejection({ code: 3, stderr: '  access denied\n' });
    execFileAsyncMock.mockRejectedValue(original);

    const failure = await scanAllProcesses(SCAN_TIMEOUT_MS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`${EXPECTED_COMMAND} exited with code 3: access denied`);
    expect((failure as Error).cause).toBe(original);
  });

  it('rethrows a spawn error such as ENOENT unchanged', async () => {
    const original = rejection({ code: 'ENOENT' });
    execFileAsyncMock.mockRejectedValue(original);

    const failure = await scanAllProcesses(SCAN_TIMEOUT_MS).catch((error: unknown) => error);

    expect(failure).toBe(original);
  });

  it('lets the live-pid scan treat a timeout and an exit as an empty set, and read a good run', async () => {
    execFileAsyncMock.mockRejectedValueOnce(rejection({ killed: true, signal: 'SIGTERM' }));
    expect((await scanLivePids(SCAN_TIMEOUT_MS)).size).toBe(0);

    execFileAsyncMock.mockRejectedValueOnce(rejection({ code: 1, stderr: 'nope' }));
    expect((await scanLivePids(SCAN_TIMEOUT_MS)).size).toBe(0);

    execFileAsyncMock.mockResolvedValueOnce({ stdout: ONE_PROCESS_STDOUT, stderr: '' });
    expect([...(await scanLivePids(SCAN_TIMEOUT_MS))]).toEqual([123]);
  });
});
