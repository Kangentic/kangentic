/**
 * `createSshRunner` (#913) over a Node child standing in for ssh: output and status collected, stdin
 * delivered as text or from a file the child reads for itself, a slow command ended by the timeout.
 * Spawns only the running Node, so Windows and Linux CI both run it. No pty host is registered here,
 * so each run starts in this process; the last block registers one and reads what it is asked for.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createSshRunner } from '../../src/main/remote/link/ssh-run';
import { setOffMainCliSpawner, type CliChildProcess, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';

function runnerFor(script: string) {
  return createSshRunner({ sshPath: process.execPath, args: ['-e', script] });
}

afterEach(() => {
  setOffMainCliSpawner(null);
});

describe('createSshRunner', () => {
  it('collects stdout, stderr and the exit status', async () => {
    const run = runnerFor("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)");
    expect(await run('ignored')).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('delivers stdin given as text, and closes it', async () => {
    const run = runnerFor('process.stdin.pipe(process.stdout)');
    expect((await run('ignored', { stdin: 'text in\n' })).stdout).toBe('text in\n');
  });

  it('closes stdin at once when none is given, so a command that reads it ends', async () => {
    const run = runnerFor("process.stdin.on('end', () => process.stdout.write('eof')); process.stdin.resume();");
    expect((await run('ignored')).stdout).toBe('eof');
  });

  it('delivers a file as stdin byte for byte, to its end, however large', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-run-stdin-'));
    try {
      // Every byte value, repeated past any pipe's buffer: text decoding would change these.
      const bytes = Buffer.alloc(2 * 1024 * 1024, Buffer.from(Array.from({ length: 256 }, (_, value) => value)));
      const filePath = path.join(directory, 'asset.bin');
      fs.writeFileSync(filePath, bytes);
      const run = runnerFor(`
        const hash = require('node:crypto').createHash('sha256');
        let total = 0;
        process.stdin.on('data', (chunk) => { hash.update(chunk); total += chunk.length; });
        process.stdin.on('end', () => process.stdout.write(total + ' ' + hash.digest('hex')));
      `);

      const result = await run('ignored', { stdin: { filePath } });

      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(result).toEqual({ code: 0, stdout: `${bytes.length} ${expected}`, stderr: '' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects when the stdin file cannot be opened, and raises no uncaught exception', async () => {
    const run = runnerFor('process.stdin.resume(); setInterval(() => {}, 1000)');
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      await expect(run('ignored', { stdin: { filePath: path.join(os.tmpdir(), 'no-such-ssh-run-stdin-file') } })).rejects.toThrow(/ENOENT/);
      // Intentional fixed wait: an uncaught exception is raised on a later tick, and non-occurrence cannot be polled.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('keeps a character that arrives split across two chunks whole', async () => {
    // The two bytes of one character, written in separate chunks with a pause between.
    const run = runnerFor("process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 200);");
    expect((await run('ignored')).stdout).toBe('é');
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

describe('createSshRunner with a pty host registered', () => {
  interface HostedRun {
    command: string;
    args: string[];
    options: OffMainCliOptions;
    child: CliChildProcess;
    stdinEnds: Array<string | undefined>;
    stops: unknown[];
  }

  /** Stands in for the host: records what it was asked to start, and hands back a run the test ends. */
  function registerHost(): HostedRun[] {
    const runs: HostedRun[] = [];
    setOffMainCliSpawner((command, args, options) => {
      const stdinEnds: Array<string | undefined> = [];
      const stops: unknown[] = [];
      const child: CliChildProcess = Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null,
        stdout: Object.assign(new EventEmitter(), { resume: () => undefined }),
        stderr: Object.assign(new EventEmitter(), { resume: () => undefined }),
        stdin: Object.assign(new EventEmitter(), { write: () => true, end: (chunk?: string) => { stdinEnds.push(chunk); } }),
        kill: () => true,
        stopTree: (mode?: unknown) => { stops.push(mode); },
      });
      runs.push({ command, args, options, child, stdinEnds, stops });
      return child;
    });
    return runs;
  }

  it('starts ssh there with the remote command last, never detached, and its text stdin sent and closed', async () => {
    const runs = registerHost();
    const run = createSshRunner({ sshPath: '/usr/bin/ssh', args: ['-o', 'BatchMode=yes', 'dev@lab'], env: { KANGENTIC_RUN: 'yes' } });

    const pending = run('uname -s', { stdin: 'input' });
    expect(runs).toHaveLength(1);
    runs[0].child.stdout.emit('data', Buffer.from('Linux\n'));
    runs[0].child.emit('close', 0, null);

    expect(await pending).toEqual({ code: 0, stdout: 'Linux\n', stderr: '' });
    expect(runs[0].command).toBe('/usr/bin/ssh');
    expect(runs[0].args).toEqual(['-o', 'BatchMode=yes', 'dev@lab', 'uname -s']);
    expect(runs[0].options.detached).toBe(false);
    expect(runs[0].options.shell).toBe(false);
    expect(runs[0].options.env.KANGENTIC_RUN).toBe('yes');
    expect(runs[0].options.stdinFile).toBeUndefined();
    expect(runs[0].stdinEnds).toEqual(['input']);
  });

  it('asks the host to open the file as stdin, and writes nothing through main', async () => {
    const runs = registerHost();
    const run = createSshRunner({ sshPath: '/usr/bin/ssh', args: ['dev@lab'] });

    const pending = run('cat > upload', { stdin: { filePath: '/mock/kangentic-host.tar.gz' } });
    runs[0].child.emit('close', 0, null);
    await pending;

    expect(runs[0].options.stdinFile).toBe('/mock/kangentic-host.tar.gz');
    expect(runs[0].stdinEnds).toEqual([]);
  });

  it('stops the whole tree at once on a timeout, and reports the run as stopped', async () => {
    const runs = registerHost();
    const run = createSshRunner({ sshPath: '/usr/bin/ssh', args: ['dev@lab'] });

    const pending = run('sleep 600', { timeoutMs: 50 });
    await expect.poll(() => runs[0].stops).toEqual(['treeNow']);
    runs[0].child.stderr.emit('data', Buffer.from('partial'));
    runs[0].child.emit('close', 255, null);

    const result = await pending;
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('partial');
    expect(result.stderr).toContain('did not finish within');
  });

  it('rejects with the host\'s error when ssh could not be started there', async () => {
    const runs = registerHost();
    const run = createSshRunner({ sshPath: '/usr/bin/ssh', args: ['dev@lab'] });
    const failure = new Error('spawn /usr/bin/ssh ENOENT');

    const pending = run('uname -s');
    runs[0].child.emit('error', failure);
    runs[0].child.emit('close', null, null);

    await expect(pending).rejects.toBe(failure);
  });
});
