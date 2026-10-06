import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The join the two halves of the DESKTOP-1Q change never meet in: a REAL
 * RetrievalClient feeding a REAL UtilityRestartPolicy, with only the two
 * telemetry sinks mocked. retrieval-client.test.ts spies on `recordCrash` and
 * utility-restart-policy.test.ts hand-feeds it, so neither shows that what the
 * client passes is what the latch report prints.
 */

const { mockFork, mockTrackEvent, mockReportHandledError } = vi.hoisted(() => ({
  mockFork: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockReportHandledError: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true },
  utilityProcess: { fork: mockFork },
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: mockReportHandledError }));

import { RetrievalClient, RetrievalUnavailableError, INTERACTIVE_TIMEOUT_MS, READY_TIMEOUT_MS } from '../../src/main/retrieval/retrieval-client';
import { UtilityRestartPolicy, resetUtilityCrashTelemetryForTests } from '../../src/main/utility-process/restart-policy';

interface FakeChild extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
}

const forkedChildren: FakeChild[] = [];

function lastChild(): FakeChild {
  return forkedChildren[forkedChildren.length - 1];
}

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('RetrievalClient crash reporting, end to end through the restart policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUtilityCrashTelemetryForTests();
    forkedChildren.length = 0;
    mockFork.mockImplementation(() => {
      const child = new EventEmitter() as FakeChild;
      child.postMessage = vi.fn();
      child.kill = vi.fn();
      child.stderr = new EventEmitter();
      forkedChildren.push(child);
      return child;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports one latch whose crashes line names each cause, the method that hung, what else was pending, and the worker\'s last stderr', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A zero backoff, or the fake clock keeps the policy from letting the next call fork.
    const policy = new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 3, backoffMs: [0] });
    const client = new RetrievalClient(policy);
    try {
      // Crash 1: a worker that never says ready.
      const neverReady = client.call('projects.summaries', { projectIds: [] });
      lastChild().stderr.emit('end');
      vi.advanceTimersByTime(READY_TIMEOUT_MS);
      await expect(neverReady).rejects.toBeInstanceOf(RetrievalUnavailableError);

      // Crash 2: a worker that says ready and then exits with a code.
      const exiting = client.call('projects.summaries', { projectIds: [] });
      const exitingChild = lastChild();
      exitingChild.emit('message', { type: 'ready' });
      await settleMicrotasks();
      exitingChild.stderr.emit('data', "Error: Cannot find module 'sqlite-vec'\n");
      exitingChild.stderr.emit('end');
      exitingChild.emit('exit', 3);
      await expect(exiting).rejects.toBeInstanceOf(RetrievalUnavailableError);

      // Crash 3: a ready worker that holds the loop. A background job and an
      // interactive call are pending; only the interactive one has a budget.
      const background = client.call('summary.candidates', { projectId: 'project-1', skip: [] }, { timeoutMs: null });
      const background2 = client.call('summary.candidates', { projectId: 'project-2', skip: [] }, { timeoutMs: null });
      const interactive = client.call('projects.summaries', { projectIds: [] });
      const hungChild = lastChild();
      hungChild.emit('message', { type: 'ready' });
      await settleMicrotasks();
      hungChild.stderr.emit('data', 'event loop held 31 s in index.rebuild\n');
      hungChild.stderr.emit('end');
      vi.advanceTimersByTime(INTERACTIVE_TIMEOUT_MS);
      await expect(interactive).rejects.toBeInstanceOf(RetrievalUnavailableError);
      await expect(background).rejects.toBeInstanceOf(RetrievalUnavailableError);
      await expect(background2).rejects.toBeInstanceOf(RetrievalUnavailableError);
      await settleMicrotasks();

      expect(policy.exhausted).toBe(true);
      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      const [error, tags, contexts] = mockReportHandledError.mock.calls[0];
      expect((error as Error).message).toBe('test-retrieval worker exited repeatedly (exit code unknown)');
      expect(tags).toEqual({
        source: 'utility_process',
        service: 'test-retrieval',
        exitCode: 'unknown',
        crashCount: '3',
        cause: 'request_timeout',
      });
      expect(contexts.utility_process.crashes).toEqual([
        'ready_timeout',
        'exit code=3',
        'request_timeout method=projects.summaries pending=summary.candidates(2)',
      ]);
      expect(contexts.utility_process.stderrTail).toBe('event loop held 31 s in index.rebuild');

      // The Aptabase side: first crash was the ready timeout, the latch was the hang.
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenNthCalledWith(1, 'utility_worker_crashed', {
        service: 'test-retrieval',
        exitCode: -1,
        cause: 'ready_timeout',
        phase: 'first',
      });
      expect(mockTrackEvent).toHaveBeenNthCalledWith(2, 'utility_worker_crashed', {
        service: 'test-retrieval',
        exitCode: -1,
        cause: 'request_timeout',
        phase: 'latched',
      });

      // What the Knowledge Graph shows once the subsystem has given up.
      expect(client.unavailableReason).toBe(
        'The retrieval worker stopped (did not answer projects.summaries in time: event loop held 31 s in index.rebuild)',
      );
    } finally {
      client.dispose();
    }
  });

  it('reports a fork that threw as fork_failed in the latch, never as an exit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFork.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const policy = new UtilityRestartPolicy({ service: 'test-retrieval', maxCrashes: 3, backoffMs: [0] });
    const client = new RetrievalClient(policy);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(client.call('projects.summaries', { projectIds: [] })).rejects.toBeInstanceOf(RetrievalUnavailableError);
      }

      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      const [, tags, contexts] = mockReportHandledError.mock.calls[0];
      expect(tags.cause).toBe('fork_failed');
      expect(contexts.utility_process.crashes).toEqual(['fork_failed', 'fork_failed', 'fork_failed']);
      expect(client.unavailableReason).toBe('The retrieval worker stopped (failed to start)');
    } finally {
      client.dispose();
    }
  });
});
