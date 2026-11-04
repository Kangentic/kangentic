import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionHistoryReader,
  type SessionHistoryReaderCallbacks,
  type SessionHistoryAttachOptions,
} from '../../src/main/pty/readers/session-history-reader';

/**
 * Pins the attach/detach hand-over of SessionHistoryReader: a detach cancels an
 * in-flight attach so the next attach starts clean (a moved conversation's
 * detach-then-attach), a live attach still blocks a second one, and
 * `waitForFile` keeps locating until the file exists or a detach cancels it.
 */

type HistoryHook = SessionHistoryAttachOptions['hook'];

const RETRY_PAUSE_MS = 1_000;

function makeHook(locate: () => Promise<string | null>): { hook: HistoryHook; locate: ReturnType<typeof vi.fn> } {
  const locateSpy = vi.fn(locate);
  const hook = {
    locate: locateSpy,
    parse: () => ({ usage: null, events: [], activity: null }),
    isFullRewrite: false,
  } as unknown as HistoryHook;
  return { hook, locate: locateSpy };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('SessionHistoryReader detach and re-attach', () => {
  let tmpDir: string;
  let historyFile: string;
  let reader: SessionHistoryReader;

  const attachOptions = (hook: HistoryHook, extra: Partial<SessionHistoryAttachOptions> = {}): SessionHistoryAttachOptions => ({
    sessionId: 'session-reattach',
    agentSessionId: 'agent-session',
    cwd: tmpDir,
    hook,
    ...extra,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-history-reattach-'));
    historyFile = path.join(tmpDir, 'chat.jsonl');
    fs.writeFileSync(historyFile, '');
    reader = new SessionHistoryReader({
      onUsageUpdate: vi.fn(),
      onEvents: vi.fn(),
      onActivity: vi.fn(),
      onFirstTelemetry: vi.fn(),
    } satisfies SessionHistoryReaderCallbacks);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reader.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('an attach after a detach of a still-locating attach starts clean and the old attach cannot replace it', async () => {
    const firstLocate = deferred<string | null>();
    const first = makeHook(() => firstLocate.promise);
    const second = makeHook(async () => historyFile);

    const firstAttach = reader.attach(attachOptions(first.hook));
    expect(first.locate).toHaveBeenCalledTimes(1);

    reader.detach('session-reattach');
    await reader.attach(attachOptions(second.hook));

    expect(second.locate).toHaveBeenCalledTimes(1);
    expect(reader.isAttached('session-reattach')).toBe(true);

    // The cancelled attach finds a file late: it must neither bail the watcher
    // out nor install a second one over the new attach's.
    firstLocate.resolve(historyFile);
    await firstAttach;
    expect(reader.isAttached('session-reattach')).toBe(true);
  });

  it('an attach while a live attach is pending is a no-op', async () => {
    const firstLocate = deferred<string | null>();
    const first = makeHook(() => firstLocate.promise);
    const second = makeHook(async () => historyFile);

    const firstAttach = reader.attach(attachOptions(first.hook));
    await reader.attach(attachOptions(second.hook));
    expect(second.locate).not.toHaveBeenCalled();

    firstLocate.resolve(historyFile);
    await firstAttach;
    expect(reader.isAttached('session-reattach')).toBe(true);
  });

  it('waitForFile keeps locating until the file appears, then installs the watcher', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const hookHandle = makeHook(async () => {
      calls += 1;
      return calls >= 3 ? historyFile : null;
    });

    const attachPromise = reader.attach(attachOptions(hookHandle.hook, { waitForFile: () => true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hookHandle.locate).toHaveBeenCalledTimes(1);
    expect(reader.isAttached('session-reattach')).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    expect(hookHandle.locate).toHaveBeenCalledTimes(2);
    expect(reader.isAttached('session-reattach')).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    await attachPromise;
    expect(hookHandle.locate).toHaveBeenCalledTimes(3);
    expect(reader.isAttached('session-reattach')).toBe(true);
  });

  it('without waitForFile a null locate falls back after one call and installs nothing', async () => {
    vi.useFakeTimers();
    const hookHandle = makeHook(async () => null);

    await reader.attach(attachOptions(hookHandle.hook));
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 3);

    expect(hookHandle.locate).toHaveBeenCalledTimes(1);
    expect(reader.isAttached('session-reattach')).toBe(false);
  });

  it('a detach stops a waitForFile loop', async () => {
    vi.useFakeTimers();
    const hookHandle = makeHook(async () => null);

    const attachPromise = reader.attach(attachOptions(hookHandle.hook, { waitForFile: () => true }));
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 2);
    const callsBeforeDetach = hookHandle.locate.mock.calls.length;
    expect(callsBeforeDetach).toBeGreaterThanOrEqual(2);

    reader.detach('session-reattach');
    // The round in flight may finish, then the loop must end.
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 5);
    await attachPromise;
    expect(hookHandle.locate.mock.calls.length).toBeLessThanOrEqual(callsBeforeDetach + 1);
    const callsAfterSettle = hookHandle.locate.mock.calls.length;

    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 5);
    expect(hookHandle.locate.mock.calls.length).toBe(callsAfterSettle);
    expect(reader.isAttached('session-reattach')).toBe(false);
  });

  it('a waitForFile check that turns false ends the wait, so an exited session stops polling for ever', async () => {
    vi.useFakeTimers();
    let sessionRuns = true;
    const hookHandle = makeHook(async () => null);

    const attachPromise = reader.attach(attachOptions(hookHandle.hook, { waitForFile: () => sessionRuns }));
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 3);
    expect(hookHandle.locate.mock.calls.length).toBeGreaterThanOrEqual(3);

    sessionRuns = false;
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 2);
    await attachPromise;
    const callsAtEnd = hookHandle.locate.mock.calls.length;
    expect(reader.isAttached('session-reattach')).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 5);
    expect(hookHandle.locate.mock.calls.length).toBe(callsAtEnd);
  });

  it('a detach during the retry pause stops the loop before another locate', async () => {
    vi.useFakeTimers();
    const hookHandle = makeHook(async () => null);

    const attachPromise = reader.attach(attachOptions(hookHandle.hook, { waitForFile: () => true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hookHandle.locate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS / 2);
    reader.detach('session-reattach');
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 5);
    await attachPromise;

    expect(hookHandle.locate).toHaveBeenCalledTimes(1);
  });

  it('a cancelled attach finishing late leaves a newer pending attach blocking a third', async () => {
    const firstLocate = deferred<string | null>();
    const secondLocate = deferred<string | null>();
    const first = makeHook(() => firstLocate.promise);
    const second = makeHook(() => secondLocate.promise);
    const third = makeHook(async () => historyFile);

    const firstAttach = reader.attach(attachOptions(first.hook));
    reader.detach('session-reattach');
    const secondAttach = reader.attach(attachOptions(second.hook));
    expect(second.locate).toHaveBeenCalledTimes(1);

    firstLocate.resolve(historyFile);
    await firstAttach;

    await reader.attach(attachOptions(third.hook));
    expect(third.locate).not.toHaveBeenCalled();

    secondLocate.resolve(historyFile);
    await secondAttach;
    expect(reader.isAttached('session-reattach')).toBe(true);
  });

  it('a detached tail whose queued read finds the file gone leaves the replacing attach in place', async () => {
    const oldHandle = makeHook(async () => historyFile);
    await reader.attach(attachOptions(oldHandle.hook));
    expect(reader.isAttached('session-reattach')).toBe(true);

    const internals = reader as unknown as {
      states: Map<string, object>;
      scheduleChange(sessionId: string, state: object, label: string): void;
    };
    const oldState = internals.states.get('session-reattach') as { chain: Promise<void> };

    // The old tail's next read parks at its stat, then fails after the replacement attached.
    const pendingStat = deferred<fs.Stats>();
    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi.spyOn(fsPromises, 'stat');
    statSpy.mockImplementationOnce(() => pendingStat.promise);
    statSpy.mockImplementation(realStat as typeof fsPromises.stat);
    internals.scheduleChange('session-reattach', oldState, 'history:change');
    await vi.waitFor(() => expect(statSpy).toHaveBeenCalledTimes(1));

    reader.detach('session-reattach');
    const newHandle = makeHook(async () => historyFile);
    await reader.attach(attachOptions(newHandle.hook));
    expect(reader.isAttached('session-reattach')).toBe(true);

    const vanished = Object.assign(new Error('gone'), { code: 'ENOENT' });
    pendingStat.reject(vanished);
    await oldState.chain;

    expect(reader.isAttached('session-reattach')).toBe(true);
  });
});
