/**
 * The background-shell watcher's process table in the pty host
 * (src/main/pty/host/host-process-table.ts): Toolhelp on Windows, the
 * PowerShell probe for good once a Toolhelp listing fails, `ps` on POSIX. The real
 * Toolhelp listing runs in tests/unit/task-process-readers.test.ts on Windows.
 */

import { describe, it, expect, vi } from 'vitest';
import { HostProcessTable, toProcessInfo } from '../../src/main/pty/host/host-process-table';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';

function fakeProbe(table: ProcessInfo[]): ProcessTreeProbe & { listAllProcesses: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return {
    isAlive: () => true,
    listAllProcesses: vi.fn(async () => table),
    listDescendants: async () => [],
    dispose: vi.fn(),
  };
}

describe('HostProcessTable', () => {
  it('answers on Windows from Toolhelp, in the shape the PowerShell probe parsed', async () => {
    const createFallbackProbe = vi.fn(() => fakeProbe([]));
    const table = new HostProcessTable({
      platform: 'win32',
      listToolhelp: async () => [
        { pid: 4100, ppid: 4000, image: 'Bash.EXE' },
        { pid: 4200, ppid: 4100, image: 'OpenConsole.exe' },
        { pid: 4300, ppid: 4100, image: 'node' },
      ],
      createFallbackProbe,
    });
    expect(await table.list()).toEqual([
      { pid: 4100, ppid: 4000, comm: 'bash' },
      { pid: 4200, ppid: 4100, comm: 'openconsole' },
      { pid: 4300, ppid: 4100, comm: 'node' },
    ]);
    // No PowerShell child is started while Toolhelp answers.
    expect(createFallbackProbe).not.toHaveBeenCalled();
  });

  it('passes an empty snapshot through as "no table this cycle"', async () => {
    const createFallbackProbe = vi.fn(() => fakeProbe([]));
    const table = new HostProcessTable({ platform: 'win32', listToolhelp: async () => [], createFallbackProbe });
    expect(await table.list()).toEqual([]);
    expect(createFallbackProbe).not.toHaveBeenCalled();
  });

  it('falls back to the PowerShell probe for good when koffi cannot load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = fakeProbe([{ pid: 4100, ppid: 4000, comm: 'bash' }]);
    const listToolhelp = vi.fn(async () => { throw new Error('Cannot find module koffi'); });
    const table = new HostProcessTable({ platform: 'win32', listToolhelp, createFallbackProbe: () => probe });
    expect(await table.list()).toEqual([{ pid: 4100, ppid: 4000, comm: 'bash' }]);
    expect(await table.list()).toEqual([{ pid: 4100, ppid: 4000, comm: 'bash' }]);
    expect(listToolhelp).toHaveBeenCalledTimes(1);
    expect(probe.listAllProcesses).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    table.dispose();
    expect(probe.dispose).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('runs the POSIX probe off Windows and never touches Toolhelp', async () => {
    const listToolhelp = vi.fn(async () => []);
    const probe = fakeProbe([{ pid: 2, ppid: 1, comm: 'zsh' }]);
    const table = new HostProcessTable({ platform: 'linux', listToolhelp, createFallbackProbe: () => probe });
    expect(await table.list()).toEqual([{ pid: 2, ppid: 1, comm: 'zsh' }]);
    expect(listToolhelp).not.toHaveBeenCalled();
  });

  it('normalizes a Toolhelp row the way the PowerShell CSV parser did', () => {
    expect(toProcessInfo({ pid: 1, ppid: 0, image: 'PowerShell.exe' })).toEqual({ pid: 1, ppid: 0, comm: 'powershell' });
    expect(toProcessInfo({ pid: 2, ppid: 0, image: 'my.exe.helper.exe' })).toEqual({ pid: 2, ppid: 0, comm: 'my.exe.helper' });
  });
});
