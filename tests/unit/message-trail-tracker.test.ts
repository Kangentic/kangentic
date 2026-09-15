import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import {
  MESSAGE_TRAIL_ENTRY_MAX_CHARS,
  MESSAGE_TRAIL_MAX_ENTRIES,
  MESSAGE_TRAIL_MAX_SESSIONS,
  MESSAGE_TRAIL_TAIL_BYTES,
  MessageTrailTracker,
  type MessageTrailAdapter,
} from '../../src/main/agent/message-trail-tracker';
import { MESSAGE_PREVIEW_MAX_CHARS } from '../../src/main/agent/shared/message-preview';
import type { AssistantMessageTrailEntry, Session, TranscriptEntry } from '../../src/shared/types';

/**
 * The board card's message trail is computed in main and PUSHED, never fetched
 * per card. These cases pin the tracker's contract against the REAL Claude
 * window parser over a temp JSONL: the first read anchors at the tail, later
 * reads see only appended records (including the first one appended after an
 * EOF read, which the window reader's offset contract would otherwise drop),
 * a burst of events coalesces into two reads, the trail is capped, a shrunk
 * file re-anchors, and an adapter without the window capability takes the
 * cached-parse fallback with the same uuid dedupe.
 */

class FakeSessionManager extends EventEmitter {
  readonly sessions = new Map<string, Session>();

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }
}

function fakeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    taskId: `task-${id}`,
    projectId: 'proj-1',
    pid: 4242,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-06-01T00:00:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: `agent-${id}`,
    ...overrides,
  };
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function userLine(uuid: string, text: string): string {
  return line({ type: 'user', uuid, timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: text } });
}

function assistantLine(uuid: string, text: string): string {
  return line({
    type: 'assistant',
    uuid,
    timestamp: '2026-06-01T00:00:01Z',
    message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }] },
  });
}

/** A window adapter over one file per agent session id, counting window reads. */
function windowAdapter(filesByAgentSessionId: Record<string, string>, calls: { windows: number }): MessageTrailAdapter {
  return {
    locateSessionHistoryFile: async (agentSessionId) => filesByAgentSessionId[agentSessionId] ?? null,
    parseTranscriptWindow: async (agentSessionId, _cwd, startByte, maxBytes) => {
      calls.windows += 1;
      const filePath = filesByAgentSessionId[agentSessionId];
      const window = await parseClaudeTranscriptWindow(filePath, startByte, maxBytes);
      return { ...window, sourcePath: filePath };
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_INTERVAL_MS = 30;

describe('MessageTrailTracker', () => {
  let tmpDir: string;
  let file: string;
  let manager: FakeSessionManager;
  let tracker: MessageTrailTracker | null;
  let pushes: Array<{ sessionId: string; entries: AssistantMessageTrailEntry[]; projectId: string }>;
  let calls: { windows: number };

  function texts(entries: AssistantMessageTrailEntry[]): string[] {
    return entries.map((entry) => entry.text);
  }

  function startTracker(adapter: MessageTrailAdapter, agentSessionId = 'agent-s1'): MessageTrailTracker {
    tracker = new MessageTrailTracker({
      sessionManager: manager,
      resolveSessionFacts: () => ({ sessionType: 'fake-agent', agentSessionId, cwd: '/mock/project' }),
      resolveAdapter: () => adapter,
      minIntervalMs: MIN_INTERVAL_MS,
      fallbackMinIntervalMs: MIN_INTERVAL_MS,
    });
    tracker.on('trail', (sessionId: string, entries: AssistantMessageTrailEntry[], projectId: string) => {
      pushes.push({ sessionId, entries, projectId });
    });
    return tracker;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-trail-tracker-test-'));
    file = path.join(tmpDir, 'session.jsonl');
    manager = new FakeSessionManager();
    manager.sessions.set('s1', fakeSession('s1'));
    tracker = null;
    pushes = [];
    calls = { windows: 0 };
  });

  afterEach(() => {
    tracker?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchors the first read at the tail and pushes the newest lines, oldest first', async () => {
    const filler: string[] = [];
    for (let turn = 0; turn < 1500; turn += 1) filler.push(userLine(`u${turn}`, `turn ${turn} ${'x'.repeat(200)}`));
    fs.writeFileSync(file, assistantLine('early', 'said long ago') + filler.join('') + assistantLine('a1', 'late one') + assistantLine('a2', 'late two'));
    expect(fs.statSync(file).size).toBeGreaterThan(MESSAGE_TRAIL_TAIL_BYTES * 2);

    startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });

    await waitUntil(() => pushes.length >= 1);
    expect(pushes[0].sessionId).toBe('s1');
    expect(pushes[0].projectId).toBe('proj-1');
    expect(texts(pushes[0].entries)).toEqual(['late one', 'late two']);
    // One bounded window, not the whole file.
    expect(calls.windows).toBe(1);
  });

  it('sees a record appended after an EOF read, and stays silent when nothing was appended', async () => {
    fs.writeFileSync(file, assistantLine('a1', 'first'));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);
    await settle(MIN_INTERVAL_MS * 3);

    // The file ends with the record's newline. Without the EOF step-back the
    // next window would start PAST that newline and drop 'second' as a
    // partial line.
    fs.appendFileSync(file, assistantLine('a2', 'second'));
    manager.emit('event', 's1', { ts: 2, type: 'tool_start', tool: 'Bash' });
    await waitUntil(() => pushes.length === 2);
    expect(texts(pushes[1].entries)).toEqual(['first', 'second']);

    await settle(MIN_INTERVAL_MS * 3);
    manager.emit('event', 's1', { ts: 3, type: 'tool_end', tool: 'Bash' });
    await settle(MIN_INTERVAL_MS * 3);
    expect(pushes).toHaveLength(2);
  });

  it('coalesces a burst of events into one immediate read and one trailing read', async () => {
    fs.writeFileSync(file, assistantLine('a1', 'first'));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));

    manager.emit('event', 's1', { ts: 1, type: 'tool_start', tool: 'Read' });
    manager.emit('event', 's1', { ts: 2, type: 'tool_end', tool: 'Read' });
    manager.emit('event', 's1', { ts: 3, type: 'tool_start', tool: 'Grep' });
    manager.emit('event', 's1', { ts: 4, type: 'tool_end', tool: 'Grep' });

    await waitUntil(() => pushes.length === 1);
    await settle(MIN_INTERVAL_MS * 4);
    expect(calls.windows).toBe(2);
    expect(texts(pushes[0].entries)).toEqual(['first']);
  });

  it('never reads on a tool result or a user prompt, which cannot carry new agent prose', async () => {
    fs.writeFileSync(file, assistantLine('a1', 'first'));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));

    manager.emit('event', 's1', { ts: 1, type: 'tool_end', tool: 'Read' });
    manager.emit('event', 's1', { ts: 2, type: 'prompt' });
    await settle(MIN_INTERVAL_MS * 4);
    expect(calls.windows).toBe(0);
    expect(pushes).toHaveLength(0);

    // The next tool call (or the turn's end) is what reads the text that preceded it.
    manager.emit('event', 's1', { ts: 3, type: 'tool_start', tool: 'Grep' });
    await waitUntil(() => pushes.length === 1);
    expect(texts(pushes[0].entries)).toEqual(['first']);
  });

  it('keeps only the newest five lines', async () => {
    const lines: string[] = [];
    for (let index = 1; index <= 7; index += 1) lines.push(assistantLine(`a${index}`, `message ${index}`));
    fs.writeFileSync(file, lines.join(''));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);
    expect(pushes[0].entries).toHaveLength(MESSAGE_TRAIL_MAX_ENTRIES);
    expect(texts(pushes[0].entries)).toEqual(['message 3', 'message 4', 'message 5', 'message 6', 'message 7']);

    await settle(MIN_INTERVAL_MS * 3);
    fs.appendFileSync(file, assistantLine('a8', 'message 8'));
    manager.emit('event', 's1', { ts: 2, type: 'idle' });
    await waitUntil(() => pushes.length === 2);
    expect(texts(pushes[1].entries)).toEqual(['message 4', 'message 5', 'message 6', 'message 7', 'message 8']);
  });

  it('caps each line above the phone preview cap, so a wrapped latest message fills a wide comfortable card', async () => {
    fs.writeFileSync(file, assistantLine('a1', 'x'.repeat(MESSAGE_TRAIL_ENTRY_MAX_CHARS + 300)));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);
    expect(MESSAGE_TRAIL_ENTRY_MAX_CHARS).toBeGreaterThan(MESSAGE_PREVIEW_MAX_CHARS);
    expect(pushes[0].entries[0].text).toHaveLength(MESSAGE_TRAIL_ENTRY_MAX_CHARS);
  });

  it('re-anchors at the tail when the file shrinks under the cursor', async () => {
    fs.writeFileSync(file, assistantLine('a1', `first ${'x'.repeat(300)}`));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);
    await settle(MIN_INTERVAL_MS * 3);

    fs.writeFileSync(file, assistantLine('b1', 'fresh'));
    manager.emit('event', 's1', { ts: 2, type: 'idle' });
    await waitUntil(() => pushes.length === 2);
    expect(texts(pushes[1].entries).at(-1)).toBe('fresh');
  });

  it('falls back to the cached parse for an adapter without the window capability and dedupes repeats', async () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'alpha' }] },
      { kind: 'assistant', uuid: 'a2', ts: 2, blocks: [{ type: 'text', text: 'beta' }] },
    ];
    let parses = 0;
    const adapter: MessageTrailAdapter = {
      parseTranscript: async () => {
        parses += 1;
        return { entries, sourcePath: null };
      },
    };
    startTracker(adapter, `agent-fallback-${Date.now()}`);

    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);
    expect(texts(pushes[0].entries)).toEqual(['alpha', 'beta']);
    expect(parses).toBeGreaterThanOrEqual(1);

    await settle(MIN_INTERVAL_MS * 3);
    manager.emit('event', 's1', { ts: 2, type: 'idle' });
    await settle(MIN_INTERVAL_MS * 3);
    // Same entries again: nothing new by uuid, so no second push.
    expect(pushes).toHaveLength(1);
  });

  it('ignores transient (Command Terminal) sessions', async () => {
    fs.writeFileSync(file, assistantLine('a1', 'first'));
    manager.sessions.set('s1', fakeSession('s1', { transient: true }));
    startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await settle(MIN_INTERVAL_MS * 3);
    expect(calls.windows).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it('retains a trail after the session exits and prunes it once the registry drops the session', async () => {
    fs.writeFileSync(file, assistantLine('a1', 'first'));
    const trailTracker = startTracker(windowAdapter({ 'agent-s1': file }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);

    manager.sessions.set('s1', fakeSession('s1', { status: 'exited', exitCode: 0 }));
    expect(texts(trailTracker.snapshot()['s1'] ?? [])).toEqual(['first']);

    manager.sessions.delete('s1');
    expect(trailTracker.snapshot()).toEqual({});
  });

  it('re-anchors on the new file when the agent session id changes, keeping the trail', async () => {
    const secondFile = path.join(tmpDir, 'forked.jsonl');
    fs.writeFileSync(file, assistantLine('a1', 'from the first file'));
    fs.writeFileSync(secondFile, assistantLine('b1', 'from the forked file'));
    startTracker(windowAdapter({ 'agent-s1': file, 'agent-forked': secondFile }, calls));
    manager.emit('event', 's1', { ts: 1, type: 'idle' });
    await waitUntil(() => pushes.length === 1);
    await settle(MIN_INTERVAL_MS * 3);

    manager.emit('agent-session-id', 's1', 'task-s1', 'proj-1', 'agent-forked');
    await waitUntil(() => pushes.length === 2);
    expect(texts(pushes[1].entries)).toEqual(['from the first file', 'from the forked file']);
  });

  describe('MESSAGE_TRAIL_MAX_SESSIONS eviction', () => {
    it('evicts the oldest tracked session once the cap is hit, clearing its trailing timer', async () => {
      const adapter: MessageTrailAdapter = {
        parseTranscript: async (agentSessionId) => ({
          entries: [
            { kind: 'assistant', uuid: `${agentSessionId}-1`, ts: 1, blocks: [{ type: 'text', text: `said by ${agentSessionId}` }] },
          ],
          sourcePath: null,
        }),
      };
      const evictionPushes: string[] = [];
      const evictionTracker = new MessageTrailTracker({
        sessionManager: manager,
        resolveSessionFacts: (sessionId) => ({ sessionType: 'fake-agent', agentSessionId: sessionId, cwd: '/mock/project' }),
        resolveAdapter: () => adapter,
        // Large enough that the trailing timer armed below can never fire
        // mid-test: every step from here to the eviction is synchronous JS
        // (no await), so Node's single-threaded event loop cannot run a
        // setTimeout callback in between regardless of the value - a
        // generous interval just keeps that intent obvious.
        minIntervalMs: 5000,
        fallbackMinIntervalMs: 5000,
      });
      evictionTracker.on('trail', (sessionId: string) => evictionPushes.push(sessionId));
      tracker = evictionTracker;

      manager.sessions.set('s0', fakeSession('s0'));
      evictionTracker.schedule('s0');
      await waitUntil(() => evictionPushes.includes('s0'));
      // s0 has a real, non-empty trail before the cap is ever hit, so its
      // disappearance from snapshot() below is a genuine eviction signal,
      // not just an untouched empty entry.
      expect(evictionTracker.snapshot()['s0']).toBeDefined();

      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      // Fill up to the cap with 199 more distinct sessions: s0..s199 is 200
      // tracked states, exactly MESSAGE_TRAIL_MAX_SESSIONS. No eviction yet.
      for (let index = 1; index < MESSAGE_TRAIL_MAX_SESSIONS; index += 1) {
        const sessionId = `s${index}`;
        manager.sessions.set(sessionId, fakeSession(sessionId));
        evictionTracker.schedule(sessionId);
      }
      expect(evictionTracker.snapshot()['s0']).toBeDefined();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      // The 201st distinct session pushes the map over the cap: s0, the
      // oldest by insertion order, is evicted.
      manager.sessions.set('s200', fakeSession('s200'));
      evictionTracker.schedule('s200');

      expect(evictionTracker.snapshot()['s0']).toBeUndefined();
      // dropState() is the tracker's only caller of clearTimeout, so one call
      // here is direct evidence s0's trailing timer was cleared, not merely
      // abandoned still-pending.
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

      clearTimeoutSpy.mockRestore();
    });
  });

  describe('read()-in-flight vs. eviction race', () => {
    it('does not re-arm a trailing read for a session evicted while its read was in flight', async () => {
      let releaseGate: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let s0CallCount = 0;
      const adapter: MessageTrailAdapter = {
        parseTranscript: async (agentSessionId) => {
          if (agentSessionId !== 's0') {
            return {
              entries: [{ kind: 'assistant', uuid: `${agentSessionId}-1`, ts: 1, blocks: [{ type: 'text', text: `said by ${agentSessionId}` }] }],
              sourcePath: null,
            };
          }
          s0CallCount += 1;
          const callNumber = s0CallCount;
          // Only the FIRST call - the in-flight read this test races against
          // eviction - is gated. A later phantom re-read (the bug) resolves
          // at once and must carry a genuinely NEW uuid so merge() cannot
          // dedupe it away and mask the bug.
          if (callNumber === 1) await gate;
          return {
            entries: [{ kind: 'assistant', uuid: `s0-call-${callNumber}`, ts: callNumber, blocks: [{ type: 'text', text: `said by s0, call ${callNumber}` }] }],
            sourcePath: null,
          };
        },
      };

      const racePushes: string[] = [];
      const raceTracker = new MessageTrailTracker({
        sessionManager: manager,
        resolveSessionFacts: (sessionId) => ({ sessionType: 'fake-agent', agentSessionId: sessionId, cwd: '/mock/project' }),
        resolveAdapter: () => adapter,
        minIntervalMs: MIN_INTERVAL_MS,
        fallbackMinIntervalMs: MIN_INTERVAL_MS,
      });
      raceTracker.on('trail', (sessionId: string) => racePushes.push(sessionId));
      tracker = raceTracker;

      manager.sessions.set('s0', fakeSession('s0'));
      // Kicks off the gated, in-flight read: readInFlight becomes true
      // synchronously, before this call even returns.
      raceTracker.schedule('s0');
      // A second trigger while the read is in flight sets rereadRequested,
      // exactly like a hook event landing mid-read.
      raceTracker.schedule('s0');

      // Fill to the cap (200 states: s0..s199), then push one more: s0, the
      // oldest, is evicted WHILE its read is still stuck on the gate. All of
      // this is synchronous JS, so it cannot race the gated read itself.
      for (let index = 1; index < MESSAGE_TRAIL_MAX_SESSIONS; index += 1) {
        const sessionId = `s${index}`;
        manager.sessions.set(sessionId, fakeSession(sessionId));
        raceTracker.schedule(sessionId);
      }
      manager.sessions.set('s200', fakeSession('s200'));
      raceTracker.schedule('s200');
      expect(raceTracker.snapshot()['s0']).toBeUndefined();

      // Let the original in-flight read complete. It still emits its own
      // trail push - that read was legitimate; only the finally block's
      // RE-ARM is what needs guarding - so this is unconditional either way.
      releaseGate?.();
      await waitUntil(() => racePushes.includes('s0'));
      expect(racePushes.filter((id) => id === 's0')).toHaveLength(1);

      raceTracker.dispose();

      // Intentional fixed wait: this asserts a NON-occurrence (no second
      // read), which cannot be polled for. Without the
      // `this.states.get(sessionId) === state` guard in read()'s finally
      // block, completing the gated read with rereadRequested still true
      // re-arms a trailing timer on the now-orphaned state. dispose() cannot
      // reach it (it only walks the live `states` map), so it fires anyway
      // after minIntervalMs and reads again, producing a second,
      // distinguishable ('s0-call-2') push for a session that is already gone.
      await settle(MIN_INTERVAL_MS * 6);
      expect(racePushes.filter((id) => id === 's0')).toHaveLength(1);
    });
  });
});
