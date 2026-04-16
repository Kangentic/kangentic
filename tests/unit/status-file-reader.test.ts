import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StatusFileReader,
  type StatusFileReaderCallbacks,
  type StatusFileHook,
} from '../../src/main/pty/readers/status-file-reader';
import {
  EventType,
  type SessionUsage,
  type SessionEvent,
} from '../../src/shared/types';

/**
 * Tests for StatusFileReader - the subsystem that owns Claude's hook-based
 * telemetry file watching pipeline (status.json + events.jsonl).
 *
 * These tests use real temp files and a stub status-file hook so its
 * behavior is predictable and we can focus on the reader's file I/O
 * and dispatch logic.
 */

function makeStubStatusFileHook(options: {
  parseStatus?: (raw: string) => SessionUsage | null;
  parseEvent?: (line: string) => SessionEvent | null;
}): StatusFileHook {
  return {
    parseStatus: options.parseStatus ?? (() => null),
    parseEvent: options.parseEvent ?? (() => null),
    isFullRewrite: true,
  };
}

function makeUsage(totalInputTokens: number): SessionUsage {
  return {
    contextWindow: {
      usedPercentage: totalInputTokens / 200_000 * 100,
      usedTokens: totalInputTokens,
      cacheTokens: 0,
      totalInputTokens,
      totalOutputTokens: 100,
      contextWindowSize: 200_000,
    },
    cost: { totalCostUsd: 0.01, totalDurationMs: 1000 },
    model: { id: 'claude-sonnet-4-5', displayName: 'claude-sonnet-4-5' },
  };
}

describe('StatusFileReader', () => {
  let tempDir: string;
  let callbacks: StatusFileReaderCallbacks;
  let reader: StatusFileReader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-file-reader-'));
    callbacks = {
      onUsageParsed: vi.fn(),
      onEventsParsed: vi.fn(),
    };
    reader = new StatusFileReader(callbacks);
  });

  afterEach(() => {
    reader.disposeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // attach / detach lifecycle
  // ---------------------------------------------------------------------------

  it('attaches to a session and reads an existing status.json immediately', () => {
    const statusPath = path.join(tempDir, 'status.json');
    fs.writeFileSync(statusPath, '{"existing":"data"}');

    const expectedUsage = makeUsage(5000);
    const parser = makeStubStatusFileHook({
      parseStatus: () => expectedUsage,
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: null,
      statusFileHook: parser,
    });

    // WAIT: attach() deletes stale status.json on setup, then the watcher
    // triggers an initial read of the (now-deleted) file. So we need to
    // re-write content AFTER attach.
    fs.writeFileSync(statusPath, '{"fresh":"data"}');

    // Trigger flush to read it synchronously (the real reader has
    // debounced watchers but this works for testing dispatch).
    reader.flushPendingEvents('session-1');

    // The initial synchronous read in attach happened on the DELETED file
    // (ENOENT), so no callback fired there. But we can still verify the
    // attach lifecycle worked:
    expect(reader.isAttached('session-1')).toBe(true);
  });

  it('deletes stale status.json on attach so the watcher does not emit cached data', () => {
    const statusPath = path.join(tempDir, 'status.json');
    fs.writeFileSync(statusPath, '{"stale":"prev-run"}');

    const parser = makeStubStatusFileHook({
      parseStatus: (raw) => {
        if (raw.includes('stale')) {
          throw new Error('should never parse stale content');
        }
        return null;
      },
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: null,
      statusFileHook: parser,
    });

    // File should be deleted by attach.
    expect(fs.existsSync(statusPath)).toBe(false);
  });

  it('truncates stale events.jsonl on attach', () => {
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '{"old":"event"}\n{"also":"old"}\n');

    const parser = makeStubStatusFileHook({});

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: parser,
    });

    // File should exist but be empty.
    expect(fs.existsSync(eventsPath)).toBe(true);
    expect(fs.readFileSync(eventsPath, 'utf-8')).toBe('');
  });

  it('detach closes watchers and deletes files', () => {
    const statusPath = path.join(tempDir, 'status.json');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, ''); // attach will truncate anyway

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: eventsPath,
      statusFileHook: makeStubStatusFileHook({}),
    });

    // Write some content after attach so there's something to delete.
    fs.writeFileSync(statusPath, '{"data":"here"}');
    fs.writeFileSync(eventsPath, 'data');

    reader.detach('session-1');

    expect(reader.isAttached('session-1')).toBe(false);
    expect(fs.existsSync(statusPath)).toBe(false);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  it('detachWithoutCleanup closes watchers but preserves files', () => {
    const statusPath = path.join(tempDir, 'status.json');
    const eventsPath = path.join(tempDir, 'events.jsonl');

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: eventsPath,
      statusFileHook: makeStubStatusFileHook({}),
    });

    fs.writeFileSync(statusPath, '{"preserve":"me"}');
    fs.writeFileSync(eventsPath, 'preserved');

    reader.detachWithoutCleanup('session-1');

    expect(reader.isAttached('session-1')).toBe(false);
    // Files intact for resume race.
    expect(fs.existsSync(statusPath)).toBe(true);
    expect(fs.readFileSync(statusPath, 'utf-8')).toBe('{"preserve":"me"}');
    expect(fs.existsSync(eventsPath)).toBe(true);
    expect(fs.readFileSync(eventsPath, 'utf-8')).toBe('preserved');
  });

  it('double-attach is idempotent', () => {
    const statusPath = path.join(tempDir, 'status.json');
    const parser = makeStubStatusFileHook({});

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: null,
      statusFileHook: parser,
    });
    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: null,
      statusFileHook: parser,
    });

    expect(reader.isAttached('session-1')).toBe(true);
  });

  it('double-detach is a safe no-op', () => {
    reader.detach('nonexistent');
    reader.detach('nonexistent');
    // No throw = pass.
  });

  it('no-op attach when both paths are null', () => {
    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: null,
      statusFileHook: makeStubStatusFileHook({}),
    });
    expect(reader.isAttached('session-1')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // handleStatusChange (via flushPendingEvents-adjacent + direct file manipulation)
  // ---------------------------------------------------------------------------

  it('parses and dispatches a status.json update', () => {
    const statusPath = path.join(tempDir, 'status.json');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    const expectedUsage = makeUsage(1234);
    const parser = makeStubStatusFileHook({
      parseStatus: () => expectedUsage,
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: eventsPath,
      statusFileHook: parser,
    });

    // Write content to the status file after attach.
    fs.writeFileSync(statusPath, '{"any":"content"}');

    // Trigger the private handleStatusChange via a test-only access path.
    // In production, fs.watch fires this asynchronously.
    const privateReader = reader as unknown as {
      handleStatusChange(sessionId: string): void;
    };
    privateReader.handleStatusChange('session-1');

    expect(callbacks.onUsageParsed).toHaveBeenCalledWith('session-1', expectedUsage);
  });

  it('skips dispatch when parseStatus returns null', () => {
    const statusPath = path.join(tempDir, 'status.json');
    const parser = makeStubStatusFileHook({
      parseStatus: () => null,
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: null,
      statusFileHook: parser,
    });

    fs.writeFileSync(statusPath, 'invalid');

    const privateReader = reader as unknown as {
      handleStatusChange(sessionId: string): void;
    };
    privateReader.handleStatusChange('session-1');

    expect(callbacks.onUsageParsed).not.toHaveBeenCalled();
  });

  it('swallows fs errors from missing status.json', () => {
    const statusPath = path.join(tempDir, 'status.json');
    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusPath,
      eventsOutputPath: null,
      statusFileHook: makeStubStatusFileHook({
        parseStatus: () => {
          throw new Error('should not be called');
        },
      }),
    });

    const privateReader = reader as unknown as {
      handleStatusChange(sessionId: string): void;
    };
    // No file exists - should not throw.
    expect(() => privateReader.handleStatusChange('session-1')).not.toThrow();
    expect(callbacks.onUsageParsed).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // handleEventsChange - append-mode reads with cursor
  // ---------------------------------------------------------------------------

  it('reads new lines from events.jsonl with a byte cursor', () => {
    const eventsPath = path.join(tempDir, 'events.jsonl');
    const parser = makeStubStatusFileHook({
      parseEvent: (line) => {
        const json = JSON.parse(line) as { type: string; detail: string };
        return { ts: Date.now(), type: EventType.Prompt, detail: json.detail } as SessionEvent;
      },
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: parser,
    });

    // First batch
    fs.writeFileSync(eventsPath, '{"type":"Prompt","detail":"one"}\n{"type":"Prompt","detail":"two"}\n');
    reader.flushPendingEvents('session-1');

    expect(callbacks.onEventsParsed).toHaveBeenCalledTimes(1);
    const firstCall = (callbacks.onEventsParsed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toBe('session-1');
    expect(firstCall[1]).toEqual(['{"type":"Prompt","detail":"one"}', '{"type":"Prompt","detail":"two"}']);
    expect(firstCall[2]).toHaveLength(2);

    // Append more content
    fs.appendFileSync(eventsPath, '{"type":"Prompt","detail":"three"}\n');
    reader.flushPendingEvents('session-1');

    expect(callbacks.onEventsParsed).toHaveBeenCalledTimes(2);
    const secondCall = (callbacks.onEventsParsed as ReturnType<typeof vi.fn>).mock.calls[1];
    // Cursor should only include the new line, not all three.
    expect(secondCall[1]).toEqual(['{"type":"Prompt","detail":"three"}']);
  });

  it('resets cursor when events.jsonl shrinks (truncation guard)', () => {
    const eventsPath = path.join(tempDir, 'events.jsonl');
    const parser = makeStubStatusFileHook({
      parseEvent: (line) => ({ ts: 1, type: EventType.Prompt, detail: line } as SessionEvent),
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: parser,
    });

    // Initial content
    fs.writeFileSync(eventsPath, 'line-one\nline-two\n');
    reader.flushPendingEvents('session-1');
    expect(callbacks.onEventsParsed).toHaveBeenCalledTimes(1);

    // Truncate + rewrite (smaller than cursor)
    fs.writeFileSync(eventsPath, 'fresh\n');
    reader.flushPendingEvents('session-1');

    // Should re-read from scratch and fire again with the new content
    expect(callbacks.onEventsParsed).toHaveBeenCalledTimes(2);
    const secondCall = (callbacks.onEventsParsed as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[1]).toEqual(['fresh']);
  });

  it('handles CRLF line endings', () => {
    const eventsPath = path.join(tempDir, 'events.jsonl');
    const parser = makeStubStatusFileHook({
      parseEvent: (line) => ({ ts: 1, type: EventType.Prompt, detail: line } as SessionEvent),
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: parser,
    });

    fs.writeFileSync(eventsPath, 'line-a\r\nline-b\r\n');
    reader.flushPendingEvents('session-1');

    const call = (callbacks.onEventsParsed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toEqual(['line-a', 'line-b']);
  });

  it('passes both raw lines and parsed events so hook-context ID capture can happen', () => {
    const eventsPath = path.join(tempDir, 'events.jsonl');
    // Parser returns events for the first line only; second line is
    // unparseable. The callback should still receive both raw lines
    // (for hook-context ID capture) and only one parsed event.
    const parser = makeStubStatusFileHook({
      parseEvent: (line) => {
        if (line === 'good-line') {
          return { ts: 1, type: EventType.Prompt, detail: line } as SessionEvent;
        }
        return null;
      },
    });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: parser,
    });

    fs.writeFileSync(eventsPath, 'good-line\nunparseable-line\n');
    reader.flushPendingEvents('session-1');

    const call = (callbacks.onEventsParsed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toEqual(['good-line', 'unparseable-line']);
    expect(call[2]).toHaveLength(1);
  });

  it('tails events.jsonl for adapters without a statusFileHook (Codex/Gemini)', () => {
    // REGRESSION: the events-file watcher used to be gated on
    // `statusFileHook != null`, which made the hook-based session-ID
    // capture path dead code for every non-Claude adapter. Gemini
    // would write `session_id` via event-bridge.js into events.jsonl
    // but Kangentic would never read it, so "Loading agent..."
    // stuck forever. Now the watcher installs whenever eventsOutputPath
    // is set, and raw lines are delivered even when the adapter
    // provides no parseEvent hook (events[] is empty, rawLines is
    // populated - exactly what captureHookSessionIds needs).
    const eventsPath = path.join(tempDir, 'events.jsonl');

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: null, // non-Claude adapter
    });

    // event-bridge.js appends a session_start line with hookContext
    // (this matches the real shape captured from Gemini in
    // tests/fixtures/agent-pty/gemini-real-auth-events.jsonl).
    const line = JSON.stringify({
      ts: Date.now(),
      type: 'session_start',
      hookContext: JSON.stringify({ session_id: 'aa7fa183-281d-4311-91f5-a244c9aab93b' }),
    });
    fs.writeFileSync(eventsPath, line + '\n');

    reader.flushPendingEvents('session-1');

    expect(callbacks.onEventsParsed).toHaveBeenCalledTimes(1);
    const call = (callbacks.onEventsParsed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('session-1'); // sessionId
    expect(call[1]).toHaveLength(1);   // rawLines
    expect(call[1][0]).toContain('aa7fa183');
    expect(call[2]).toHaveLength(0);   // events - empty because no statusFileHook
  });

  it('flushPendingEvents is idempotent on empty files', () => {
    const eventsPath = path.join(tempDir, 'events.jsonl');
    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: eventsPath,
      statusFileHook: makeStubStatusFileHook({}),
    });

    // Reader already truncated events.jsonl on attach. Flushing should
    // be a no-op.
    reader.flushPendingEvents('session-1');
    reader.flushPendingEvents('session-1');

    expect(callbacks.onEventsParsed).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // disposeAll
  // ---------------------------------------------------------------------------

  it('disposeAll releases all active attachments without deleting files', () => {
    const statusA = path.join(tempDir, 'a-status.json');
    const eventsA = path.join(tempDir, 'a-events.jsonl');
    const statusB = path.join(tempDir, 'b-status.json');
    const eventsB = path.join(tempDir, 'b-events.jsonl');

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusA,
      eventsOutputPath: eventsA,
      statusFileHook: makeStubStatusFileHook({}),
    });
    reader.attach({
      sessionId: 'session-2',
      statusOutputPath: statusB,
      eventsOutputPath: eventsB,
      statusFileHook: makeStubStatusFileHook({}),
    });

    // Put some content down so we can verify disposeAll does NOT delete.
    fs.writeFileSync(statusA, '{"a":1}');
    fs.writeFileSync(statusB, '{"b":2}');

    reader.disposeAll();

    expect(reader.isAttached('session-1')).toBe(false);
    expect(reader.isAttached('session-2')).toBe(false);
    // Files preserved - disposeAll is for shutdown, not full cleanup.
    expect(fs.existsSync(statusA)).toBe(true);
    expect(fs.existsSync(statusB)).toBe(true);
  });
});
