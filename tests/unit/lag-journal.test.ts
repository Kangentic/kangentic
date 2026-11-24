/**
 * The lag journal (src/devtools/main/lag-journal.ts) and its reader.
 *
 * The lag report lived in memory, so a restart erased the record of the run it
 * ended. These pin what the files must keep for the next launch to read: the
 * header and the launch window in a file rotation never touches, every later
 * record in a capped one, and a reader that gets all of it back, survives a
 * line a kill cut short, and tells one launch from the next.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LagJournal,
  LAUNCH_FILE_SUFFIX,
  RUN_FILE_SUFFIX,
  lagJournalDirectory,
  launchIdOf,
  type LagJournalLaunchFacts,
} from '../../src/devtools/main/lag-journal';
import { listLaunches, pruneLaunches, readLaunch, resolveLaunchId } from '../../src/devtools/main/lag-journal-reader';
import { flushAllForTest, resetForTest, ROTATED_FILE_SUFFIX } from '../../src/main/diagnostics/async-file-queue';
import type { EventLoopLagReport } from '../../src/main/diagnostics/event-loop-lag';
import type { StallProfileSummary } from '../../src/devtools/main/stall-profiler';

const LAUNCH_STARTED_AT_MS = Date.UTC(2026, 10, 24, 4, 0, 0);
const PID = 4242;
const LAUNCH_WINDOW_MS = 5 * 60_000;

const FACTS: LagJournalLaunchFacts = {
  versions: { kangentic: '0.62.0', electron: '45.4.1', node: '24.22.3', chrome: '156.0.0.0' },
  platform: 'win32',
  arch: 'x64',
  ephemeralPreview: false,
  diagnostics: { stallProfiler: true, recordIpcTraffic: false },
};

const STALL: StallProfileSummary = {
  detectedAt: '2026-11-24T04:00:09.000Z',
  maxDelayMs: 143,
  slowSpans: [{ label: 'db:transaction', ms: 64 }],
  stalledChecks: 1,
  longestBusyRunMs: 142.3,
  topFrames: [{ functionName: 'parseStrictJsonObject', location: 'build/index.js:1200', selfMs: 96.9 }],
  heaviestStack: ['dispatch build/index.js:10', 'parseStrictJsonObject build/index.js:1200'],
  profileMs: 21_000,
  saveMs: 0.4,
  summaryMs: 2.1,
  file: null,
};

function isoAfterLaunch(offsetMs: number): string {
  return new Date(LAUNCH_STARTED_AT_MS + offsetMs).toISOString();
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('lag journal', () => {
  let directory: string;
  /** Milliseconds since the launch started, as the journal's clock reads it. */
  let sinceLaunchMs: number;

  function createJournal(startedAtMs = LAUNCH_STARTED_AT_MS, pid = PID): LagJournal {
    return new LagJournal({
      directory,
      launchStartedAtMs: startedAtMs,
      pid,
      now: () => startedAtMs + sinceLaunchMs,
    });
  }

  function launchFile(launchId: string): string {
    return path.join(directory, launchId + LAUNCH_FILE_SUFFIX);
  }

  function runFile(launchId: string): string {
    return path.join(directory, launchId + RUN_FILE_SUFFIX);
  }

  beforeEach(() => {
    resetForTest();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-lag-journal-'));
    sinceLaunchMs = 1_000;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('lives under the config dir logs folder, one id per launch that sorts by start time', () => {
    expect(lagJournalDirectory(directory)).toBe(path.join(directory, 'logs', 'lag'));
    const earlier = launchIdOf(LAUNCH_STARTED_AT_MS, 9_999);
    const later = launchIdOf(LAUNCH_STARTED_AT_MS + 60_000, 1);
    expect(earlier).toBe('2026-11-24T04-00-00-000Z-9999');
    expect(earlier < later).toBe(true);
  });

  it('writes the header first, then what the rings already held, to the launch file', async () => {
    const journal = createJournal();
    const rings: Pick<EventLoopLagReport, 'recentSpikes' | 'recentSlowSyncWork' | 'recentRelayedSlowSyncWork' | 'recentDelayWindows'> = {
      recentSpikes: [{ at: isoAfterLaunch(300), lagMs: 210 }],
      recentSlowSyncWork: [{ at: isoAfterLaunch(310), label: 'spawn:cmd:FontResolver.computeAvailableFonts', ms: 205 }],
      recentRelayedSlowSyncWork: [{ at: isoAfterLaunch(400), label: 'pty-host:pty:spawn', ms: 23 }],
      recentDelayWindows: [{ at: isoAfterLaunch(900), maxMs: 17, p99Ms: 16.2, meanMs: 13.9 }],
    };

    journal.recordLaunch(FACTS);
    journal.backfill(rings as EventLoopLagReport);
    await flushAllForTest();

    const lines = readLines(launchFile(journal.launchId));
    expect(lines.map((line) => line.type)).toEqual(['launch', 'spike', 'span', 'span', 'window']);
    expect(lines[0]).toMatchObject({
      type: 'launch',
      at: '2026-11-24T04:00:00.000Z',
      launchId: journal.launchId,
      pid: PID,
      versions: FACTS.versions,
      diagnostics: FACTS.diagnostics,
    });
    // A relayed span names its process from its label.
    expect(lines[2]).toMatchObject({ process: 'main', label: 'spawn:cmd:FontResolver.computeAvailableFonts' });
    expect(lines[3]).toMatchObject({ process: 'pty-host', label: 'pty-host:pty:spawn' });
    expect(fs.existsSync(runFile(journal.launchId))).toBe(false);
  });

  it('keeps the launch window in its own file and sends later records to the run file', async () => {
    const journal = createJournal();
    journal.recordLaunch(FACTS);
    journal.recordLag({ kind: 'spike', at: isoAfterLaunch(2_000), lagMs: 282 }, null);

    sinceLaunchMs = LAUNCH_WINDOW_MS + 1;
    journal.recordLag({ kind: 'spike', at: isoAfterLaunch(LAUNCH_WINDOW_MS + 1), lagMs: 500 }, null);
    journal.recordStall({ ...STALL, detectedAt: isoAfterLaunch(LAUNCH_WINDOW_MS + 2) });
    await flushAllForTest();

    expect(readLines(launchFile(journal.launchId)).map((line) => line.type)).toEqual(['launch', 'spike']);
    expect(readLines(runFile(journal.launchId)).map((line) => line.type)).toEqual(['spike', 'stall']);
  });

  it('drops a quiet delay window once the launch window is over, and keeps one that held a block or a note', async () => {
    const journal = createJournal();
    const quiet = { kind: 'window' as const, at: isoAfterLaunch(10_000), maxMs: 17, p99Ms: 16.2, meanMs: 13.9 };
    journal.recordLag(quiet, null);

    sinceLaunchMs = LAUNCH_WINDOW_MS + 1;
    journal.recordLag(quiet, null);
    journal.recordLag({ ...quiet, maxMs: 81.3 }, null);
    journal.recordLag({ ...quiet, note: 'stall-profiler' }, null);
    await flushAllForTest();

    expect(readLines(launchFile(journal.launchId))).toHaveLength(1);
    expect(readLines(runFile(journal.launchId)).map((line) => [line.maxMs, line.note])).toEqual([
      [81.3, undefined],
      [17, 'stall-profiler'],
    ]);
  });

  it('reads a whole launch back: header, timeline, every kind of record, and the exit', async () => {
    const journal = createJournal();
    journal.recordLaunch(FACTS);
    journal.recordStartup([{ label: 'process_start', elapsedMs: 0 }, { label: 'window_ready', elapsedMs: 3_850 }]);
    journal.recordLag({ kind: 'spike', at: isoAfterLaunch(3_900), lagMs: 3_782 }, null);
    journal.recordLag({ kind: 'spike', at: isoAfterLaunch(4_000), lagMs: 95 }, 'pty-host');
    journal.recordLag({ kind: 'span', relayed: false, at: isoAfterLaunch(3_901), label: 'db:transaction', ms: 64 }, null);
    journal.recordLag({ kind: 'window', at: isoAfterLaunch(10_000), maxMs: 69.5, p99Ms: 16.3, meanMs: 7.2, note: 'stall-profiler' }, null);
    journal.recordStall(STALL);
    journal.recordRenderer({
      spikes: [{ at: isoAfterLaunch(5_000), lagMs: 120 }],
      longFrames: [{ at: isoAfterLaunch(5_001), durationMs: 180, blockingMs: 130, renderMs: 12, styleLayoutMs: 9, scripts: [] }],
    });
    journal.recordExit('quit');
    await flushAllForTest();

    const report = await readLaunch(directory, journal.launchId);

    expect(report.launch).toMatchObject({ launchId: journal.launchId, platform: 'win32' });
    expect(report.startup).toEqual([{ label: 'process_start', elapsedMs: 0 }, { label: 'window_ready', elapsedMs: 3_850 }]);
    expect(report.exit).toMatchObject({ reason: 'quit' });
    expect(report.stalls).toEqual([STALL]);
    expect(report.spikes).toEqual([
      { at: isoAfterLaunch(3_900), process: 'main', lagMs: 3_782 },
      { at: isoAfterLaunch(4_000), process: 'pty-host', lagMs: 95 },
      { at: isoAfterLaunch(5_000), process: 'renderer', lagMs: 120 },
    ]);
    expect(report.spans).toEqual([{ at: isoAfterLaunch(3_901), process: 'main', label: 'db:transaction', ms: 64 }]);
    expect(report.windows).toEqual([
      { at: isoAfterLaunch(10_000), process: 'main', maxMs: 69.5, p99Ms: 16.3, meanMs: 7.2, note: 'stall-profiler' },
    ]);
    expect(report.longFrames).toHaveLength(1);
    expect(report.counts).toEqual({ spike: 3, span: 1, window: 1, stall: 1, 'long-frame': 1 });
    expect(report.firstRecordAt).toBe(isoAfterLaunch(3_900));
    expect(report.unreadableLines).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it('reads the launch file, then the rotated slice, then the live one', async () => {
    const journal = createJournal();
    journal.recordLaunch(FACTS);
    await flushAllForTest();
    const spikeLine = (offsetMs: number, lagMs: number): string =>
      JSON.stringify({ type: 'spike', at: isoAfterLaunch(offsetMs), process: 'main', lagMs }) + '\n';
    fs.writeFileSync(runFile(journal.launchId) + ROTATED_FILE_SUFFIX, spikeLine(400_000, 100));
    fs.writeFileSync(runFile(journal.launchId), spikeLine(900_000, 200));

    const report = await readLaunch(directory, journal.launchId);

    expect(report.spikes.map((spike) => spike.lagMs)).toEqual([100, 200]);
  });

  it('survives a line a kill cut short, and counts it', async () => {
    const journal = createJournal();
    journal.recordLaunch(FACTS);
    journal.recordLag({ kind: 'spike', at: isoAfterLaunch(2_000), lagMs: 90 }, null);
    await flushAllForTest();
    fs.appendFileSync(launchFile(journal.launchId), '{"type":"spike","at":"2026-11-24T04:00:0');

    const report = await readLaunch(directory, journal.launchId);

    expect(report.spikes).toHaveLength(1);
    expect(report.unreadableLines).toBe(1);
    expect(report.exit).toBeNull();
  });

  it('writes a renderer long frame once, though the renderer hands it over again, and still writes a newer one', async () => {
    // The renderer's observer replays the browser's buffered frames when its
    // module is hot-replaced, so main receives frames it already wrote.
    const longFrame = (offsetMs: number) => ({
      at: isoAfterLaunch(offsetMs), durationMs: 180, blockingMs: 130, renderMs: 12, styleLayoutMs: 9, scripts: [],
    });
    const journal = createJournal();

    journal.recordRenderer({ spikes: [], longFrames: [longFrame(5_000)] });
    journal.recordRenderer({ spikes: [], longFrames: [longFrame(5_000)] });
    journal.recordRenderer({ spikes: [], longFrames: [longFrame(4_000)] });
    journal.recordRenderer({ spikes: [], longFrames: [longFrame(6_000)] });
    await flushAllForTest();

    const frames = readLines(launchFile(journal.launchId)).filter((line) => line.type === 'long-frame');
    expect(frames.map((line) => line.at)).toEqual([isoAfterLaunch(5_000), isoAfterLaunch(6_000)]);
  });

  it('counts a line with valid JSON but missing fields as unreadable, lists it nowhere, and still counts a type it does not know', async () => {
    const journal = createJournal();
    journal.recordLaunch(FACTS);
    journal.recordLag({ kind: 'spike', at: isoAfterLaunch(2_000), lagMs: 90 }, null);
    await flushAllForTest();
    // Each malformed line carries an `at` earlier than the real record, so one
    // that was counted would show as the first record.
    const earlierAt = isoAfterLaunch(500);
    fs.appendFileSync(launchFile(journal.launchId), [
      JSON.stringify({ type: 'spike', process: 'main', lagMs: 80 }),
      JSON.stringify({ type: 'stall', at: earlierAt, process: 'main' }),
      JSON.stringify({ type: 'long-frame', at: earlierAt, process: 'renderer' }),
      JSON.stringify({ type: 'future-kind', at: isoAfterLaunch(3_000) }),
    ].join('\n') + '\n');

    const report = await readLaunch(directory, journal.launchId);

    expect(report.unreadableLines).toBe(3);
    expect(report.stalls).toEqual([]);
    expect(report.longFrames).toEqual([]);
    expect(report.spikes).toEqual([{ at: isoAfterLaunch(2_000), process: 'main', lagMs: 90 }]);
    expect(report.firstRecordAt).toBe(isoAfterLaunch(2_000));
    expect(report.counts).toEqual({ spike: 1, 'future-kind': 1 });
  });

  it('narrows to a time range and caps each list at its newest, with the real totals in counts', async () => {
    const journal = createJournal();
    journal.recordLaunch(FACTS);
    for (let second = 1; second <= 6; second++) {
      journal.recordLag({ kind: 'spike', at: isoAfterLaunch(second * 1_000), lagMs: 80 + second }, null);
    }
    await flushAllForTest();

    const ranged = await readLaunch(directory, journal.launchId, { since: isoAfterLaunch(2_000), until: isoAfterLaunch(5_000) });
    expect(ranged.spikes.map((spike) => spike.lagMs)).toEqual([82, 83, 84, 85]);
    // The header describes the launch, whatever range was asked for.
    expect(ranged.launch).not.toBeNull();

    const capped = await readLaunch(directory, journal.launchId, { maxRecords: 2 });
    expect(capped.spikes.map((spike) => spike.lagMs)).toEqual([85, 86]);
    expect(capped.counts.spike).toBe(6);
    expect(capped.truncated).toBe(true);
  });

  it('tells the running launch from the one before it', async () => {
    const previous = createJournal(LAUNCH_STARTED_AT_MS - 3_600_000, 1_111);
    previous.recordLaunch(FACTS);
    previous.recordLag({ kind: 'spike', at: isoAfterLaunch(-3_500_000), lagMs: 444 }, null);
    const current = createJournal();
    current.recordLaunch(FACTS);
    await flushAllForTest();

    const launches = await listLaunches(directory, current.launchId);
    expect(launches.map((launch) => [launch.id, launch.current])).toEqual([
      [current.launchId, true],
      [previous.launchId, false],
    ]);
    expect(launches[1].startedAt).toBe('2026-11-24T03:00:00.000Z');
    expect(launches[1].bytes).toBeGreaterThan(0);

    expect(await resolveLaunchId(directory, 'previous', current.launchId)).toBe(previous.launchId);
    expect(await resolveLaunchId(directory, 'current', current.launchId)).toBe(current.launchId);
    expect(await resolveLaunchId(directory, previous.launchId, current.launchId)).toBe(previous.launchId);
    expect(await resolveLaunchId(directory, '2020-01-01T00-00-00-000Z-1', current.launchId)).toBeNull();

    const report = await readLaunch(directory, previous.launchId);
    expect(report.spikes.map((spike) => spike.lagMs)).toEqual([444]);
  });

  it('prunes the oldest launches with every file they own, and nothing else in the folder', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const id = launchIdOf(LAUNCH_STARTED_AT_MS + index * 60_000, PID + index);
      ids.push(id);
      fs.writeFileSync(launchFile(id), '');
      fs.writeFileSync(runFile(id), '');
    }
    fs.writeFileSync(runFile(ids[0]) + ROTATED_FILE_SUFFIX, '');
    fs.writeFileSync(path.join(directory, 'terminal-trace.jsonl'), '');

    const removed = await pruneLaunches(directory, 2);

    expect(removed).toEqual([ids[0], ids[1]]);
    expect(fs.readdirSync(directory).sort()).toEqual([
      ids[2] + RUN_FILE_SUFFIX,
      ids[2] + LAUNCH_FILE_SUFFIX,
      ids[3] + RUN_FILE_SUFFIX,
      ids[3] + LAUNCH_FILE_SUFFIX,
      'terminal-trace.jsonl',
    ].sort());
  });

  it('reads a folder that does not exist yet as no launches', async () => {
    const missing = path.join(directory, 'never-created');
    expect(await listLaunches(missing, null)).toEqual([]);
    expect(await pruneLaunches(missing)).toEqual([]);
  });
});
