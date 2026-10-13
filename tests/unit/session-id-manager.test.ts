import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionIdManager } from '../../src/main/pty/lifecycle/session-id-manager';
import type { AgentParser } from '../../src/shared/types';

function makeAdapter(sessionIdStrategy: Partial<{
  fromOutput: (data: string) => string | null;
  fromFilesystem: (input: { spawnedAt: Date; cwd: string }) => Promise<string | null>;
  fromHook: (hookContext: string) => string | null;
}>): AgentParser {
  return {
    detectFirstOutput: (data: string) => data.length > 0,
    removeHooks: () => {},
    runtime: {
      activity: { kind: 'pty' },
      sessionId: {
        fromOutput: sessionIdStrategy.fromOutput,
        fromFilesystem: sessionIdStrategy.fromFilesystem,
        fromHook: sessionIdStrategy.fromHook,
      },
    },
  } as unknown as AgentParser;
}

describe('SessionIdManager', () => {
  let capturedIds: Map<string, string>;
  let existingSessions: Set<string>;
  let manager: SessionIdManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedIds = new Map();
    existingSessions = new Set();
    manager = new SessionIdManager({
      hasAgentSessionId: (id) => capturedIds.has(id),
      notifyAgentSessionId: (id, capturedId) => capturedIds.set(id, capturedId),
      sessionExists: (id) => existingSessions.has(id),
      agentSessionIdOf: (id) => capturedIds.get(id) ?? null,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const UUID_REGEX = /session id:\s+([0-9a-f-]{36})/i;
  const fromOutput = (data: string): string | null => {
    const match = data.match(UUID_REGEX);
    return match ? match[1] : null;
  };

  describe('onData', () => {
    it('captures the ID from a PTY chunk using the adapter regex', () => {
      existingSessions.add('s1');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', makeAdapter({ fromOutput }));
      expect(capturedIds.get('s1')).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('spans chunks via the rolling buffer', () => {
      const adapter = makeAdapter({ fromOutput });
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb', adapter);
      expect(capturedIds.has('s1')).toBe(false);
      manager.onData('s1', '-af55c8295c38\n', adapter);
      expect(capturedIds.get('s1')).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('does nothing after the ID is already known', () => {
      const adapter = makeAdapter({ fromOutput });
      capturedIds.set('s1', 'already-captured');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', adapter);
      expect(capturedIds.get('s1')).toBe('already-captured');
    });

    it('no-ops when the adapter has no fromOutput strategy', () => {
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', makeAdapter({}));
      expect(capturedIds.has('s1')).toBe(false);
    });
  });

  describe('scanScrollback', () => {
    it('captures from a full scrollback buffer', () => {
      const adapter = makeAdapter({ fromOutput });
      const scrollback = 'Gemini CLI v0.31.0\nsession id: 4231e6aa-5409-4749-9272-270e9aab079b\nExiting...';
      manager.scanScrollback('s1', adapter, scrollback);
      expect(capturedIds.get('s1')).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('no-ops when the ID is already known', () => {
      capturedIds.set('s1', 'already');
      manager.scanScrollback('s1', makeAdapter({ fromOutput }), 'session id: 4231e6aa-5409-4749-9272-270e9aab079b');
      expect(capturedIds.get('s1')).toBe('already');
    });
  });

  describe('init with filesystem strategy', () => {
    it('resolves and notifies on successful filesystem capture', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue('filesystem-captured-uuid');
      manager.init('s1', makeAdapter({ fromFilesystem }), '/some/cwd', 'codex');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(fromFilesystem).toHaveBeenCalledOnce();
      expect(capturedIds.get('s1')).toBe('filesystem-captured-uuid');
    });

    it('skips the notification when the session was removed before the promise resolved', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue('late-id');
      manager.init('s1', makeAdapter({ fromFilesystem }), '/cwd', 'codex');
      existingSessions.delete('s1');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(capturedIds.has('s1')).toBe(false);
    });

    it('logs a warning (does not throw) when the filesystem promise rejects', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockRejectedValue(new Error('boom'));
      manager.init('s1', makeAdapter({ fromFilesystem }), '/cwd', 'codex');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalled();
      expect(capturedIds.has('s1')).toBe(false);
    });
  });

  // A folder scan finds the newest session file an agent wrote in a folder. With
  // two sessions of that agent started in one folder close together, the file can
  // be the other's, and recording it would make a Resume reopen the wrong
  // conversation. An ambiguous match is dropped: no id is better than a wrong one.
  // A worktree session has a folder of its own and is never ambiguous.
  describe('init with filesystem strategy: an ambiguous folder match', () => {
    /** Start a session whose folder scan resolves to `foundId` once timers run. */
    function startScanning(sessionId: string, folder: string, agentName: string, foundId: string | null): void {
      existingSessions.add(sessionId);
      manager.init(sessionId, makeAdapter({ fromFilesystem: vi.fn().mockResolvedValue(foundId) }), folder, agentName);
    }

    async function settle(): Promise<void> {
      await vi.runAllTimersAsync();
      await Promise.resolve();
    }

    it('drops the match when another session of the same agent started in the same folder inside the window', async () => {
      startScanning('other', '/project', 'codex', null);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.has('s1')).toBe(false);
    });

    it('keeps the match when the other session in the folder is a different agent', async () => {
      startScanning('other', '/project', 'gemini', null);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });

    it('keeps the match when the other session is in another folder (a worktree of its own)', async () => {
      startScanning('other', '/project/.kangentic/worktrees/task-1', 'codex', null);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });

    it('keeps the match when the other session started outside the window', async () => {
      startScanning('other', '/project', 'codex', null);
      await vi.advanceTimersByTimeAsync(61_000);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });

    it('keeps the match when the other session already holds a different id', async () => {
      startScanning('other', '/project', 'codex', null);
      capturedIds.set('other', 'other-id');
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });

    it('drops a match that another session in the folder already holds, however long ago it started', async () => {
      startScanning('other', '/project', 'codex', null);
      capturedIds.set('other', 'found-id');
      await vi.advanceTimersByTimeAsync(61_000);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBeUndefined();
    });

    it('stops counting a session once it is removed', async () => {
      startScanning('other', '/project', 'codex', null);
      manager.removeSession('other');
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });

    // Distinct from removeSession above: that one drops the manager's own spawn
    // record. Here the record stays and the session registry no longer lists the
    // session, which is the `sessionExists` clause of the conflict check alone.
    it('keeps the match when the other session is gone from the session registry', async () => {
      startScanning('other', '/project', 'codex', null);
      existingSessions.delete('other');
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });

    // A session that ended or was paused is not removed from the registry: the
    // PTY exit handler only cancels its diagnostic timer (clearDiagnostic), and its
    // row stays listed with no agent session id. The file the folder scan found
    // may be the one that session wrote before it stopped, so the match is still
    // dropped. A change that forgot an exited session's spawn record, or counted
    // only live ones, would record that file as this session's id.
    it('drops the match when the other same-agent session already ended but is still registered', async () => {
      startScanning('other', '/project', 'codex', null);
      manager.clearDiagnostic('other');
      await vi.advanceTimersByTimeAsync(10_000);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();

      expect(existingSessions.has('other')).toBe(true);
      expect(capturedIds.has('s1')).toBe(false);
      const droppedWarnings = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('Dropped a session ID'));
      expect(droppedWarnings).toHaveLength(1);
      expect(droppedWarnings[0]).toContain('same agent');
    });

    // Windows and macOS file systems are case-insensitive by default, so two
    // spellings of one folder are one folder. A case-sensitive Linux file system
    // keeps them apart, so the same pair there is two folders and the match stays.
    // Plain strings, nothing is written to disk.
    it.skipIf(process.platform === 'linux')('treats cwd strings that differ only in letter case as one folder', async () => {
      startScanning('other', '/Project', 'codex', null);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.has('s1')).toBe(false);
    });

    it.runIf(process.platform === 'linux')('keeps cwd strings that differ only in letter case apart as two folders', async () => {
      startScanning('other', '/Project', 'codex', null);
      startScanning('s1', '/project', 'codex', 'found-id');
      await settle();
      expect(capturedIds.get('s1')).toBe('found-id');
    });
  });

  describe('diagnostic timer', () => {
    it('warns after 30s when no capture fired', () => {
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'claude');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).toHaveBeenCalled();
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('claude session ID not captured');
    });

    it('does NOT warn when capture happened before the timeout', () => {
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'claude');
      capturedIds.set('s1', 'already');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT arm the timer for adapters without a session-ID strategy', () => {
      manager.init('s1', { runtime: {} } as unknown as AgentParser, '/cwd', 'unknown');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('clearDiagnostic cancels the pending warning', () => {
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'claude');
      manager.clearDiagnostic('s1');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT arm the timer when hasKnownAgentSessionId=true (caller-owned UUID)', () => {
      // Adapters like Qwen and Kimi pass --session-id <uuid> at spawn time.
      // The agent's session ID is fixed by us, so the "not captured" warning
      // would be a false positive. spawn-flow signals this via the flag.
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'qwen', true);
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('removeSession', () => {
    it('clears timer and drops scanner state', () => {
      const adapter = makeAdapter({ fromOutput });
      manager.init('s1', adapter, '/cwd', 'claude');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb', adapter);
      manager.removeSession('s1');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
      // Scanner was dropped, so the tail alone won't match
      manager.onData('s1', '-af55c8295c38\n', adapter);
      expect(capturedIds.has('s1')).toBe(false);
    });
  });
});
