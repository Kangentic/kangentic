/**
 * The transcripts of agents that cannot name one plain file at spawn (#913, task 1004): a file found after
 * the session starts, an index that names a fresh session's id, and an export of a conversation kept in a
 * database. A fake host drives the races on every OS, and the real helper runs the real export script where
 * a POSIX shell can.
 *
 * What a user loses if it breaks: a session on a host with an empty viewer, a copy cut off mid-document that
 * reads as an empty conversation, a resume of someone else's conversation, or a transcript sent again and
 * again until it crowds out the terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextSnapshotDelayMs, readSnapshotAnswer, RemoteSessionRelay, type RemoteSessionFiles, type RemoteTranscriptSource } from '../../src/main/remote/remote-session-relay';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { prepareWslHookTransport } from '../../src/main/agent/shared/wsl-hook-transport';
import { remoteExportPath, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';
import type { RemoteTranscriptSnapshot } from '../../src/shared/types';
import { dialHelper, makeHelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let scratch: string;
let mirror: string;
let shellFolder: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-sources-'));
  mirror = path.join(scratch, 'mirror');
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const placeOf = (home = '/home/dev', hostProject = '/home/dev/project'): SshCliPlace => ({
  kind: 'ssh',
  hostId: 'host-a',
  home,
  shellName: 'sh',
  localHome: mirror,
  roots: [{ local: shellFolder, host: hostProject }],
});

function registrationOf(sessionId: string, transcripts: RemoteTranscriptSource, extra: { agentSessionId?: string | null; place?: SshCliPlace } = {}) {
  const localSession = path.join(shellFolder, '.kangentic', 'sessions', sessionId);
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  return {
    hostId: 'host-a',
    sessionId,
    place: extra.place ?? placeOf(),
    localSessionDirectory: localSession,
    statusOutputPath: path.join(localSession, 'status.json'),
    agentSessionId: extra.agentSessionId ?? null,
    transcripts,
  };
}

/** A host behind the relay's jobs that records what it is asked and answers from the test. */
function fakeHost() {
  const watchCalls: Array<Array<{ key: string; path: string }>> = [];
  const commands: HostCommandRequest[] = [];
  const removed: string[] = [];
  const calls: string[] = [];
  const state = {
    sizes: {} as Record<string, number>,
    answer: (_request: HostCommandRequest): HostCommandResult => ({ code: 0, stdout: 'replaced 10\n', stderr: '', timedOut: false }),
  };
  const files: RemoteSessionFiles = {
    writeFiles: async () => undefined,
    writeFileRaw: async () => undefined,
    watchHooks: async () => undefined,
    unwatchHooks: async () => undefined,
    watchFiles: async (_hostId, _sessionId, tailed) => {
      watchCalls.push(tailed.map((entry) => ({ ...entry })));
      return { watching: true, sizes: state.sizes };
    },
    unwatchFiles: async () => { calls.push('unwatchFiles'); },
    removeFiles: async (_hostId, paths) => { removed.push(...paths); },
    removeEmptyDirectories: async () => undefined,
    runCommand: async (_hostId, request) => {
      commands.push(request);
      calls.push('runCommand');
      return state.answer(request);
    },
  };
  return { files, watchCalls, commands, removed, calls, state };
}

function makeRelay() {
  const host = fakeHost();
  const relay = new RemoteSessionRelay({ files: host.files });
  teardown.push(() => relay.dispose());
  return { host, relay };
}

const chunk = (sessionId: string, key: string, offset: number, text: string, size: number, reset = false) => ({
  type: 'fileChunk' as const, sessionId, key, offset, reset, size, data: Buffer.from(text).toString('base64'),
});

describe('a transcript found after the session started', () => {
  const wire = (id: string): string => path.join(mirror, '.agent', `${id}.jsonl`);

  it('is tailed once the id arrives, keeping what was already tailing, and the chunk lands in the new file', async () => {
    const { host, relay } = makeRelay();
    const index = path.join(mirror, '.agent', 'index.jsonl');
    await relay.register(registrationOf('s1', {
      files: (id) => [wire(id)],
      index: { path: index, folder: '/home/dev/project', sessionIdsIn: () => [] },
    }));
    expect(host.watchCalls).toEqual([[{ key: '0', path: '/home/dev/.agent/index.jsonl' }]]);

    relay.setAgentSessionId('s1', 'abc');

    await vi.waitFor(() => expect(host.watchCalls).toHaveLength(2));
    expect(host.watchCalls[1]).toEqual([
      { key: '0', path: '/home/dev/.agent/index.jsonl' },
      { key: '1', path: '/home/dev/.agent/abc.jsonl' },
    ]);
    relay.deliverChunk(chunk('s1', '1', 0, 'line\n', 5));
    expect(fs.readFileSync(wire('abc'), 'utf8')).toBe('line\n');
  });

  it('asks nothing of the host for an id it already has', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', { files: (id) => [wire(id)] }));
    relay.setAgentSessionId('s1', 'abc');
    await vi.waitFor(() => expect(host.watchCalls).toHaveLength(1));

    relay.setAgentSessionId('s1', 'abc');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(host.watchCalls).toHaveLength(1);
  });

  it('follows a new id, stops the old file, and never reuses a key', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', { files: (id) => [wire(id)] }));
    relay.setAgentSessionId('s1', 'first');
    await vi.waitFor(() => expect(host.watchCalls).toHaveLength(1));

    relay.setAgentSessionId('s1', 'second');
    await vi.waitFor(() => expect(host.watchCalls).toHaveLength(2));

    expect(host.watchCalls[1]).toEqual([{ key: '1', path: '/home/dev/.agent/second.jsonl' }]);
    // A chunk of the old file still on its way is dropped, and cannot land in the new one.
    relay.deliverChunk(chunk('s1', '0', 0, 'old', 3));
    expect(fs.existsSync(wire('second'))).toBe(false);
  });

  it('keeps an id that arrives while the files are still being pushed', async () => {
    const { host, relay } = makeRelay();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    host.files.writeFiles = async () => { await held; };
    const registering = relay.register(registrationOf('s1', { files: (id) => [wire(id)] }));
    await vi.waitFor(() => expect(relay.has('s1')).toBe(false));

    relay.setAgentSessionId('s1', 'abc');
    release();
    await registering;

    await vi.waitFor(() => expect(host.watchCalls.at(-1)).toEqual([{ key: '0', path: '/home/dev/.agent/abc.jsonl' }]));
  });

  it('ignores an id for a session already released', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', { files: (id) => [wire(id)] }));
    await relay.release('s1');

    relay.setAgentSessionId('s1', 'abc');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(host.watchCalls).toEqual([]);
  });

  it('refuses a path outside the mirror, as it does at spawn', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', { files: () => [path.join(scratch, 'elsewhere', 'abc.jsonl')] }));

    relay.setAgentSessionId('s1', 'abc');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(host.watchCalls.flat()).toEqual([]);
  });
});

describe('an index that names a fresh session', () => {
  const indexPath = (): string => path.join(mirror, '.agent', 'index.jsonl');

  function indexSource(folder = '/home/dev/project', files: RemoteTranscriptSource['files'] = () => []): RemoteTranscriptSource {
    return { files, index: { path: indexPath(), folder, sessionIdsIn: (text) => text.split('\n').filter(Boolean) } };
  }

  function relayFindingIds() {
    const made = makeRelay();
    const found: Array<[string, string]> = [];
    made.relay.onSessionIdFound((sessionId, id) => found.push([sessionId, id]));
    return { ...made, found };
  }

  it('reads only what was added after the agent started, so an older session is never taken for this one', async () => {
    const { host, relay, found } = relayFindingIds();
    host.state.sizes = { 0: 4 };
    await relay.register(registrationOf('s1', indexSource()));

    relay.deliverChunk(chunk('s1', '0', 0, 'old\n', 4));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(found).toEqual([]);

    relay.deliverChunk(chunk('s1', '0', 4, 'mine\n', 9));
    await vi.waitFor(() => expect(found).toEqual([['s1', 'mine']]));
  });

  it('names nothing when two sessions wait in one folder, because a wrong id resumes someone else', async () => {
    const { relay, found } = relayFindingIds();
    await relay.register(registrationOf('s1', indexSource()));
    await relay.register(registrationOf('s2', indexSource()));

    relay.deliverChunk(chunk('s1', '0', 0, 'new\n', 4));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(found).toEqual([]);
  });

  it('names a session in another folder, and leaves out an id another session holds', async () => {
    const { relay, found } = relayFindingIds();
    await relay.register(registrationOf('s1', indexSource('/home/dev/project/.kangentic/worktrees/a')));
    await relay.register(registrationOf('s2', indexSource('/home/dev/project/.kangentic/worktrees/b'), { agentSessionId: 'theirs' }));

    relay.deliverChunk(chunk('s1', '0', 0, 'theirs\nmine\n', 12));

    await vi.waitFor(() => expect(found).toEqual([['s1', 'mine']]));
  });

  it('asks for the transcript again as the index grows, for a resume on a mirror that held no index', async () => {
    const { host, relay } = relayFindingIds();
    let named = false;
    const wire = path.join(mirror, '.agent', 'wire.jsonl');
    await relay.register(registrationOf('s1', indexSource(undefined, () => (named ? [wire] : [])), { agentSessionId: 'known' }));
    expect(host.watchCalls).toHaveLength(1);

    named = true;
    relay.deliverChunk(chunk('s1', '0', 0, 'known\n', 6));

    await vi.waitFor(() => expect(host.watchCalls.at(-1)).toContainEqual({ key: '1', path: '/home/dev/.agent/wire.jsonl' }));
  });

  it('names nothing with an older program on the host that answers no sizes, since all of the index would read as new', async () => {
    const { host, relay, found } = relayFindingIds();
    host.files.watchFiles = async () => ({ watching: true });
    await relay.register(registrationOf('s1', indexSource()));

    relay.deliverChunk(chunk('s1', '0', 0, 'an-older-session\n', 17));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(found).toEqual([]);
  });

  it('reads the whole index as new when the file was not there before the agent ran', async () => {
    const { host, relay, found } = relayFindingIds();
    host.state.sizes = {};
    await relay.register(registrationOf('s1', indexSource()));

    relay.deliverChunk(chunk('s1', '0', 0, 'mine\n', 5));

    await vi.waitFor(() => expect(found).toEqual([['s1', 'mine']]));
  });

  it('names nothing after the index was replaced, since what lies past the baseline may be old', async () => {
    const { host, relay, found } = relayFindingIds();
    host.state.sizes = { 0: 2 };
    await relay.register(registrationOf('s1', indexSource()));

    relay.deliverChunk(chunk('s1', '0', 0, 'older\nsessions\n', 15, true));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(found).toEqual([]);
  });
});

describe('an exported transcript', () => {
  const copy = (id = 'abc'): string => remoteExportPath(placeOf(), 'agent', id);
  const spec = (id = 'abc'): RemoteTranscriptSnapshot => ({ file: 'agent', args: ['export', id], cwd: '/home/dev/project', localPath: copy(id) });
  const source = (): RemoteTranscriptSource => ({ files: () => [], snapshot: async (id) => spec(id) });

  /** A relay holding a session whose export is under way, and the key its chunks come on. */
  async function exporting() {
    const made = makeRelay();
    await made.relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    return made;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('never leaves half a document where a reader looks, and keeps the last whole copy until the next is whole', async () => {
    const { relay } = await exporting();

    relay.deliverChunk(chunk('s1', '0', 0, '{"n":', 8));
    expect(fs.existsSync(copy())).toBe(false);
    relay.deliverChunk(chunk('s1', '0', 5, '1}\n', 8));
    expect(fs.readFileSync(copy(), 'utf8')).toBe('{"n":1}\n');

    // The next export arrives over a link that drops partway: the reader keeps the whole one it had.
    relay.deliverChunk(chunk('s1', '0', 0, '{"n":2,', 12, true));
    expect(fs.readFileSync(copy(), 'utf8')).toBe('{"n":1}\n');
  });

  it('empties what an earlier export left that never finished arriving', async () => {
    const { relay } = await exporting();
    fs.mkdirSync(path.dirname(copy()), { recursive: true });
    fs.writeFileSync(`${copy()}.part`, 'a much longer leftover from an export that was cut off');

    relay.deliverChunk(chunk('s1', '0', 0, '{}\n', 3));

    expect(fs.readFileSync(copy(), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(`${copy()}.part`)).toBe(false);
  });

  it('starts the export over a shorter new file, and lands only the new one', async () => {
    const { relay } = await exporting();
    relay.deliverChunk(chunk('s1', '0', 0, '{"long":"first export"}\n', 24));

    relay.deliverChunk(chunk('s1', '0', 0, '{}\n', 3, true));

    expect(fs.readFileSync(copy(), 'utf8')).toBe('{}\n');
  });

  it('keeps the old copy when a rename fails, and puts the new one in place on a later try', async () => {
    const { host, relay } = await exporting();
    // A folder in the copy's place fails the rename on every OS, as a reader's open handle does on Windows.
    fs.mkdirSync(path.join(copy(), 'held'), { recursive: true });
    relay.deliverChunk(chunk('s1', '0', 0, '{}\n', 3));
    expect(fs.statSync(copy()).isDirectory()).toBe(true);

    fs.rmSync(copy(), { recursive: true });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(host.commands.length).toBeGreaterThan(1);
    expect(fs.readFileSync(copy(), 'utf8')).toBe('{}\n');
  });

  it('exports on a schedule through the host\'s own shell, never overlapping a run still going', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    expect(host.commands).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.commands).toHaveLength(1);
    expect(host.commands[0].file).toBe('sh');
    expect(host.commands[0].cwd).toBe('/home/dev/project');
    expect(host.commands[0].args.slice(3)).toEqual(['/home/dev/.kangentic/transcripts/agent/abc.json', 'agent', 'export', 'abc']);
    // Every caller value is an argument: the script holds none of them.
    expect(host.commands[0].args[1]).not.toContain('abc');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.commands).toHaveLength(2);
  });

  it('waits for an id before exporting, and starts soon after one arrives', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', source()));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.commands).toEqual([]);

    relay.setAgentSessionId('s1', 'abc');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(host.commands).toHaveLength(1);
  });

  it('takes a last export before it stops the tail, and removes the host\'s file after, for a session shorter than a tick', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));

    await relay.release('s1');

    expect(host.calls).toEqual(['runCommand', 'unwatchFiles']);
    expect(host.watchCalls).toEqual([[{ key: '0', path: '/home/dev/.kangentic/transcripts/agent/abc.json' }]]);
    expect(host.removed).toContain('/home/dev/.kangentic/transcripts/agent/abc.json');
  });

  it('lets a reader wait for the last export of a session that is ending, and for no other', async () => {
    const { relay } = makeRelay();
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await relay.register(registrationOf('s2', { files: () => [] }));
    expect(relay.transcriptSettled('s2')).toBeNull();

    const settled = relay.transcriptSettled('s1');
    let landed = false;
    void settled?.then(() => { landed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(landed).toBe(false);

    await relay.release('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(landed).toBe(true);
    expect(relay.transcriptSettled('s1')).toBeNull();
  });

  it('never holds a reader for long when the release is held up', async () => {
    const { relay } = makeRelay();
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));

    let landed = false;
    void relay.transcriptSettled('s1')?.then(() => { landed = true; });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(landed).toBe(true);
  });

  it('leaves the copy alone when the export fails, logs the reason once, and tries again', async () => {
    const host = fakeHost();
    const lines: string[] = [];
    const relay = new RemoteSessionRelay({ files: host.files, log: (line) => lines.push(line) });
    teardown.push(() => relay.dispose());
    host.state.answer = () => ({ code: 1, stdout: '', stderr: 'Error: No session found', timedOut: false });
    fs.mkdirSync(path.dirname(copy()), { recursive: true });
    fs.writeFileSync(copy(), '{"whole":true}\n');
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));

    await vi.advanceTimersByTimeAsync(65_000);

    expect(host.commands.length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((line) => line.includes('No session found'))).toHaveLength(1);
    expect(fs.readFileSync(copy(), 'utf8')).toBe('{"whole":true}\n');
  });

  it('says why an export never lands on an older program on the host, once', async () => {
    const host = fakeHost();
    const lines: string[] = [];
    const relay = new RemoteSessionRelay({ files: host.files, log: (line) => lines.push(line) });
    teardown.push(() => relay.dispose());
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const { size: _size, ...withNoSize } = chunk('s1', '0', 0, '{}\n', 3);

    relay.deliverChunk(withNoSize as never);
    relay.deliverChunk(withNoSize as never);

    expect(fs.existsSync(copy())).toBe(false);
    expect(lines.filter((line) => line.includes('no file size'))).toHaveLength(1);
  });

  it('logs the reason, not the shell\'s own opening lines, which change run to run', async () => {
    const host = fakeHost();
    const lines: string[] = [];
    const relay = new RemoteSessionRelay({ files: host.files, log: (line) => lines.push(line) });
    teardown.push(() => relay.dispose());
    let pid = 1000;
    host.state.answer = () => {
      pid += 1;
      return { code: 127, stdout: '', stderr: `bash: cannot set terminal process group (${pid}): Inappropriate ioctl for device\nbash: no job control in this shell\nsh: 4: agent: not found\n`, timedOut: false };
    };
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));

    await vi.advanceTimersByTimeAsync(65_000);

    expect(lines).toEqual(['could not export the transcript for s1: sh: 4: agent: not found']);
  });

  it('survives a host that cannot be reached, with the copy as it was', async () => {
    const { host, relay } = makeRelay();
    host.files.runCommand = async () => { throw new Error('the host did not answer runCommand within 30 s'); };
    fs.mkdirSync(path.dirname(copy()), { recursive: true });
    fs.writeFileSync(copy(), '{"whole":true}\n');
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));

    await vi.advanceTimersByTimeAsync(5_000);
    await relay.release('s1');

    expect(fs.readFileSync(copy(), 'utf8')).toBe('{"whole":true}\n');
  });
});

describe('the export\'s pace', () => {
  it('reads what the script printed, and nothing else as an answer', () => {
    expect(readSnapshotAnswer('replaced 1024\n')).toEqual({ replaced: true, bytes: 1024 });
    expect(readSnapshotAnswer('unchanged 1024\n')).toEqual({ replaced: false, bytes: 1024 });
    expect(readSnapshotAnswer('a banner\nunchanged 7\n')).toEqual({ replaced: false, bytes: 7 });
    expect(readSnapshotAnswer('')).toBeNull();
  });

  it('holds a small export to the shortest gap and spaces a large one so the link is not held', () => {
    expect(nextSnapshotDelayMs(1_000)).toBe(30_000);
    expect(nextSnapshotDelayMs(100_000_000)).toBe(500_000);
  });
});

describe('a transcript watch the host did not take', () => {
  const wire = (id: string): string => path.join(mirror, '.agent', `${id}.jsonl`);

  it('is rolled back and asked again on the next trigger, and the file\'s chunks then land', async () => {
    const { host, relay } = makeRelay();
    host.state.sizes = {};
    await relay.register(registrationOf('s1', {
      files: (id) => [wire(id)],
      index: { path: path.join(mirror, '.agent', 'index.jsonl'), folder: '/home/dev/project', sessionIdsIn: () => [] },
    }));
    const takeWatch = host.files.watchFiles;
    const attempts: string[][] = [];
    let refuse = true;
    host.files.watchFiles = async (hostId, sessionId, tailed) => {
      attempts.push(tailed.map((entry) => entry.path));
      if (refuse) {
        refuse = false;
        throw new Error('the host did not answer watchFiles');
      }
      return takeWatch(hostId, sessionId, tailed);
    };

    relay.setAgentSessionId('s1', 'abc');
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    expect(host.watchCalls).toHaveLength(1);

    // The index growing is a later trigger for the same set. With the failed watch left looking held, nothing
    // would ask the host again and the file would never be tailed.
    relay.deliverChunk(chunk('s1', '0', 0, 'noise\n', 6));
    await vi.waitFor(() => expect(attempts).toHaveLength(2));

    expect(attempts[1]).toContain('/home/dev/.agent/abc.jsonl');
    const tailed = host.watchCalls[1].find((entry) => entry.path === '/home/dev/.agent/abc.jsonl');
    expect(tailed).toBeDefined();
    relay.deliverChunk(chunk('s1', tailed?.key ?? '', 0, 'line\n', 5));
    expect(fs.readFileSync(wire('abc'), 'utf8')).toBe('line\n');
  });
});

describe('an export racing its own tail, its release and its replacement', () => {
  const copy = (id = 'abc'): string => remoteExportPath(placeOf(), 'agent', id);
  const spec = (id = 'abc'): RemoteTranscriptSnapshot => ({ file: 'agent', args: ['export', id], cwd: '/home/dev/project', localPath: copy(id) });
  const source = (): RemoteTranscriptSource => ({ files: () => [], snapshot: async (id) => spec(id) });
  const unchanged = (): HostCommandResult => ({ code: 0, stdout: 'unchanged 10\n', stderr: '', timedOut: false });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('is tailed on a later tick when the watch after its first snapshot failed, though every export answers unchanged', async () => {
    const { host, relay } = makeRelay();
    host.state.answer = unchanged;
    const takeWatch = host.files.watchFiles;
    let attempts = 0;
    host.files.watchFiles = async (hostId, sessionId, tailed) => {
      attempts += 1;
      if (attempts === 1) throw new Error('the host did not answer watchFiles');
      return takeWatch(hostId, sessionId, tailed);
    };
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(1);
    expect(host.watchCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(host.watchCalls).toHaveLength(1);
    const [tailed] = host.watchCalls[0];
    expect(tailed.path).toBe('/home/dev/.kangentic/transcripts/agent/abc.json');
    relay.deliverChunk(chunk('s1', tailed.key, 0, '{}\n', 3));
    expect(fs.readFileSync(copy(), 'utf8')).toBe('{}\n');
  });

  it('keeps the last whole copy when a piece of the next export never landed, and the next export starts over', async () => {
    const { host, relay } = makeRelay();
    host.state.answer = unchanged;
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const [tailed] = host.watchCalls[0];
    relay.deliverChunk(chunk('s1', tailed.key, 0, 'whole\n', 6));
    expect(fs.readFileSync(copy(), 'utf8')).toBe('whole\n');

    // Nothing resends the middle of this one, and its last chunk still brings the file to the size the host said.
    relay.deliverChunk(chunk('s1', tailed.key, 0, 'aaaa', 12, true));
    relay.deliverChunk(chunk('s1', tailed.key, 8, 'cccc', 12));
    expect(fs.readFileSync(copy(), 'utf8')).toBe('whole\n');

    relay.deliverChunk(chunk('s1', tailed.key, 0, 'replacement\n', 12, true));
    expect(fs.readFileSync(copy(), 'utf8')).toBe('replacement\n');
  });

  it('keeps the last whole copy when the staged file went partway through an export', async () => {
    const { host, relay } = makeRelay();
    host.state.answer = unchanged;
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const [tailed] = host.watchCalls[0];
    relay.deliverChunk(chunk('s1', tailed.key, 0, 'whole\n', 6));

    relay.deliverChunk(chunk('s1', tailed.key, 0, 'aaaa', 8, true));
    fs.rmSync(`${copy()}.part`, { force: true });
    relay.deliverChunk(chunk('s1', tailed.key, 4, 'bbbb', 8));

    expect(fs.readFileSync(copy(), 'utf8')).toBe('whole\n');
  });

  it('starts no further export once the relay is disposed during one', async () => {
    const { host, relay } = makeRelay();
    let finishExport = (): void => undefined;
    const heldExport = new Promise<void>((resolve) => { finishExport = resolve; });
    host.files.runCommand = async (_hostId, request) => {
      host.commands.push(request);
      await heldExport;
      return unchanged();
    };
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.commands).toHaveLength(1);

    relay.dispose();
    finishExport();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(host.commands).toHaveLength(1);
  });

  it('lets a reader waiting for the last export go at dispose, not after the bound', async () => {
    const { relay } = makeRelay();
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    let landed = false;
    void relay.transcriptSettled('s1')?.then(() => { landed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(landed).toBe(false);

    relay.dispose();
    // Far short of the 30 s bound, so only the dispose can have let the reader go.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(landed).toBe(true);
  });

  it('makes a resume wait for the release of the session it replaces, so the old release cannot remove what the new one tails', async () => {
    const { host, relay } = makeRelay();
    const order: string[] = [];
    let freeRelease = (): void => undefined;
    const heldRelease = new Promise<void>((resolve) => { freeRelease = resolve; });
    host.files.unwatchHooks = async (_hostId, sessionId) => {
      if (sessionId === 's1') await heldRelease;
    };
    const takeRemove = host.files.removeFiles;
    host.files.removeFiles = async (hostId, paths) => {
      order.push('s1 removes the host file');
      await takeRemove(hostId, paths);
    };
    const takeRun = host.files.runCommand;
    host.files.runCommand = async (hostId, request) => {
      order.push('export');
      return takeRun(hostId, request);
    };
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    const releasing = relay.release('s1');
    await relay.register(registrationOf('s2', source(), { agentSessionId: 'abc' }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual([]);

    freeRelease();
    await releasing;
    await vi.advanceTimersByTimeAsync(1_000);

    // The old session's last export and removal come first. The resume's export follows them.
    expect(order).toEqual(['export', 's1 removes the host file', 'export']);
  });

  it('clears what the old id\'s export left staged when the id moves on, and keeps its whole copy', async () => {
    const { host, relay } = makeRelay();
    await relay.register(registrationOf('s1', source(), { agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const key = host.watchCalls[0][0].key;
    relay.deliverChunk(chunk('s1', key, 0, '{"n":1}\n', 8));
    relay.deliverChunk(chunk('s1', key, 0, '{"n":2,', 12, true));
    expect(fs.readFileSync(copy('abc'), 'utf8')).toBe('{"n":1}\n');
    expect(fs.existsSync(`${copy('abc')}.part`)).toBe(true);

    relay.setAgentSessionId('s1', 'def');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(host.commands.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(`${copy('abc')}.part`)).toBe(false);
    expect(fs.readFileSync(copy('abc'), 'utf8')).toBe('{"n":1}\n');
  });
});

describe('a read of the index while a backfill arrives', () => {
  const indexPath = (): string => path.join(mirror, '.agent', 'index.jsonl');

  async function relayAskingIndex(sessionIdsIn: (text: string) => string[]) {
    const made = makeRelay();
    made.host.state.sizes = {};
    const found: Array<[string, string]> = [];
    made.relay.onSessionIdFound((sessionId, id) => found.push([sessionId, id]));
    await made.relay.register(registrationOf('s1', {
      files: () => [],
      index: { path: indexPath(), folder: '/home/dev/project', sessionIdsIn },
    }));
    return { ...made, found };
  }

  it('waits for the last chunk, then reads the whole index once', async () => {
    const asked: string[] = [];
    const { relay } = await relayAskingIndex((text) => { asked.push(text); return []; });

    relay.deliverChunk(chunk('s1', '0', 0, 'aa\n', 9));
    relay.deliverChunk(chunk('s1', '0', 3, 'bb\n', 9));
    // Intentional fixed wait: non-occurrence cannot be polled. A read starts on the next turns of the loop.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(asked).toEqual([]);

    relay.deliverChunk(chunk('s1', '0', 6, 'cc\n', 9));

    await vi.waitFor(() => expect(asked).toEqual(['aa\nbb\ncc\n']));
  });

  it('still reads on a chunk with no size, which is an older program on the host', async () => {
    const asked: string[] = [];
    const { relay } = await relayAskingIndex((text) => { asked.push(text); return []; });
    const { size: _size, ...withNoSize } = chunk('s1', '0', 0, 'aa\n', 99);

    relay.deliverChunk(withNoSize as never);

    await vi.waitFor(() => expect(asked).toEqual(['aa\n']));
  });

  it('goes round again when the index grows during a read, so an id in the later chunk is found with no third chunk', async () => {
    let reads = 0;
    // Assigned once the relay exists, and called from inside the reader below.
    let deliverSecond: () => void = () => undefined;
    const { relay, found } = await relayAskingIndex((text) => {
      reads += 1;
      // The first read is under way and holds only the first chunk when the second one lands.
      if (reads === 1) deliverSecond();
      return text.split('\n').filter((line) => line.startsWith('id-'));
    });
    deliverSecond = () => relay.deliverChunk(chunk('s1', '0', 6, 'id-two\n', 13));

    relay.deliverChunk(chunk('s1', '0', 0, 'noise\n', 6));

    await vi.waitFor(() => expect(found).toEqual([['s1', 'id-two']]));
    expect(reads).toBe(2);
  });
});

describe.skipIf(process.platform === 'win32')('an export through the real helper and its shell script', () => {
  let hostHome: string;
  let hostProject: string;
  let fakeCli: string;

  beforeEach(() => {
    hostHome = path.join(scratch, 'host-home');
    hostProject = path.join(hostHome, 'project');
    fs.mkdirSync(hostProject, { recursive: true });
    fakeCli = path.join(scratch, 'fake-cli.sh');
    fs.writeFileSync(fakeCli, '#!/bin/sh\necho "progress goes to stderr" >&2\ncat "$1"\n', { mode: 0o755 });
  });

  async function realRelay() {
    const helperRig = makeHelperRig(1, { homeDirectory: hostHome, baseEnv: { SHELL: '/bin/sh', PATH: process.env.PATH } });
    const link = new RemoteLink({
      identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
      connect: async () => dialHelper(helperRig),
      reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
    });
    link.start();
    await link.requestHelper('hostInfo', {});
    const files: RemoteSessionFiles = {
      writeFiles: (_hostId, fileList, directories) => link.requestHelper('writeFiles', { files: fileList, ...(directories ? { directories } : {}) }),
      writeFileRaw: async () => undefined,
      watchHooks: (_hostId, sessionId, directory, statusFile) => link.requestHelper('watchHooks', { sessionId, directory, ...(statusFile ? { statusFile } : {}) }),
      unwatchHooks: (_hostId, sessionId) => link.requestHelper('unwatchHooks', { sessionId }),
      watchFiles: (_hostId, sessionId, tailed) => link.requestHelper('watchFiles', { sessionId, files: tailed }),
      unwatchFiles: (_hostId, sessionId) => link.requestHelper('unwatchFiles', { sessionId }),
      removeFiles: (_hostId, paths) => link.requestHelper('removeFiles', { paths }),
      removeEmptyDirectories: (_hostId, paths) => link.requestHelper('removeEmptyDirectories', { paths }),
      runCommand: (_hostId, request) => link.requestHelper('runCommand', request),
    };
    const relay = new RemoteSessionRelay({ files });
    link.setEventListener((event) => {
      if (event.type === 'fileChunk') relay.deliverChunk(event);
    });
    teardown.push(() => relay.dispose(), () => link.stop(), () => helperRig.helper.dispose());
    return relay;
  }

  /** One session on the host that exports `document` and ends. Its release takes the last export. */
  async function runSession(relay: RemoteSessionRelay, sessionId: string, document: string): Promise<string> {
    const place = placeOf(hostHome, hostProject);
    const localPath = remoteExportPath(place, 'agent', 'abc');
    const source = path.join(hostHome, 'source.json');
    fs.writeFileSync(source, document);
    await relay.register(registrationOf(sessionId, {
      files: () => [],
      snapshot: async () => ({ file: fakeCli, args: [source], cwd: hostProject, localPath }),
    }, { agentSessionId: 'abc', place }));
    await relay.release(sessionId);
    return localPath;
  }

  it('carries an export far past a frame\'s cap, and leaves no file behind on the host', async () => {
    const relay = await realRelay();
    // Past the 256 KiB a reply can hold, and inside the last pass's cap: this is why it is never stdout.
    const document = `${JSON.stringify({ text: '界'.repeat(400_000) })}\n`;

    const localPath = await runSession(relay, 's1', document);

    expect(fs.readFileSync(localPath, 'utf8')).toBe(document);
    expect(fs.existsSync(`${localPath}.part`)).toBe(false);
    const hostFolder = path.join(hostHome, '.kangentic', 'transcripts', 'agent');
    expect(fs.readdirSync(hostFolder)).toEqual([]);
  });

  it('replaces the copy with the next session\'s export of the same conversation', async () => {
    const relay = await realRelay();
    await runSession(relay, 's1', '{"turns":1}\n');

    const localPath = await runSession(relay, 's2', '{"turns":2}\n');

    expect(fs.readFileSync(localPath, 'utf8')).toBe('{"turns":2}\n');
  });

  it('keeps the whole copy when the CLI cannot export, and the script leaves nothing staged', async () => {
    const relay = await realRelay();
    const localPath = await runSession(relay, 's1', '{"turns":1}\n');
    fs.writeFileSync(fakeCli, '#!/bin/sh\necho "Error: No session found" >&2\nexit 1\n', { mode: 0o755 });

    await runSession(relay, 's2', 'unused');

    expect(fs.readFileSync(localPath, 'utf8')).toBe('{"turns":1}\n');
    expect(fs.readdirSync(path.join(hostHome, '.kangentic', 'transcripts', 'agent'))).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('keeps the export owner-only, and leaves the CLI its own mask', async () => {
    const relay = await realRelay();
    // What the CLI's stdout is opened as, and the mask the CLI itself runs under.
    fs.writeFileSync(fakeCli, '#!/bin/sh\nstat -L -c %a /proc/self/fd/1\numask\n', { mode: 0o755 });
    const previousMask = process.umask(0o022);
    teardown.push(() => process.umask(previousMask));

    const localPath = await runSession(relay, 's1', 'unused');

    expect(fs.readFileSync(localPath, 'utf8').trim().split('\n')).toEqual(['600', '0022']);
    expect(fs.statSync(path.join(hostHome, '.kangentic', 'transcripts', 'agent')).mode & 0o777).toBe(0o700);
  });

  it('treats an export of nothing as a failure, so an empty file never replaces a conversation', async () => {
    const relay = await realRelay();
    const localPath = await runSession(relay, 's1', '{"turns":1}\n');
    fs.writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await runSession(relay, 's2', 'unused');

    expect(fs.readFileSync(localPath, 'utf8')).toBe('{"turns":1}\n');
  });

  it('keeps a value with shell characters as a value', async () => {
    const relay = await realRelay();
    const place = placeOf(hostHome, hostProject);
    const localPath = remoteExportPath(place, 'agent', 'abc');
    const marker = path.join(hostHome, 'pwned');
    const hostile = `; touch ${marker}; "$(touch ${marker})"`;
    fs.writeFileSync(fakeCli, '#!/bin/sh\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
    await relay.register(registrationOf('s1', {
      files: () => [],
      snapshot: async () => ({ file: fakeCli, args: [hostile], cwd: hostProject, localPath }),
    }, { agentSessionId: 'abc', place }));
    await relay.release('s1');

    expect(fs.readFileSync(localPath, 'utf8')).toBe(`${hostile}\n`);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
