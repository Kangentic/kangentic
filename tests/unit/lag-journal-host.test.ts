/**
 * The lag journal's wiring (src/devtools/main/lag-journal-host.ts).
 *
 * `LagJournal` and the reader have their own tests. What nothing else drove is
 * the host that connects them: the sinks it installs on the lag monitor, the
 * stall profiler and the startup timer, what `stopLagJournal` takes back, how
 * it reads the renderer's records over the debugger, and when it prunes old
 * launches. A sink that is not installed (or not removed) loses a source's
 * records, or writes into a journal that has already said it exited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';

const hoisted = vi.hoisted(() => ({
  isDebuggerAttached: vi.fn(),
  runtimeEvaluate: vi.fn(),
  setStallSummaryListener: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../src/devtools/main/cdp', () => ({
  isDebuggerAttached: hoisted.isDebuggerAttached,
  runtimeEvaluate: hoisted.runtimeEvaluate,
}));
vi.mock('../../src/devtools/main/stall-profiler', () => ({
  setStallSummaryListener: hoisted.setStallSummaryListener,
}));

const FACTS = {
  versions: { kangentic: '0.62.0', electron: '45.4.1', node: '24.22.3', chrome: '156.0.0.0' },
  platform: 'linux',
  arch: 'x64',
  ephemeralPreview: false,
  diagnostics: { stallProfiler: true },
};

const STALL = {
  detectedAt: '2026-11-24T04:00:09.000Z',
  maxDelayMs: 143,
  slowSpans: [],
  stalledChecks: 1,
  longestBusyRunMs: 142.3,
  topFrames: [],
  heaviestStack: [],
  profileMs: 21_000,
  saveMs: 0.4,
  summaryMs: 2.1,
  file: null,
};

const RENDERER_LONG_FRAME = {
  at: '2026-11-24T04:00:20.000Z',
  durationMs: 180,
  blockingMs: 130,
  renderMs: 12,
  styleLayoutMs: 9,
  scripts: [],
};

const TIMER_FUNCTIONS = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] as const;

describe('lag journal host', () => {
  let configDir: string;
  let host: typeof import('../../src/devtools/main/lag-journal-host');
  let lagMonitor: typeof import('../../src/main/diagnostics/event-loop-lag');
  let startupTimer: typeof import('../../src/main/startup-timer');
  let reader: typeof import('../../src/devtools/main/lag-journal-reader');
  let journalFiles: typeof import('../../src/devtools/main/lag-journal');
  let queue: typeof import('../../src/main/diagnostics/async-file-queue');

  /** A window the host may read the renderer's records from. */
  function windowStub(destroyed = false): BrowserWindow {
    return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
  }

  function startHost(getMainWindow: () => BrowserWindow | null = () => null): void {
    host.startLagJournal({ configDir, getMainWindow, facts: FACTS });
  }

  /** Let the setImmediate-driven file queue and any pending promise continuation finish. */
  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await queue.flushAllForTest();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function readJournal() {
    const location = host.getLagJournalLocation();
    if (!location) throw new Error('the journal is not started');
    await queue.flushAllForTest();
    return reader.readLaunch(location.directory, location.launchId);
  }

  beforeEach(async () => {
    vi.resetModules();
    hoisted.isDebuggerAttached.mockReset();
    hoisted.runtimeEvaluate.mockReset();
    hoisted.setStallSummaryListener.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-lag-host-'));
    host = await import('../../src/devtools/main/lag-journal-host');
    lagMonitor = await import('../../src/main/diagnostics/event-loop-lag');
    startupTimer = await import('../../src/main/startup-timer');
    reader = await import('../../src/devtools/main/lag-journal-reader');
    journalFiles = await import('../../src/devtools/main/lag-journal');
    queue = await import('../../src/main/diagnostics/async-file-queue');
  });

  afterEach(async () => {
    host.stopLagJournal('test-end');
    lagMonitor.relaySlowSyncSpans(null);
    await queue.flushAllForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  describe('sinks', () => {
    it('writes a slow span from the lag monitor, a record another process relays, a stall summary and the startup timeline', async () => {
      // A span is only kept while spans are counted: a relay stands in for the monitor.
      lagMonitor.relaySlowSyncSpans(() => undefined);
      startHost();

      lagMonitor.recordSyncSpan('db:transaction', 40);
      lagMonitor.relayLagRecord('pty-host', { kind: 'spike', at: '2026-11-24T04:00:05.000Z', lagMs: 95 });
      expect(hoisted.setStallSummaryListener).toHaveBeenCalledTimes(1);
      const stallListener = hoisted.setStallSummaryListener.mock.calls[0][0] as (summary: typeof STALL) => void;
      stallListener(STALL);
      startupTimer.mark('window_ready');
      startupTimer.finishStartupTimer();
      const report = await readJournal();

      expect(report.spans).toContainEqual(expect.objectContaining({ process: 'main', label: 'db:transaction', ms: 40 }));
      expect(report.spikes).toEqual([{ at: '2026-11-24T04:00:05.000Z', process: 'pty-host', lagMs: 95 }]);
      expect(report.stalls).toEqual([STALL]);
      expect(report.startup?.map((startupMark) => startupMark.label)).toEqual(['window_ready']);
    });

    it('writes an exit line with the reason on stop, and nothing after it from any source', async () => {
      lagMonitor.relaySlowSyncSpans(() => undefined);
      startHost();
      const location = host.getLagJournalLocation();
      if (!location) throw new Error('the journal is not started');
      await queue.flushAllForTest();

      host.stopLagJournal('quit');
      await queue.flushAllForTest();
      const atExit = await reader.readLaunch(location.directory, location.launchId);
      expect(atExit.exit).toMatchObject({ reason: 'quit' });

      lagMonitor.recordSyncSpan('db:transaction', 40);
      lagMonitor.relayLagRecord('pty-host', { kind: 'spike', at: '2026-11-24T04:00:05.000Z', lagMs: 95 });
      startupTimer.mark('window_ready');
      startupTimer.finishStartupTimer();
      await queue.flushAllForTest();

      expect(await reader.readLaunch(location.directory, location.launchId)).toEqual(atExit);
      // The stall listener was handed back too.
      expect(hoisted.setStallSummaryListener).toHaveBeenLastCalledWith(null);
    });
  });

  describe('renderer collection', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...TIMER_FUNCTIONS] });
    });

    it('writes the spikes and long frames the renderer hands over, every 30 s', async () => {
      hoisted.isDebuggerAttached.mockReturnValue(true);
      hoisted.runtimeEvaluate.mockResolvedValue({
        value: { spikes: [{ at: '2026-11-24T04:00:19.000Z', lagMs: 120 }], longFrames: [RENDERER_LONG_FRAME] },
        error: null,
      });
      startHost(() => windowStub());

      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      const report = await readJournal();

      expect(hoisted.runtimeEvaluate).toHaveBeenCalledTimes(1);
      expect(report.spikes).toEqual([{ at: '2026-11-24T04:00:19.000Z', process: 'renderer', lagMs: 120 }]);
      expect(report.longFrames).toEqual([RENDERER_LONG_FRAME]);
    });

    const nothingToCollect: Array<{
      name: string;
      attached: boolean;
      getMainWindow: () => BrowserWindow | null;
      result: { value: unknown; error: string | null };
      evaluates: boolean;
    }> = [
      { name: 'the debugger is not attached', attached: false, getMainWindow: () => windowStub(), result: { value: null, error: null }, evaluates: false },
      { name: 'the window is destroyed', attached: true, getMainWindow: () => windowStub(true), result: { value: null, error: null }, evaluates: false },
      { name: 'there is no window', attached: true, getMainWindow: () => null, result: { value: null, error: null }, evaluates: false },
      {
        name: 'the evaluation reports an error',
        attached: true,
        getMainWindow: () => windowStub(),
        result: { value: { spikes: [{ at: '2026-11-24T04:00:19.000Z', lagMs: 120 }], longFrames: [] }, error: 'Uncaught' },
        evaluates: true,
      },
      { name: 'the renderer has no collector and answers null', attached: true, getMainWindow: () => windowStub(), result: { value: null, error: null }, evaluates: true },
      { name: 'the answer is not the records shape', attached: true, getMainWindow: () => windowStub(), result: { value: { spikes: 'x', longFrames: [] }, error: null }, evaluates: true },
    ];

    it.each(nothingToCollect)('writes nothing and throws nothing when $name', async ({ attached, getMainWindow, result, evaluates }) => {
      hoisted.isDebuggerAttached.mockReturnValue(attached);
      hoisted.runtimeEvaluate.mockResolvedValue(result);
      startHost(getMainWindow);

      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      const report = await readJournal();

      expect(hoisted.runtimeEvaluate).toHaveBeenCalledTimes(evaluates ? 1 : 0);
      expect(report.spikes).toEqual([]);
      expect(report.longFrames).toEqual([]);
    });

    it('catches a rejected evaluation, warns, and writes nothing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      hoisted.isDebuggerAttached.mockReturnValue(true);
      hoisted.runtimeEvaluate.mockRejectedValue(new Error('debugger detached'));
      startHost(() => windowStub());

      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      const report = await readJournal();

      expect(warn).toHaveBeenCalledWith('[lag-journal] could not read the renderer records:', expect.any(Error));
      expect(report.spikes).toEqual([]);
      expect(report.longFrames).toEqual([]);
    });

    it('asks for the global that install.tsx assigns, so a rename on either side cannot silently stop collection', async () => {
      // install.tsx is a React module no node test can import, so its text is
      // read: a global one side renames and the other does not collects nothing.
      hoisted.isDebuggerAttached.mockReturnValue(true);
      hoisted.runtimeEvaluate.mockResolvedValue({ value: null, error: null });
      startHost(() => windowStub());
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();

      expect(hoisted.runtimeEvaluate).toHaveBeenCalledTimes(1);
      const expression = String(hoisted.runtimeEvaluate.mock.calls[0][1]);
      const globalName = /window\.(__kangentic\w+)/.exec(expression)?.[1];
      expect(globalName).toBeDefined();
      const installSource = fs.readFileSync(path.resolve(__dirname, '../../src/devtools/renderer/install.tsx'), 'utf-8');
      expect(installSource).toMatch(new RegExp(`\\.${globalName}\\s*=\\s*\\w+`));
    });
  });

  describe('pruning old launches', () => {
    /** Thirty-three launches from 2020, each with its launch file, before this one starts. */
    function writeOlderLaunches(): string[] {
      const directory = journalFiles.lagJournalDirectory(configDir);
      fs.mkdirSync(directory, { recursive: true });
      const fileNames: string[] = [];
      for (let index = 0; index < 33; index++) {
        const launchId = journalFiles.launchIdOf(Date.UTC(2020, 0, 1, 0, index, 0), 1_000 + index);
        const fileName = launchId + journalFiles.LAUNCH_FILE_SUFFIX;
        fs.writeFileSync(path.join(directory, fileName), '');
        fileNames.push(fileName);
      }
      return fileNames;
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...TIMER_FUNCTIONS] });
    });

    it('removes the oldest launches 60 s after start and keeps the running one', async () => {
      const olderFiles = writeOlderLaunches();
      startHost();
      await settle();
      const location = host.getLagJournalLocation();
      if (!location) throw new Error('the journal is not started');
      const runningFile = location.launchId + journalFiles.LAUNCH_FILE_SUFFIX;
      expect(fs.readdirSync(location.directory)).toHaveLength(34);

      await vi.advanceTimersByTimeAsync(60_000);

      // 34 launches, the newest 30 kept: the four oldest of 2020 go.
      await vi.waitFor(() => {
        expect(fs.readdirSync(location.directory).sort()).toEqual([...olderFiles.slice(4), runningFile].sort());
      });
    });

    it('leaves every file in place when it stopped before the 60 s', async () => {
      const olderFiles = writeOlderLaunches();
      startHost();
      await settle();
      const location = host.getLagJournalLocation();
      if (!location) throw new Error('the journal is not started');
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      host.stopLagJournal('quit');
      // Both the renderer poll and the prune are cleared with the journal.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      await settle();

      const remaining = fs.readdirSync(location.directory);
      for (const fileName of olderFiles) expect(remaining).toContain(fileName);
    });
  });
});
