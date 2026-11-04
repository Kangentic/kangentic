/**
 * Carrying a remote agent's transcript from the host to this computer (#913): the helper's file tail on real
 * files, the mapping from this computer's mirror of the host's home to the host's own path, and what Claude
 * declares as its transcript. `remote-session-relay.test.ts` runs the whole path through the real link.
 *
 * What a user loses if it breaks: a remote conversation that shows nothing in the viewer, the search index
 * and the token ledger, or a copy that is a different file from the one the agent is writing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTail, type FileChunkEvent } from '../../src/main/remote/helper/file-tail';
import { mirrorPathToHost, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

let folder: string;
const teardown: Array<() => void> = [];

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-'));
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(folder, { recursive: true, force: true });
});

function tailer(options: ConstructorParameters<typeof FileTail>[0] extends infer T ? Partial<T> : never = {}): { tail: FileTail; events: FileChunkEvent[] } {
  const events: FileChunkEvent[] = [];
  const tail = new FileTail({ emit: (event) => events.push(event), intervalMs: 20, ...options });
  teardown.push(() => tail.dispose());
  return { tail, events };
}

const bytesOf = (events: FileChunkEvent[]): string => Buffer.concat(events.map((event) => Buffer.from(event.data, 'base64'))).toString('utf8');

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the helper\'s file tail', () => {
  it('sends the bytes already in the file, then only what is appended, each chunk at its offset', async () => {
    const file = path.join(folder, 'a.jsonl');
    fs.writeFileSync(file, 'one\n');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);

    await until(() => bytesOf(events) === 'one\n');
    fs.appendFileSync(file, 'two\n');
    await until(() => bytesOf(events) === 'one\ntwo\n');

    expect(events.map((event) => event.offset)).toEqual([0, 4]);
    expect(events.every((event) => event.sessionId === 's1' && event.key === '0' && !event.reset)).toBe(true);
  });

  it('waits for a file that is not there yet, and sends nothing for it', async () => {
    const file = path.join(folder, 'later.jsonl');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events).toEqual([]);

    fs.writeFileSync(file, 'hello');
    await until(() => bytesOf(events) === 'hello');
  });

  it('splits a large file into chunks and paces a backfill, a few chunks a scan', async () => {
    const file = path.join(folder, 'big.jsonl');
    fs.writeFileSync(file, 'x'.repeat(1000));
    const { tail, events } = tailer({ chunkBytes: 100, chunksPerScan: 2, intervalMs: 200 });
    tail.watch('s1', [{ key: '0', path: file }]);

    await until(() => events.length >= 2);
    // One scan has run: two chunks of the ten, not all of them.
    expect(events.length).toBe(2);
    expect(events.map((event) => event.offset)).toEqual([0, 100]);

    await until(() => events.length === 10, 5000);
    expect(bytesOf(events)).toBe('x'.repeat(1000));
  });

  it('keeps a multi-byte character whole when a chunk edge falls inside it, because the copy is written by byte', async () => {
    const file = path.join(folder, 'utf8.jsonl');
    const text = '界界界界界界界界界界';
    fs.writeFileSync(file, text);
    const { tail, events } = tailer({ chunkBytes: 7, chunksPerScan: 100 });
    tail.watch('s1', [{ key: '0', path: file }]);

    await until(() => events.length >= 5);
    expect(bytesOf(events)).toBe(text);
    expect(events.some((event) => event.data !== '' && Buffer.from(event.data, 'base64').length === 7)).toBe(true);
  });

  it('says reset, and starts over from byte 0, when the file is shorter than what was sent', async () => {
    const file = path.join(folder, 'shrunk.jsonl');
    fs.writeFileSync(file, 'a long line of text\n');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);
    await until(() => bytesOf(events).length === 20);

    fs.writeFileSync(file, 'new\n');
    await until(() => events.some((event) => event.reset));

    const resetChunk = events.find((event) => event.reset)!;
    expect(resetChunk.offset).toBe(0);
    expect(Buffer.from(resetChunk.data, 'base64').toString('utf8')).toBe('new\n');
  });

  it('says reset with no bytes when the file is emptied', async () => {
    const file = path.join(folder, 'emptied.jsonl');
    fs.writeFileSync(file, 'something\n');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);
    await until(() => events.length === 1);

    fs.writeFileSync(file, '');
    await until(() => events.length === 2);

    expect(events[1]).toMatchObject({ offset: 0, reset: true, data: '' });
  });

  it('sends what is left in a last unpaced pass when it is told to stop, then sends no more', async () => {
    const file = path.join(folder, 'last.jsonl');
    fs.writeFileSync(file, 'a'.repeat(500));
    // A slow poll and a small pace: only the last pass can have sent all of it.
    const { tail, events } = tailer({ chunkBytes: 100, chunksPerScan: 1, intervalMs: 60_000 });
    tail.watch('s1', [{ key: '0', path: file }]);

    await tail.unwatch('s1');

    expect(bytesOf(events)).toBe('a'.repeat(500));
    expect(tail.isWatching('s1')).toBe(false);
    fs.appendFileSync(file, 'b');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bytesOf(events)).toBe('a'.repeat(500));
  });

  it('tails several files of one session under their own keys', async () => {
    const first = path.join(folder, 'first.jsonl');
    const second = path.join(folder, 'second.jsonl');
    fs.writeFileSync(first, '1');
    fs.writeFileSync(second, '2');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: 'a', path: first }, { key: 'b', path: second }]);

    await until(() => events.length === 2);

    expect(Object.fromEntries(events.map((event) => [event.key, Buffer.from(event.data, 'base64').toString('utf8')]))).toEqual({ a: '1', b: '2' });
  });
});

describe('a path in the mirror of the host\'s home, as the host names it', () => {
  const place = (localHome: string): SshCliPlace => ({
    kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome, roots: [],
  });

  it('is the host\'s home plus the path under the mirror', () => {
    const localHome = path.join(os.tmpdir(), 'mirrors', 'host-a');
    expect(mirrorPathToHost(path.join(localHome, '.claude', 'projects', '-home-dev-api', 'abc.jsonl'), place(localHome)))
      .toBe('/home/dev/.claude/projects/-home-dev-api/abc.jsonl');
  });

  it('is null for a path outside the mirror, the mirror itself, and a place with no mirror', () => {
    const localHome = path.join(os.tmpdir(), 'mirrors', 'host-a');
    expect(mirrorPathToHost(path.join(os.tmpdir(), 'mirrors', 'host-b', 'x.jsonl'), place(localHome))).toBeNull();
    expect(mirrorPathToHost(path.join(localHome, '..', 'x.jsonl'), place(localHome))).toBeNull();
    expect(mirrorPathToHost(localHome, place(localHome))).toBeNull();
    expect(mirrorPathToHost(path.join(localHome, 'x.jsonl'), place(''))).toBeNull();
  });
});

describe('Claude\'s transcript on a host', () => {
  const localHome = path.join(os.tmpdir(), 'mirrors', 'host-a');
  const shellFolder = path.join(os.tmpdir(), 'remote-projects', 'p1');
  const stored = toStoredCliTarget({
    kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome, roots: [{ local: shellFolder, host: '/home/dev/api' }],
  });

  it('is the one file Claude appends to, in the mirror, filed under the slug of the folder on the HOST', () => {
    const files = new ClaudeAdapter().remoteTranscriptFiles({ agentSessionId: 'abc', cwd: shellFolder, cliTarget: stored });
    expect(files).toEqual([path.join(localHome, '.claude', 'projects', '-home-dev-api', 'abc.jsonl')]);
    // And that is the host's file once the mirror's root is the host's home.
    const place: SshCliPlace = { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome, roots: [] };
    expect(mirrorPathToHost(files[0], place)).toBe('/home/dev/.claude/projects/-home-dev-api/abc.jsonl');
  });

  it('declares nothing for a conversation that is not on a host', () => {
    const wsl = { kind: 'wsl', distro: 'Ubuntu' } as unknown as Parameters<ClaudeAdapter['remoteTranscriptFiles']>[0]['cliTarget'];
    expect(new ClaudeAdapter().remoteTranscriptFiles({ agentSessionId: 'abc', cwd: shellFolder, cliTarget: wsl })).toEqual([]);
  });
});
