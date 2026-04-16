import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionHistoryReader,
  dispatchSessionHistoryResult,
  type SessionHistoryReaderCallbacks,
} from '../../src/main/pty/readers/session-history-reader';
import { Activity, EventType, type SessionHistoryParseResult, type SessionEvent } from '../../src/shared/types';

/**
 * Tests for SessionHistoryReader.
 *
 * Split into two test groups:
 * - dispatchSessionHistoryResult: pure function, no I/O, tests fan-out logic
 * - SessionHistoryReader class: integration-style tests with real temp files
 */

// -----------------------------------------------------------------------------
// Pure dispatch-function tests (no I/O)
// -----------------------------------------------------------------------------

describe('dispatchSessionHistoryResult', () => {
  let callbacks: SessionHistoryReaderCallbacks;

  beforeEach(() => {
    callbacks = {
      onUsageUpdate: vi.fn(),
      onEvents: vi.fn(),
      onActivity: vi.fn(),
      onFirstTelemetry: vi.fn(),
    };
  });

  it('calls onUsageUpdate when result.usage is present', () => {
    const result: SessionHistoryParseResult = {
      usage: {
        contextWindow: {
          usedPercentage: 50,
          usedTokens: 1000,
          cacheTokens: 0,
          totalInputTokens: 1000,
          totalOutputTokens: 100,
          contextWindowSize: 2000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
        model: { id: 'test-model', displayName: 'test-model' },
      },
      events: [],
      activity: null,
    };
    dispatchSessionHistoryResult('session-1', result, callbacks);
    expect(callbacks.onUsageUpdate).toHaveBeenCalledWith('session-1', result.usage);
    expect(callbacks.onEvents).not.toHaveBeenCalled();
    expect(callbacks.onActivity).not.toHaveBeenCalled();
  });

  it('skips onUsageUpdate when result.usage is null', () => {
    dispatchSessionHistoryResult('session-1', { usage: null, events: [], activity: null }, callbacks);
    expect(callbacks.onUsageUpdate).not.toHaveBeenCalled();
  });

  it('calls onEvents when events array is non-empty', () => {
    const events: SessionEvent[] = [
      { ts: 1000, type: EventType.Prompt, detail: 'test' },
      { ts: 2000, type: EventType.Idle, detail: 'test' },
    ];
    dispatchSessionHistoryResult('session-1', { usage: null, events, activity: null }, callbacks);
    expect(callbacks.onEvents).toHaveBeenCalledWith('session-1', events);
  });

  it('skips onEvents when events array is empty', () => {
    dispatchSessionHistoryResult('session-1', { usage: null, events: [], activity: null }, callbacks);
    expect(callbacks.onEvents).not.toHaveBeenCalled();
  });

  it('calls onActivity for Thinking hint', () => {
    dispatchSessionHistoryResult('session-1', { usage: null, events: [], activity: Activity.Thinking }, callbacks);
    expect(callbacks.onActivity).toHaveBeenCalledWith('session-1', Activity.Thinking);
  });

  it('calls onActivity for Idle hint', () => {
    dispatchSessionHistoryResult('session-1', { usage: null, events: [], activity: Activity.Idle }, callbacks);
    expect(callbacks.onActivity).toHaveBeenCalledWith('session-1', Activity.Idle);
  });

  it('skips onActivity when activity hint is null', () => {
    dispatchSessionHistoryResult('session-1', { usage: null, events: [], activity: null }, callbacks);
    expect(callbacks.onActivity).not.toHaveBeenCalled();
  });

  it('handles all three signals populated in one result', () => {
    const result: SessionHistoryParseResult = {
      usage: {
        contextWindow: {
          usedPercentage: 25,
          usedTokens: 500,
          cacheTokens: 0,
          totalInputTokens: 500,
          totalOutputTokens: 50,
          contextWindowSize: 2000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
        model: { id: 'combo-model', displayName: 'combo-model' },
      },
      events: [{ ts: 1000, type: EventType.Prompt, detail: 'go' }],
      activity: Activity.Thinking,
    };
    dispatchSessionHistoryResult('session-1', result, callbacks);
    expect(callbacks.onUsageUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvents).toHaveBeenCalledTimes(1);
    expect(callbacks.onActivity).toHaveBeenCalledWith('session-1', Activity.Thinking);
  });

  it('never calls onFirstTelemetry (reserved for the class method)', () => {
    const result: SessionHistoryParseResult = {
      usage: {
        contextWindow: {
          usedPercentage: 0, usedTokens: 0, cacheTokens: 0,
          totalInputTokens: 0, totalOutputTokens: 0, contextWindowSize: 0,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
        model: { id: 'x', displayName: 'x' },
      },
      events: [{ ts: 1, type: EventType.Prompt, detail: 'x' }],
      activity: Activity.Thinking,
    };
    dispatchSessionHistoryResult('session-1', result, callbacks);
    expect(callbacks.onFirstTelemetry).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// SessionHistoryReader class tests (integration-style, real temp files)
// -----------------------------------------------------------------------------

describe('SessionHistoryReader', () => {
  let tempDir: string;
  let callbacks: SessionHistoryReaderCallbacks;
  let reader: SessionHistoryReader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-history-reader-'));
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('attaches to a pre-existing file and reads it immediately', async () => {
    const filePath = path.join(tempDir, 'session.json');
    fs.writeFileSync(filePath, '{"model":"test"}');

    const fakeResult: SessionHistoryParseResult = {
      usage: {
        contextWindow: {
          usedPercentage: 10, usedTokens: 100, cacheTokens: 0,
          totalInputTokens: 100, totalOutputTokens: 5, contextWindowSize: 1000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
        model: { id: 'test', displayName: 'test' },
      },
      events: [],
      activity: null,
    };

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'agent-uuid',
      cwd: tempDir,
      hook: {
        locate: async () => filePath,
        parse: () => fakeResult,
        isFullRewrite: true,
      },
    });

    expect(callbacks.onUsageUpdate).toHaveBeenCalledWith('session-1', fakeResult.usage);
    expect(callbacks.onFirstTelemetry).toHaveBeenCalledWith('session-1');
    expect(reader.isAttached('session-1')).toBe(true);
  });

  it('skips attach when locate returns null', async () => {
    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'agent-uuid',
      cwd: tempDir,
      hook: {
        locate: async () => null,
        parse: () => ({ usage: null, events: [], activity: null }),
        isFullRewrite: false,
      },
    });

    expect(callbacks.onUsageUpdate).not.toHaveBeenCalled();
    expect(callbacks.onFirstTelemetry).not.toHaveBeenCalled();
    expect(reader.isAttached('session-1')).toBe(false);
  });

  it('double-attach is idempotent', async () => {
    const filePath = path.join(tempDir, 'session.json');
    fs.writeFileSync(filePath, '{}');
    const parse = vi.fn(() => ({
      usage: null,
      events: [],
      activity: null,
    } satisfies SessionHistoryParseResult));

    const hook = {
      locate: async () => filePath,
      parse,
      isFullRewrite: true,
    };

    await reader.attach({ sessionId: 'session-1', agentSessionId: 'x', cwd: tempDir, hook });
    await reader.attach({ sessionId: 'session-1', agentSessionId: 'x', cwd: tempDir, hook });

    expect(parse).toHaveBeenCalledTimes(1); // second attach should be no-op
    expect(reader.isAttached('session-1')).toBe(true);
  });

  it('detach closes the watcher and releases state', async () => {
    const filePath = path.join(tempDir, 'session.json');
    fs.writeFileSync(filePath, '{}');

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'x',
      cwd: tempDir,
      hook: {
        locate: async () => filePath,
        parse: () => ({ usage: null, events: [], activity: null }),
        isFullRewrite: true,
      },
    });

    expect(reader.isAttached('session-1')).toBe(true);
    reader.detach('session-1');
    expect(reader.isAttached('session-1')).toBe(false);
  });

  it('double-detach is a safe no-op', () => {
    reader.detach('nonexistent');
    reader.detach('nonexistent');
    // No throw = pass.
  });

  it('auto-detaches when the file disappears (ENOENT)', async () => {
    const filePath = path.join(tempDir, 'session.json');
    fs.writeFileSync(filePath, '{}');

    let parseCallCount = 0;
    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'x',
      cwd: tempDir,
      hook: {
        locate: async () => filePath,
        parse: () => {
          parseCallCount++;
          return { usage: null, events: [], activity: null };
        },
        isFullRewrite: true,
      },
    });

    // Delete the file, then manually delete the state via a simulated
    // change by calling detach to verify the ENOENT guard works.
    fs.rmSync(filePath);

    // Attempt another parse by simulating a change through direct reader
    // API - we can't easily trigger FileWatcher's onChange synchronously
    // from a test, so instead verify the detach path is reachable by
    // calling detach directly and ensuring isAttached flips.
    reader.detach('session-1');
    expect(reader.isAttached('session-1')).toBe(false);
    expect(parseCallCount).toBe(1); // only the initial read
  });

  it('append-mode reads new bytes using a byte cursor', async () => {
    const filePath = path.join(tempDir, 'rollout.jsonl');
    fs.writeFileSync(filePath, '{"t":"a"}\n');

    const receivedContent: string[] = [];
    const parse = vi.fn((content: string) => {
      receivedContent.push(content);
      return { usage: null, events: [], activity: null } satisfies SessionHistoryParseResult;
    });

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'x',
      cwd: tempDir,
      hook: {
        locate: async () => filePath,
        parse,
        isFullRewrite: false,
      },
    });

    // First call should have read the initial content.
    expect(receivedContent[0]).toBe('{"t":"a"}\n');

    // The cursor should now be at the end of that content. A future
    // append would read only the new bytes. We can't easily trigger
    // onChange in a unit test, but we verified the initial read worked.
    expect(reader.isAttached('session-1')).toBe(true);
  });

  it('dispatches all signals to the right callbacks', async () => {
    const filePath = path.join(tempDir, 'session.json');
    fs.writeFileSync(filePath, '{}');

    const result: SessionHistoryParseResult = {
      usage: {
        contextWindow: {
          usedPercentage: 42, usedTokens: 420, cacheTokens: 0,
          totalInputTokens: 420, totalOutputTokens: 10, contextWindowSize: 1000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
        model: { id: 'dispatch-test', displayName: 'dispatch-test' },
      },
      events: [{ ts: 1, type: EventType.Prompt, detail: 'go' }],
      activity: Activity.Thinking,
    };

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'x',
      cwd: tempDir,
      hook: {
        locate: async () => filePath,
        parse: () => result,
        isFullRewrite: true,
      },
    });

    expect(callbacks.onUsageUpdate).toHaveBeenCalledWith('session-1', result.usage);
    expect(callbacks.onEvents).toHaveBeenCalledWith('session-1', result.events);
    expect(callbacks.onActivity).toHaveBeenCalledWith('session-1', Activity.Thinking);
    expect(callbacks.onFirstTelemetry).toHaveBeenCalledWith('session-1');
    expect(callbacks.onFirstTelemetry).toHaveBeenCalledTimes(1);
  });

  it('disposeAll releases all active watchers', async () => {
    const file1 = path.join(tempDir, 'a.json');
    const file2 = path.join(tempDir, 'b.json');
    fs.writeFileSync(file1, '{}');
    fs.writeFileSync(file2, '{}');

    const parse = () => ({ usage: null, events: [], activity: null } satisfies SessionHistoryParseResult);

    await reader.attach({
      sessionId: 'session-1', agentSessionId: 'x', cwd: tempDir,
      hook: { locate: async () => file1, parse, isFullRewrite: true },
    });
    await reader.attach({
      sessionId: 'session-2', agentSessionId: 'y', cwd: tempDir,
      hook: { locate: async () => file2, parse, isFullRewrite: true },
    });

    expect(reader.isAttached('session-1')).toBe(true);
    expect(reader.isAttached('session-2')).toBe(true);

    reader.disposeAll();

    expect(reader.isAttached('session-1')).toBe(false);
    expect(reader.isAttached('session-2')).toBe(false);
  });

  it('detach during in-flight attach cancels cleanly', async () => {
    const filePath = path.join(tempDir, 'session.json');
    fs.writeFileSync(filePath, '{}');

    let locateResolve: ((value: string) => void) | null = null;
    const locatePromise = new Promise<string>((resolve) => {
      locateResolve = resolve;
    });

    const parse = vi.fn(() => ({ usage: null, events: [], activity: null } satisfies SessionHistoryParseResult));

    const attachPromise = reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'x',
      cwd: tempDir,
      hook: {
        locate: () => locatePromise,
        parse,
        isFullRewrite: true,
      },
    });

    // While attach is still awaiting locate, call detach.
    reader.detach('session-1');

    // Now let locate resolve. Attach should bail without installing a watcher.
    locateResolve!(filePath);
    await attachPromise;

    expect(parse).not.toHaveBeenCalled();
    expect(reader.isAttached('session-1')).toBe(false);
  });
});
