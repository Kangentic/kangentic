/**
 * readGitObject's handling of the `git cat-file --batch` stream, driven by a
 * stand-in child process, so the cases real git never produces on demand can
 * be fed byte by byte: a header split mid-id, content in several pieces, a
 * header the parser does not recognise, a process that cannot start. It also
 * pins when the reader stops git early. git-object-reader.test.ts pins the
 * same reader against real git.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

import { readGitObject } from '../../src/main/git/git-object-reader';

const OBJECT_ID = 'a'.repeat(40);

/** The parts of a ChildProcess the reader uses. */
class StandInChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  readonly kill = vi.fn(() => true);

  /** Write to stdout the way git does, one `data` event per piece. */
  write(...pieces: Array<string | Buffer>): void {
    for (const piece of pieces) this.stdout.emit('data', typeof piece === 'string' ? Buffer.from(piece) : piece);
  }
}

let child: StandInChild;

beforeEach(() => {
  mockSpawn.mockReset();
  child = new StandInChild();
  mockSpawn.mockReturnValue(child);
});

describe('readGitObject over a stand-in git', () => {
  it('asks for the name on stdin, never as an argument', () => {
    void readGitObject('/repository', 'HEAD:img/a.png', { maxBytes: 100 });

    expect(mockSpawn).toHaveBeenCalledWith('git', ['cat-file', '--batch'], expect.objectContaining({ cwd: '/repository' }));
    expect(child.stdin.end).toHaveBeenCalledWith('HEAD:img/a.png\n');
  });

  it('reads a header split mid-id and content split in three, and leaves git to finish on its own', async () => {
    const reading = readGitObject('/repository', 'HEAD:img/a.png', { maxBytes: 100 });

    child.write(OBJECT_ID.slice(0, 7), `${OBJECT_ID.slice(7)} blob 5`, '\nab', 'cd', 'e\n');

    expect(await reading).toEqual({ kind: 'blob', objectId: OBJECT_ID, bytes: Buffer.from('abcde') });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['the id the caller holds', { knownObjectId: OBJECT_ID, maxBytes: 100 }, `${OBJECT_ID} blob 5\n`, { kind: 'unchanged', objectId: OBJECT_ID }],
    ['an object over the cap', { maxBytes: 4 }, `${OBJECT_ID} blob 5\n`, { kind: 'too-large', objectId: OBJECT_ID, size: 5 }],
    ['a name git cannot resolve', { maxBytes: 100 }, 'HEAD:img/a.png missing\n', { kind: 'missing' }],
    ['a directory rather than a file', { maxBytes: 100 }, `${OBJECT_ID} tree 40\n`, { kind: 'missing' }],
  ])('stops git at the header for %s', async (_label, options, header, expected) => {
    const reading = readGitObject('/repository', 'HEAD:img/a.png', options);

    child.write(header);

    expect(await reading).toEqual(expected);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a header it does not recognise and stops git', async () => {
    const reading = readGitObject('/repository', 'HEAD:img/a.png', { maxBytes: 100 });

    child.write('this is not a header\n');

    await expect(reading).rejects.toThrow(/does not recognise/);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a git that cannot start with an error that carries no Node error code', async () => {
    // A spawn failure arrives as ENOENT. Copied through, it would read to the
    // caller as a file that is not there, and git missing would never be logged.
    const reading = readGitObject('/repository', 'HEAD:img/a.png', { maxBytes: 100 });

    child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));

    const error = await reading.catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/git cat-file could not start: spawn git ENOENT/);
    expect('code' in (error as Error)).toBe(false);
  });

  it('rejects a git that exits before answering, with what git wrote to stderr', async () => {
    const reading = readGitObject('/repository', 'HEAD:img/a.png', { maxBytes: 100 });

    child.stderr.emit('data', Buffer.from('fatal: not a git repository\n'));
    child.emit('close', 128);

    await expect(reading).rejects.toThrow('git cat-file exited with 128 before it answered: fatal: not a git repository');
  });

  it('ignores a close that follows a finished read', async () => {
    const reading = readGitObject('/repository', 'HEAD:img/a.png', { maxBytes: 100 });

    child.write(`${OBJECT_ID} blob 2\nok\n`);
    child.emit('close', 0);

    expect(await reading).toEqual({ kind: 'blob', objectId: OBJECT_ID, bytes: Buffer.from('ok') });
  });
});
