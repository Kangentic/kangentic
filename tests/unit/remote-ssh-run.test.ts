/**
 * `createSshRunner` (#913) over a Node child standing in for ssh: output and status collected, stdin
 * delivered as bytes or a stream, a slow command ended by the timeout. Spawns only the running Node,
 * so Windows and Linux CI both run it.
 */
import { describe, expect, it } from 'vitest';
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
