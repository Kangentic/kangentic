/**
 * Main's handle on an agent CLI run in the pty host (`RemoteCliProcess`,
 * `PtyHostClient.spawnCli`): what `spawnCli` returns when a host is registered.
 * Its consumers (`runCliPrint`, the warm answer session, OpenCode's session
 * delete) were written against a local child process, so the handle must
 * emit the same events in the same order, and a host crash must end the run
 * instead of leaving its caller waiting.
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostCommand, PtyHostEvent } from '../../src/main/pty/host/protocol';
import type { PtyHostLifecycleListener, PtyHostTransport } from '../../src/main/pty/host/pty-host-client';

function fakeHost() {
  const posted: PtyHostCommand[] = [];
  let deliver: (event: PtyHostEvent) => void = () => undefined;
  let lifecycle: PtyHostLifecycleListener | null = null;
  const transport: PtyHostTransport = {
    post: (command) => { posted.push(command); },
    request: () => Promise.reject(new Error('no requests here')),
    setEventListener: (listener) => { deliver = listener; },
    setLifecycleListener: (listener) => { lifecycle = listener; },
    hostPid: 1234,
    shutdown: () => undefined,
  };
  const client = new PtyHostClient(transport);
  return {
    client,
    posted,
    emit: (event: PtyHostEvent) => deliver(event),
    hostDown: () => lifecycle?.onHostDown(),
  };
}

const OPTIONS = { cwd: '/work', shell: false, env: { PATH: '/bin' }, detached: false };

describe('RemoteCliProcess', () => {
  it('posts the spawn at once and returns the handle before the host answers', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', ['-p'], OPTIONS);
    expect(child.pid).toBeUndefined();
    expect(host.posted).toEqual([{ type: 'cliSpawn', params: { processId: child.processId, command: 'claude', args: ['-p'], ...OPTIONS } }]);
  });

  it('emits spawn, stdout and stderr Buffers, exit, then close, in the host order', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', [], OPTIONS);
    const seen: string[] = [];
    child.on('spawn', () => seen.push(`spawn ${child.pid}`));
    child.stdout.on('data', (chunk: Buffer) => seen.push(`stdout ${Buffer.isBuffer(chunk)} ${chunk.toString('utf-8')}`));
    child.stderr.on('data', (chunk: Buffer) => seen.push(`stderr ${chunk.toString('utf-8')}`));
    child.on('exit', (code, signal) => seen.push(`exit ${code} ${signal} ${child.exitCode}`));
    child.on('close', (code) => seen.push(`close ${code}`));

    const processId = child.processId;
    host.emit({ type: 'cliSpawned', processId, pid: 4321 });
    // The utility process structured-clones a Buffer into a plain Uint8Array.
    host.emit({ type: 'cliData', processId, stream: 'stdout', data: new Uint8Array(Buffer.from('hello ')) });
    host.emit({ type: 'cliData', processId, stream: 'stderr', data: new Uint8Array(Buffer.from('warn')) });
    host.emit({ type: 'cliData', processId, stream: 'stdout', data: Buffer.from('world') });
    host.emit({ type: 'cliExit', processId, code: 0, signal: null });
    host.emit({ type: 'cliClose', processId, code: 0, signal: null });
    // A late event for a finished run reaches nobody.
    host.emit({ type: 'cliData', processId, stream: 'stdout', data: Buffer.from('late') });

    expect(seen).toEqual([
      'spawn 4321',
      'stdout true hello ',
      'stderr warn',
      'stdout true world',
      'exit 0 null 0',
      'close 0',
    ]);
  });

  it('writes and ends stdin as commands, and ends it once', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', [], OPTIONS);
    host.posted.length = 0;
    expect(child.stdin.write('{"type":"user"}\n')).toBe(true);
    child.stdin.end('last');
    child.stdin.end();
    expect(child.stdin.write('after end')).toBe(false);
    expect(host.posted).toEqual([
      { type: 'cliWrite', processId: child.processId, data: '{"type":"user"}\n' },
      { type: 'cliEndInput', processId: child.processId, data: 'last' },
    ]);
  });

  it('stops its tree through the host, and not once it has exited', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', [], OPTIONS);
    host.posted.length = 0;
    child.stopTree();
    expect(child.kill('SIGTERM')).toBe(true);
    expect(host.posted).toEqual([
      { type: 'cliStop', processId: child.processId },
      { type: 'cliStop', processId: child.processId },
    ]);
    host.emit({ type: 'cliExit', processId: child.processId, code: 1, signal: null });
    host.posted.length = 0;
    child.stopTree();
    expect(host.posted).toEqual([]);
  });

  it('reports a failed start as an error event with its code', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('missing-cli', [], OPTIONS);
    const errors: NodeJS.ErrnoException[] = [];
    child.on('error', (error: NodeJS.ErrnoException) => errors.push(error));
    host.emit({ type: 'cliError', processId: child.processId, error: { message: 'spawn missing-cli ENOENT', code: 'ENOENT' } });
    host.emit({ type: 'cliClose', processId: child.processId, code: null, signal: null });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('ENOENT');
  });

  it('does not throw for an error nobody listens to', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', [], OPTIONS);
    expect(() => host.emit({ type: 'cliError', processId: child.processId, error: { message: 'boom' } })).not.toThrow();
  });

  it('ends every live run when the host dies: error, exit, then close', () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', [], OPTIONS);
    const finished = host.client.spawnCli('claude', [], OPTIONS);
    host.emit({ type: 'cliClose', processId: finished.processId, code: 0, signal: null });
    const seen: string[] = [];
    child.on('error', (error: Error) => seen.push(`error ${error.message}`));
    child.on('exit', (code, signal) => seen.push(`exit ${code} ${signal}`));
    child.on('close', () => seen.push('close'));
    finished.on('close', () => seen.push('finished closed again'));

    host.hostDown();

    expect(seen).toEqual([
      'error The pty host stopped while the agent was running',
      'exit null SIGKILL',
      'close',
    ]);
    // Never restarted on the new host.
    expect(host.posted.filter((command) => command.type === 'cliSpawn')).toHaveLength(2);
  });

  it('stops the CLI the dead host left running', async () => {
    const host = fakeHost();
    const child = host.client.spawnCli('claude', [], OPTIONS);
    // Stand-in for the orphaned CLI: a real process this test owns.
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    const orphanExited = new Promise<void>((resolve) => orphan.once('exit', () => resolve()));
    await new Promise<void>((resolve) => orphan.once('spawn', () => resolve()));
    host.emit({ type: 'cliSpawned', processId: child.processId, pid: orphan.pid ?? null });
    child.on('error', () => undefined);

    host.hostDown();

    await orphanExited;
    expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
  }, 20_000);
});
