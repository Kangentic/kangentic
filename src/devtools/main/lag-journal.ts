import * as path from 'node:path';
import { queueAppend, queueAppendWithRotation } from '../../main/diagnostics/async-file-queue';
import {
  DELAY_BACKSTOP_MS,
  timeSyncWork,
  type EventLoopLagReport,
  type LagRecord,
} from '../../main/diagnostics/event-loop-lag';
import type { StartupMark } from '../../main/startup-timer';
import type { RendererLongFrame } from '../renderer/lag-recorder';
import type { StallProfileSummary } from './stall-profiler';

/**
 * Keeps the lag report's records past a restart.
 *
 * The lag monitor's rings, the stall profiler's summaries and the startup
 * timeline all lived in memory, so the record of a launch lasted until the
 * next one. When the boot freeze was analysed on 2026-11-23, 18 of the last
 * 19 boots had nothing left to read.
 *
 * Every record is one JSON line, appended through the shared async queue as
 * it is recorded. A launch owns two files under `<configDir>/logs/lag/`,
 * named by its start time and pid:
 *
 * - `<launch>.launch.jsonl` holds the header, the startup timeline and every
 *   record of the first `LAUNCH_WINDOW_MS`. It is never rotated, so a run that
 *   lasts a week still has its launch.
 * - `<launch>.jsonl` holds everything after, capped by rotation (`.1` holds the
 *   previous slice), so a long run keeps its recent hours.
 *
 * `lag-journal-reader.ts` reads them back. The files are plain JSON lines, so
 * they can also be read with no app running.
 */

export const LAG_JOURNAL_DIRECTORY_NAME = 'lag';
export const LAUNCH_FILE_SUFFIX = '.launch.jsonl';
export const RUN_FILE_SUFFIX = '.jsonl';
/** How long after process start a record still goes to the launch file. */
export const LAUNCH_WINDOW_MS = 5 * 60_000;
/** At most twice this on disk per launch, the primary plus one rotated copy.
 *  A day of dogfooding wrote about 1 MB, so this holds a week of recent records. */
export const RUN_FILE_MAX_BYTES = 8 * 1024 * 1024;
const JOURNAL_LABEL = 'diag:lag-journal';

/** Whose thread a record is about. */
export type LagJournalProcess = 'main' | 'pty-host' | 'worker' | 'renderer';

/** A renderer long animation frame, as `lag-recorder.ts` reports it. */
export type JournalLongFrame = RendererLongFrame;

/** What the header says about the launch. No path and no name: only versions and switches. */
export interface LagJournalLaunchFacts {
  versions: { kangentic: string; electron: string; node: string; chrome: string };
  platform: string;
  arch: string;
  ephemeralPreview: boolean;
  /** Which Developer diagnostics were on when the journal attached. */
  diagnostics: Record<string, boolean>;
}

export type LagJournalLine =
  | ({ type: 'launch'; at: string; launchId: string; pid: number } & LagJournalLaunchFacts)
  | { type: 'startup'; at: string; marks: StartupMark[] }
  | { type: 'spike'; at: string; process: LagJournalProcess; lagMs: number }
  | { type: 'span'; at: string; process: LagJournalProcess; label: string; ms: number }
  | { type: 'window'; at: string; process: LagJournalProcess; maxMs: number; p99Ms: number; meanMs: number; note?: string }
  | { type: 'stall'; at: string; process: 'main'; summary: StallProfileSummary }
  | { type: 'long-frame'; at: string; process: 'renderer'; frame: JournalLongFrame }
  | { type: 'exit'; at: string; reason: string };

export function lagJournalDirectory(configDir: string): string {
  return path.join(configDir, 'logs', LAG_JOURNAL_DIRECTORY_NAME);
}

/**
 * A launch's id: its start time with `:` and `.` made file-safe, then its pid.
 * Sorts by time. `LAUNCH_ID_PATTERN` in `lag-journal-reader.ts` reads it back,
 * so the two change together.
 */
export function launchIdOf(startedAtMs: number, pid: number): string {
  return `${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}-${pid}`;
}

/** The process a relayed span's label names (`pty-host:pty:spawn`, `worker:db:checkpoint`). */
function processOfRelayedLabel(label: string): LagJournalProcess {
  if (label.startsWith('pty-host:')) return 'pty-host';
  if (label.startsWith('worker:')) return 'worker';
  return 'main';
}

function processOfSource(relayedFrom: string): LagJournalProcess {
  if (relayedFrom === 'pty-host' || relayedFrom === 'worker' || relayedFrom === 'renderer') return relayedFrom;
  return 'main';
}

export interface LagJournalOptions {
  directory: string;
  /** Epoch ms the process started. The launch window is measured from it. */
  launchStartedAtMs: number;
  pid: number;
  now?: () => number;
  launchWindowMs?: number;
  maxRunFileBytes?: number;
}

export class LagJournal {
  readonly launchId: string;
  private readonly pid: number;
  private readonly launchFilePath: string;
  private readonly runFilePath: string;
  private readonly launchStartedAtMs: number;
  private readonly launchWindowMs: number;
  private readonly maxRunFileBytes: number;
  private readonly now: () => number;
  /** Set while a line is being written, so a span about that write cannot write again. */
  private writing = false;
  /** The start of the newest renderer long frame written. Empty until the first. */
  private lastLongFrameAt = '';

  constructor(options: LagJournalOptions) {
    this.launchId = launchIdOf(options.launchStartedAtMs, options.pid);
    this.pid = options.pid;
    this.launchFilePath = path.join(options.directory, this.launchId + LAUNCH_FILE_SUFFIX);
    this.runFilePath = path.join(options.directory, this.launchId + RUN_FILE_SUFFIX);
    this.launchStartedAtMs = options.launchStartedAtMs;
    this.launchWindowMs = options.launchWindowMs ?? LAUNCH_WINDOW_MS;
    this.maxRunFileBytes = options.maxRunFileBytes ?? RUN_FILE_MAX_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  private inLaunchWindow(): boolean {
    return this.now() - this.launchStartedAtMs < this.launchWindowMs;
  }

  private write(line: LagJournalLine): void {
    if (this.writing) return;
    this.writing = true;
    try {
      timeSyncWork(JOURNAL_LABEL, () => {
        const text = JSON.stringify(line) + '\n';
        if (this.inLaunchWindow()) queueAppend(this.launchFilePath, text);
        else queueAppendWithRotation(this.runFilePath, text, this.maxRunFileBytes);
      });
    } finally {
      this.writing = false;
    }
  }

  /** The header, first in the launch file. */
  recordLaunch(facts: LagJournalLaunchFacts): void {
    this.write({
      type: 'launch',
      at: new Date(this.launchStartedAtMs).toISOString(),
      launchId: this.launchId,
      pid: this.pid,
      ...facts,
    });
  }

  /** What the monitor's rings already hold. The monitor starts before devtools installs. */
  backfill(report: EventLoopLagReport): void {
    for (const spike of report.recentSpikes) this.recordLag({ kind: 'spike', ...spike }, null);
    for (const span of report.recentSlowSyncWork) this.recordLag({ kind: 'span', relayed: false, ...span }, null);
    for (const span of report.recentRelayedSlowSyncWork) this.recordLag({ kind: 'span', relayed: true, ...span }, null);
    for (const delayWindow of report.recentDelayWindows) this.recordLag({ kind: 'window', ...delayWindow }, null);
  }

  /** The lag monitor's sink (`setLagRecordSink`). */
  recordLag(record: LagRecord, relayedFrom: string | null): void {
    if (record.kind === 'spike') {
      const sourceProcess = relayedFrom ? processOfSource(relayedFrom) : 'main';
      this.write({ type: 'spike', at: record.at, process: sourceProcess, lagMs: record.lagMs });
      return;
    }
    if (record.kind === 'span') {
      const sourceProcess = relayedFrom
        ? processOfSource(relayedFrom)
        : record.relayed ? processOfRelayedLabel(record.label) : 'main';
      this.write({ type: 'span', at: record.at, process: sourceProcess, label: record.label, ms: record.ms });
      return;
    }
    // A quiet window says nothing a reader cannot assume. Past the launch
    // window, keep only the ones that held a block or carry a note.
    if (!this.inLaunchWindow() && record.maxMs < DELAY_BACKSTOP_MS && !record.note) return;
    this.write({
      type: 'window',
      at: record.at,
      process: relayedFrom ? processOfSource(relayedFrom) : 'main',
      maxMs: record.maxMs,
      p99Ms: record.p99Ms,
      meanMs: record.meanMs,
      ...(record.note ? { note: record.note } : {}),
    });
  }

  recordStall(summary: StallProfileSummary): void {
    this.write({ type: 'stall', at: summary.detectedAt, process: 'main', summary });
  }

  recordStartup(marks: StartupMark[]): void {
    this.write({ type: 'startup', at: new Date(this.now()).toISOString(), marks });
  }

  recordRenderer(records: { spikes: Array<{ at: string; lagMs: number }>; longFrames: JournalLongFrame[] }): void {
    for (const spike of records.spikes) {
      this.write({ type: 'spike', at: spike.at, process: 'renderer', lagMs: spike.lagMs });
    }
    for (const frame of records.longFrames) {
      // The renderer's observer replays the frames the browser still buffers
      // when its module is hot-replaced in a dev session, so frames already
      // written here arrive a second time. A repeated frame reads as a repeat
      // of a real stall. Frames arrive in time order and no two start in the
      // same millisecond, so one at or before the newest written is a replay.
      if (frame.at <= this.lastLongFrameAt) continue;
      this.lastLongFrameAt = frame.at;
      this.write({ type: 'long-frame', at: frame.at, process: 'renderer', frame });
    }
  }

  /** Queued like every line. A dev build drains the queue synchronously on exit (`index.ts`). */
  recordExit(reason: string): void {
    this.write({ type: 'exit', at: new Date(this.now()).toISOString(), reason });
  }
}
