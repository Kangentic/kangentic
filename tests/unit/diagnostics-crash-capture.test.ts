/**
 * Unit tests for `src/main/diagnostics/crash-capture.ts`.
 *
 * Covers the always-on crash persistence path:
 *   - The IPC.CRASH_REPORT handler writes a record to disk for renderer
 *     side crashes forwarded by the preload error capture.
 *   - Filenames are derived from the timestamp with `:` and `.` replaced
 *     so the path is portable across Windows.
 *   - Records survive round-tripping through JSON without data loss.
 *
 * The process-level handlers (uncaughtException, unhandledRejection) and
 * the per-webContents listeners are exercised in the e2e suite where a
 * real Electron + main process is available.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrashRecord } from '../../src/shared/types';

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const appListeners = new Map<string, (...args: unknown[]) => unknown>();
const recordGpuProcessGoneMock = vi.fn();
const recordGpuModeObservationMock = vi.fn();
const probeDiscoverMock = vi.fn();
const probeSnapshotMock = vi.fn(() => ({ zygote: 'dead', schedulingEntities: 891, maxUserProcesses: '123561' }));
const createLinuxGpuZygoteProbeMock = vi.fn(() => ({ discover: probeDiscoverMock, snapshot: probeSnapshotMock }));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
    getGPUFeatureStatus: vi.fn(() => ({ gpu_compositing: 'enabled' })),
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      appListeners.set(eventName, handler);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

// gpu-health.ts's own counting/latch/decay/durable-write contract is covered
// by tests/unit/gpu-health.test.ts; this file only pins that crash-capture's
// listener calls it with the right arguments and for the right reasons.
vi.mock('../../src/main/diagnostics/gpu-health', () => ({
  recordGpuProcessGone: recordGpuProcessGoneMock,
  recordGpuModeObservation: recordGpuModeObservationMock,
}));

// linux-gpu-zygote.ts has its own suite; here only the wiring matters, and
// the real probe would read this machine's /proc on a Linux CI runner.
vi.mock('../../src/main/diagnostics/linux-gpu-zygote', () => ({
  createLinuxGpuZygoteProbe: createLinuxGpuZygoteProbeMock,
}));

/** crash-capture.ts decides on the probe from process.platform when it is
 *  started, so each test pins the platform it means rather than inheriting
 *  the runner's (Windows locally, Linux on CI). */
async function withPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

let tempDirectory: string;
let gpuHealthFilePath: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-capture-test-'));
  gpuHealthFilePath = path.join(tempDirectory, 'gpu-health.json');
  ipcHandlers.clear();
  appListeners.clear();
  recordGpuProcessGoneMock.mockClear();
  recordGpuModeObservationMock.mockClear();
  probeDiscoverMock.mockClear();
  probeSnapshotMock.mockClear();
  createLinuxGpuZygoteProbeMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  // A test that pins Date with fake timers must not leak the fake clock into
  // the next test if it throws before its own inline restore runs.
  vi.useRealTimers();
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('crash-capture', () => {
  it('registers an IPC.CRASH_REPORT handler that writes a record to disk', async () => {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    const { IPC } = await import('../../src/shared/ipc-channels');
    startCrashCapture({ getProjectRoot: () => tempDirectory, gpuHealthFilePath });

    const handler = ipcHandlers.get(IPC.CRASH_REPORT);
    expect(handler).toBeDefined();

    const record: CrashRecord = {
      ts: '2026-05-06T12:34:56.789Z',
      kind: 'renderer-window-error',
      source: 'renderer',
      message: 'TypeError: x.y is not a function',
      stack: 'TypeError\n    at handler (file:///app.js:1:1)',
      origin: 'http://localhost:5173/',
      context: { line: 12, col: 3 },
      versions: { kangentic: 'unknown', electron: '41.0.0', node: '24.0.0', chrome: '128' },
    };
    handler!({}, record);

    const directory = path.join(tempDirectory, '.kangentic', 'logs', 'crashes');
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    // Colons in the timestamp are illegal on Windows; the writer rewrites
    // them with `-`. Check the substitution rather than the full filename
    // (millisecond precision varies across runs).
    expect(files[0]).not.toContain(':');
    expect(files[0]).toMatch(/^2026-05-06T12-34-56-789Z\.json$/);

    const persisted = JSON.parse(fs.readFileSync(path.join(directory, files[0]!), 'utf-8'));
    expect(persisted).toEqual(record);
  });

  it('drops the report silently when project root is null', async () => {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    const { IPC } = await import('../../src/shared/ipc-channels');
    startCrashCapture({ getProjectRoot: () => null, gpuHealthFilePath });

    const handler = ipcHandlers.get(IPC.CRASH_REPORT);
    const record: CrashRecord = {
      ts: '2026-05-06T12:00:00.000Z',
      kind: 'renderer-unhandled-rejection',
      source: 'renderer',
      message: 'no project',
      stack: null,
      origin: null,
      context: null,
      versions: { kangentic: 'unknown', electron: '41.0.0', node: '24.0.0', chrome: '128' },
    };
    expect(() => handler!({}, record)).not.toThrow();
    expect(fs.existsSync(path.join(tempDirectory, '.kangentic'))).toBe(false);
  });

  it('subscribes to web-contents-created on the app for per-window crash capture', async () => {
    const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
    startCrashCapture({ getProjectRoot: () => tempDirectory, gpuHealthFilePath });
    expect(appListeners.has('web-contents-created')).toBe(true);
  });

  it('records a GPU process death from child-process-gone, and ignores clean exits and other child types', async () => {
    // The GPU process is not a webContents, so the app-level event is the
    // only place its death is visible; a crash or kill puts every terminal on
    // the DOM renderer for the next two minutes (terminal-webgl.ts), so the
    // record is what lets that be diagnosed locally after the fact.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
      startCrashCapture({ getProjectRoot: () => tempDirectory, gpuHealthFilePath });

      const handler = appListeners.get('child-process-gone');
      expect(handler).toBeDefined();
      const directory = path.join(tempDirectory, '.kangentic', 'logs', 'crashes');

      // Not recorded: another child type, and the GPU process exiting cleanly
      // (which happens on app quit and must not leave a crash record per run).
      handler!({}, { type: 'Utility', reason: 'crashed', exitCode: 1, serviceName: 'network' });
      handler!({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
      expect(fs.existsSync(directory)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      // gpu-health.ts's counting must short-circuit on exactly the same two
      // cases as the local crash record, or the two would drift apart.
      expect(recordGpuProcessGoneMock).not.toHaveBeenCalled();

      // Recorded: a GPU crash, and a GPU kill (Chromium treats both alike).
      // Filenames derive from the record timestamp, so pin Date between the
      // two calls; in the same millisecond the second would overwrite the first.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-10T22:29:17.000Z'));
      handler!({}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
      vi.setSystemTime(new Date('2026-09-10T22:29:18.000Z'));
      handler!({}, { type: 'GPU', reason: 'killed', exitCode: 1 });
      vi.useRealTimers();
      const files = fs.readdirSync(directory).sort();
      expect(files).toHaveLength(2);
      const records = files.map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf-8')) as CrashRecord);
      // Pins the record to the fake clock rather than a constant or stale
      // value: a handler that wrote either would still produce two distinct
      // filenames only by accident.
      expect(records.map((record) => record.ts)).toEqual([
        '2026-09-10T22:29:17.000Z',
        '2026-09-10T22:29:18.000Z',
      ]);
      expect(records.map((record) => record.kind)).toEqual(['gpu-process-gone', 'gpu-process-gone']);
      expect(records.map((record) => record.source)).toEqual(['gpu', 'gpu']);
      expect(records.map((record) => record.context)).toEqual([
        { reason: 'crashed', exitCode: 5 },
        { reason: 'killed', exitCode: 1 },
      ]);
      expect(records[0]!.message).toBe('GPU process gone: crashed');
      expect(records[0]!.versions.kangentic).toBe('1.2.3');
      // The persisted log gets one warn per death (warn lines always persist).
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[0]![0])).toContain('[gpu] GPU process gone: crashed (exit code 5)');

      // Each recorded death also feeds gpu-health.ts's counting, with the
      // configured escalation path, the raw reason/exitCode, the running
      // app's version, and a lazy GPU-feature-status reader - the wiring the
      // escalation report at boot depends on.
      expect(recordGpuProcessGoneMock).toHaveBeenCalledTimes(2);
      expect(recordGpuProcessGoneMock).toHaveBeenNthCalledWith(
        1, gpuHealthFilePath, 'crashed', 5, '1.2.3', { getFeatureStatus: expect.any(Function) },
      );
      expect(recordGpuProcessGoneMock).toHaveBeenNthCalledWith(
        2, gpuHealthFilePath, 'killed', 1, '1.2.3', { getFeatureStatus: expect.any(Function) },
      );
      // The reader is a live closure over app.getGPUFeatureStatus(), not a
      // value snapshotted at call time - gpu-health.ts relies on this to read
      // it lazily, only once a write is actually about to happen.
      const passedGetFeatureStatus = recordGpuProcessGoneMock.mock.calls[0]![4].getFeatureStatus;
      expect(passedGetFeatureStatus()).toEqual({ gpu_compositing: 'enabled' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('counts a launch-failed reason the same way as a crash, if one ever arrives', async () => {
    // Electron 41 never emits child-process-gone for a launch failure (it
    // does not override BrowserChildProcessLaunchFailed), so DESKTOP-W's
    // ladder never reaches this handler; gpu-info-update below is what does.
    // Should a later Electron forward it, it must flow through the same two
    // paths as any other non-clean-exit GPU death.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
      startCrashCapture({ getProjectRoot: () => tempDirectory, gpuHealthFilePath });

      const handler = appListeners.get('child-process-gone');
      handler!({}, { type: 'GPU', reason: 'launch-failed', exitCode: null });

      const directory = path.join(tempDirectory, '.kangentic', 'logs', 'crashes');
      const files = fs.readdirSync(directory);
      expect(files).toHaveLength(1);
      const record = JSON.parse(fs.readFileSync(path.join(directory, files[0]!), 'utf-8')) as CrashRecord;
      expect(record.context).toEqual({ reason: 'launch-failed', exitCode: null });

      expect(recordGpuProcessGoneMock).toHaveBeenCalledTimes(1);
      expect(recordGpuProcessGoneMock).toHaveBeenCalledWith(
        gpuHealthFilePath, 'launch-failed', null, '1.2.3', { getFeatureStatus: expect.any(Function) },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('feeds every gpu-info-update to gpu-health.ts, the one signal a GPU launch-failure ladder leaves (DESKTOP-W)', async () => {
    // A GPU process that fails to launch never reaches child-process-gone,
    // and on Linux neither does one whose zygote died with it. Chromium's
    // fallback to its last rung does emit gpu-info-update before the fatal,
    // so this listener is what puts the incident on disk at all.
    await withPlatform('win32', async () => {
      const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
      const { app } = await import('electron');
      startCrashCapture({ getProjectRoot: () => tempDirectory, gpuHealthFilePath });

      const handler = appListeners.get('gpu-info-update');
      expect(handler, 'crash-capture must subscribe to gpu-info-update').toBeDefined();

      handler!();
      expect(recordGpuModeObservationMock).toHaveBeenCalledTimes(1);
      expect(recordGpuModeObservationMock).toHaveBeenCalledWith(
        gpuHealthFilePath, '1.2.3', { getFeatureStatus: expect.any(Function), readLinuxProcessSnapshot: undefined },
      );
      // No local crash record: a fallback is not a death, and this event also
      // fires on every healthy GPU restart.
      expect(fs.existsSync(path.join(tempDirectory, '.kangentic'))).toBe(false);
      // Off Linux there is no zygote to look for.
      expect(createLinuxGpuZygoteProbeMock).not.toHaveBeenCalled();

      // A LIVE reader, not a value captured when the event fired: the fallback
      // is a change of status, and gpu-health.ts has to read the current one.
      const passedGetFeatureStatus = recordGpuModeObservationMock.mock.calls[0]![2].getFeatureStatus;
      vi.mocked(app.getGPUFeatureStatus).mockReturnValueOnce({ gpu_compositing: 'disabled_software' } as Electron.GPUFeatureStatus);
      expect(passedGetFeatureStatus()).toEqual({ gpu_compositing: 'disabled_software' });
    });
  });

  it('on Linux, looks for the GPU zygote on every update and hands gpu-health.ts a live reading of it', async () => {
    // The zygote has to be found while the GPU is healthy: the fallback that
    // needs the reading comes after the zygote may already be dead. Calling
    // discover() on every update (it is idempotent) is what guarantees the
    // first, healthy update does the finding.
    await withPlatform('linux', async () => {
      const { startCrashCapture } = await import('../../src/main/diagnostics/crash-capture');
      startCrashCapture({ getProjectRoot: () => tempDirectory, gpuHealthFilePath });

      expect(createLinuxGpuZygoteProbeMock).toHaveBeenCalledTimes(1);
      expect(createLinuxGpuZygoteProbeMock).toHaveBeenCalledWith(process.pid);

      const handler = appListeners.get('gpu-info-update');
      handler!();
      handler!();
      expect(probeDiscoverMock).toHaveBeenCalledTimes(2);
      // Discovery runs before gpu-health.ts reads, on the same update.
      expect(probeDiscoverMock.mock.invocationCallOrder[0]).toBeLessThan(
        recordGpuModeObservationMock.mock.invocationCallOrder[0]!,
      );

      // The reading is taken when gpu-health.ts asks for it, not when the
      // update fired.
      expect(probeSnapshotMock).not.toHaveBeenCalled();
      const passedReader = recordGpuModeObservationMock.mock.calls[0]![2].readLinuxProcessSnapshot;
      expect(passedReader()).toEqual({ zygote: 'dead', schedulingEntities: 891, maxUserProcesses: '123561' });
      expect(probeSnapshotMock).toHaveBeenCalledTimes(1);
    });
  });
});
