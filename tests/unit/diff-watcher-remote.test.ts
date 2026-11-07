/**
 * The Changes panel's live refresh for a checkout on an SSH host (#913).
 *
 * What a user loses if it breaks: a panel for a task on a host that looks live and never updates (the
 * stand-in folder here is empty, so a file watch on it arms and never fires), or one that refreshes on every
 * poll, or that keeps asking a slow host while the last answer is still on its way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiffWatcher, REMOTE_POLL_MS } from '../../src/main/git/diff-watcher';
import { setRemoteGitResolver, type RemoteGitRunner } from '../../src/main/git/remote-git';

const REMOTE_PATH = '/shell/.kangentic/worktrees/7';
const DEBOUNCE_MS = 500;

let fingerprint: ReturnType<typeof vi.fn<() => Promise<string>>>;
let watcher: DiffWatcher;
let fsWatch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  fingerprint = vi.fn<() => Promise<string>>(async () => 'a');
  setRemoteGitResolver((directory) => (directory === REMOTE_PATH ? ({ fingerprint } as unknown as RemoteGitRunner) : null));
  fsWatch = vi.spyOn(fs, 'watch');
  watcher = new DiffWatcher();
});

afterEach(() => {
  watcher.closeAll();
  setRemoteGitResolver(null);
  fsWatch.mockRestore();
  vi.useRealTimers();
});

/** Let one poll run and its debounce pass. */
async function pollOnce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
}

describe('a checkout on a host', () => {
  it('is polled, not watched, and its first answer is only the baseline', async () => {
    const callback = vi.fn();
    watcher.subscribe(REMOTE_PATH, callback);
    await vi.advanceTimersByTimeAsync(0);

    expect(fsWatch).not.toHaveBeenCalled();
    expect(fingerprint).toHaveBeenCalledTimes(1);
    await pollOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it('fires once when the fingerprint moves, and not again while it stays', async () => {
    const callback = vi.fn();
    watcher.subscribe(REMOTE_PATH, callback);
    await vi.advanceTimersByTimeAsync(0);

    fingerprint.mockResolvedValue('b');
    await pollOnce();
    expect(callback).toHaveBeenCalledTimes(1);
    await pollOnce();
    await pollOnce();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('reads again after a host that was out of reach answers, whether or not it moved', async () => {
    const callback = vi.fn();
    fingerprint.mockRejectedValueOnce(new Error('The link to the host is down.'));
    watcher.subscribe(REMOTE_PATH, callback);
    await vi.advanceTimersByTimeAsync(0);
    // The first answer failed, so there is no baseline: nothing is known, and the next answer says to read.
    await pollOnce();
    expect(callback).toHaveBeenCalledTimes(1);

    fingerprint.mockRejectedValueOnce(new Error('down again'));
    await pollOnce();
    expect(callback).toHaveBeenCalledTimes(1);
    // Back, with the fingerprint it had before the outage: still a read, since a change in between is unknown.
    await pollOnce();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('never has two polls in flight, so a slow host is asked once', async () => {
    let answer: (value: string) => void = () => undefined;
    fingerprint.mockImplementation(() => new Promise<string>((resolve) => { answer = resolve; }));
    watcher.subscribe(REMOTE_PATH, vi.fn());
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 5);
    expect(fingerprint).toHaveBeenCalledTimes(1);

    answer('a');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    expect(fingerprint).toHaveBeenCalledTimes(2);
  });

  it('shares one poll between subscribers, and stops when the last one leaves', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watcher.subscribe(REMOTE_PATH, first);
    const stopSecond = watcher.subscribe(REMOTE_PATH, second);
    await vi.advanceTimersByTimeAsync(0);
    expect(fingerprint).toHaveBeenCalledTimes(1);

    fingerprint.mockResolvedValue('b');
    await pollOnce();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(fingerprint).toHaveBeenCalledTimes(2);

    stopFirst();
    fingerprint.mockResolvedValue('c');
    await pollOnce();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    stopSecond();
    const callsWhenStopped = fingerprint.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 5);
    expect(fingerprint).toHaveBeenCalledTimes(callsWhenStopped);
  });

  it('does not fire for an answer that lands after its subscriber left', async () => {
    let answer: (value: string) => void = () => undefined;
    fingerprint.mockImplementationOnce(async () => 'a');
    const callback = vi.fn();
    const stop = watcher.subscribe(REMOTE_PATH, callback);
    await vi.advanceTimersByTimeAsync(0);

    fingerprint.mockImplementation(() => new Promise<string>((resolve) => { answer = resolve; }));
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    stop();
    answer('changed');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('a local path', () => {
  it('is still watched, never polled', () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-watcher-local-'));
    try {
      const stop = watcher.subscribe(local, vi.fn());
      expect(fsWatch).toHaveBeenCalled();
      expect(fingerprint).not.toHaveBeenCalled();
      stop();
    } finally {
      fs.rmSync(local, { recursive: true, force: true });
    }
  });
});
