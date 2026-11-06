/**
 * Carrying a remote agent's transcript from the host to this computer (#913): the helper's file tail on real
 * files, the mapping from this computer's mirror of the host's home to the host's own path, and what Claude
 * declares as its transcript. `remote-session-relay.test.ts` runs the whole path through the real link.
 *
 * What a user loses if it breaks: a remote conversation that shows nothing in the viewer, the search index
 * and the token ledger, or a copy that is a different file from the one the agent is writing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTail, type FileChunkEvent } from '../../src/main/remote/helper/file-tail';
import { hostPathForTarget, hostPathToMirror, mirrorPathToHost, placeFromStored, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { clearClaudeTranscriptLocatorCacheForTests, findClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-locator';

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
  it('keeps a file\'s place when a second watch names it again, so a transcript found late sends nothing twice', async () => {
    const first = path.join(folder, 'a.jsonl');
    const second = path.join(folder, 'b.jsonl');
    fs.writeFileSync(first, 'one\n');
    fs.writeFileSync(second, 'two\n');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: first }]);
    await until(() => bytesOf(events) === 'one\n');

    tail.watch('s1', [{ key: '0', path: first }, { key: '1', path: second }]);
    await until(() => events.some((event) => event.key === '1'));
    fs.appendFileSync(first, 'more\n');
    await until(() => events.filter((event) => event.key === '0').length === 2);

    expect(events.filter((event) => event.key === '0').map((event) => event.offset)).toEqual([0, 4]);
    expect(events.find((event) => event.key === '1')?.offset).toBe(0);
  });

  it('stops a file a second watch leaves out', async () => {
    const first = path.join(folder, 'a.jsonl');
    fs.writeFileSync(first, 'one\n');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: first }]);
    await until(() => events.length === 1);

    tail.watch('s1', []);
    fs.appendFileSync(first, 'more\n');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events).toHaveLength(1);
  });

  it('says how large the file is on each chunk, so a copy that must be whole knows when it is', async () => {
    const file = path.join(folder, 'whole.json');
    fs.writeFileSync(file, 'x'.repeat(250));
    const { tail, events } = tailer({ chunkBytes: 100 });
    tail.watch('s1', [{ key: '0', path: file }]);

    await until(() => events.length === 3);

    expect(events.map((event) => event.size)).toEqual([250, 250, 250]);
  });

  it('reports what each file holds, leaving out one that is not there', async () => {
    const file = path.join(folder, 'index.jsonl');
    fs.writeFileSync(file, 'abcd');
    const { tail } = tailer();
    tail.watch('s1', [{ key: '0', path: file }, { key: '1', path: path.join(folder, 'missing') }]);

    expect(await tail.sizes('s1')).toEqual({ 0: 4 });
  });

  it('sends the whole new file when an export swaps it in, with no byte of the old one', async () => {
    const file = path.join(folder, 'export.json');
    fs.writeFileSync(file, '{"version":"old"}');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);
    await until(() => bytesOf(events) === '{"version":"old"}');

    const staged = `${file}.tmp`;
    fs.writeFileSync(staged, '{"version":"a longer new export"}');
    fs.renameSync(staged, file);

    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ offset: 0, reset: true, size: 33 });
    expect(Buffer.from(events[1].data, 'base64').toString('utf8')).toBe('{"version":"a longer new export"}');
  });

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

  it('says reset, and starts over from byte 0, when a LONGER file replaces it under a new inode', async () => {
    const file = path.join(folder, 'replaced.jsonl');
    const incoming = path.join(folder, 'incoming.jsonl');
    fs.writeFileSync(file, 'short\n');
    const inodeBefore = fs.statSync(file).ino;
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);
    await until(() => bytesOf(events) === 'short\n');

    // The new file exists beside the old one before the old one goes, so the two cannot share an inode.
    const replacement = 'a replacement much longer than the first file\n';
    fs.writeFileSync(incoming, replacement);
    fs.rmSync(file);
    fs.renameSync(incoming, file);
    if (fs.statSync(file).ino === inodeBefore) return; // a file system that reports no inode: only the size half exists there

    await until(() => events.some((event) => event.reset));
    const resetChunk = events.find((event) => event.reset)!;
    expect(resetChunk.offset).toBe(0);
    expect(Buffer.from(resetChunk.data, 'base64').toString('utf8')).toBe(replacement);
  });

  // The agent rotating its transcript between the tail's stat and its open. Without the identity check after the
  // open, the new file is read from the old file's offset: the copy gets the middle of a file, written as if it
  // continued the one before it, and nothing tells Kangentic to empty its copy first.
  it('starts over with a reset at byte 0, and sends no stray bytes, when the file is swapped between the stat and the open', async () => {
    const file = path.join(folder, 'swapped.jsonl');
    const incoming = path.join(folder, 'incoming.jsonl');
    fs.writeFileSync(file, 'short\n');
    const inodeBefore = fs.statSync(file).ino;
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: file }]);
    await until(() => bytesOf(events) === 'short\n');
    const eventsBefore = events.length;

    const replacement = 'a replacement much longer than the first file\n';
    const realOpen = fs.promises.open.bind(fs.promises);
    let swapped = false;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...openArguments: Parameters<typeof fs.promises.open>) => {
      if (!swapped) {
        swapped = true;
        fs.writeFileSync(incoming, replacement);
        fs.rmSync(file);
        fs.renameSync(incoming, file);
      }
      return realOpen(...openArguments);
    });
    teardown.push(() => openSpy.mockRestore());
    // The old file grows, so the next poll stats it, finds more to send, and opens it: the swap lands in between.
    fs.appendFileSync(file, 'more\n');

    await until(() => swapped && events.length > eventsBefore);
    if (fs.statSync(file).ino === inodeBefore) return; // a file system that reports no inode: only the size half exists there

    const afterSwap = events.slice(eventsBefore);
    expect(afterSwap[0]).toMatchObject({ offset: 0, reset: true });
    expect(Buffer.from(afterSwap[0].data, 'base64').toString('utf8')).toBe(replacement);
    expect(afterSwap.filter((event) => event.reset)).toHaveLength(1);
  });

  it('keeps the new tail running when a watch replaces the entry during the last pass of an unwatch', async () => {
    const first = path.join(folder, 'first.jsonl');
    const second = path.join(folder, 'second.jsonl');
    fs.writeFileSync(first, 'one\n');
    fs.writeFileSync(second, 'two\n');
    const { tail, events } = tailer();
    tail.watch('s1', [{ key: '0', path: first }]);
    await until(() => bytesOf(events) === 'one\n');

    const stopping = tail.unwatch('s1');
    // Synchronously after the call: the unwatch is still in its last pass.
    tail.watch('s1', [{ key: '1', path: second }]);
    await stopping;

    expect(tail.isWatching('s1')).toBe(true);
    await until(() => events.some((event) => event.key === '1' && Buffer.from(event.data, 'base64').toString('utf8') === 'two\n'));
    fs.appendFileSync(second, 'more\n');
    await until(() => events.some((event) => event.key === '1' && Buffer.from(event.data, 'base64').toString('utf8') === 'more\n'));
  });

  describe('the last pass at unwatch', () => {
    it('logs how many bytes it left when the finalChunks cap stopped it, and logs nothing for a tail that caught up', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const big = path.join(folder, 'big.jsonl');
        fs.writeFileSync(big, 'x'.repeat(500));
        const capped = tailer({ chunkBytes: 100, chunksPerScan: 1, finalChunks: 2, intervalMs: 60_000 });
        capped.tail.watch('s1', [{ key: '0', path: big }]);
        await capped.tail.unwatch('s1');
        expect(bytesOf(capped.events)).toBe('x'.repeat(200));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('300 bytes');

        warn.mockClear();
        const small = path.join(folder, 'small.jsonl');
        fs.writeFileSync(small, 'done\n');
        const caughtUp = tailer({ intervalMs: 60_000 });
        caughtUp.tail.watch('s2', [{ key: '0', path: small }]);
        await caughtUp.tail.unwatch('s2');
        expect(bytesOf(caughtUp.events)).toBe('done\n');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
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

describe('a file the tail finds by a search', () => {
  const ROLLOUT = '^rollout-.*-abc\\.jsonl$';
  const search = (depth = 3) => ({ key: 'found', directory: folder, depth, fileName: ROLLOUT });

  function writeRollout(relative: string, content: string): string {
    const file = path.join(folder, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  it('finds a file in a dated folder whose name it could not be told, and tails it from then on', async () => {
    const file = writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-abc.jsonl', 'one\n');
    const { tail, events } = tailer();
    tail.watch('s1', [], [search()]);

    await until(() => bytesOf(events) === 'one\n');
    fs.appendFileSync(file, 'two\n');
    await until(() => bytesOf(events) === 'one\ntwo\n');

    expect(events.every((event) => event.key === 'found')).toBe(true);
  });

  it('finds a file that appears late, which is how Codex writes a new session', async () => {
    const { tail, events } = tailer({ searchDelayMs: 10, searchMaxDelayMs: 20 });
    tail.watch('s1', [], [search()]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual([]);

    writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-abc.jsonl', 'late\n');

    await until(() => bytesOf(events) === 'late\n');
  });

  it('finds a resumed session in the folder of the day it began, not only today\'s', async () => {
    writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-other.jsonl', 'not this one\n');
    writeRollout('2024/02/29/rollout-2024-02-29T09-14-22-abc.jsonl', 'old conversation\n');
    const { tail, events } = tailer();
    tail.watch('s1', [], [search()]);

    await until(() => events.length > 0);

    expect(bytesOf(events)).toBe('old conversation\n');
  });

  it('takes the newest name when two match', async () => {
    writeRollout('2025/01/01/rollout-2025-01-01T00-00-00-abc.jsonl', 'older\n');
    writeRollout('2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl', 'newer\n');
    const { tail, events } = tailer();
    tail.watch('s1', [], [search()]);

    await until(() => events.length > 0);

    expect(bytesOf(events)).toBe('newer\n');
  });

  it('looks no deeper than it was told, so a subagent chat one level down is not taken for the conversation', async () => {
    writeRollout('a/b/c/d/rollout-2026-11-06T09-14-22-abc.jsonl', 'too deep\n');
    const { tail, events } = tailer({ searchDelayMs: 5, searchMaxDelayMs: 5 });
    tail.watch('s1', [], [search(3)]);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('neither follows nor takes a symlink, so a search cannot leave the folder it was given', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tail-outside-'));
    teardown.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'rollout-2026-11-06T09-14-22-abc.jsonl'), 'outside\n');
    fs.symlinkSync(outside, path.join(folder, 'linked'));
    fs.symlinkSync(path.join(outside, 'rollout-2026-11-06T09-14-22-abc.jsonl'), path.join(folder, 'rollout-link-abc.jsonl'));
    const { tail, events } = tailer({ searchDelayMs: 5, searchMaxDelayMs: 5 });
    tail.watch('s1', [], [search()]);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events).toEqual([]);
  });

  it('walks on a backoff while it finds nothing, because a walk reads a folder per day of history', async () => {
    fs.mkdirSync(path.join(folder, '2026'));
    const readdir = vi.spyOn(fs.promises, 'readdir');
    teardown.push(() => readdir.mockRestore());
    const { tail } = tailer({ intervalMs: 5, searchDelayMs: 100, searchMaxDelayMs: 100 });
    tail.watch('s1', [], [search()]);

    await new Promise((resolve) => setTimeout(resolve, 230));

    const walks = readdir.mock.calls.filter(([directory]) => directory === folder).length;
    expect(walks).toBeGreaterThanOrEqual(2);
    // At the poll's own pace this would be over 40.
    expect(walks).toBeLessThanOrEqual(4);
  });

  it('holds the file it found, and stops walking', async () => {
    writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-abc.jsonl', 'one\n');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    teardown.push(() => readdir.mockRestore());
    const { tail, events } = tailer({ intervalMs: 5 });
    tail.watch('s1', [], [search()]);
    await until(() => events.length > 0);
    const walked = readdir.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(readdir.mock.calls.length).toBe(walked);
  });

  it('looks once more at the last pass, whatever the backoff says, so a short session still sends its file', async () => {
    const { tail, events } = tailer({ searchDelayMs: 60_000, searchMaxDelayMs: 60_000 });
    tail.watch('s1', [], [search()]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-abc.jsonl', 'the whole session\n');

    await tail.unwatch('s1');

    expect(bytesOf(events)).toBe('the whole session\n');
  });

  it('keeps what it found and its place when a second watch names the same search', async () => {
    writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-abc.jsonl', 'one\n');
    const other = path.join(folder, 'other.jsonl');
    fs.writeFileSync(other, 'x');
    const { tail, events } = tailer();
    tail.watch('s1', [], [search()]);
    await until(() => events.length === 1);

    tail.watch('s1', [{ key: 'plain', path: other }], [search()]);
    await until(() => events.some((event) => event.key === 'plain'));

    expect(events.filter((event) => event.key === 'found')).toHaveLength(1);
  });

  it('starts over with a reset when the file it found is swapped, as a rollout restored from its compressed form is', async () => {
    const file = writeRollout('2026/11/06/rollout-2026-11-06T09-14-22-abc.jsonl', 'one\n');
    const { tail, events } = tailer();
    tail.watch('s1', [], [search()]);
    await until(() => events.length === 1);

    fs.writeFileSync(`${file}.tmp`, 'restored and longer\n');
    fs.rmSync(file);
    fs.renameSync(`${file}.tmp`, file);

    await until(() => events.some((event) => event.reset));
    expect(events.find((event) => event.reset)).toMatchObject({ offset: 0 });
  });

  it('leaves a file not found yet out of the sizes, as a file that is not there', async () => {
    const { tail } = tailer();
    tail.watch('s1', [], [search()]);

    await expect(tail.sizes('s1')).resolves.toEqual({});
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

describe('a path the CLI reports on the host, as this computer reads it', () => {
  const localHome = path.join(os.tmpdir(), 'mirrors', 'host-a');
  const shellFolder = path.join(os.tmpdir(), 'remote-projects', 'p1');
  const place: SshCliPlace = {
    kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome, roots: [{ local: shellFolder, host: '/home/dev/api' }],
  };

  it('maps a path under the host\'s home into the mirror, and one under the project into the shell folder', () => {
    expect(hostPathForTarget('/home/dev/.claude/projects/-home-dev-api/abc.jsonl', place))
      .toBe(path.join(localHome, '.claude', 'projects', '-home-dev-api', 'abc.jsonl'));
    // The project lies under the home, and the project root wins.
    expect(hostPathForTarget('/home/dev/api/src/main.ts', place)).toBe(path.join(shellFolder, 'src', 'main.ts'));
  });

  it('leaves a path outside the home and the project as it is, and a place with no mirror alone', () => {
    expect(hostPathForTarget('/srv/other/file', place)).toBe('/srv/other/file');
    expect(hostPathToMirror('/home/dev/.claude/x', { ...place, localHome: '' })).toBeNull();
    expect(hostPathToMirror('/home/dev', place)).toBeNull();
    expect(hostPathToMirror('/home/developer/x', place)).toBeNull();
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

  it('is found by Claude\'s own locator once the copy has arrived, from the session\'s own folder and host', async () => {
    clearClaudeTranscriptLocatorCacheForTests();
    const realHome = path.join(folder, 'mirror');
    const realShell = path.join(folder, 'shell');
    const realStored = toStoredCliTarget({
      kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: realHome, roots: [{ local: realShell, host: '/home/dev/api' }],
    });
    const adapter = new ClaudeAdapter();
    const [copy] = adapter.remoteTranscriptFiles({ agentSessionId: 'abc', cwd: realShell, cliTarget: realStored });
    const place = placeFromStored(realStored);

    expect(await findClaudeTranscriptFile({ agentSessionId: 'abc', cwd: realShell, place })).toBeNull();

    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, '{"type":"user"}\n');
    expect(await findClaudeTranscriptFile({ agentSessionId: 'abc', cwd: realShell, place })).toBe(copy);
  });

  it('is found from the path Claude reports in its status line, which is a path on the host', async () => {
    clearClaudeTranscriptLocatorCacheForTests();
    const realHome = path.join(folder, 'mirror');
    const realShell = path.join(folder, 'shell');
    const realStored = toStoredCliTarget({
      kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: realHome, roots: [{ local: realShell, host: '/home/dev/api' }],
    });
    const place = placeFromStored(realStored);
    const copy = path.join(realHome, '.claude', 'projects', '-home-dev-api', 'abc.jsonl');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, '{"type":"user"}\n');

    expect(await findClaudeTranscriptFile({
      agentSessionId: 'abc',
      cwd: path.join(folder, 'somewhere-else'),
      place,
      reportedPath: '/home/dev/.claude/projects/-home-dev-api/abc.jsonl',
    })).toBe(copy);
  });

  it('declares nothing for a conversation that is not on a host', () => {
    const wsl = { kind: 'wsl', distro: 'Ubuntu' } as unknown as Parameters<ClaudeAdapter['remoteTranscriptFiles']>[0]['cliTarget'];
    expect(new ClaudeAdapter().remoteTranscriptFiles({ agentSessionId: 'abc', cwd: shellFolder, cliTarget: wsl })).toEqual([]);
  });
});
