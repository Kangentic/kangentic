/**
 * Deterministic, fully-mocked-fs coverage for two SessionHistoryReader
 * cursor-tracking branches in `processChange()` that
 * tests/unit/session-history-reader.test.ts cannot reach: that file uses
 * REAL fs and a real FileWatcher, and its own comments note "we can't
 * easily trigger FileWatcher's onChange synchronously from a test" - so
 * neither a post-initial-read truncation event nor a queued attach-time
 * statSync failure is reachable there.
 *
 * This file instead mocks `node:fs` entirely, mirroring the approach in
 * tests/unit/file-watcher.test.ts: fs.watch's callback is captured so a
 * "change" can be fired synchronously, and fs.statSync / fs.openSync /
 * fs.readSync are driven by ordered response queues so every byte-cursor
 * transition is asserted exactly. This makes both branches deterministic
 * and OS-agnostic (no dependency on real fs.watch delivery timing, which
 * differs between Windows and Linux and is the exact thing the existing
 * file avoids).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── fs mock (queue-driven, no real filesystem I/O) ──────────────────────

type StatResponse = { size: number } | 'THROW';

let statQueue: StatResponse[] = [];
let readQueue: string[] = [];
let watchCallbacks: Array<() => void> = [];

const mockStatSync = vi.fn(() => {
  const next = statQueue.shift();
  if (next === undefined) {
    throw new Error('test bug: unexpected fs.statSync call - response queue exhausted');
  }
  if (next === 'THROW') {
    throw new Error('EBUSY: simulated transient stat race');
  }
  return { size: next.size, mtimeMs: 0 };
});

const mockOpenSync = vi.fn(() => 42);
const mockCloseSync = vi.fn(() => undefined);
const mockReadSync = vi.fn((...args: unknown[]) => {
  const [, buffer, offset] = args as [number, Buffer, number, number, number];
  const content = readQueue.shift();
  if (content === undefined) {
    throw new Error('test bug: unexpected fs.readSync call - response queue exhausted');
  }
  buffer.write(content, offset, 'utf-8');
  return Buffer.byteLength(content, 'utf-8');
});

/** Fire the most recently registered fs.watch callback (simulates one OS change event). */
function fireWatch(): void {
  const callback = watchCallbacks[watchCallbacks.length - 1];
  if (callback) callback();
}

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn((_path: string, callback: (...args: unknown[]) => void) => {
      watchCallbacks.push(callback);
      return { close: vi.fn(), on: vi.fn() };
    }),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    openSync: (...args: unknown[]) => mockOpenSync(...args),
    closeSync: (...args: unknown[]) => mockCloseSync(...args),
    readSync: (...args: unknown[]) => mockReadSync(...args),
  },
}));

import { SessionHistoryReader, type SessionHistoryReaderCallbacks } from '../../src/main/pty/readers/session-history-reader';
import type { SessionHistoryParseResult } from '../../src/shared/types';

describe('SessionHistoryReader cursor-tracking branches (fully-mocked fs)', () => {
  let callbacks: SessionHistoryReaderCallbacks;
  let reader: SessionHistoryReader;

  beforeEach(() => {
    vi.useFakeTimers();
    statQueue = [];
    readQueue = [];
    watchCallbacks = [];
    mockStatSync.mockClear();
    mockOpenSync.mockClear();
    mockCloseSync.mockClear();
    mockReadSync.mockClear();
    callbacks = {
      onUsageUpdate: vi.fn(),
      onEvents: vi.fn(),
      onActivity: vi.fn(),
      onFirstTelemetry: vi.fn(),
    };
    reader = new SessionHistoryReader(callbacks);
  });

  afterEach(() => {
    reader.disposeAll();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------
  // Branch (a): truncation guard resets to the NEW file size for a resume
  // watcher, never to 0.
  // ---------------------------------------------------------------------

  it('a resume watcher (startAtEnd) whose file shrinks after the cursor advanced resets the cursor to the NEW size, not 0', async () => {
    // Red-green: hardcoding `resetTo = 0` in session-history-reader.ts's
    // truncation guard (instead of `state.startedAtEnd ? stat.size : 0`)
    // makes the final assertions below fail - the post-shrink read would
    // request position 0 / length 250 (re-reading the pre-shrink tail)
    // instead of position 200 / length 50.
    const filePath = '/fake/rollout.jsonl';
    const parse = vi.fn((content: string) => ({ usage: null, events: [], activity: null }) as SessionHistoryParseResult);

    // attach()'s startAtEnd cursor stat: EOF is 500 bytes at attach time.
    statQueue.push({ size: 500 });
    // attach()'s synchronous initial processChange: nothing new yet.
    statQueue.push({ size: 500 });

    await reader.attach({
      sessionId: 'session-resume',
      agentSessionId: 'agent-uuid',
      cwd: '/fake',
      hook: { locate: async () => filePath, parse, isFullRewrite: false },
      startAtEnd: true,
    });

    expect(parse).not.toHaveBeenCalled(); // nothing new at attach time
    expect(reader.isAttached('session-resume')).toBe(true);

    // The session appends 300 bytes (500 -> 800). Normal forward read.
    statQueue.push({ size: 800 });
    readQueue.push('A'.repeat(300));
    fireWatch();
    vi.advanceTimersByTime(50); // flush FileWatcher's debounce

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0]).toBe('A'.repeat(300));
    expect(mockReadSync.mock.calls[0][3]).toBe(300); // length
    expect(mockReadSync.mock.calls[0][4]).toBe(500); // position

    // The file is truncated (rotated / replaced) down to 200 bytes - below
    // the advanced cursor (800). This is a RESUME watcher (startedAtEnd),
    // so the cursor must reset to the NEW size (200), never to 0.
    statQueue.push({ size: 200 });
    fireWatch();
    vi.advanceTimersByTime(50);

    // Nothing to read yet (200 <= reset cursor 200) - parse count unchanged.
    expect(parse).toHaveBeenCalledTimes(1);

    // The file grows again past the reset cursor (200 -> 250). If the guard
    // had wrongly reset to 0, this read would request position 0 / length
    // 250 instead of position 200 / length 50.
    statQueue.push({ size: 250 });
    readQueue.push('B'.repeat(50));
    fireWatch();
    vi.advanceTimersByTime(50);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[1][0]).toBe('B'.repeat(50));
    expect(mockReadSync.mock.calls[1][3]).toBe(50); // length - proves cursor was reset to 200, not 0
    expect(mockReadSync.mock.calls[1][4]).toBe(200); // position - proves cursor was reset to 200, not 0
  });

  it('a normal (non-resume) watcher whose file shrinks resets the cursor to 0', async () => {
    // Contrast case: startAtEnd is false, so the pre-existing truncation
    // behavior (reset to 0) must be unchanged by the resume-aware guard.
    const filePath = '/fake/rollout.jsonl';
    const parse = vi.fn((content: string) => ({ usage: null, events: [], activity: null }) as SessionHistoryParseResult);

    // attach()'s synchronous initial read: 100 bytes already present.
    statQueue.push({ size: 100 });
    readQueue.push('X'.repeat(100));

    await reader.attach({
      sessionId: 'session-fresh',
      agentSessionId: 'agent-uuid',
      cwd: '/fake',
      hook: { locate: async () => filePath, parse, isFullRewrite: false },
    });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0]).toBe('X'.repeat(100));

    // File shrinks to 30 bytes (below cursor 100). The truncation-guard
    // reset AND the subsequent read of the new, smaller content both happen
    // within this single processChange call (30 > the reset cursor of 0).
    statQueue.push({ size: 30 });
    readQueue.push('Y'.repeat(30));
    fireWatch();
    vi.advanceTimersByTime(50);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[1][0]).toBe('Y'.repeat(30));
    // The read after the reset started at position 0 (the whole new, smaller
    // file), not at the pre-shrink cursor of 100 - confirming a non-resume
    // watcher resets to 0, contrasting the resume watcher's reset-to-size.
    expect(mockReadSync.mock.calls[1][3]).toBe(30); // length
    expect(mockReadSync.mock.calls[1][4]).toBe(0); // position
  });

  // ---------------------------------------------------------------------
  // Branch (b): deferEofInit - a failed startAtEnd stat defers the EOF
  // anchor to the first processChange call.
  // ---------------------------------------------------------------------

  it('a failed startAtEnd stat defers the EOF anchor: the first processChange sets the cursor and reads nothing, and later reads start from that anchor, not 0', async () => {
    // Red-green: deleting the `if (state.deferEofInit) { ...; return; }`
    // block in session-history-reader.ts's processChange makes the
    // assertions below fail two ways: (1) parse/readSync would be called
    // during attach (reading the 900 bytes of pre-existing content), and
    // (2) the later read would request position 0 / length 950 instead of
    // position 900 / length 50.
    const filePath = '/fake/rollout.jsonl';
    const parse = vi.fn((content: string) => ({ usage: null, events: [], activity: null }) as SessionHistoryParseResult);

    // attach()'s startAtEnd cursor stat throws (a transient race just after
    // locate confirmed the file exists) - deferEofInit is armed, cursor=0.
    statQueue.push('THROW');
    // attach()'s synchronous initial processChange: the stat now succeeds,
    // observing 900 bytes of PRE-EXISTING (pre-suspend) content already on
    // disk. This call must anchor cursor=900 and read NOTHING.
    statQueue.push({ size: 900 });

    await reader.attach({
      sessionId: 'session-resume-race',
      agentSessionId: 'agent-uuid',
      cwd: '/fake',
      hook: { locate: async () => filePath, parse, isFullRewrite: false },
      startAtEnd: true,
    });

    // The deferred first call must NOT read the 900 pre-existing bytes.
    expect(parse).not.toHaveBeenCalled();
    expect(mockReadSync).not.toHaveBeenCalled();
    expect(reader.isAttached('session-resume-race')).toBe(true);

    // 50 fresh bytes are appended after the defer point (900 -> 950). If the
    // cursor had wrongly stayed at 0, this read would request position 0 /
    // length 950 - re-surfacing the stale pre-suspend tail this flag exists
    // to suppress.
    statQueue.push({ size: 950 });
    readQueue.push('C'.repeat(50));
    fireWatch();
    vi.advanceTimersByTime(50);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0]).toBe('C'.repeat(50));
    expect(mockReadSync.mock.calls[0][3]).toBe(50); // length - proves cursor anchored to 900, not 0
    expect(mockReadSync.mock.calls[0][4]).toBe(900); // position - proves cursor anchored to 900, not 0
  });

  it('a successful startAtEnd stat does NOT arm deferEofInit (contrast case)', async () => {
    // When the attach-time stat succeeds, the reader takes the normal
    // startAtEnd path (cursor = EOF immediately) - the deferred-anchor
    // branch above must not fire spuriously on the happy path.
    const filePath = '/fake/rollout.jsonl';
    const parse = vi.fn((content: string) => ({ usage: null, events: [], activity: null }) as SessionHistoryParseResult);

    statQueue.push({ size: 500 }); // attach-time stat succeeds
    statQueue.push({ size: 500 }); // initial processChange - nothing new

    await reader.attach({
      sessionId: 'session-resume-ok',
      agentSessionId: 'agent-uuid',
      cwd: '/fake',
      hook: { locate: async () => filePath, parse, isFullRewrite: false },
      startAtEnd: true,
    });

    expect(parse).not.toHaveBeenCalled();

    // A subsequent read starts at the immediately-anchored cursor (500),
    // not at a deferred re-anchor.
    statQueue.push({ size: 550 });
    readQueue.push('D'.repeat(50));
    fireWatch();
    vi.advanceTimersByTime(50);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(mockReadSync.mock.calls[0][4]).toBe(500); // position
    expect(mockReadSync.mock.calls[0][3]).toBe(50); // length
  });
});
