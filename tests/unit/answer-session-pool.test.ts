/**
 * One warm answering session per chat, bound to what it was started with.
 *
 * The pool's promises: a chat reuses its session under the same key and gets a
 * new one under another; a dead or busy session is replaced; every ending (the
 * chat, a failed turn, ten idle minutes, the quit) disposes the process and
 * removes its run directory, the second time after the process is gone, since
 * Windows keeps a live process's working directory.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AnswerSession } from '../../src/main/agent/agent-adapter';
import { createAnswerSessionPool } from '../../src/main/retrieval/answer-session-pool';
import { sweepStaleAnswerRunDirectories, STALE_ANSWER_RUN_DIRECTORY_MS } from '../../src/main/agent/shared/answer-run-directory';

class FakeSession implements AnswerSession {
  readonly ready = Promise.resolve();
  alive = true;
  busy = false;
  disposed = 0;
  private resolveExited: () => void = () => undefined;
  readonly exited = new Promise<void>((resolve) => { this.resolveExited = resolve; });
  ask = vi.fn(async () => 'answer');
  dispose(): void {
    this.disposed += 1;
    this.alive = false;
  }
  exit(): void {
    this.resolveExited();
  }
}

function harness(idleMs = 60_000, maxSessions = 4) {
  let directoryCount = 0;
  const removed: string[] = [];
  const sessions: FakeSession[] = [];
  const sweep = vi.fn(async () => 0);
  const pool = createAnswerSessionPool<{ table: string }>({
    idleMs,
    maxSessions,
    makeDirectory: () => `dir-${++directoryCount}`,
    removeDirectory: (directory) => removed.push(directory),
    sweepStaleDirectories: sweep,
  });
  const open = vi.fn((directory: string) => {
    void directory;
    const session = new FakeSession();
    sessions.push(session);
    return session;
  });
  return { pool, open, sessions, removed, sweep };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAnswerSessionPool', () => {
  it('reuses a chat\'s session under the same key, and keeps what it was primed with', () => {
    const { pool, open } = harness();
    const first = pool.take('chat-1', 'key-a', open);
    expect(first).not.toBeNull();
    first!.primed = { table: 'T' };
    const again = pool.take('chat-1', 'key-a', open);
    expect(again).toBe(first);
    expect(again!.primed).toEqual({ table: 'T' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('dir-1');
  });

  it('replaces a session under another key, disposing it and removing its directory', async () => {
    const { pool, open, sessions, removed } = harness();
    pool.take('chat-1', 'key-a', open);
    const replacement = pool.take('chat-1', 'key-b', open);
    expect(sessions[0].disposed).toBe(1);
    expect(replacement!.session).toBe(sessions[1]);
    expect(replacement!.primed).toBeNull();
    expect(removed).toEqual(['dir-1']);
    // Once the process is gone, the directory is removed again: the first
    // pass cannot take a live process's working directory on Windows.
    sessions[0].exit();
    await sessions[0].exited;
    await Promise.resolve();
    expect(removed).toEqual(['dir-1', 'dir-1']);
  });

  it('replaces a dead session and one still busy with a turn the user moved past', () => {
    const { pool, open, sessions } = harness();
    pool.take('chat-1', 'key', open);
    sessions[0].alive = false;
    pool.take('chat-1', 'key', open);
    sessions[1].busy = true;
    pool.take('chat-1', 'key', open);
    expect(open).toHaveBeenCalledTimes(3);
    expect(sessions[1].disposed).toBe(1);
  });

  it('keeps chats apart', () => {
    const { pool, open } = harness();
    const one = pool.take('chat-1', 'key', open);
    const two = pool.take('chat-2', 'key', open);
    expect(one).not.toBe(two);
    expect(pool.size).toBe(2);
  });

  it('returns null for an agent with no session, leaving no directory', () => {
    const { pool, removed } = harness();
    expect(pool.take('chat-1', 'key', () => null)).toBeNull();
    expect(removed).toEqual(['dir-1']);
    expect(pool.size).toBe(0);
  });

  it('removes the directory when the session cannot start', () => {
    const { pool, removed } = harness();
    expect(() => pool.take('chat-1', 'key', () => { throw new Error('no CLI'); })).toThrow('no CLI');
    expect(removed).toEqual(['dir-1']);
  });

  it('ends a session left idle, and a question restarts the clock', () => {
    vi.useFakeTimers();
    const { pool, open, sessions } = harness(10_000);
    const pooled = pool.take('chat-1', 'key', open)!;
    vi.advanceTimersByTime(8_000);
    pool.touch(pooled);
    vi.advanceTimersByTime(8_000);
    expect(sessions[0].disposed).toBe(0);
    vi.advanceTimersByTime(2_001);
    expect(sessions[0].disposed).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('ends on the chat, on a failed turn, and all at once on quit', () => {
    const { pool, open, sessions } = harness();
    pool.take('chat-1', 'key', open);
    pool.end('chat-1');
    expect(sessions[0].disposed).toBe(1);

    const failed = pool.take('chat-2', 'key', open)!;
    pool.discard(failed);
    expect(sessions[1].disposed).toBe(1);

    pool.take('chat-3', 'key', open);
    pool.take('chat-4', 'key', open);
    pool.disposeAll();
    expect(sessions[2].disposed).toBe(1);
    expect(sessions[3].disposed).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('does not let a stale handle discard the session that replaced it', () => {
    const { pool, open, sessions } = harness();
    const stale = pool.take('chat-1', 'key-a', open)!;
    pool.take('chat-1', 'key-b', open);
    pool.discard(stale);
    expect(sessions[1].disposed).toBe(0);
    expect(pool.size).toBe(1);
  });

  it('keeps one live session by default, ending the least recently used', () => {
    // The graph is one surface app-wide, so a second chat's session means the
    // first is one nobody can reach any more: an orphan a missed end left.
    const sessions: FakeSession[] = [];
    const pool = createAnswerSessionPool<{ table: string }>({
      makeDirectory: () => 'dir',
      removeDirectory: () => undefined,
      sweepStaleDirectories: async () => 0,
    });
    const open = () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    };
    pool.take('chat-1', 'key', open);
    pool.take('chat-2', 'key', open);
    expect(sessions[0].disposed).toBe(1);
    expect(pool.size).toBe(1);
  });

  it('under a larger cap, ends the one used longest ago', () => {
    const { pool, open, sessions } = harness(60_000, 2);
    pool.take('chat-1', 'key', open);
    pool.take('chat-2', 'key', open);
    pool.take('chat-1', 'key', open);
    pool.take('chat-3', 'key', open);
    expect(sessions[1].disposed).toBe(1);
    expect(sessions[0].disposed).toBe(0);
  });

  it('opens nothing for a prewarm whose chat ended while it resolved', () => {
    const { pool, open } = harness();
    const generation = pool.endGeneration('chat-1');
    pool.end('chat-1');
    expect(pool.take('chat-1', 'key', open, { endGeneration: generation })).toBeNull();
    expect(open).not.toHaveBeenCalled();
    // A chat kept across a close is prewarmed again on the next open.
    expect(pool.take('chat-1', 'key', open, { endGeneration: pool.endGeneration('chat-1') })).not.toBeNull();
  });

  it('sweeps stale run directories once per launch, on the first session', () => {
    const { pool, open, sweep } = harness();
    expect(sweep).not.toHaveBeenCalled();
    pool.take('chat-1', 'key', open);
    pool.take('chat-2', 'key', open);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

describe('sweepStaleAnswerRunDirectories', () => {
  it('removes run directories older than a day and leaves fresh ones and everything else', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-root-'));
    try {
      const stale = path.join(root, 'kangentic-answer-old');
      const fresh = path.join(root, 'kangentic-answer-new');
      const unrelated = path.join(root, 'someone-else-old');
      for (const directory of [stale, fresh, unrelated]) {
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
      }
      const nowMs = Date.now();
      const old = new Date(nowMs - STALE_ANSWER_RUN_DIRECTORY_MS - 60_000);
      fs.utimesSync(stale, old, old);
      fs.utimesSync(unrelated, old, old);

      await expect(sweepStaleAnswerRunDirectories({ root, nowMs })).resolves.toBe(1);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
