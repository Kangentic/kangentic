/**
 * A file crossing to or from a host through `runCommand` (`remote/host-transfer.ts`). It is what carries an
 * attachment, a screenshot and a dropped file, so a lost byte or a path outside the host's home has to fail here,
 * on the real scripts through the helper's real command runner, not a copy of what they do.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostFileSizes, HostTransferError, readHostBytes, writeHostBytes, type HostCommandAccess } from '../../src/main/remote/host-transfer';
import { runHostCommand } from '../../src/main/remote/helper/host-command';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

/** A request or reply must fit a frame's JSON body. */
const FRAME_JSON_BYTES = 256 * 1024;

function answering(result: Partial<HostCommandResult>): HostCommandAccess {
  return { runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...result }) };
}

describe('an answer that is not the file', () => {
  it('reads a link that dropped as an error, never as a file that is not there', async () => {
    const access: HostCommandAccess = { runCommand: async () => { throw new Error('host unreachable'); } };
    await expect(readHostBytes(access, '/home/dev/a.png', 1024)).rejects.toThrow(/host unreachable/);
    await expect(readHostBytes(access, '/home/dev/a.png', 1024)).rejects.toBeInstanceOf(HostTransferError);
  });

  it('reads a timeout and a shell that never ran the script as errors', async () => {
    await expect(readHostBytes(answering({ code: null, timedOut: true }), '/home/dev/a.png', 1024)).rejects.toThrow(/too long/);
    await expect(readHostBytes(answering({ code: null, error: 'no shell' }), '/home/dev/a.png', 1024)).rejects.toThrow(/no shell/);
  });

  it('fails a reply shorter than the size the host named', async () => {
    const access = answering({ stdout: `KG:size:10\nKG:out:${Buffer.from('abc').toString('base64')}\n` });
    let rounds = 0;
    const counting: HostCommandAccess = {
      runCommand: async (request) => {
        rounds += 1;
        if (rounds > 1) return { code: 0, stdout: 'KG:size:10\nKG:out:\n', stderr: '', timedOut: false };
        return access.runCommand(request);
      },
    };
    await expect(readHostBytes(counting, '/home/dev/a.png', 1024)).rejects.toThrow(/less of/);
  });

  it('fails a file whose size changes between chunks', async () => {
    let rounds = 0;
    const access: HostCommandAccess = {
      runCommand: async () => {
        rounds += 1;
        const size = rounds === 1 ? 10 : 12;
        return { code: 0, stdout: `KG:size:${size}\nKG:out:${Buffer.from('abc').toString('base64')}\n`, stderr: '', timedOut: false };
      },
    };
    await expect(readHostBytes(access, '/home/dev/a.png', 1024)).rejects.toThrow(/changed/);
  });

  it('removes the staging file when a chunk fails', async () => {
    const steps: string[] = [];
    const access: HostCommandAccess = {
      runCommand: async (request) => {
        const step = request.args[5] ?? '';
        steps.push(step);
        if (step === 'first') return { code: 0, stdout: 'KG:ok\n', stderr: '', timedOut: false };
        throw new Error('link dropped');
      },
    };
    await expect(writeHostBytes(access, '/home/dev/a.bin', Buffer.alloc(200 * 1024))).rejects.toThrow(/link dropped/);
    expect(steps).toEqual(['first', 'more', 'abort']);
  });

  it('stops the write and drops the staging file when the host refuses the path', async () => {
    const steps: string[] = [];
    const access: HostCommandAccess = {
      runCommand: async (request) => {
        steps.push(request.args[5] ?? '');
        return { code: 0, stdout: 'KG:refused\n', stderr: '', timedOut: false };
      },
    };
    await expect(writeHostBytes(access, '/home/dev/a.bin', Buffer.from('x'))).rejects.toThrow(/home folder/);
    expect(steps).toEqual(['first', 'abort']);
  });
});

describe('a write that runs out of time', () => {
  it('sends no request at all when the signal is already aborted', async () => {
    let requests = 0;
    const access: HostCommandAccess = {
      runCommand: async () => {
        requests += 1;
        return { code: 0, stdout: 'KG:ok\n', stderr: '', timedOut: false };
      },
    };
    const stop = AbortSignal.abort();

    await expect(writeHostBytes(access, '/home/dev/a.bin', Buffer.from('x'), stop)).rejects.toThrow(/ran out of time/);
    await expect(writeHostBytes(access, '/home/dev/a.bin', Buffer.from('x'), stop)).rejects.toBeInstanceOf(HostTransferError);
    expect(requests).toBe(0);
  });

  it('sends no further chunk once the signal aborts after the first, and tells the host to drop its staging file', async () => {
    const controller = new AbortController();
    const steps: string[] = [];
    const access: HostCommandAccess = {
      runCommand: async (request) => {
        const step = request.args[5] ?? '';
        steps.push(step);
        if (step === 'first') controller.abort();
        return { code: 0, stdout: 'KG:ok\n', stderr: '', timedOut: false };
      },
    };

    // Three chunks long, so there is a chunk after the first to withhold.
    await expect(writeHostBytes(access, '/home/dev/a.bin', Buffer.alloc(300 * 1024), controller.signal)).rejects.toThrow(/ran out of time/);

    expect(steps).toEqual(['first', 'abort']);
  });
});

const hasPosixShell = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  && spawnSync('base64', ['--version'], { stdio: 'ignore' }).status !== null;

describe.runIf(hasPosixShell)('on a real shell', () => {
  let scratch: string;
  let home: string;
  let requestSizes: number[];
  let replySizes: number[];

  const host: HostCommandAccess = {
    runCommand: async (request: HostCommandRequest) => {
      requestSizes.push(Buffer.byteLength(JSON.stringify(request)));
      const result = await runHostCommand(request, {
        shellPath: '/bin/sh',
        cwd: request.cwd ?? home,
        baseEnv: { PATH: process.env.PATH, HOME: home },
      });
      replySizes.push(Buffer.byteLength(JSON.stringify({ t: 'reply', id: 1, ok: true, result })));
      return result;
    },
  };

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'host-transfer-'));
    home = path.join(scratch, 'home');
    fs.mkdirSync(home);
    requestSizes = [];
    replySizes = [];
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('reads binary bytes past one frame exactly, every reply inside a frame', async () => {
    const original = crypto.randomBytes(700 * 1024);
    fs.writeFileSync(path.join(home, 'shot.png'), original);

    const read = await readHostBytes(host, path.join(home, 'shot.png'), 1024 * 1024);

    expect(read.kind).toBe('bytes');
    if (read.kind === 'bytes') expect(read.bytes.equals(original)).toBe(true);
    expect(replySizes.length).toBeGreaterThan(1);
    expect(Math.max(...replySizes)).toBeLessThan(FRAME_JSON_BYTES);
  });

  it('writes binary bytes past one frame exactly, every request inside a frame, and makes the folders', async () => {
    const original = crypto.randomBytes(700 * 1024);
    const target = path.join(home, 'proj', '.kangentic', 'captures', 'shot.png');

    await writeHostBytes(host, target, original);

    expect(fs.readFileSync(target).equals(original)).toBe(true);
    expect(requestSizes.length).toBeGreaterThan(2);
    expect(Math.max(...requestSizes)).toBeLessThan(FRAME_JSON_BYTES);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['shot.png']);
  });

  it('round trips an empty file', async () => {
    const target = path.join(home, 'empty.txt');
    await writeHostBytes(host, target, Buffer.alloc(0));
    expect(fs.statSync(target).size).toBe(0);
    const read = await readHostBytes(host, target, 1024);
    expect(read).toEqual({ kind: 'bytes', bytes: Buffer.alloc(0) });
  });

  it('replaces a file that is there', async () => {
    const target = path.join(home, 'a.txt');
    fs.writeFileSync(target, 'old');
    await writeHostBytes(host, target, Buffer.from('new'));
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('answers missing for a file or folder that is not there, and too-large without reading it', async () => {
    expect(await readHostBytes(host, path.join(home, 'nothing.png'), 1024)).toEqual({ kind: 'missing' });
    expect(await readHostBytes(host, path.join(home, 'no', 'folder.png'), 1024)).toEqual({ kind: 'missing' });
    fs.writeFileSync(path.join(home, 'big.bin'), Buffer.alloc(4096));
    expect(await readHostBytes(host, path.join(home, 'big.bin'), 1024)).toEqual({ kind: 'too-large', size: 4096 });
  });

  it('sizes each file in order, and reads a folder, a symlink and a missing file as not there', async () => {
    fs.writeFileSync(path.join(home, 'a.bin'), Buffer.alloc(5));
    fs.mkdirSync(path.join(home, 'folder'));
    fs.symlinkSync(path.join(home, 'a.bin'), path.join(home, 'link'));

    const sizes = await hostFileSizes(host, ['a.bin', 'gone', 'folder', 'link'].map((name) => path.join(home, name)));

    expect(sizes).toEqual([5, null, null, null]);
  });

  it('keeps a hostile name an argument', async () => {
    const hostile = path.join(home, 'a b; touch pwned $(touch pwned2) `touch pwned3`.png');
    await writeHostBytes(host, hostile, Buffer.from('x'));
    const read = await readHostBytes(host, hostile, 1024);
    expect(read).toEqual({ kind: 'bytes', bytes: Buffer.from('x') });
    expect(fs.readdirSync(home).filter((name) => name.startsWith('pwned'))).toEqual([]);
  });

  it('refuses a path outside the home, one that climbs out, and a relative one, for both directions', async () => {
    const outside = path.join(scratch, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    for (const refused of [outside, path.join(home, '..', 'outside.txt').replace(scratch, `${home}/..`), 'relative.txt']) {
      await expect(readHostBytes(host, refused, 1024)).rejects.toThrow(/home folder/);
      await expect(writeHostBytes(host, refused, Buffer.from('x'))).rejects.toThrow(/home folder/);
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('refuses a symlink, and a symlinked folder that leads out of the home, and makes nothing through it', async () => {
    const elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'secret');
    fs.symlinkSync(elsewhere, path.join(home, 'link'));
    fs.symlinkSync(path.join(elsewhere, 'secret.txt'), path.join(home, 'file-link'));

    await expect(readHostBytes(host, path.join(home, 'link', 'secret.txt'), 1024)).rejects.toThrow(/home folder/);
    await expect(readHostBytes(host, path.join(home, 'file-link'), 1024)).rejects.toThrow(/home folder/);
    await expect(writeHostBytes(host, path.join(home, 'link', 'made', 'new.txt'), Buffer.from('x'))).rejects.toThrow(/home folder/);
    await expect(writeHostBytes(host, path.join(home, 'file-link'), Buffer.from('x'))).rejects.toThrow(/home folder/);
    expect(fs.readdirSync(elsewhere)).toEqual(['secret.txt']);
    expect(fs.readFileSync(path.join(elsewhere, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('refuses a . or .. component before it makes any folder, so a climb that follows a new folder leaves nothing behind', async () => {
    // mkdir -p would make `nope`, then walk out of it and make `zzz` beside the home. Neither may exist afterwards.
    await expect(writeHostBytes(host, `${home}/nope/../../zzz/f.txt`, Buffer.from('x'))).rejects.toThrow(/home folder/);
    expect(fs.existsSync(path.join(home, 'nope'))).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'zzz'))).toBe(false);

    await expect(writeHostBytes(host, `${home}/made/./f.txt`, Buffer.from('x'))).rejects.toThrow(/home folder/);
    expect(fs.existsSync(path.join(home, 'made'))).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('sizes only plain files beneath the home: a file outside it, a relative path and a link that leads out are not there', async () => {
    const elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(scratch, 'outside.txt'), 'outside');
    fs.writeFileSync(path.join(home, 'first.bin'), Buffer.alloc(3));
    fs.writeFileSync(path.join(home, 'second.bin'), Buffer.alloc(7));
    fs.writeFileSync(path.join(home, 'relative.bin'), Buffer.alloc(4));
    fs.symlinkSync(path.join(elsewhere, 'secret.txt'), path.join(home, 'file-link'));
    fs.symlinkSync(elsewhere, path.join(home, 'folder-link'));

    const sizes = await hostFileSizes(host, [
      path.join(home, 'second.bin'),
      path.join(scratch, 'outside.txt'),
      'relative.bin', // the shell runs in the home, so this file is there, but a relative path is never trusted
      path.join(home, 'file-link'),
      path.join(home, 'folder-link', 'secret.txt'),
      path.join(home, 'first.bin'),
    ]);

    expect(sizes).toEqual([7, null, null, null, null, 3]);
  });

  it('still works when the home itself is reached through a link', async () => {
    const realHome = path.join(scratch, 'real-home');
    fs.mkdirSync(realHome);
    const linkedHome = path.join(scratch, 'linked-home');
    fs.symlinkSync(realHome, linkedHome);
    const linked: HostCommandAccess = {
      runCommand: (request) => runHostCommand(request, { shellPath: '/bin/sh', cwd: linkedHome, baseEnv: { PATH: process.env.PATH, HOME: linkedHome } }),
    };
    await writeHostBytes(linked, path.join(linkedHome, 'a.txt'), Buffer.from('x'));
    expect(await readHostBytes(linked, path.join(linkedHome, 'a.txt'), 1024)).toEqual({ kind: 'bytes', bytes: Buffer.from('x') });
  });
});
