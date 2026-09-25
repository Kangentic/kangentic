import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * gpu-health.ts - the recording/decay/durable-record contract behind
 * DESKTOP-18, DESKTOP-W and DESKTOP-15.
 *
 * The load-bearing assertions:
 *   - the record is written on EVERY death, not at a latch. The threshold
 *     moved to report time because the killing death probably never reaches
 *     JS at all: Chromium calls RecordProcessCrash (and the LOG(FATAL)) from
 *     the delegate, before the observer notification Electron emits from. So
 *     whatever ends up on disk has to already be there;
 *   - the death SEQUENCE is kept, bounded, with the first and last surviving
 *     the trim - it is the only thing that can say which rung of Chromium's
 *     fallback ladder was current each time;
 *   - Aptabase still sees at most two events per run (first + latched), never
 *     one per death, for the same reason restart-policy.ts caps its own count
 *     - an unbounded per-crash tick is what made a handful of looping installs
 *     read as "71 crashes a day";
 *   - isEscalationFromCurrentRun keeps a run from consuming a record it wrote
 *     itself, which is how DESKTOP-18's seven 9-second launches would each
 *     have eaten their own report;
 *   - shouldReportEscalation does not blame the GPU for an unrelated abrupt
 *     death (a renderer OOM, a kill, a power loss);
 *   - a fallback with NO death at all is recorded and counts as one near the
 *     end of a run. That is DESKTOP-W. GPU launch failures never reach JS, so
 *     Chromium's `gpu-info-update` at its last rung is the only trace. Only a
 *     transition away from hardware compositing writes, so our own software
 *     mode and a machine degraded from boot stay silent, unless the Linux
 *     GPU zygote is dead, which is never a normal state;
 *   - a corrupt or missing file reads as nothing pending, reading does not
 *     clear, and the clear is a compare-and-clear so a fresh record written
 *     between read and clear survives.
 */

const { mockTrackEvent, atomicWriteJsonSpy } = vi.hoisted(() => ({
  mockTrackEvent: vi.fn(),
  atomicWriteJsonSpy: vi.fn(),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: mockTrackEvent }));
// Delegates to the REAL atomicWriteJson by default, so every existing test in
// this file keeps exercising the real write path. Only the writeEscalation
// fallback test below overrides one call with mockImplementationOnce, which
// self-clears after that single call and falls back to the delegation.
vi.mock('../../src/main/config/board-config/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/board-config/atomic-write')>();
  atomicWriteJsonSpy.mockImplementation(actual.atomicWriteJson);
  return { ...actual, atomicWriteJson: atomicWriteJsonSpy };
});

import {
  recordGpuProcessGone,
  recordGpuModeObservation,
  readPendingGpuEscalation,
  clearGpuEscalation,
  resetGpuHealthForTests,
  isEscalationFromCurrentRun,
  isDeathNearRunEnd,
  shouldReportEscalation,
  summarizeGpuInfo,
} from '../../src/main/diagnostics/gpu-health';

const START_MS = 1_700_000_000_000;

/** A controllable clock, so no test depends on wall time. */
function makeClock(start = START_MS) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let tempDir: string;
let escalationPath: string;

beforeEach(() => {
  resetGpuHealthForTests();
  mockTrackEvent.mockClear();
  // mockClear, not mockReset: mockReset would strip the delegation to the
  // real atomicWriteJson set up above, silently switching every other test
  // in this file onto the fs.writeFileSync fallback without going red.
  atomicWriteJsonSpy.mockClear();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-gpu-health-'));
  escalationPath = path.join(tempDir, 'gpu-health.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('recordGpuProcessGone', () => {
  it('writes on the VERY FIRST death, before any threshold (the killing death may never reach JS)', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 5, '0.41.0', { now: clock.now });

    const escalation = readPendingGpuEscalation(escalationPath);
    expect(escalation?.count).toBe(1);
    expect(escalation?.reason).toBe('crashed');
    // This is the whole reason the threshold moved to report time. Chromium
    // runs the LOG(FATAL) from GpuProcessHost::RecordProcessCrash, which is
    // the delegate call - it happens BEFORE the observer notification that
    // Electron emits child-process-gone from. So the death that actually
    // kills the app is the one we will never be told about, and a write
    // gated on three observed deaths can lose the whole incident.
    expect(fs.existsSync(escalationPath)).toBe(true);
  });

  it('keeps the record current on every further death, and appends to the sequence', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 2 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 2, '0.41.0', options);
    const secondRecord = readPendingGpuEscalation(escalationPath);
    expect(secondRecord?.count).toBe(2);

    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 9, '0.41.0', options);

    const updatedRecord = readPendingGpuEscalation(escalationPath);
    expect(updatedRecord).not.toEqual(secondRecord);
    expect(updatedRecord).toEqual({
      reason: 'killed',
      exitCode: 9,
      count: 3,
      firstAt: secondRecord?.firstAt,
      lastAt: new Date(START_MS + 2_000).toISOString(),
      appVersion: '0.41.0',
      featureStatus: {},
      deaths: [
        { reason: 'crashed', exitCode: 1, at: new Date(START_MS).toISOString(), compositing: 'unknown', webgl: 'unknown' },
        { reason: 'crashed', exitCode: 2, at: new Date(START_MS + 1_000).toISOString(), compositing: 'unknown', webgl: 'unknown' },
        { reason: 'killed', exitCode: 9, at: new Date(START_MS + 2_000).toISOString(), compositing: 'unknown', webgl: 'unknown' },
      ],
      modeChanges: [],
    });
  });

  it('reads GPU feature status on every death, and records the rung each one left behind', () => {
    const clock = makeClock();
    // Chromium walking its fallback ladder: hardware first, then software.
    // The third entry is a HARDWARE death that already reads the lower rung:
    // Chromium falls back before Electron emits child-process-gone, and this
    // is exactly what three kills recorded on Windows and on Linux.
    const statuses = [
      { gpu_compositing: 'enabled', webgl: 'enabled' },
      { gpu_compositing: 'enabled', webgl: 'enabled' },
      { gpu_compositing: 'disabled_software', webgl: 'unavailable_software' },
    ];
    let call = 0;
    const getFeatureStatus = vi.fn(() => statuses[Math.min(call++, statuses.length - 1)]);
    const options = { now: clock.now, maxCrashes: 3, getFeatureStatus };

    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'launch-failed', null, '0.41.0', options);

    expect(getFeatureStatus).toHaveBeenCalledTimes(3);
    const record = readPendingGpuEscalation(escalationPath);
    // The SEQUENCE is the diagnosis: the same end-state snapshot would be
    // produced whether the GPU died once on software GL or walked the whole
    // ladder to get there.
    expect(record?.deaths.map((death) => death.compositing)).toEqual([
      'enabled',
      'enabled',
      'disabled_software',
    ]);
    expect(record?.featureStatus).toEqual(statuses[2]);
  });

  it('never lets a throwing getFeatureStatus lose the write or escape to the caller', () => {
    const clock = makeClock();
    const getFeatureStatus = vi.fn(() => {
      throw new Error('GPU info unavailable');
    });

    // It used to be evaluated in the argument expression, OUTSIDE
    // writeEscalation's try/catch, so a throw here took the write with it AND
    // escaped into Electron's child-process-gone emit.
    expect(() =>
      recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, getFeatureStatus }),
    ).not.toThrow();
    expect(readPendingGpuEscalation(escalationPath)?.count).toBe(1);
    expect(readPendingGpuEscalation(escalationPath)?.featureStatus).toEqual({});
  });

  it('bounds the death sequence, keeping the first and the last', () => {
    const clock = makeClock();
    for (let index = 0; index < 30; index += 1) {
      recordGpuProcessGone(escalationPath, `reason-${index}`, index, '0.41.0', { now: clock.now });
      clock.advance(1_000);
    }

    const record = readPendingGpuEscalation(escalationPath);
    // count stays the true total; only the middle of the sequence is dropped.
    expect(record?.count).toBe(30);
    expect(record?.deaths).toHaveLength(20);
    expect(record?.deaths[0].reason).toBe('reason-0');
    expect(record?.deaths[19].reason).toBe('reason-29');
  });

  it('forgets an isolated death once the decay window passes, so a recoverable crash never accumulates (DESKTOP-15 shape)', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(300_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(300_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    // Three deaths total, but never fewer than 300s apart, so the count never
    // accumulated past one. The file DOES exist now - every death writes -
    // but it says count: 1, and the sequence holds only the surviving death.
    // shouldReportEscalation is what turns that into "say nothing", not the
    // absence of a file.
    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.count).toBe(1);
    expect(record?.deaths).toHaveLength(1);
    expect(
      shouldReportEscalation(record!, { previousRunExit: 'clean', lastKnownAliveAt: null }),
    ).toBe(false);
  });

  it('latches once three deaths land inside the decay window, even split across resets by an earlier decay', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(300_000); // decays the lone crash above
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    const escalation = readPendingGpuEscalation(escalationPath);
    expect(escalation?.count).toBe(3);
  });

  it('sends at most two Aptabase events per run (first + latched), never one per death', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    // A fourth death after the latch must not tick a third event.
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenNthCalledWith(1, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'first',
    });
    expect(mockTrackEvent).toHaveBeenNthCalledWith(2, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'latched',
    });
  });

  /**
   * The sibling of the test above, across a decay boundary. The existing
   * "sends at most two Aptabase events per run" test never crosses a decay
   * reset, and the existing decay-boundary test ("latches once three deaths
   * land inside the decay window...") never asserts on trackEvent - so
   * nothing pinned that a SECOND escalation incident, later in the same run,
   * does not tick a third and fourth gpu_process_gone event. trackedPhases is
   * the module-level per-run gate that makes this true; decayIfQuiet
   * deliberately does not clear it (see the module's own comment above
   * `trackedPhases`), which is exactly what this test pins.
   *
   * Both incidents are asserted independently (firstAt, count) before the
   * trackEvent count check, so "called exactly twice" is conditional on two
   * REAL escalations having occurred, not on the second group failing to
   * latch at all.
   */
  it('sends exactly two Aptabase events across a run with two decay-separated latch incidents, never a third or fourth', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };

    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    const firstEscalation = readPendingGpuEscalation(escalationPath);
    expect(firstEscalation?.firstAt).toBe(new Date(START_MS).toISOString());
    expect(firstEscalation?.count).toBe(3);

    // Longer than decayMs, so the in-memory crash count resets before the
    // next death lands - but trackedPhases must survive this reset.
    clock.advance(300_001);
    const secondIncidentStartMs = clock.now();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    const secondEscalation = readPendingGpuEscalation(escalationPath);
    // A genuinely new incident (a fresh firstAt after the decay reset), not a
    // stale read of the first record.
    expect(secondEscalation?.firstAt).toBe(new Date(secondIncidentStartMs).toISOString());
    expect(secondEscalation?.count).toBe(3);
    expect(secondEscalation?.firstAt).not.toBe(firstEscalation?.firstAt);

    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenNthCalledWith(1, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'first',
    });
    expect(mockTrackEvent).toHaveBeenNthCalledWith(2, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'latched',
    });
  });

  it('respects a configured maxCrashes and decayMs instead of always using the defaults', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 });

    expect(readPendingGpuEscalation(escalationPath)?.count).toBe(1);
  });

  it('normalizes a null/undefined exit code to null on the escalation record', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'launch-failed', undefined, '0.41.0', { now: clock.now, maxCrashes: 1 });

    expect(readPendingGpuEscalation(escalationPath)?.exitCode).toBeNull();
  });

  it('creates the target directory if it does not exist yet (a fresh install before configDir is created)', () => {
    const nestedPath = path.join(tempDir, 'not-yet-created', 'gpu-health.json');
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(nestedPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();
    expect(readPendingGpuEscalation(nestedPath)?.count).toBe(1);
  });
});

/**
 * `app.getGPUFeatureStatus()` maps measured on Linux in Electron 41.10.7
 * (Ubuntu 24.04 under WSLg), not invented. Each is what a `gpu-info-update`
 * listener read at that point in a real run.
 */
const HARDWARE_STATUS: Record<string, string> = {
  '2d_canvas': 'enabled', direct_rendering_display_compositor: 'disabled_off_ok', gpu_compositing: 'enabled',
  multiple_raster_threads: 'enabled_on', opengl: 'enabled_on', rasterization: 'enabled', raw_draw: 'disabled_off_ok',
  skia_graphite: 'disabled_off', trees_in_viz: 'disabled_off', video_decode: 'enabled', video_encode: 'disabled_software',
  vulkan: 'disabled_off', webgl: 'enabled', webgpu: 'enabled', webgpu_on_vk_via_gl_interop: 'enabled', webnn: 'disabled_off',
};
/** After the fallback to DISPLAY_COMPOSITOR, the last rung before the fatal.
 *  Byte for byte the same map `app.disableHardwareAcceleration()` plus
 *  `--in-process-gpu` produces from its first read, which is why only a
 *  transition away from hardware may count. */
const DISPLAY_COMPOSITOR_STATUS: Record<string, string> = {
  '2d_canvas': 'disabled_software', direct_rendering_display_compositor: 'disabled_off_ok', gpu_compositing: 'disabled_software',
  multiple_raster_threads: 'disabled_off', opengl: 'disabled_off', rasterization: 'disabled_software', raw_draw: 'disabled_off_ok',
  skia_graphite: 'disabled_off', trees_in_viz: 'disabled_off', video_decode: 'disabled_software', video_encode: 'disabled_software',
  vulkan: 'disabled_off', webgl: 'disabled_off', webgpu: 'disabled_off', webgpu_on_vk_via_gl_interop: 'disabled_off', webnn: 'disabled_off',
};
/** A blocklisted driver: a GPU process runs, but compositing never did. */
const BLOCKLISTED_STATUS: Record<string, string> = {
  '2d_canvas': 'unavailable_software', direct_rendering_display_compositor: 'disabled_off_ok', gpu_compositing: 'disabled_software',
  multiple_raster_threads: 'enabled_on', opengl: 'unavailable_off', rasterization: 'unavailable_off', raw_draw: 'disabled_off_ok',
  skia_graphite: 'disabled_off', trees_in_viz: 'disabled_off', video_decode: 'unavailable_off', video_encode: 'disabled_software',
  vulkan: 'disabled_off', webgl: 'unavailable_off', webgpu: 'unavailable_software', webgpu_on_vk_via_gl_interop: 'disabled_off', webnn: 'disabled_off',
};
/** A SOFTWARE_GL rung above DISPLAY_COMPOSITOR: compositing already reads the
 *  same as the rung below it, and only the rest of the map tells them apart. */
const SOFTWARE_GL_STATUS: Record<string, string> = { ...DISPLAY_COMPOSITOR_STATUS, webgl: 'unavailable_software' };

function observe(clock: ReturnType<typeof makeClock>, featureStatus: Record<string, string>, appVersion = '0.44.0'): void {
  recordGpuModeObservation(escalationPath, appVersion, { now: clock.now, getFeatureStatus: () => featureStatus });
}

describe('recordGpuModeObservation (the fallback a launch-failure ladder leaves)', () => {
  it('records a fallback with no GPU death at all, and the next launch counts it as the death that ended the run (DESKTOP-W, 0.43.0)', () => {
    // The CachyOS crash, on its real clock. The run started 17:54:57.936Z and
    // hit the fatal at 17:58:55Z. No child-process-gone ever fired: every
    // death on the way was a launch failure, which Electron does not forward.
    // Chromium's gpu-info-update at its last rung is the only thing JS heard,
    // and in the Linux reproduction the synchronous write was on disk before
    // the process died, in the same millisecond as the fatal.
    const runStartMs = Date.parse('2026-09-23T17:54:57.936Z');
    const clock = makeClock(runStartMs);
    clock.advance(400);
    observe(clock, HARDWARE_STATUS);
    expect(fs.existsSync(escalationPath)).toBe(false);

    const fallbackMs = Date.parse('2026-09-23T17:58:54.998Z');
    clock.advance(fallbackMs - clock.now());
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    const record = readPendingGpuEscalation(escalationPath);
    expect(record).toEqual({
      reason: 'hardware-fallback',
      exitCode: null,
      count: 0,
      firstAt: '2026-09-23T17:58:54.998Z',
      lastAt: '2026-09-23T17:58:54.998Z',
      appVersion: '0.44.0',
      featureStatus: DISPLAY_COMPOSITOR_STATUS,
      deaths: [],
      modeChanges: [{ at: '2026-09-23T17:58:54.998Z', compositing: 'disabled_software', webgl: 'disabled_off' }],
    });
    // A fallback is not a death, so it ticks no Aptabase event.
    expect(mockTrackEvent).not.toHaveBeenCalled();

    // The next launch: no exit recorded, and the last run-uptime checkpoint
    // is the third one-minute tick, 57 seconds before the fatal.
    const context = { previousRunExit: 'abrupt', lastKnownAliveAt: '2026-09-23T17:57:57.936Z' };
    expect(isDeathNearRunEnd(record!, context)).toBe(true);
    expect(shouldReportEscalation(record!, context)).toBe(true);
  });

  it('writes nothing when compositing was never on the GPU (our own software mode, a blocklisted driver)', () => {
    const clock = makeClock();
    // Software mode reads the DISPLAY_COMPOSITOR map from its very first
    // update. Recording it would write a "fallback" on every software-mode
    // boot, and that boot runs right after the one the recovery exists for.
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    clock.advance(1_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    // A blocklisted box churns through statuses at boot and can still fall
    // to DISPLAY_COMPOSITOR later. It never had hardware to lose.
    clock.advance(1_000);
    observe(clock, BLOCKLISTED_STATUS);
    clock.advance(60_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    expect(fs.existsSync(escalationPath)).toBe(false);
  });

  it('records a fallback whose compositing reads "unavailable_*", not only "disabled_*"', () => {
    // isDegradedCompositing's own doc comment calls this "software or no
    // compositing", and BLOCKLISTED_STATUS above already proves unavailable_*
    // is a real value Chromium reports for gpu_compositing (measured on
    // Linux). This machine had hardware, then compositing went fully
    // unavailable rather than falling back to software - a transition the
    // "disabled" prefix alone would silently drop.
    const clock = makeClock();
    observe(clock, HARDWARE_STATUS);
    expect(fs.existsSync(escalationPath)).toBe(false);

    const unavailableStatus = { ...DISPLAY_COMPOSITOR_STATUS, gpu_compositing: 'unavailable_software' };
    clock.advance(1_000);
    observe(clock, unavailableStatus);

    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.modeChanges).toHaveLength(1);
    expect(record?.modeChanges[0]?.compositing).toBe('unavailable_software');
    expect(record?.featureStatus.gpu_compositing).toBe('unavailable_software');
  });

  it('writes nothing while compositing stays on the GPU, however often the update fires', () => {
    // gpu-info-update fires on every GPU process restart, and on a healthy
    // machine each one re-reads hardware.
    const clock = makeClock();
    for (let index = 0; index < 5; index += 1) {
      observe(clock, HARDWARE_STATUS);
      clock.advance(3_000);
    }
    expect(fs.existsSync(escalationPath)).toBe(false);
    expect(atomicWriteJsonSpy).not.toHaveBeenCalled();
  });

  it('writes once for a repeated degraded status, keeping lastAt at the change, not the repeat', () => {
    // In DISPLAY_COMPOSITOR mode every GPU restart repeats the same map.
    const clock = makeClock();
    observe(clock, HARDWARE_STATUS);
    clock.advance(10_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    const changeAt = new Date(clock.now()).toISOString();
    clock.advance(1_300);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    clock.advance(3_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    expect(atomicWriteJsonSpy).toHaveBeenCalledTimes(1);
    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.modeChanges).toHaveLength(1);
    expect(record?.lastAt).toBe(changeAt);
  });

  it('moves lastAt to the lower rung when a second degraded status follows the first', () => {
    // SOFTWARE_GL and DISPLAY_COMPOSITOR both read `disabled_software` for
    // compositing. Keyed on that field alone, lastAt would stay at the upper
    // rung, possibly minutes before the fatal, and fail the near-end check.
    const clock = makeClock();
    observe(clock, HARDWARE_STATUS);
    clock.advance(60_000);
    observe(clock, SOFTWARE_GL_STATUS);
    clock.advance(240_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.modeChanges.map((modeChange) => modeChange.webgl)).toEqual(['unavailable_software', 'disabled_off']);
    expect(record?.firstAt).toBe(new Date(START_MS + 60_000).toISOString());
    expect(record?.lastAt).toBe(new Date(START_MS + 300_000).toISOString());
  });

  it('records a fallback again after hardware is seen in between', () => {
    // Chromium never climbs back up its ladder within a run, but a status
    // read that returns to hardware must not leave the next identical
    // fallback deduplicated against a change that is no longer current.
    const clock = makeClock();
    observe(clock, HARDWARE_STATUS);
    clock.advance(1_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    clock.advance(1_000);
    observe(clock, HARDWARE_STATUS);
    clock.advance(1_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    expect(readPendingGpuEscalation(escalationPath)?.modeChanges).toHaveLength(2);
  });

  it('bounds the mode-change sequence to MAX_MODE_CHANGES (8), keeping the first and the last', () => {
    // A hardware read resets the dedup signature (see "records a fallback
    // again after hardware is seen in between" above), so alternating
    // HARDWARE_STATUS and DISPLAY_COMPOSITOR_STATUS writes a fresh entry on
    // every degraded read, unlike the repeated-status dedup the earlier
    // tests exercise. Nine such pairs push a ninth entry and trigger the
    // trim.
    const clock = makeClock();
    for (let index = 0; index < 9; index += 1) {
      observe(clock, HARDWARE_STATUS);
      clock.advance(1_000);
      observe(clock, DISPLAY_COMPOSITOR_STATUS);
      clock.advance(1_000);
    }

    const record = readPendingGpuEscalation(escalationPath);
    // count stays the true total; only the middle of the sequence is dropped.
    expect(record?.modeChanges).toHaveLength(8);
    expect(record?.modeChanges[0].at).toBe(new Date(START_MS + 1_000).toISOString());
    expect(record?.modeChanges[7].at).toBe(new Date(START_MS + 17_000).toISOString());
  });

  it('keeps the deaths that led to a fallback, and the fallback when a later death rewrites the record (the crash-ladder shape)', () => {
    // Measured on Linux: three SIGKILLs of the GPU process, each announced by
    // child-process-gone, and the fallback's gpu-info-update 1 ms after the
    // third.
    const clock = makeClock();
    const deathOptions = { now: clock.now, getFeatureStatus: () => HARDWARE_STATUS };
    observe(clock, HARDWARE_STATUS);
    for (let index = 0; index < 3; index += 1) {
      clock.advance(3_000);
      recordGpuProcessGone(escalationPath, 'killed', 9, '0.44.0', deathOptions);
    }
    clock.advance(1);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    const afterFallback = readPendingGpuEscalation(escalationPath);
    expect(afterFallback?.count).toBe(3);
    expect(afterFallback?.deaths).toHaveLength(3);
    expect(afterFallback?.reason).toBe('killed');
    expect(afterFallback?.exitCode).toBe(9);
    expect(afterFallback?.modeChanges).toHaveLength(1);
    expect(afterFallback?.firstAt).toBe(new Date(START_MS + 3_000).toISOString());
    expect(afterFallback?.lastAt).toBe(new Date(START_MS + 9_001).toISOString());

    clock.advance(1_300);
    recordGpuProcessGone(escalationPath, 'killed', 9, '0.44.0', { now: clock.now, getFeatureStatus: () => DISPLAY_COMPOSITOR_STATUS });
    const afterLaterDeath = readPendingGpuEscalation(escalationPath);
    expect(afterLaterDeath?.count).toBe(4);
    expect(afterLaterDeath?.modeChanges).toHaveLength(1);
    expect(afterLaterDeath?.lastAt).toBe(new Date(START_MS + 10_301).toISOString());
  });

  it('keeps the fallback across a decay reset that clears the deaths', () => {
    const clock = makeClock();
    const options = { now: clock.now, decayMs: 300_000 };
    observe(clock, HARDWARE_STATUS);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.44.0', options);
    clock.advance(1_000);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    clock.advance(600_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.44.0', options);

    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.count).toBe(1);
    expect(record?.deaths).toHaveLength(1);
    expect(record?.modeChanges).toHaveLength(1);
    // The incident now spans the fallback and the later death.
    expect(record?.firstAt).toBe(new Date(START_MS + 2_000).toISOString());
    expect(record?.lastAt).toBe(new Date(START_MS + 602_000).toISOString());
  });

  it('does not decay the death count from a mode observation, unlike recordGpuProcessGone itself', () => {
    // Deliberate: recordGpuModeObservation never calls decayIfQuiet. The
    // deaths may already be on disk as a crash loop the next launch
    // reports, and a decay here would overwrite that with a fallback-only
    // record.
    const clock = makeClock();
    const deathOptions = { now: clock.now, decayMs: 300_000 };
    observe(clock, HARDWARE_STATUS);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 9, '0.44.0', deathOptions);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 9, '0.44.0', deathOptions);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 9, '0.44.0', deathOptions);

    // Past the decay window, with no further death - only a mode observation.
    clock.advance(300_001);
    const fallbackAt = new Date(clock.now()).toISOString();
    observe(clock, DISPLAY_COMPOSITOR_STATUS);

    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.count).toBe(3);
    expect(record?.reason).toBe('killed');
    expect(record?.deaths).toHaveLength(3);
    expect(record?.deaths.every((death) => death.reason === 'killed')).toBe(true);
    expect(record?.modeChanges).toHaveLength(1);
    expect(record?.lastAt).toBe(fallbackAt);
  });

  it('does not blame the GPU for a boot-time fallback the run survived, or for an unrelated death twenty minutes later', () => {
    // A VM or a broken-GL box can read hardware for a moment at boot and then
    // fall back, on every launch. The report gate and the near-end check are
    // what keep that from downgrading or reporting anyone.
    const clock = makeClock();
    observe(clock, HARDWARE_STATUS);
    clock.advance(800);
    observe(clock, DISPLAY_COMPOSITOR_STATUS);
    const record = readPendingGpuEscalation(escalationPath)!;
    expect(record.count).toBe(0);

    const cleanExit = { previousRunExit: 'clean', lastKnownAliveAt: new Date(START_MS + 3_600_000).toISOString() };
    expect(isDeathNearRunEnd(record, cleanExit)).toBe(false);
    expect(shouldReportEscalation(record, cleanExit)).toBe(false);

    const unrelatedAbruptEnd = { previousRunExit: 'abrupt', lastKnownAliveAt: new Date(START_MS + 20 * 60_000).toISOString() };
    expect(isDeathNearRunEnd(record, unrelatedAbruptEnd)).toBe(false);
    expect(shouldReportEscalation(record, unrelatedAbruptEnd)).toBe(false);
  });

  describe('the Linux zygote reading', () => {
    const snapshot = (zygote: 'alive' | 'dead' | 'unknown') => ({ zygote, schedulingEntities: 970, maxUserProcesses: '123561' });

    it('records a dead-zygote fallback on a machine that never composited on the GPU, with the reading on the entry', () => {
      // A blocklisted Linux box, measured: boot reads degraded with the zygote
      // alive, then the zygote dies and Chromium falls to its last rung. The
      // hardware-first rule alone would record nothing here, and the fatal
      // follows within milliseconds.
      const clock = makeClock();
      let zygote: 'alive' | 'dead' = 'alive';
      const options = {
        now: clock.now,
        getFeatureStatus: () => BLOCKLISTED_STATUS,
        readLinuxProcessSnapshot: () => snapshot(zygote),
      };
      recordGpuModeObservation(escalationPath, '0.44.0', options);
      clock.advance(2);
      recordGpuModeObservation(escalationPath, '0.44.0', options);
      expect(fs.existsSync(escalationPath)).toBe(false);

      clock.advance(240_000);
      zygote = 'dead';
      recordGpuModeObservation(escalationPath, '0.44.0', { ...options, getFeatureStatus: () => DISPLAY_COMPOSITOR_STATUS });

      const record = readPendingGpuEscalation(escalationPath);
      expect(record?.count).toBe(0);
      expect(record?.reason).toBe('hardware-fallback');
      expect(record?.modeChanges).toEqual([
        {
          at: new Date(START_MS + 240_002).toISOString(),
          compositing: 'disabled_software',
          webgl: 'disabled_off',
          linux: { zygote: 'dead', schedulingEntities: 970, maxUserProcesses: '123561' },
        },
      ]);
    });

    it('does not lift the hardware-first rule while the zygote is alive or unreadable', () => {
      // Our own software mode and a blocklisted boot both have a live zygote;
      // an unreadable /proc is no evidence of anything.
      const clock = makeClock();
      for (const zygote of ['alive', 'unknown'] as const) {
        recordGpuModeObservation(escalationPath, '0.44.0', {
          now: clock.now,
          getFeatureStatus: () => DISPLAY_COMPOSITOR_STATUS,
          readLinuxProcessSnapshot: () => snapshot(zygote),
        });
      }
      expect(fs.existsSync(escalationPath)).toBe(false);
    });

    it('reads /proc only on a degraded status, never on the healthy updates of every GPU restart', () => {
      const clock = makeClock();
      const readLinuxProcessSnapshot = vi.fn(() => snapshot('alive'));
      recordGpuModeObservation(escalationPath, '0.44.0', { now: clock.now, getFeatureStatus: () => HARDWARE_STATUS, readLinuxProcessSnapshot });
      recordGpuModeObservation(escalationPath, '0.44.0', { now: clock.now, getFeatureStatus: () => HARDWARE_STATUS, readLinuxProcessSnapshot });
      expect(readLinuxProcessSnapshot).not.toHaveBeenCalled();

      recordGpuModeObservation(escalationPath, '0.44.0', { now: clock.now, getFeatureStatus: () => DISPLAY_COMPOSITOR_STATUS, readLinuxProcessSnapshot });
      expect(readLinuxProcessSnapshot).toHaveBeenCalledTimes(1);
      // The crash-ladder shape: a normal fallback also carries the reading,
      // which is what says "the zygote was fine, so it was not a dead zygote".
      expect(readPendingGpuEscalation(escalationPath)?.modeChanges[0]?.linux?.zygote).toBe('alive');
    });

    it('still records the fallback when the /proc reader throws, just without the reading', () => {
      const clock = makeClock();
      observe(clock, HARDWARE_STATUS);
      recordGpuModeObservation(escalationPath, '0.44.0', {
        now: clock.now,
        getFeatureStatus: () => DISPLAY_COMPOSITOR_STATUS,
        readLinuxProcessSnapshot: () => {
          throw new Error('proc unreadable');
        },
      });
      const modeChange = readPendingGpuEscalation(escalationPath)?.modeChanges[0];
      expect(modeChange?.compositing).toBe('disabled_software');
      expect(modeChange).not.toHaveProperty('linux');
    });

    it('leaves the entry without a linux block off Linux, where no reader is passed', () => {
      const clock = makeClock();
      observe(clock, HARDWARE_STATUS);
      observe(clock, DISPLAY_COMPOSITOR_STATUS);
      expect(readPendingGpuEscalation(escalationPath)?.modeChanges[0]).not.toHaveProperty('linux');
    });
  });

  it('never throws and writes nothing on a throwing, empty, or unrecognized status read', () => {
    const clock = makeClock();
    observe(clock, HARDWARE_STATUS);
    expect(() =>
      recordGpuModeObservation(escalationPath, '0.44.0', {
        now: clock.now,
        getFeatureStatus: () => {
          throw new Error('GPU info unavailable');
        },
      }),
    ).not.toThrow();
    observe(clock, {});
    observe(clock, { gpu_compositing: 'something_new' });

    expect(fs.existsSync(escalationPath)).toBe(false);
  });
});

/**
 * writeEscalation's own doc comment claims "Never throws". Three guarded
 * paths back that claim; this suite exercises the two that matter most for a
 * running app (an unwritable directory, and an atomic-write failure that
 * still has to leave a readable record) plus the "even the fallback fails"
 * give-up case.
 */
describe('writeEscalation failure paths (the "Never throws" contract)', () => {
  it('does not throw and writes nothing when the escalation directory cannot be created (a path component is an existing file, not a directory)', () => {
    // fs.mkdirSync(dirname, { recursive: true }) cannot create a directory
    // inside something that is itself a plain file - the mkdir call throws,
    // and the guarded catch must swallow it before anything is written.
    const blockingFilePath = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(blockingFilePath, 'this is a file, not a directory');
    const blockedEscalationPath = path.join(blockingFilePath, 'nested', 'gpu-health.json');
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(blockedEscalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();
    expect(fs.existsSync(blockedEscalationPath)).toBe(false);
    expect(readPendingGpuEscalation(blockedEscalationPath)).toBeNull();
  });

  it('falls back to a plain writeFileSync and still leaves a readable record when atomicWriteJson throws', () => {
    // Consumed after this one call, so every OTHER test in the file keeps
    // going through the real atomicWriteJson via the delegating mock.
    atomicWriteJsonSpy.mockImplementationOnce(() => {
      throw new Error('rename failed mid-write');
    });
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();

    // Proves the fallback actually engaged, not merely that nothing threw:
    // atomicWriteJson was attempted (and failed) before the record became
    // readable via the plain fs.writeFileSync path.
    expect(atomicWriteJsonSpy).toHaveBeenCalledTimes(1);
    expect(readPendingGpuEscalation(escalationPath)).toEqual({
      reason: 'crashed',
      exitCode: 1,
      count: 1,
      firstAt: new Date(START_MS).toISOString(),
      lastAt: new Date(START_MS).toISOString(),
      appVersion: '0.41.0',
      featureStatus: {},
      deaths: [
        { reason: 'crashed', exitCode: 1, at: new Date(START_MS).toISOString(), compositing: 'unknown', webgl: 'unknown' },
      ],
      modeChanges: [],
    });
  });

  it('gives up silently when the writeFileSync fallback also fails (a directory sits where the record file should go)', () => {
    // No mocking needed: a directory at the escalation path makes the real
    // atomicWriteJson fail naturally (its tmp-file write succeeds, but
    // renaming a file onto an existing directory throws), and then the plain
    // fs.writeFileSync fallback fails the same way writing directly to it -
    // exercising both guarded catches with real fs behavior.
    fs.mkdirSync(escalationPath);
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();
  });
});

describe('readPendingGpuEscalation', () => {
  it('returns null when no file exists', () => {
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('treats a corrupt file as nothing pending, without throwing', () => {
    fs.writeFileSync(escalationPath, '{ not json');
    expect(() => readPendingGpuEscalation(escalationPath)).not.toThrow();
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('treats a wrong-shaped record (a string where count belongs) as nothing pending', () => {
    fs.writeFileSync(
      escalationPath,
      JSON.stringify({ reason: 'crashed', exitCode: 1, count: 'three', firstAt: 'x', lastAt: 'y', appVersion: '0.41.0' }),
    );
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('tolerates a missing or wrong-shaped featureStatus as {} rather than invalidating the whole record', () => {
    fs.writeFileSync(
      escalationPath,
      JSON.stringify({ reason: 'crashed', exitCode: 1, count: 3, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0' }),
    );
    expect(readPendingGpuEscalation(escalationPath)?.featureStatus).toEqual({});

    fs.writeFileSync(
      escalationPath,
      JSON.stringify({
        reason: 'crashed', exitCode: 1, count: 3, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
        featureStatus: ['not', 'an', 'object'],
      }),
    );
    expect(readPendingGpuEscalation(escalationPath)?.featureStatus).toEqual({});
  });

  /**
   * `readPendingGpuEscalation`'s `deaths` normalization, pinned with hand-built
   * fixture literals rather than records produced by `recordGpuProcessGone`.
   * The writer always produces well-formed entries, so only a hand-written
   * fixture exercises the parser against a shape it did not write itself -
   * the same "external-input parsers need a real-shape fixture test"
   * convention as `codex-rollout-event-msg.jsonl`.
   */
  describe('deaths array normalization', () => {
    it('drops a deaths entry that is not an object, or is null', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'crashed', exitCode: 1, count: 3, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
          deaths: [null, 'a stray string entry', 42, { reason: 'crashed', exitCode: 1, at: 'z' }],
        }),
      );
      const record = readPendingGpuEscalation(escalationPath);
      expect(record?.deaths).toEqual([
        { reason: 'crashed', exitCode: 1, at: 'z', compositing: 'unknown', webgl: 'unknown' },
      ]);
    });

    it('drops a deaths entry missing reason or at, or carrying a non-string reason or at', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'crashed', exitCode: 1, count: 5, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
          deaths: [
            { exitCode: 1, at: 'z' }, // missing reason
            { reason: 1, at: 'z' }, // non-string reason
            { reason: 'crashed' }, // missing at
            { reason: 'crashed', at: 5 }, // non-string at
            { reason: 'crashed', at: 'z', exitCode: 1 }, // the lone survivor
          ],
        }),
      );
      const record = readPendingGpuEscalation(escalationPath);
      expect(record?.deaths).toEqual([
        { reason: 'crashed', exitCode: 1, at: 'z', compositing: 'unknown', webgl: 'unknown' },
      ]);
    });

    it('normalizes a surviving entry\'s missing or non-string compositing/webgl to "unknown"', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'crashed', exitCode: 1, count: 2, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
          deaths: [
            { reason: 'crashed', at: 'z', exitCode: 1 }, // compositing/webgl both missing
            { reason: 'crashed', at: 'z', exitCode: 1, compositing: 42, webgl: false }, // wrong type
          ],
        }),
      );
      const record = readPendingGpuEscalation(escalationPath);
      expect(record?.deaths).toEqual([
        { reason: 'crashed', exitCode: 1, at: 'z', compositing: 'unknown', webgl: 'unknown' },
        { reason: 'crashed', exitCode: 1, at: 'z', compositing: 'unknown', webgl: 'unknown' },
      ]);
    });

    it('normalizes a surviving entry\'s missing or non-number exitCode to null', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'crashed', exitCode: 1, count: 2, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
          deaths: [
            { reason: 'crashed', at: 'z' }, // exitCode missing
            { reason: 'crashed', at: 'z', exitCode: 'nine' }, // wrong type
          ],
        }),
      );
      const record = readPendingGpuEscalation(escalationPath);
      expect(record?.deaths).toEqual([
        { reason: 'crashed', exitCode: null, at: 'z', compositing: 'unknown', webgl: 'unknown' },
        { reason: 'crashed', exitCode: null, at: 'z', compositing: 'unknown', webgl: 'unknown' },
      ]);
    });

    it('round-trips a well-formed deaths entry unchanged', () => {
      const wellFormed = {
        reason: 'killed',
        exitCode: 9,
        at: '2026-09-18T02:35:44.000Z',
        compositing: 'enabled',
        webgl: 'enabled',
      };
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'killed', exitCode: 9, count: 1, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
          deaths: [wellFormed],
        }),
      );
      const record = readPendingGpuEscalation(escalationPath);
      expect(record?.deaths).toEqual([wellFormed]);
    });

    it('reads a pre-upgrade record with no deaths or modeChanges key at all as empty lists, the rest of the record still parsing', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({ reason: 'crashed', exitCode: 1, count: 3, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0' }),
      );
      const record = readPendingGpuEscalation(escalationPath);
      expect(record).toEqual({
        reason: 'crashed',
        exitCode: 1,
        count: 3,
        firstAt: 'x',
        lastAt: 'y',
        appVersion: '0.41.0',
        featureStatus: {},
        deaths: [],
        modeChanges: [],
      });
    });
  });

  describe('modeChanges array normalization', () => {
    it('drops a non-object entry or one with no string at, and normalizes a missing compositing or webgl to "unknown"', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'hardware-fallback', exitCode: null, count: 0, firstAt: 'x', lastAt: 'y', appVersion: '0.44.0',
          modeChanges: [
            null,
            'a stray string entry',
            { compositing: 'disabled_software', webgl: 'disabled_off' }, // missing at
            { at: 7, compositing: 'disabled_software' }, // non-string at
            { at: 'z' }, // survives, with both statuses unknown
            { at: 'w', compositing: 42, webgl: false }, // survives, wrong-typed statuses normalized
          ],
        }),
      );
      expect(readPendingGpuEscalation(escalationPath)?.modeChanges).toEqual([
        { at: 'z', compositing: 'unknown', webgl: 'unknown' },
        { at: 'w', compositing: 'unknown', webgl: 'unknown' },
      ]);
    });

    it('keeps a well-formed linux block, reads an unrecognized zygote state as unknown, and drops a block that is not an object', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'hardware-fallback', exitCode: null, count: 0, firstAt: 'x', lastAt: 'y', appVersion: '0.44.0',
          modeChanges: [
            { at: 'a', compositing: 'disabled_software', webgl: 'disabled_off', linux: { zygote: 'dead', schedulingEntities: 891, maxUserProcesses: '123561' } },
            // A report that says "dead" on bad data would send a triage the
            // wrong way, so anything else reads unknown.
            { at: 'b', compositing: 'disabled_software', webgl: 'disabled_off', linux: { zygote: 'zombie', schedulingEntities: '891', maxUserProcesses: 5 } },
            { at: 'c', compositing: 'disabled_software', webgl: 'disabled_off', linux: 'dead' },
          ],
        }),
      );
      expect(readPendingGpuEscalation(escalationPath)?.modeChanges).toEqual([
        { at: 'a', compositing: 'disabled_software', webgl: 'disabled_off', linux: { zygote: 'dead', schedulingEntities: 891, maxUserProcesses: '123561' } },
        { at: 'b', compositing: 'disabled_software', webgl: 'disabled_off', linux: { zygote: 'unknown', schedulingEntities: null, maxUserProcesses: null } },
        { at: 'c', compositing: 'disabled_software', webgl: 'disabled_off' },
      ]);
    });

    it('treats a modeChanges value that is not an array as empty', () => {
      fs.writeFileSync(
        escalationPath,
        JSON.stringify({
          reason: 'hardware-fallback', exitCode: null, count: 0, firstAt: 'x', lastAt: 'y', appVersion: '0.44.0',
          modeChanges: { at: 'z' },
        }),
      );
      expect(readPendingGpuEscalation(escalationPath)?.modeChanges).toEqual([]);
    });
  });

  it('does not clear the file merely by reading it', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 });

    readPendingGpuEscalation(escalationPath);
    readPendingGpuEscalation(escalationPath);

    expect(fs.existsSync(escalationPath)).toBe(true);
  });
});

describe('clearGpuEscalation', () => {
  it('removes an existing escalation file', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 });
    expect(fs.existsSync(escalationPath)).toBe(true);

    clearGpuEscalation(escalationPath);

    expect(fs.existsSync(escalationPath)).toBe(false);
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('does not throw when there is nothing to clear', () => {
    expect(() => clearGpuEscalation(escalationPath)).not.toThrow();
  });
});

describe('a fresh run after resetGpuHealthForTests (the real cross-launch shape)', () => {
  it('starts a clean count even with an unread escalation still on disk from a prior run', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 2 });
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 2 });
    expect(readPendingGpuEscalation(escalationPath)?.count).toBe(2);

    // Simulate the boot report reading and clearing it, then a fresh
    // process (module state reset) hitting a single, isolated death.
    clearGpuEscalation(escalationPath);
    resetGpuHealthForTests();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 2 });

    // The new run writes immediately, but with its OWN count of 1 and its own
    // one-entry sequence: the previous run's tally did not carry over.
    const record = readPendingGpuEscalation(escalationPath);
    expect(record?.count).toBe(1);
    expect(record?.deaths).toHaveLength(1);
  });
});

describe('summarizeGpuInfo', () => {
  /** The shape app.getGPUInfo('complete') really returns, measured on
   *  Electron 41 (Windows). Trimmed here to the keys the summarizer reads
   *  plus enough filler to stand in for the ~6.5-7 KB of auxAttributes the
   *  real payload carries. */
  const realShape = {
    gpuDevice: [
      { vendorId: 4318, deviceId: 11141, driverVersion: '32.0.16.1088', driverVendor: 'NVIDIA', active: true, cudaComputeCapabilityMajor: 0 },
      { vendorId: 4098, deviceId: 5056, driverVersion: '32.0.21045.5002', active: false },
      { vendorId: 5140, deviceId: 140, driverVersion: '10.0.26100.9278', active: false },
    ],
    machineModelName: 'Test Machine',
    machineModelVersion: '1.0',
    auxAttributes: {
      glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)',
      glVendor: 'Google Inc. (NVIDIA)',
      glVersion: 'OpenGL ES 2.0.0',
      glExtensions: 'x'.repeat(5000),
      inProcessGpu: false,
    },
  };

  it('keeps the adapters and driver versions a triage would read', () => {
    const summary = summarizeGpuInfo(realShape);
    expect(summary?.gpuDevice).toEqual([
      { vendorId: 4318, deviceId: 11141, driverVersion: '32.0.16.1088', driverVendor: 'NVIDIA', active: true },
      { vendorId: 4098, deviceId: 5056, driverVersion: '32.0.21045.5002', driverVendor: undefined, active: false },
      { vendorId: 5140, deviceId: 140, driverVersion: '10.0.26100.9278', driverVendor: undefined, active: false },
    ]);
    expect(summary?.glRenderer).toContain('RTX 5090');
  });

  it('drops the open-ended payload, so the death sequence keeps its room in the Sentry context', () => {
    // The raw object measured 6969 bytes on a real Electron 41 run. It shares
    // one context with `deaths`, and if that context is truncated the
    // sequence - the whole reason per-death detail is recorded - is what goes.
    const rawBytes = JSON.stringify(realShape).length;
    const summaryBytes = JSON.stringify(summarizeGpuInfo(realShape)).length;
    expect(rawBytes).toBeGreaterThan(5000);
    expect(summaryBytes).toBeLessThan(600);
  });

  it('returns null rather than throwing on a shape it does not recognize', () => {
    expect(summarizeGpuInfo(null)).toBeNull();
    expect(summarizeGpuInfo(undefined)).toBeNull();
    expect(summarizeGpuInfo('not an object')).toBeNull();
    expect(summarizeGpuInfo(42)).toBeNull();
    expect(summarizeGpuInfo(true)).toBeNull();
    // A partial object still summarizes; it just carries empty fields.
    expect(summarizeGpuInfo({})?.gpuDevice).toEqual([]);
  });

  it('pulls glVendor, glVersion, and isSoftwareRendering out of auxAttributes', () => {
    const summary = summarizeGpuInfo({
      ...realShape,
      auxAttributes: { ...realShape.auxAttributes, isSoftwareRendering: true },
    });
    expect(summary?.glVendor).toBe('Google Inc. (NVIDIA)');
    expect(summary?.glVersion).toBe('OpenGL ES 2.0.0');
    expect(summary?.isSoftwareRendering).toBe(true);
  });

  it('reads machineModelName and machineModelVersion off the root, not auxAttributes', () => {
    const summary = summarizeGpuInfo(realShape);
    expect(summary?.machineModelName).toBe('Test Machine');
    expect(summary?.machineModelVersion).toBe('1.0');
  });

  it('caps gpuDevice at 4 entries even when the raw payload carries more', () => {
    const manyDevices = Array.from({ length: 7 }, (_, index) => ({
      vendorId: index,
      deviceId: index * 10,
      driverVersion: `1.0.${index}`,
      active: index === 0,
    }));
    const summary = summarizeGpuInfo({ ...realShape, gpuDevice: manyDevices });
    expect(summary?.gpuDevice).toEqual(
      manyDevices.slice(0, 4).map((device) => ({
        vendorId: device.vendorId,
        deviceId: device.deviceId,
        driverVersion: device.driverVersion,
        driverVendor: undefined,
        active: device.active,
      })),
    );
  });
});

describe('isEscalationFromCurrentRun', () => {
  const recordAt = (lastAt: string) => ({
    reason: 'crashed',
    exitCode: 1,
    count: 3,
    firstAt: lastAt,
    lastAt,
    appVersion: '0.41.0',
    featureStatus: {},
    deaths: [],
    modeChanges: [],
  });

  it('claims a record written after this process started', () => {
    // DESKTOP-18's exact shape: the writer is installed at module scope and
    // the reporter runs inside whenReady after createWindow and an await, so
    // a GPU crash-looping from startup writes into that gap. Without this,
    // the same run consumes and reports its own record while the async POST
    // races the LOG(FATAL), and the NEXT launch finds nothing pending.
    const processStart = '2026-09-18T02:35:36.705Z';
    expect(isEscalationFromCurrentRun(recordAt('2026-09-18T02:35:44.000Z'), processStart)).toBe(true);
  });

  it('disclaims a record written by a previous run', () => {
    const processStart = '2026-09-18T02:35:36.705Z';
    expect(isEscalationFromCurrentRun(recordAt('2026-09-18T02:34:57.000Z'), processStart)).toBe(false);
  });

  it('treats an undateable record as a previous run\'s, because reporting twice beats losing it', () => {
    expect(isEscalationFromCurrentRun(recordAt('not-a-date'), '2026-09-18T02:35:36.705Z')).toBe(false);
  });
});

describe('shouldReportEscalation / isDeathNearRunEnd', () => {
  const record = (count: number, lastAt: string) => ({
    reason: 'crashed',
    exitCode: 1,
    count,
    firstAt: lastAt,
    lastAt,
    appVersion: '0.41.0',
    featureStatus: {},
    deaths: [],
    modeChanges: [],
  });

  it('does NOT blame the GPU when an unrelated crash ended the run (DESKTOP-16 shape)', () => {
    // One GPU death, then forty more minutes of healthy running, then the
    // renderer dies of commit exhaustion. `abrupt` alone would have called
    // that a graphics failure to the user's face.
    const context = { previousRunExit: 'abrupt', lastKnownAliveAt: '2026-09-18T03:15:00.000Z' };
    const oneEarlyDeath = record(1, '2026-09-18T02:35:00.000Z');
    expect(isDeathNearRunEnd(oneEarlyDeath, context)).toBe(false);
    expect(shouldReportEscalation(oneEarlyDeath, context)).toBe(false);
  });

  it('reports and blames the GPU when the death sits at the end of an abrupt run (DESKTOP-18 shape)', () => {
    // A 9-second run writes only its init checkpoint, so "last known alive"
    // is the run start and the death lands after it.
    const context = { previousRunExit: 'abrupt', lastKnownAliveAt: '2026-09-18T02:35:36.705Z' };
    const dyingRun = record(2, '2026-09-18T02:35:44.000Z');
    expect(isDeathNearRunEnd(dyingRun, context)).toBe(true);
    expect(shouldReportEscalation(dyingRun, context)).toBe(true);
  });

  it('reports a threshold breach the run then survived, but does not blame it for the ending', () => {
    // Chromium fell back on its own and the app quit normally. Worth a Sentry
    // issue, worth no recovery and no word to the user.
    const context = { previousRunExit: 'clean', lastKnownAliveAt: '2026-09-18T03:15:00.000Z' };
    const survived = record(3, '2026-09-18T02:35:00.000Z');
    expect(shouldReportEscalation(survived, context)).toBe(true);
    expect(isDeathNearRunEnd(survived, context)).toBe(false);
  });

  it('tolerates a pre-upgrade run record with no timestamp', () => {
    const context = { previousRunExit: 'abrupt', lastKnownAliveAt: null };
    expect(isDeathNearRunEnd(record(1, '2026-09-18T02:35:44.000Z'), context)).toBe(false);
  });

  /**
   * The existing tests above use deaths ~7s and ~40min from
   * lastKnownAliveAt, both far from the edge, so changing the module's
   * private DEATH_NEAR_RUN_END_MS (90_000ms) to, say, 60_000 or 120_000 would
   * turn nothing red. These pin the comparison at the boundary itself:
   * `lastDeath >= lastAlive - DEATH_NEAR_RUN_END_MS`.
   */
  describe('isDeathNearRunEnd boundary (DEATH_NEAR_RUN_END_MS = 90_000ms)', () => {
    const lastAliveMs = Date.parse('2026-09-18T02:35:36.705Z');
    const context = {
      previousRunExit: 'abrupt',
      lastKnownAliveAt: new Date(lastAliveMs).toISOString(),
    };

    it('is true exactly at the 90s boundary (>=, not >)', () => {
      const atBoundary = record(1, new Date(lastAliveMs - 90_000).toISOString());
      expect(isDeathNearRunEnd(atBoundary, context)).toBe(true);
    });

    it('is true just inside the boundary (89999ms before lastKnownAliveAt)', () => {
      const justInside = record(1, new Date(lastAliveMs - 90_000 + 1).toISOString());
      expect(isDeathNearRunEnd(justInside, context)).toBe(true);
    });

    it('is false just outside the boundary (90001ms before lastKnownAliveAt)', () => {
      const justOutside = record(1, new Date(lastAliveMs - 90_000 - 1).toISOString());
      expect(isDeathNearRunEnd(justOutside, context)).toBe(false);
    });

    it('is true when the death postdates lastKnownAliveAt (a death AFTER the last checkpoint is also near-end)', () => {
      const afterAlive = record(1, new Date(lastAliveMs + 5_000).toISOString());
      expect(isDeathNearRunEnd(afterAlive, context)).toBe(true);
    });

    it('returns false when record.lastAt is unparseable, even with a valid lastKnownAliveAt', () => {
      expect(isDeathNearRunEnd(record(1, 'not-a-date'), context)).toBe(false);
    });

    it('returns false when context.lastKnownAliveAt is a non-empty but unparseable string', () => {
      // Distinct from the "tolerates a pre-upgrade run record with no
      // timestamp" test above, which covers a null lastKnownAliveAt (the
      // `!context.lastKnownAliveAt` guard). This exercises the LATER
      // `Number.isFinite(lastAlive)` guard instead, since a non-empty string
      // passes the truthiness check and only fails at Date.parse.
      const unparseableContext = { previousRunExit: 'abrupt', lastKnownAliveAt: 'also-not-a-date' };
      expect(isDeathNearRunEnd(record(1, '2026-09-18T02:35:44.000Z'), unparseableContext)).toBe(false);
    });
  });
});

describe('clearGpuEscalation compare-and-clear', () => {
  it('leaves a record that changed between the read and the clear', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now });
    const reported = readPendingGpuEscalation(escalationPath);

    // The crash loop is still running: another death lands before the report
    // path gets to its clear. An unconditional unlink would take the new
    // record with it, and nothing would ever rewrite it.
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now });

    clearGpuEscalation(escalationPath, { onlyIfLastAt: reported!.lastAt });

    expect(fs.existsSync(escalationPath)).toBe(true);
    expect(readPendingGpuEscalation(escalationPath)?.count).toBe(2);
  });

  it('clears when the record is still the one that was reported', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now });
    const reported = readPendingGpuEscalation(escalationPath);

    clearGpuEscalation(escalationPath, { onlyIfLastAt: reported!.lastAt });

    expect(fs.existsSync(escalationPath)).toBe(false);
  });
});
