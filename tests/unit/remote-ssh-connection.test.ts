/**
 * `openSshStream` (#913) over a Node child standing in for ssh: the stdio becomes a duplex stream,
 * ssh's own stderr becomes the error, and destroying the stream stops the child. The real ssh is the
 * rig's. Windows and Linux CI both run this, because it spawns only the running Node.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSshStream } from '../../src/main/remote/link/ssh-connection';

const ECHO = 'process.stdin.pipe(process.stdout)';
const FAIL = "process.stderr.write('dev@build-box: Permission denied (publickey).\\n'); process.exit(255)";
const HANG = 'setInterval(() => {}, 1000)';

function standIn(script: string) {
  return openSshStream({ sshPath: process.execPath, args: ['-e', script], remoteCommand: 'ignored' });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('openSshStream', () => {
  it('carries bytes both ways through the child\'s stdio', async () => {
    const stream = standIn(ECHO);
    const received: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => received.push(chunk));
    stream.write(Buffer.from([0, 255, 10, 13, 65]));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (Buffer.concat(received).length >= 5) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    expect([...Buffer.concat(received)]).toEqual([0, 255, 10, 13, 65]);
    stream.destroy();
    await once(stream, 'close');
  });

  it('makes what ssh printed the error when the child ends, in its own words', async () => {
    const stream = standIn(FAIL);
    const [error] = (await once(stream, 'error')) as [Error];
    expect(error.message).toContain('exited with code 255');
    expect(error.message).toContain('dev@build-box: Permission denied (publickey).');
  });

  it('stops the child when the stream is destroyed, and leaves nothing running', async () => {
    let childPid = 0;
    const stream = openSshStream({
      sshPath: process.execPath,
      args: ['-e', HANG],
      remoteCommand: 'ignored',
      spawnProcess: ((...parameters: Parameters<typeof spawn>) => {
        const child = spawn(...parameters);
        childPid = child.pid ?? 0;
        return child;
      }) as typeof spawn,
    });
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);
    stream.destroy();
    await once(stream, 'close');
    const deadline = Date.now() + 5000;
    while (alive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(childPid)).toBe(false);
  });
});
