/**
 * `createSshRunner` (#913) over a Node child standing in for ssh: output and status collected, stdin
 * delivered as bytes or a stream, a slow command ended by the timeout. Spawns only the running Node,
 * so Windows and Linux CI both run it.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { createSshRunner } from '../../src/main/remote/link/ssh-run';

function runnerFor(script: string) {
  return createSshRunner({ sshPath: process.execPath, args: ['-e', script] });
}

describe('createSshRunner', () => {
  it('collects stdout, stderr and the exit status', async () => {
    const run = runnerFor("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)");
    expect(await run('ignored')).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('delivers stdin given as bytes', async () => {
    const run = runnerFor('process.stdin.pipe(process.stdout)');
    expect((await run('ignored', { stdin: Buffer.from('bytes in') })).stdout).toBe('bytes in');
  });

  it('delivers stdin given as a stream, to its end', async () => {
    const run = runnerFor('process.stdin.pipe(process.stdout)');
    const pieces = Array.from({ length: 50 }, (_, index) => Buffer.from(`piece ${index};`));
    const result = await run('ignored', { stdin: Readable.from(pieces) });
    expect(result.stdout).toBe(pieces.map((piece) => piece.toString()).join(''));
  });

  // A stream with no error listener would throw out of the pty host, and a pipe left open would leave ssh waiting.
  it('rejects with the error of a stdin stream that fails, ends the child, and raises no uncaught exception', async () => {
    let child: ChildProcess | null = null;
    const run = createSshRunner({
      sshPath: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
      spawnProcess: ((...spawnArguments: Parameters<typeof spawn>) => {
        child = spawn(...spawnArguments);
        return child;
      }) as typeof spawn,
    });
    const failure = new Error('the file being sent went away');
    const failing = new Readable({ read() { this.destroy(failure); } });
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      await expect(run('ignored', { stdin: failing })).rejects.toBe(failure);
      const started = child as ChildProcess | null;
      if (!started) throw new Error('the runner never started a child');
      await vi.waitFor(() => expect(started.exitCode !== null || started.signalCode !== null).toBe(true), { timeout: 5000 });
      // Intentional fixed wait: an uncaught exception is raised on a later tick, and non-occurrence cannot be polled.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('ends a command that outlives its timeout, with a code of null and a sentence saying so', async () => {
    const run = runnerFor('setInterval(() => {}, 1000)');
    const result = await run('ignored', { timeoutMs: 300 });
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('did not finish within');
  });

  it('rejects when ssh cannot be started', async () => {
    const run = createSshRunner({ sshPath: process.execPath.replace(/[^\\/]+$/, 'no-such-ssh'), args: [] });
    await expect(run('ignored')).rejects.toThrow();
  });
});
