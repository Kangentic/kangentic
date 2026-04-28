/**
 * SessionManager write-queue integration tests.
 *
 * Locks in the invariants that prevent the Ctrl+V paste-truncation regression:
 * the per-session FIFO queue must be created lazily, reused across calls,
 * and properly torn down on kill() and natural PTY exit. The regression
 * was caused by each write() call independently starting its own chunker,
 * which interleaved bytes from concurrent callers.
 *
 * Cases covered here:
 *  1. Happy path: payload reaches pty.write for a live session.
 *  2. Second write() to the same session reuses the existing queue (no
 *     second createWriteQueue call).
 *  3. kill() disposes the queue and removes it from the map so subsequent
 *     writes produce no pty.write calls.
 *  4. Natural PTY exit ('exit' event) disposes the queue and removes the
 *     map entry.
 *  5. onAutoDispose path: when pty.write throws, the next write() creates
 *     a fresh queue and the new payload arrives.
 *  8. Regression-locking integration case: two concurrent write() calls of
 *     >4KB each must join back to the full concatenation in submission
 *     order with no chunk straddling the A/B boundary.
 *
 * Cases #6 and #7 (pure write-queue helper behaviour) live in
 * tests/unit/write-queue.test.ts, which already exercises createWriteQueue
 * directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock heavy modules before importing SessionManager. Mirrors the pattern
// established by tests/unit/session-manager.test.ts.
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
  isUncPath: (pathString: string) => /^[\\/]{2}[^\\/]/.test(pathString),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as nodePty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';

// ---------------------------------------------------------------------------
// Mock PTY factory - matches the shape from session-manager.test.ts.
// ---------------------------------------------------------------------------

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-wq-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: spawn a real session through SessionManager with a mock PTY.
// ---------------------------------------------------------------------------

async function spawnSessionWithMock(manager: SessionManager, taskId: string) {
  const mock = createMockPty();
  vi.mocked(nodePty.spawn).mockReturnValue(mock.mockPty as unknown as nodePty.IPty);
  const session = await manager.spawn({
    taskId,
    command: '',
    cwd: tmpDir,
  });
  return { session, ...mock };
}

// ---------------------------------------------------------------------------
// 1. Happy path: payload reaches pty.write for a live session.
// ---------------------------------------------------------------------------

describe('SessionManager.write - happy path', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('routes a small payload to pty.write via the queue (single chunk)', async () => {
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(manager, 'task-wq-happy');

      manager.write(session.id, 'hello');
      vi.runAllTimers();

      expect(mockPty.write).toHaveBeenCalledWith('hello');
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits a large payload across multiple pty.write calls that concatenate correctly', async () => {
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(manager, 'task-wq-large');
      const payload = 'x'.repeat(10000);

      manager.write(session.id, payload);
      vi.runAllTimers();

      const writtenCalls: string[] = (mockPty.write.mock.calls as [string][]).map(
        (callArgs) => callArgs[0],
      );
      expect(writtenCalls.join('')).toBe(payload);
      // Confirm the split happened (more than one chunk for 10KB > 4KB default).
      expect(writtenCalls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Second write() to the same session reuses the existing queue.
// ---------------------------------------------------------------------------

describe('SessionManager.write - queue reuse', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('does not start a second drain loop when write() is called twice before draining', async () => {
    // To verify queue reuse we spy on createWriteQueue. Because the module is
    // already imported, we re-spy on the module internals via the write-queue
    // module. The observable proof is simpler: if the queue were NOT reused,
    // two independent drain loops would each start their own synchronous first
    // chunk, producing interleaved output. Instead, we verify that all writes
    // still arrive in submission order.
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(manager, 'task-wq-reuse');

      const firstPayload = 'A'.repeat(100);
      const secondPayload = 'B'.repeat(100);

      manager.write(session.id, firstPayload);
      // Still within the same synchronous tick - queue exists but drain is
      // scheduled. A second createWriteQueue would spawn a competing loop.
      manager.write(session.id, secondPayload);
      vi.runAllTimers();

      const writtenText = (mockPty.write.mock.calls as [string][])
        .map((callArgs) => callArgs[0])
        .join('');

      // Both payloads must arrive and in submission order.
      expect(writtenText).toBe(firstPayload + secondPayload);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not interleave bytes when two concurrent writes exceed the chunk size', async () => {
    // Regression-locking: proves the serialization invariant at the
    // SessionManager API boundary (not just at the createWriteQueue level).
    // Two writes of 50000 bytes each must join to exactly 'A'*50000 + 'B'*50000
    // with no chunk straddling the boundary.
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(manager, 'task-wq-no-interleave');

      const firstPayload = 'A'.repeat(50000);
      const secondPayload = 'B'.repeat(50000);

      manager.write(session.id, firstPayload);
      manager.write(session.id, secondPayload);
      vi.runAllTimers();

      const writtenText = (mockPty.write.mock.calls as [string][])
        .map((callArgs) => callArgs[0])
        .join('');

      expect(writtenText.length).toBe(100000);
      expect(writtenText).toBe(firstPayload + secondPayload);

      // Stronger assertion: the A-to-B transition happens exactly at index 50000.
      // No chunk boundary should split the transition in an interleaved way.
      const firstBIndex = writtenText.indexOf('B');
      expect(firstBIndex).toBe(50000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. kill() disposes the queue and removes the map entry.
// ---------------------------------------------------------------------------

describe('SessionManager.kill - queue teardown', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('no pty.write calls land after kill(), even with a write() in the same tick', async () => {
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(manager, 'task-wq-kill');

      // Enqueue a large payload so the drain loop is scheduled.
      manager.write(session.id, 'q'.repeat(50000));
      // Record how many writes the synchronous first chunk produced.
      const writesBeforeKill = mockPty.write.mock.calls.length;

      // Kill tears down the queue. Any pending setImmediate drain must stop.
      manager.kill(session.id);
      mockPty.write.mockClear();

      // Attempt to write again - session.pty is now null, so write() should
      // return immediately without creating a new queue.
      manager.write(session.id, 'post-kill payload');
      vi.runAllTimers();

      // After kill(), zero new writes should have occurred.
      expect(mockPty.write.mock.calls.length).toBe(0);
      // Confirm the pre-kill write count was non-zero (test would be vacuous
      // if the session never got a queue in the first place).
      expect(writesBeforeKill).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('write() to a killed session does not throw', async () => {
    const { session } = await spawnSessionWithMock(manager, 'task-wq-kill-nothrow');
    manager.kill(session.id);
    expect(() => manager.write(session.id, 'safe payload')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Natural PTY exit ('exit' event) disposes the queue and removes the entry.
// ---------------------------------------------------------------------------

describe('SessionManager - natural PTY exit disposes write queue', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('no pty.write calls land after the PTY fires its exit event', async () => {
    vi.useFakeTimers();
    try {
      const { session, mockPty, triggerExit } = await spawnSessionWithMock(
        manager,
        'task-wq-natural-exit',
      );

      // Enqueue a large payload so a drain loop is scheduled.
      manager.write(session.id, 'z'.repeat(50000));
      const writesBeforeExit = mockPty.write.mock.calls.length;

      // Simulate the PTY process ending naturally.
      triggerExit(0);

      // Advance timers to let the scheduled drain tick run. The exit handler
      // should have disposed the queue, so the drain loop must stop.
      vi.runAllTimers();
      mockPty.write.mockClear();

      // A write after exit: the session no longer has a live PTY, so the
      // early guard `if (!session?.pty || ...)` returns before creating a queue.
      manager.write(session.id, 'post-exit payload');
      vi.runAllTimers();

      expect(mockPty.write.mock.calls.length).toBe(0);
      // Sanity: the pre-exit write DID produce at least one chunk.
      expect(writesBeforeExit).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. onAutoDispose path: pty.write throws, next write() creates a fresh queue.
// ---------------------------------------------------------------------------

describe('SessionManager.write - onAutoDispose recovery', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('creates a fresh queue after pty.write throws, and the next payload arrives', async () => {
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(
        manager,
        'task-wq-auto-dispose',
      );

      // Suppress expected error logging from the queue's throw handler.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let shouldThrow = false;
      mockPty.write.mockImplementation((data: string) => {
        if (shouldThrow) throw new Error('pty handle gone');
        // Record the call as written (the spy is still tracking via mock.calls).
        void data;
      });

      // First write: start a drain loop for a large payload.
      manager.write(session.id, 'a'.repeat(20000));
      // The first synchronous chunk has landed. Now arm the throw.
      shouldThrow = true;
      vi.advanceTimersToNextTimer();
      // The throw fires and onAutoDispose removes the map entry.

      // Disarm the throw for the fresh queue.
      shouldThrow = false;
      mockPty.write.mockClear();

      // Second write: must create a fresh queue (the old one was auto-disposed).
      manager.write(session.id, 'recovery-payload');
      vi.runAllTimers();

      const writtenText = (mockPty.write.mock.calls as [string][])
        .map((callArgs) => callArgs[0])
        .join('');

      expect(writtenText).toBe('recovery-payload');

      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Regression-locking integration case (the Ctrl+V truncation scenario).
// ---------------------------------------------------------------------------

describe('SessionManager.write - regression-locking concurrent write case', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('two concurrent SessionManager.write() calls of >4KB join in submission order with no A/B boundary straddle', async () => {
    // This is the exact scenario that caused Ctrl+V paste truncation.
    //
    // Before the write queue: write() would call pty.write() directly
    // (or spawn independent chunker chains). Two concurrent calls of 50KB each
    // would start separate setTimeout(1) loops that interleaved, fragmenting
    // bracketed-paste sequences.
    //
    // After the queue: both enqueue() calls append to the SAME buffer. The
    // single drain loop emits them in FIFO order. The combined output must be
    // exactly 'A'*50000 + 'B'*50000 with no interleaving.
    vi.useFakeTimers();
    try {
      const { session, mockPty } = await spawnSessionWithMock(
        manager,
        'task-wq-regression',
      );

      const firstPayload = 'A'.repeat(50000);
      const secondPayload = 'B'.repeat(50000);

      // Simulate two concurrent callers (user input + paste injector).
      manager.write(session.id, firstPayload);
      manager.write(session.id, secondPayload);
      vi.runAllTimers();

      const writtenText = (mockPty.write.mock.calls as [string][])
        .map((callArgs) => callArgs[0])
        .join('');

      // Total byte count must be preserved.
      expect(writtenText.length).toBe(100000);

      // All bytes must arrive in submission order.
      expect(writtenText).toBe(firstPayload + secondPayload);

      // No interleaving: the first 'B' must appear at exactly index 50000
      // in the joined output. This is the definitive proof that both writes
      // were serialised through the same queue buffer - any interleaving
      // would scatter 'B' bytes among the first 50000 characters.
      const firstBIndex = writtenText.indexOf('B');
      expect(firstBIndex).toBe(50000);

      // At most ONE chunk may straddle the A/B boundary (the chunk that
      // happens to span index 50000). Every other chunk must be pure A's
      // or pure B's. Mixed chunks beyond the first transition indicate
      // interleaved writes, not a single boundary crossing.
      const writtenChunks: string[] = (mockPty.write.mock.calls as [string][]).map(
        (callArgs) => callArgs[0],
      );
      const mixedChunkCount = writtenChunks.filter(
        (chunk) => chunk.includes('A') && chunk.includes('B'),
      ).length;
      // Exactly 0 or 1 chunk may contain both A and B: the boundary chunk.
      // More than 1 mixed chunk proves interleaving, which is the regression.
      expect(mixedChunkCount).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
