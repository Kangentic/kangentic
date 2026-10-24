/**
 * `POST /scroll-latency`: time a fullscreen agent's scroll from the wheel to
 * the painted frame, split into the agent's share and Kangentic's.
 *
 * Arms the pty host's round-trip probe and the renderer's, optionally drives
 * trusted wheel ticks (CDP `Input.dispatchMouseEvent`, the event a real wheel
 * produces) or keystrokes into one session's terminal, waits out the window,
 * reads both rings, and joins them (`scroll-latency-report.ts`). Without a
 * driver it records whatever a person does in the window (`input: 'key'` to
 * time typing instead of scrolling). Also reports, for the same window, each
 * session's output totals, CPU time per app process, the host's stalls and
 * what its labelled work cost, the renderer's long frames, and on request a
 * CPU profile of the host's thread.
 *
 * Body: `{ sessionId?, durationMs?, input?, drive?: { kind?, ticks?, intervalMs?,
 * direction?, deltaY?, settleMs? }, profileHost? }`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import type { EventLoopLagReport, SyncWorkStats } from '../../main/diagnostics/event-loop-lag';
import type { HostRoundTripReading } from '../../main/diagnostics/pty-round-trip-probe';
import type { SessionManager } from '../../main/pty/session-manager';
import type { RendererRoundTripReading } from '../../renderer/utils/scroll-latency-probe';
import type { RoundTripInput } from '../../shared/round-trip-input';
import { dispatchKeypress, dispatchMouseEvent, runtimeEvaluate, typeText } from './cdp';
import { buildScrollLatencyReport } from './scroll-latency-report';
import { summarizeBusyProfile } from './stall-profiler';

interface JsonResponder {
  json: (statusCode: number, body: unknown) => void;
  error: (statusCode: number, kind: string, detail: string) => void;
}

type WheelDirection = 'up' | 'down' | 'up-then-down';

/** `wheel` scrolls; `keys` types `x` then Backspace, `ticks` times each, so the
 *  agent's input line ends where it began. A key drive never sends Enter. */
type DriveKind = 'wheel' | 'keys';

interface DriveOptions {
  kind: DriveKind;
  ticks: number;
  intervalMs: number;
  direction: WheelDirection;
  deltaY: number;
  settleMs: number;
}

const DEFAULT_RECORD_MS = 15_000;
const MAX_WINDOW_MS = 110_000;
/** Each probe stays armed this much past the window, so the tail is kept. */
const ARM_MARGIN_MS = 500;

function numberOr(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

/** Dispatches per tick: two for a key pair or a wheel's up and back, one for a one-way wheel. */
function dispatchesPerTick(kind: DriveKind, direction: WheelDirection): number {
  return kind === 'keys' || direction === 'up-then-down' ? 2 : 1;
}

function parseDrive(value: unknown): DriveOptions | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  const kind: DriveKind = input.kind === 'keys' ? 'keys' : 'wheel';
  const direction: WheelDirection = input.direction === 'up' || input.direction === 'down' ? input.direction : 'up-then-down';
  const intervalMs = numberOr(input.intervalMs, 50, 5, 5000);
  const settleMs = numberOr(input.settleMs, 1500, 0, 30_000);
  // The window is capped at MAX_WINDOW_MS, and both probes disarm with it, so
  // a tick past that would land in a terminal nobody is timing. As few as 8
  // fit: two dispatches 5 s apart with a 30 s settle.
  const ticksThatFit = Math.floor((MAX_WINDOW_MS - settleMs) / (intervalMs * dispatchesPerTick(kind, direction)));
  return {
    kind,
    ticks: Math.min(Math.round(numberOr(input.ticks, 20, 1, 500)), ticksThatFit),
    intervalMs,
    direction,
    // One notch of a Windows wheel in Chromium is 100 CSS pixels.
    deltaY: numberOr(input.deltaY, 100, 1, 2000),
    settleMs,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** What each labelled span cost between two reads of one report. */
function syncWorkDelta(before: EventLoopLagReport | null, after: EventLoopLagReport | null): Record<string, { count: number; totalMs: number }> {
  if (!after) return {};
  const delta: Record<string, { count: number; totalMs: number }> = {};
  for (const [label, stats] of Object.entries(after.syncWorkByLabel)) {
    const previous: SyncWorkStats | undefined = before?.syncWorkByLabel[label];
    const count = stats.count - (previous?.count ?? 0);
    if (count <= 0) continue;
    delta[label] = { count, totalMs: Math.round(stats.totalMs - (previous?.totalMs ?? 0)) };
  }
  return delta;
}

function withinWindow<Entry extends { at: string }>(entries: readonly Entry[], startMs: number, endMs: number): Entry[] {
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return at >= startMs && at <= endMs;
  });
}

/** Cumulative CPU seconds per app process, keyed `<type>:<name or pid>`. */
function cpuSecondsByProcess(): Map<string, number> {
  const seconds = new Map<string, number>();
  for (const metric of app.getAppMetrics()) {
    const cumulative = metric.cpu.cumulativeCPUUsage;
    if (cumulative === undefined) continue;
    seconds.set(`${metric.type}:${metric.name ?? metric.serviceName ?? metric.pid}`, cumulative);
  }
  return seconds;
}

/** CPU time each process spent in the window, in ms and as a share of one core. */
function cpuInWindow(before: Map<string, number>, after: Map<string, number>, windowMs: number): Array<{ process: string; cpuMs: number; percentOfCore: number }> {
  const rows: Array<{ process: string; cpuMs: number; percentOfCore: number }> = [];
  for (const [process, afterSeconds] of after) {
    const beforeSeconds = before.get(process);
    if (beforeSeconds === undefined) continue;
    const cpuMs = Math.round((afterSeconds - beforeSeconds) * 1000);
    rows.push({ process, cpuMs, percentOfCore: Math.round((cpuMs / windowMs) * 1000) / 10 });
  }
  return rows.sort((left, right) => right.cpuMs - left.cpuMs);
}

async function evaluate<Value>(window: BrowserWindow, expression: string): Promise<Value | null> {
  const result = await runtimeEvaluate<Value>(window, expression);
  if (result.error) throw new Error(result.error);
  return result.value;
}

export async function respondScrollLatency(
  body: unknown,
  window: BrowserWindow,
  sessionManager: SessionManager,
  profileDirectory: string,
  responder: JsonResponder,
): Promise<void> {
  const input = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : undefined;
  const drive = parseDrive(input.drive);
  const profileHost = input.profileHost === true;

  // Which round trips the report times; a record-only window says it in `input`.
  const roundTripInput: RoundTripInput = drive?.kind === 'keys' || input.input === 'key' ? 'key' : 'mouse';

  let rect: { x: number; y: number; width: number; height: number } | null = null;
  if (drive) {
    if (!sessionId) return responder.error(400, 'missing-session', 'A drive needs `sessionId`, the terminal to drive.');
    rect = await evaluate(window, `window.__kangenticScrollLatency?.terminalRect(${JSON.stringify(sessionId)}) ?? null`);
    if (!rect) return responder.error(404, 'terminal-not-mounted', `No visible terminal is mounted for session ${sessionId}.`);
    if (drive.kind === 'keys') {
      // Programmatic focus, not a click: a click would send the agent a mouse report.
      const focused = await evaluate<boolean>(window, `window.__kangenticScrollLatency?.focusTerminal(${JSON.stringify(sessionId)}) ?? false`);
      if (!focused) return responder.error(404, 'terminal-not-focusable', `Could not focus the terminal of session ${sessionId}.`);
    }
  }

  const tickCount = drive ? drive.ticks * dispatchesPerTick(drive.kind, drive.direction) : 0;
  const windowMs = Math.min(
    MAX_WINDOW_MS,
    drive ? tickCount * drive.intervalMs + drive.settleMs : numberOr(input.durationMs, DEFAULT_RECORD_MS, 500, MAX_WINDOW_MS),
  );

  const readHostLag = (): Promise<EventLoopLagReport | null> =>
    sessionManager.requestPtyHostDiagnostic('devLagReport', {}).catch(() => null);
  const hostLagBefore = await readHostLag();
  await sessionManager.requestPtyHostDiagnostic('devArmRoundTripProbe', { durationMs: windowMs + ARM_MARGIN_MS });
  await evaluate(window, `window.__kangenticScrollLatency?.arm(${windowMs + ARM_MARGIN_MS}) ?? null`);
  const profilePromise = profileHost
    ? sessionManager.requestPtyHostDiagnostic('devCpuProfile', { durationMs: windowMs }, windowMs + 15_000)
    : null;
  // Handled here as well as awaited below: a return or throw before that
  // await must not leave the request to reject unhandled in main.
  profilePromise?.catch(() => undefined);
  const cpuBefore = cpuSecondsByProcess();
  const windowStartedAt = Date.now();

  if (drive?.kind === 'keys') {
    for (let index = 0; index < tickCount; index++) {
      const dueAt = windowStartedAt + index * drive.intervalMs;
      const waitMs = dueAt - Date.now();
      if (waitMs > 0) await wait(waitMs);
      if (index % 2 === 0) await typeText(window, 'x');
      else await dispatchKeypress(window, 'Backspace');
    }
    await wait(Math.max(0, windowStartedAt + windowMs - Date.now()));
  } else if (drive && rect) {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const directions: number[] = drive.direction === 'up'
      ? Array.from({ length: drive.ticks }, () => -1)
      : drive.direction === 'down'
        ? Array.from({ length: drive.ticks }, () => 1)
        : [...Array.from({ length: drive.ticks }, () => -1), ...Array.from({ length: drive.ticks }, () => 1)];
    // Ticks are scheduled against the start, so a slow dispatch does not stretch the cadence.
    for (let index = 0; index < directions.length; index++) {
      const dueAt = windowStartedAt + index * drive.intervalMs;
      const waitMs = dueAt - Date.now();
      if (waitMs > 0) await wait(waitMs);
      await dispatchMouseEvent(window, { type: 'mouseWheel', x: centerX, y: centerY, deltaY: directions[index] * drive.deltaY });
    }
    await wait(Math.max(0, windowStartedAt + windowMs - Date.now()));
  } else {
    await wait(windowMs);
  }
  // Let the last answers land inside the armed margin.
  await wait(ARM_MARGIN_MS);
  const windowEndedAt = Date.now();
  const cpuAfter = cpuSecondsByProcess();

  const rendererReading = await evaluate<RendererRoundTripReading>(window, 'window.__kangenticScrollLatency?.read() ?? null');
  if (!rendererReading) return responder.error(503, 'probe-not-installed', 'The renderer probe is not installed (no devtools bootstrap).');
  let hostReading: HostRoundTripReading | null = null;
  let hostError: string | null = null;
  try {
    hostReading = await sessionManager.requestPtyHostDiagnostic('devReadRoundTripProbe', {});
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
  }
  const hostLagAfter = await readHostLag();
  const rendererLag = await evaluate<{ recentLongFrames?: Array<{ at: string; durationMs: number; blockingMs: number; scripts: unknown[] }> }>(
    window,
    `(() => { const report = window.__kangenticLagReport; return typeof report === 'function' ? report() : null; })()`,
  ).catch(() => null);

  let hostProfile: unknown = null;
  if (profilePromise) {
    try {
      const profile = await profilePromise;
      let file: string | null = null;
      try {
        await fs.promises.mkdir(profileDirectory, { recursive: true });
        file = path.join(profileDirectory, `pty-host-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
        await fs.promises.writeFile(file, JSON.stringify(profile), 'utf-8');
      } catch {
        file = null;
      }
      hostProfile = { file, ...summarizeBusyProfile(profile) };
    } catch (error) {
      hostProfile = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const report = buildScrollLatencyReport(rendererReading, hostReading, sessionId, roundTripInput);
  const longFrames = withinWindow(rendererLag?.recentLongFrames ?? [], windowStartedAt, windowEndedAt);
  responder.json(200, {
    window: {
      startedAt: new Date(windowStartedAt).toISOString(),
      endedAt: new Date(windowEndedAt).toISOString(),
      durationMs: windowEndedAt - windowStartedAt,
      drive: drive ? { ...drive, dispatchedTicks: tickCount } : null,
    },
    ...report,
    cpu: cpuInWindow(cpuBefore, cpuAfter, windowEndedAt - windowStartedAt),
    hostError,
    hostStalls: hostLagAfter
      ? {
        spikes: withinWindow(hostLagAfter.recentSpikes, windowStartedAt, windowEndedAt),
        slowSyncWork: withinWindow(hostLagAfter.recentSlowSyncWork, windowStartedAt, windowEndedAt),
        delayWindows: withinWindow(hostLagAfter.recentDelayWindows, windowStartedAt, windowEndedAt + 10_000),
        syncWorkInWindow: syncWorkDelta(hostLagBefore, hostLagAfter),
      }
      : null,
    rendererLongFrames: {
      count: longFrames.length,
      maxMs: longFrames.reduce((max, frame) => Math.max(max, frame.durationMs), 0),
      heaviest: [...longFrames].sort((left, right) => right.durationMs - left.durationMs).slice(0, 5),
    },
    hostProfile,
  });
}
