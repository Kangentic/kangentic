/**
 * `spawnCli` (`src/main/agent/shared/auto-name.ts`) starts an agent CLI run in
 * the pty host when one is registered (`off-main-cli.ts`), and locally only
 * when none is.
 *
 * The integration case runs the whole route with a real child process: a
 * headless run through `runCliPrintSummarize` -> `spawnCli` ->
 * `spawnOffMainCli` -> `PtyHostClient.spawnCli` -> the host's
 * `HostCliProcesses` -> back as events, streamed chunks included. Only the
 * transport between the two halves is a direct function call here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runCliPrintSummarize, spawnCli, stopAllCliRuns, stopCli } from '../../src/main/agent/shared/auto-name';
import { HostCliProcesses } from '../../src/main/pty/host/host-cli-processes';
import { PtyHostClient, type PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import { setOffMainCliSpawner, type CliChildProcess, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';

afterEach(() => {
  stopAllCliRuns();
  setOffMainCliSpawner(null);
});

/** A run the drop-in hands back: records its stop. */
function fakeRemoteChild(): CliChildProcess & { stops: number } {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: Object.assign(new EventEmitter(), { resume: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { resume: () => undefined }),
    stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
    kill: () => true,
    stops: 0,
    stopTree: () => { child.stops += 1; },
  });
  return child;
}

describe('spawnCli with a pty host registered', () => {
  it('hands the run to the host with the CLI, its args, cwd, merged env and group lead', () => {
    const calls: Array<{ command: string; args: string[]; options: OffMainCliOptions }> = [];
    const remote = fakeRemoteChild();
    setOffMainCliSpawner((command, args, options) => {
      calls.push({ command, args, options });
      return remote;
    });

    const child = spawnCli('/usr/local/bin/agent', ['-p', '--json'], '/work/tree', { KANGENTIC_RUN: 'yes' });

    expect(child).toBe(remote);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/usr/local/bin/agent');
    expect(calls[0].args).toEqual(['-p', '--json']);
    expect(calls[0].options.cwd).toBe('/work/tree');
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.detached).toBe(process.platform !== 'win32');
    expect(calls[0].options.env.KANGENTIC_RUN).toBe('yes');
    // The rest of main's environment comes along, with no unset entries.
    expect(Object.values(calls[0].options.env).every((value) => typeof value === 'string')).toBe(true);
    expect(Object.keys(calls[0].options.env).length).toBeGreaterThan(1);
  });

  it('stops a host run through the host, and the quit path reaches it', () => {
    const remote = fakeRemoteChild();
    setOffMainCliSpawner(() => remote);
    const child = spawnCli('/usr/local/bin/agent', [], '/work');
    stopCli(child);
    expect(remote.stops).toBe(1);
    stopAllCliRuns();
    expect(remote.stops).toBe(2);
  });

  it('forgets a host run once it exits, so quit does not stop it again', () => {
    const remote = fakeRemoteChild();
    setOffMainCliSpawner(() => remote);
    spawnCli('/usr/local/bin/agent', [], '/work');
    remote.emit('exit', 0, null);
    stopAllCliRuns();
    expect(remote.stops).toBe(0);
  });

  it('runs a headless print end to end through the host, streaming its output', async () => {
    let deliverToMain: (event: PtyHostEvent) => void = () => undefined;
    const hostProcesses = new HostCliProcesses((event) => deliverToMain(event), undefined, '/nonexistent/kangentic-host-binary');
    const transport: PtyHostTransport = {
      post: (command) => {
        if (command.type === 'cliSpawn') hostProcesses.start(command.params);
        else if (command.type === 'cliWrite') hostProcesses.write(command.processId, command.data);
        else if (command.type === 'cliEndInput') hostProcesses.endInput(command.processId, command.data);
        else if (command.type === 'cliStop') hostProcesses.stop(command.processId);
      },
      request: () => Promise.reject(new Error('no requests here')),
      setEventListener: (listener) => { deliverToMain = listener; },
      hostPid: null,
      shutdown: () => hostProcesses.stopAll(),
    };
    const client = new PtyHostClient(transport);
    const spawner = vi.fn((command: string, args: string[], options: OffMainCliOptions) => client.spawnCli(command, args, options));
    setOffMainCliSpawner(spawner);

    const chunks: string[] = [];
    const title = await runCliPrintSummarize({
      cliPath: process.execPath,
      args: ['-e', `
        let prompt = '';
        process.stdin.on('data', (chunk) => { prompt += chunk; });
        process.stdin.on('end', () => {
          process.stdout.write('Fix the ');
          setTimeout(() => process.stdout.write(prompt.includes('resize') ? 'resize race' : 'unknown'), 20);
        });
      `],
      prompt: 'the terminal resize race on Windows',
      cwd: process.cwd(),
      timeoutMs: 15_000,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(title).toBe('Fix the resize race');
    expect(chunks.join('')).toBe('Fix the resize race');
    expect(hostProcesses.liveCount).toBe(0);
  }, 20_000);
});
