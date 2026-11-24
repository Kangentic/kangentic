import type { BrowserWindow } from 'electron';
import { getEventLoopLagReport, setLagRecordSink } from '../../main/diagnostics/event-loop-lag';
import { setStartupTimelineSink } from '../../main/startup-timer';
import type { takeRendererLagRecords } from '../renderer/lag-recorder';
import { isDebuggerAttached, runtimeEvaluate } from './cdp';
import { LagJournal, lagJournalDirectory, type LagJournalLaunchFacts } from './lag-journal';
import { pruneLaunches } from './lag-journal-reader';
import { setStallSummaryListener } from './stall-profiler';

/**
 * Starts the lag journal for this launch and feeds it from every source: the
 * lag monitor's rings (and the pty host's records relayed through them), the
 * stall profiler's summaries, the startup timeline, and the renderer.
 *
 * The renderer has no channel to main for this, and adding one would mean an
 * IPC endpoint that exists only in a dev build. So main asks for the
 * renderer's new records over the debugger the inspection bridge already
 * attached, every `RENDERER_POLL_MS`. With the bridge off, or DevTools open
 * (which takes the debugger), the renderer's records stay in its rings only.
 */

const RENDERER_POLL_MS = 30_000;
/** Old launches are removed this long after start, well clear of the boot. */
const PRUNE_DELAY_MS = 60_000;
const TAKE_RENDERER_RECORDS = `(() => {
  const take = window.__kangenticTakeLagRecords;
  return typeof take === 'function' ? take() : null;
})()`;

export interface LagJournalHostOptions {
  configDir: string;
  facts: LagJournalLaunchFacts;
  getMainWindow: () => BrowserWindow | null;
}

/** What `window.__kangenticTakeLagRecords` hands over (`install.tsx` sets it to this function). */
type RendererLagRecords = ReturnType<typeof takeRendererLagRecords>;

let journal: LagJournal | null = null;
let journalDirectory: string | null = null;
let rendererPollTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/** Where this launch's journal is, for the reader. Null before it starts. */
export function getLagJournalLocation(): { directory: string; launchId: string } | null {
  if (!journal || !journalDirectory) return null;
  return { directory: journalDirectory, launchId: journal.launchId };
}

function isRendererLagRecords(value: unknown): value is RendererLagRecords {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { spikes?: unknown; longFrames?: unknown };
  return Array.isArray(candidate.spikes) && Array.isArray(candidate.longFrames);
}

async function pollRenderer(target: LagJournal, getMainWindow: () => BrowserWindow | null): Promise<void> {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || !isDebuggerAttached(mainWindow)) return;
  const result = await runtimeEvaluate(mainWindow, TAKE_RENDERER_RECORDS);
  if (result.error || !isRendererLagRecords(result.value)) return;
  target.recordRenderer(result.value);
}

/** Start journaling this launch. Idempotent. */
export function startLagJournal(options: LagJournalHostOptions): void {
  if (journal) return;
  const directory = lagJournalDirectory(options.configDir);
  const started = new LagJournal({
    directory,
    // When this process started, on the wall clock.
    launchStartedAtMs: Math.round(performance.timeOrigin),
    pid: process.pid,
  });
  journal = started;
  journalDirectory = directory;
  started.recordLaunch(options.facts);
  // The monitor has been running since the top of index.ts. Take what its
  // rings hold, then every record from here on.
  started.backfill(getEventLoopLagReport());
  setLagRecordSink((record, relayedFrom) => started.recordLag(record, relayedFrom));
  setStallSummaryListener((summary) => started.recordStall(summary));
  setStartupTimelineSink((marks) => started.recordStartup(marks));

  rendererPollTimer = setInterval(() => {
    pollRenderer(started, options.getMainWindow).catch((error: unknown) => {
      console.warn('[lag-journal] could not read the renderer records:', error);
    });
  }, RENDERER_POLL_MS);
  rendererPollTimer.unref();

  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    pruneLaunches(directory).catch((error: unknown) => {
      console.warn('[lag-journal] could not prune old launches:', error);
    });
  }, PRUNE_DELAY_MS);
  pruneTimer.unref();
}

/** Write the exit line and stop feeding the journal. Synchronous, for the quit path. */
export function stopLagJournal(reason: string): void {
  if (rendererPollTimer) {
    clearInterval(rendererPollTimer);
    rendererPollTimer = null;
  }
  if (pruneTimer) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
  if (!journal) return;
  setLagRecordSink(null);
  setStallSummaryListener(null);
  setStartupTimelineSink(null);
  journal.recordExit(reason);
  journal = null;
}
