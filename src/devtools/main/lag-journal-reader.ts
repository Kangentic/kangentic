import type { Stats } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { ROTATED_FILE_SUFFIX } from '../../main/diagnostics/async-file-queue';
import type { StartupMark } from '../../main/startup-timer';
import {
  LAUNCH_FILE_SUFFIX,
  RUN_FILE_SUFFIX,
  type JournalLongFrame,
  type LagJournalLine,
  type LagJournalProcess,
} from './lag-journal';
import type { StallProfileSummary } from './stall-profiler';

/**
 * Reads a launch's lag journal back (`lag-journal.ts`).
 *
 * A run's file can reach megabytes, and this runs on main's thread, so it
 * reads line by line off a stream and never parses a whole file in one task.
 * A reader of the stall record must not be a stall.
 */

/** Launches kept on disk; a prune removes the files of older ones. */
export const KEEP_LAUNCHES = 30;
/** The most of each kind of record one read returns. The newest are kept. */
const DEFAULT_MAX_RECORDS = 500;
const LAUNCH_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(\d+)$/;

export interface LagJournalLaunch {
  id: string;
  /** UTC ISO, read back out of the id. */
  startedAt: string;
  /** UTC ISO of the newest write to any of the launch's files. */
  lastWriteAt: string;
  bytes: number;
  /** True for the launch that is running now. */
  current: boolean;
}

export interface LagJournalReport {
  launchId: string;
  launch: Extract<LagJournalLine, { type: 'launch' }> | null;
  startup: StartupMark[] | null;
  /** Null when the run ended without a clean quit, or is still running. */
  exit: { at: string; reason: string } | null;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  /** Every record in range by type, including the ones a capped list dropped. */
  counts: Record<string, number>;
  /** Lines that were not whole JSON (a write cut short by a kill) or lacked their type's fields. */
  unreadableLines: number;
  /** True when a list below was capped; `counts` has the real totals. */
  truncated: boolean;
  stalls: StallProfileSummary[];
  spikes: Array<{ at: string; process: LagJournalProcess; lagMs: number }>;
  spans: Array<{ at: string; process: LagJournalProcess; label: string; ms: number }>;
  windows: Array<{ at: string; process: LagJournalProcess; maxMs: number; p99Ms: number; meanMs: number; note?: string }>;
  longFrames: JournalLongFrame[];
}

export interface ReadLaunchOptions {
  /** Keep only records at or after this UTC ISO time. */
  since?: string;
  /** Keep only records at or before this UTC ISO time. */
  until?: string;
  maxRecords?: number;
}

/** The launch id a journal file belongs to, or null for a file that is not one. */
function launchIdOfFile(name: string): string | null {
  for (const suffix of [LAUNCH_FILE_SUFFIX, RUN_FILE_SUFFIX + ROTATED_FILE_SUFFIX, RUN_FILE_SUFFIX]) {
    if (!name.endsWith(suffix)) continue;
    const id = name.slice(0, -suffix.length);
    return LAUNCH_ID_PATTERN.test(id) ? id : null;
  }
  return null;
}

function startedAtOf(launchId: string): string {
  const match = LAUNCH_ID_PATTERN.exec(launchId);
  if (!match) return '';
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

async function journalFileNames(directory: string): Promise<string[]> {
  try {
    return await fsPromises.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every launch with a journal on disk, newest first. */
export async function listLaunches(directory: string, currentLaunchId: string | null): Promise<LagJournalLaunch[]> {
  const launches = new Map<string, { bytes: number; lastWriteMs: number }>();
  for (const name of await journalFileNames(directory)) {
    const id = launchIdOfFile(name);
    if (!id) continue;
    let stats: Stats;
    try {
      stats = await fsPromises.stat(path.join(directory, name));
    } catch {
      // Removed between the listing and the stat: a prune or a rotation.
      continue;
    }
    const entry = launches.get(id) ?? { bytes: 0, lastWriteMs: 0 };
    entry.bytes += stats.size;
    entry.lastWriteMs = Math.max(entry.lastWriteMs, stats.mtimeMs);
    launches.set(id, entry);
  }
  return [...launches.entries()]
    .sort(([left], [right]) => (left < right ? 1 : -1))
    .map(([id, entry]) => ({
      id,
      startedAt: startedAtOf(id),
      lastWriteAt: new Date(entry.lastWriteMs).toISOString(),
      bytes: entry.bytes,
      current: id === currentLaunchId,
    }));
}

/**
 * Turn `current`, `previous` or an id into a launch id on disk. `previous` is
 * the newest launch that is not the running one. Null when there is none.
 */
export async function resolveLaunchId(
  directory: string,
  selector: string,
  currentLaunchId: string | null,
): Promise<string | null> {
  const launches = await listLaunches(directory, currentLaunchId);
  if (selector === 'current') return launches.find((launch) => launch.current)?.id ?? null;
  if (selector === 'previous') return launches.find((launch) => !launch.current)?.id ?? null;
  return launches.find((launch) => launch.id === selector)?.id ?? null;
}

function pushCapped<Entry>(list: Entry[], entry: Entry, maxRecords: number): boolean {
  list.push(entry);
  if (list.length <= maxRecords) return false;
  list.shift();
  return true;
}

/** Read one launch's journal: its launch file, then the rotated slice, then the live one. */
export async function readLaunch(
  directory: string,
  launchId: string,
  options: ReadLaunchOptions = {},
): Promise<LagJournalReport> {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const report: LagJournalReport = {
    launchId,
    launch: null,
    startup: null,
    exit: null,
    firstRecordAt: null,
    lastRecordAt: null,
    counts: {},
    unreadableLines: 0,
    truncated: false,
    stalls: [],
    spikes: [],
    spans: [],
    windows: [],
    longFrames: [],
  };
  const filePaths = [
    path.join(directory, launchId + LAUNCH_FILE_SUFFIX),
    path.join(directory, launchId + RUN_FILE_SUFFIX + ROTATED_FILE_SUFFIX),
    path.join(directory, launchId + RUN_FILE_SUFFIX),
  ];
  for (const filePath of filePaths) {
    await readJournalFile(filePath, (line) => {
      if (line === null) {
        report.unreadableLines += 1;
        return;
      }
      // The header and the timeline describe the whole launch, whatever range was asked for.
      if (line.type === 'launch') {
        report.launch = line;
        return;
      }
      if (line.type === 'startup') {
        report.startup = line.marks;
        return;
      }
      if (line.type === 'exit') {
        report.exit = { at: line.at, reason: line.reason };
        return;
      }
      if (options.since && line.at < options.since) return;
      if (options.until && line.at > options.until) return;
      report.counts[line.type] = (report.counts[line.type] ?? 0) + 1;
      if (report.firstRecordAt === null || line.at < report.firstRecordAt) report.firstRecordAt = line.at;
      if (report.lastRecordAt === null || line.at > report.lastRecordAt) report.lastRecordAt = line.at;
      let dropped = false;
      if (line.type === 'stall') dropped = pushCapped(report.stalls, line.summary, maxRecords);
      else if (line.type === 'spike') dropped = pushCapped(report.spikes, { at: line.at, process: line.process, lagMs: line.lagMs }, maxRecords);
      else if (line.type === 'span') dropped = pushCapped(report.spans, { at: line.at, process: line.process, label: line.label, ms: line.ms }, maxRecords);
      else if (line.type === 'long-frame') dropped = pushCapped(report.longFrames, line.frame, maxRecords);
      else if (line.type === 'window') {
        dropped = pushCapped(report.windows, {
          at: line.at,
          process: line.process,
          maxMs: line.maxMs,
          p99Ms: line.p99Ms,
          meanMs: line.meanMs,
          ...(line.note ? { note: line.note } : {}),
        }, maxRecords);
      }
      if (dropped) report.truncated = true;
    });
  }
  return report;
}

/**
 * Whether a parsed line has the fields its type is read for. The files
 * outlive the build that wrote them (30 launches are kept), and they are
 * plain text anyone can edit, so a line is checked before it is trusted. A
 * `stall` with no summary would otherwise put `undefined` in the report's
 * list, and a line with no `at` would become its first record's time. A type
 * this build does not know passes: it is counted, and listed nowhere.
 */
function isJournalLine(value: unknown): value is LagJournalLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  if (typeof line.type !== 'string' || typeof line.at !== 'string') return false;
  const isRecord = (field: unknown): boolean => typeof field === 'object' && field !== null;
  switch (line.type) {
    case 'launch': return isRecord(line.versions);
    case 'startup': return Array.isArray(line.marks);
    case 'spike': return typeof line.lagMs === 'number';
    case 'span': return typeof line.label === 'string' && typeof line.ms === 'number';
    case 'window': return typeof line.maxMs === 'number';
    case 'stall': return isRecord(line.summary);
    case 'long-frame': return isRecord(line.frame);
    case 'exit': return typeof line.reason === 'string';
    default: return true;
  }
}

/** Hand each line of one journal file to `onLine`, null for a line that is not whole JSON or lacks its type's fields. A missing file reads as empty. */
async function readJournalFile(filePath: string, onLine: (line: LagJournalLine | null) => void): Promise<void> {
  // Opened first, so a missing file is a plain rejection here. A read stream
  // on a missing path reports it as an 'error' event readline never forwards.
  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    for await (const text of handle.readLines({ encoding: 'utf-8' })) {
      if (text.length === 0) continue;
      let parsed: LagJournalLine | null = null;
      try {
        const value: unknown = JSON.parse(text);
        if (isJournalLine(value)) parsed = value;
      } catch {
        // A line a kill cut short. Counted by the caller, never fatal.
      }
      onLine(parsed);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Remove the files of every launch past the newest `keep`. Returns the ids of
 * the launches whose files are all gone.
 */
export async function pruneLaunches(directory: string, keep: number = KEEP_LAUNCHES): Promise<string[]> {
  const names = await journalFileNames(directory);
  const launchIds = [...new Set(names.map(launchIdOfFile).filter((id): id is string => id !== null))].sort();
  const pastKeep = launchIds.slice(0, Math.max(0, launchIds.length - keep));
  const pastKeepSet = new Set(pastKeep);
  const stillOnDisk = new Set<string>();
  for (const name of names) {
    const id = launchIdOfFile(name);
    if (id === null || !pastKeepSet.has(id)) continue;
    try {
      await fsPromises.rm(path.join(directory, name), { force: true });
    } catch {
      // Held open by a scanner or an editor (EBUSY or EPERM on Windows). One
      // file that will not go must not keep the rest, and the next launch's
      // prune tries it again.
      stillOnDisk.add(id);
    }
  }
  return pastKeep.filter((id) => !stillOnDisk.has(id));
}
