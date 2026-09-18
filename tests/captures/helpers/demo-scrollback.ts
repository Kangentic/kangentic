/**
 * Node-side loader for the recorded terminal sessions in tests/captures/fixtures/demo/.
 *
 * Reads manifest.json, and for every entry whose recording exists returns the SERIALIZED stream
 * (the headless-xterm re-serialization of the raw PTY bytes; the capture script keeps only that
 * plus the raw byte count), keyed by the session id the dataset replays it into. A missing
 * recording is simply absent here; buildDemoPreConfig refuses to seed a session without one.
 *
 * Used by the capture rig (marketing-fixture.ts) and by demo/vite.config.mts at build time. Kept
 * apart from demo-dataset.ts, which must stay free of Node imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SESSIONS, type DemoCellWidthTable, type DemoChangesMap, type DemoDiff, type DemoHistory, type DemoScrollbackMap } from './demo-dataset';
import type { TranscriptEntry } from '../../../src/shared/types';
import { wcwidthV11 } from '../../../src/shared/xterm-unicode11';

interface DemoCaptureRecord {
  agent: string;
  serialized: string;
  rawBytes: number;
  /** The last lines of the terminal as it displays them, computed at record time. */
  peek?: string[];
  /** The working tree after the session, in the mock's git.diffFiles shape. */
  changes?: DemoDiff;
  /** The same bytes as a timed stream: what the live frame replays as it happened. */
  stream?: Array<{ t: number; data: string }>;
  /** The PTY size the recording was made at; its bytes only replay into that grid. */
  cols?: number;
  rows?: number;
  /** Why the capture stopped: idle or exited when the agent finished on its own, stop-after or stop-when when cut. */
  stopReason?: string;
  /** The frame beforeEndMs before the end, with its displayed last lines: the moment the live frame opens a working session at. */
  openFrame?: { beforeEndMs: number; serialized: string; peek: string[] } | null;
  /** How the displayed last lines change over the recording, on the stream's own clock. */
  peekTimeline?: Array<{ t: number; lines: string[] }>;
  /** The whole screen every quarter second, for a terminal the bytes cannot address. */
  frameTimeline?: Array<{ t: number; frame: string }>;
  /** What the agent said, and when, on the stream's own clock. See loadDemoMessageTrails. */
  messageTrail?: DemoMessageTrailEntry[];
  /** How long the capture ran, which is the clock messageTrail offsets sit on. */
  durationMs?: number;
}

/**
 * One line of a recording's agent message trail, on the recording's own clock.
 *
 * `uuid`, `ts` and `text` are exactly `AssistantMessageTrailEntry`, which is what main pushes and
 * what the card renders; `t` is the replay offset this line lands at.
 */
export interface DemoMessageTrailEntry {
  t: number;
  uuid: string;
  ts: number;
  text: string;
}

interface DemoManifest {
  captures: Array<{
    file: string;
    sessionId: string;
    agent: string;
    project: string;
    /**
     * The same session recorded at the tiled width (manifest geometry `taskWindowTiled`, or
     * `commandTerminalTiled` for a Command Terminal session), the way a Command Terminal boot has
     * a `-tiled` sibling. The seed switches a session between the two by the width its window
     * mounts at; the session's clock, trail, diff and peeks stay the single recording's.
     */
    tiled?: string;
    /** Whether the agent's transcript was derived beside the recording (transcripts/<file>), for the conversation viewer. */
    transcript?: boolean;
  }>;
  /** The PTY size of each surface a recording plays on (see the manifest's comment). */
  geometry?: Record<string, { cols: number; rows: number }>;
  /** How long before its recording's end the live frame opens a session shown as working. */
  liveTailMs?: number;
}

/** One recording as the web build indexes it: which file, and what it stands in for. */
export interface DemoRecordingEntry {
  file: string;
  serialized: string;
  stream: Array<{ t: number; data: string }>;
  /** The last displayed lines at the end of the recording: the Monitor peek once a replay gets there. */
  peek: string[];
  /** The grid the recording was made at; a terminal of any other size gets the frame, not the bytes. */
  cols: number;
  rows: number;
  /** How the capture ended; a session whose recording ran to the agent's own end flips to needs-you when the replay gets there. */
  stopReason: string;
  /**
   * The screen every quarter second. A terminal whose grid the recording's bytes cannot address
   * plays these instead: a frame reflows, so the same recording is live at any size and on any
   * machine. Rides in the recording file, never the seed, since it is the size of the stream.
   */
  frameTimeline: Array<{ t: number; frame: string }>;
  /** The same session at the tiled width, when the manifest names one (a session entry only). */
  tiled?: DemoRecordingEntry;
}

/** A session's tiled recording as the seed paints it without a fetch: its final frame, and the opening frame of a working session. */
export interface DemoTiledFrames {
  serialized: string;
  openFrame: { serialized: string; peek: string[] } | null;
}

/**
 * Every recording on disk, by what the frame replays it for: a session the boards show, the
 * agent starting on a task in a permission mode (a drag into an auto-spawn column), or the
 * project's default agent starting with no prompt (a new Command Terminal). The spawn and
 * terminal recordings are named by the driver (spawn-<taskId>-<mode>.json,
 * terminal-<projectId>.json), so the listing is the index.
 */
export interface DemoRecordingsIndex {
  sessions: Record<string, DemoRecordingEntry>;
  spawns: Record<string, DemoRecordingEntry>;
  terminals: Record<string, DemoRecordingEntry>;
  /** The surface sizes the recordings were made at, so the frame can tell which boot fits a window. */
  geometry: Record<string, { cols: number; rows: number }>;
}

export const DEMO_FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'demo');

/**
 * The column width of every code point that is not one cell wide, as ranges, from the exact
 * table the app's xterm instances run (src/shared/xterm-unicode11.ts). The seed's frame applier
 * clips a row at the mounted grid's edge by counting cells, and a hand-rolled parser that counted
 * code units would drift a column per emoji against the terminal it writes into
 * (.claude/rules/xterm-unicode11-parity.md). Derived at build time rather than committed, so it
 * cannot go stale against an xterm upgrade; ~1.1 million lookups, well under a second.
 */
export function buildCellWidthTable(): DemoCellWidthTable {
  const wide: number[] = [];
  const zero: number[] = [];
  let runWidth = 1;
  let runStart = 0;
  const close = (end: number): void => {
    if (runWidth === 2) wide.push(runStart, end);
    else if (runWidth === 0) zero.push(runStart, end);
  };
  for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
    const width = wcwidthV11(codepoint);
    if (width === runWidth) continue;
    close(codepoint - 1);
    runWidth = width;
    runStart = codepoint;
  }
  close(0x10ffff);
  return { wide, zero };
}

export function loadDemoRecordings(fixturesDir: string = DEMO_FIXTURES_DIR): DemoRecordingsIndex {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8')) as DemoManifest;
  const index: DemoRecordingsIndex = { sessions: {}, spawns: {}, terminals: {}, geometry: manifest.geometry ?? {} };
  // Built in one place so a new DemoRecordingEntry field cannot reach the spawn and terminal
  // entries below while the session entries keep the old shape. The sessions loop takes the
  // record loadRecordings already parsed; only spawns and terminals, which the manifest does not
  // list, still read from disk.
  const entryOf = (file: string, record: DemoCaptureRecord): DemoRecordingEntry | null => {
    if (typeof record.serialized !== 'string' || record.serialized.length === 0) return null;
    return { file, serialized: record.serialized, stream: Array.isArray(record.stream) ? record.stream : [], peek: Array.isArray(record.peek) ? record.peek : [], cols: record.cols ?? 0, rows: record.rows ?? 0, stopReason: record.stopReason ?? '', frameTimeline: Array.isArray(record.frameTimeline) ? record.frameTimeline : [] };
  };
  const read = (file: string): DemoRecordingEntry | null =>
    entryOf(file, JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf-8')) as DemoCaptureRecord);
  for (const { sessionId, record, tiled } of loadRecordings(fixturesDir)) {
    const manifestEntry = manifest.captures.find((entry) => entry.sessionId === sessionId);
    if (!manifestEntry) continue;
    const entry = entryOf(manifestEntry.file, record);
    if (!entry) continue;
    if (tiled) {
      const tiledEntry = entryOf(tiled.file, tiled.record);
      if (tiledEntry) entry.tiled = tiledEntry;
    }
    index.sessions[sessionId] = entry;
  }
  for (const file of fs.readdirSync(fixturesDir)) {
    const spawn = /^spawn-(.+)-(plan|acceptEdits|default|dontAsk|bypassPermissions|auto)\.json$/.exec(file);
    const terminal = /^terminal-(.+)\.json$/.exec(file);
    if (spawn) {
      const entry = read(file);
      if (entry) index.spawns[`${spawn[1]}:${spawn[2]}`] = entry;
    } else if (terminal) {
      const entry = read(file);
      if (entry) index.terminals[terminal[1]] = entry;
    }
  }
  return index;
}

/** The app version from package.json, stamped into the sample install so both consumers show it. */
export function readAppVersion(): string {
  const packageJsonPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version === '') {
    throw new Error(`${packageJsonPath} has no usable "version"`);
  }
  return packageJson.version;
}

/**
 * The parsed recordings, keyed by resolved fixtures directory. Every accessor below walks the
 * whole set, and one `npm run build:demo` calls seven of them (loadDemoRecordings for the asset
 * plan, then six more for the seed), so an uncached read parsed the 39MB fixture directory seven
 * times per build, on every PR through the always-on demo CI job. The fixtures are static files
 * that nothing rewrites mid-process: the capture rig and the timeline backfill both use plain fs
 * calls rather than this module, so one parse per directory per process is enough. Consumers only
 * read the records (buildDemoPreConfig stringifies them), so sharing one parse between accessors
 * is safe.
 */
interface LoadedRecording {
  sessionId: string;
  record: DemoCaptureRecord;
  /** The manifest's `tiled` sibling, when it names one and the file is on disk. */
  tiled?: { file: string; record: DemoCaptureRecord };
}

const recordingsCache = new Map<string, LoadedRecording[]>();

function loadRecordings(fixturesDir: string): LoadedRecording[] {
  const cacheKey = path.resolve(fixturesDir);
  const cached = recordingsCache.get(cacheKey);
  if (cached) return cached;
  const manifestPath = path.join(fixturesDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as DemoManifest;
  const recordings: LoadedRecording[] = [];
  for (const entry of manifest.captures) {
    const recordingPath = path.join(fixturesDir, entry.file);
    if (!fs.existsSync(recordingPath)) continue;
    const loaded: LoadedRecording = { sessionId: entry.sessionId, record: JSON.parse(fs.readFileSync(recordingPath, 'utf-8')) as DemoCaptureRecord };
    if (entry.tiled) {
      const tiledPath = path.join(fixturesDir, entry.tiled);
      // A named sibling that is not on disk is a matrix run that has not happened yet, and a
      // session that silently fell back to its single recording would look like a hold bug in
      // every tiled scene; refuse the way a missing single recording is refused.
      if (!fs.existsSync(tiledPath)) {
        throw new Error(`${entry.sessionId}: the manifest names a tiled recording ${entry.tiled} that is not on disk. Run "node scripts/capture-demo-sessions.mjs --only ${entry.tiled.replace(/\.json$/, '')}"`);
      }
      loaded.tiled = { file: entry.tiled, record: JSON.parse(fs.readFileSync(tiledPath, 'utf-8')) as DemoCaptureRecord };
    }
    recordings.push(loaded);
  }
  recordingsCache.set(cacheKey, recordings);
  return recordings;
}

export function loadDemoScrollback(fixturesDir: string = DEMO_FIXTURES_DIR): DemoScrollbackMap {
  const map: DemoScrollbackMap = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    if (typeof record.serialized === 'string' && record.serialized.length > 0) {
      map[sessionId] = record.serialized;
    }
  }
  return map;
}

/**
 * The last lines of each recording as the terminal displays them, keyed by session id. The
 * capture script reads them from its rendered headless xterm at record time (cursor-positioned
 * words keep their spacing, which a byte-level strip of the escape sequences loses), so a
 * Monitor card's output peek is the terminal's own text.
 */
export function loadDemoPeeks(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, string[]> {
  const peeks: Record<string, string[]> = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    if (Array.isArray(record.peek) && record.peek.length > 0) peeks[sessionId] = record.peek;
  }
  return peeks;
}

/**
 * When each session's recording ends and why, keyed by session id. The live frame runs a working
 * session's clock from page open (its recording's end is that far ahead, mounted or not), and a
 * still reads a recording that ran to the agent's own end as finished.
 */
export function loadDemoEnds(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, { durationMs: number; stopReason: string }> {
  const ends: Record<string, { durationMs: number; stopReason: string }> = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    const stream = Array.isArray(record.stream) ? record.stream : [];
    const last = stream[stream.length - 1];
    ends[sessionId] = { durationMs: last ? last.t : 0, stopReason: record.stopReason ?? '' };
  }
  return ends;
}

/** How long before its recording's end the live frame opens a session shown as working, from the manifest. */
export function readLiveTailMs(fixturesDir: string = DEMO_FIXTURES_DIR): number {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8')) as DemoManifest;
  if (typeof manifest.liveTailMs !== 'number' || manifest.liveTailMs <= 0) {
    throw new Error(`${path.join(fixturesDir, 'manifest.json')} has no usable "liveTailMs"`);
  }
  return manifest.liveTailMs;
}

/**
 * The frame at the moment the live frame opens each working session at, with the Monitor peek
 * of that moment, keyed by session id: what a still and the marketing captures paint for such a
 * session, so every view starts from the moment the live replay does. The capture script keeps
 * it at the tail the session was recorded for; one kept at another tail (the manifest's or the
 * session's changed since) would paint a different moment, so it fails the build and the rig.
 */
export function loadDemoOpenFrames(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, { serialized: string; peek: string[] }> {
  const liveTailMs = readLiveTailMs(fixturesDir);
  const frames: Record<string, { serialized: string; peek: string[] }> = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    const openFrame = checkedOpenFrame(sessionId, record, liveTailMs, sessionId.replace(/^sess-[a-z]+-/, ''));
    if (openFrame) frames[sessionId] = openFrame;
  }
  return frames;
}

/** A recording's open frame, refused when it was kept at a tail the live frame no longer opens at. */
function checkedOpenFrame(sessionId: string, record: DemoCaptureRecord, liveTailMs: number, reRecord: string): { serialized: string; peek: string[] } | null {
  if (!record.openFrame) return null;
  const session = DEMO_SESSIONS.find((candidate) => candidate.id === sessionId);
  const expectedTail = session?.liveTailMs ?? liveTailMs;
  if (record.openFrame.beforeEndMs !== expectedTail) {
    throw new Error(`${sessionId}: its recording's open frame was kept ${record.openFrame.beforeEndMs} ms before the end, but the live frame opens it ${expectedTail} ms before. Re-run scripts/capture-demo-sessions.mjs --only ${reRecord}`);
  }
  return { serialized: record.openFrame.serialized, peek: Array.isArray(record.openFrame.peek) ? record.openFrame.peek : [] };
}

/**
 * What a still paints for a session whose window mounted at the tiled width, keyed by session id:
 * the tiled recording's final frame, and for a working session the frame at the moment the live
 * frame opens it. Inline because a still fetches no recording; only the sessions the manifest
 * gives a `tiled` sibling are here, and the seed falls back to the single recording's frames for
 * every other one.
 *
 * The opening moment is the SINGLE recording's: a session's clock runs on the single recording
 * (its duration and tail), and a terminal on the tiled layout plays the tiled bytes from that
 * same offset. So the frame is the tiled recording's own frame timeline at
 * `single duration - tail`, derived here rather than kept by the capture, whose open frame would
 * be a tail before the VARIANT's end, a different moment whenever the second run is a different
 * length (it always is). A variant shorter than that offset has already ended when the live
 * frame opens it, so its still is its final frame, as the terminal would show.
 */
export function loadDemoTiledFrames(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, DemoTiledFrames> {
  const liveTailMs = readLiveTailMs(fixturesDir);
  const frames: Record<string, DemoTiledFrames> = {};
  for (const { sessionId, record, tiled } of loadRecordings(fixturesDir)) {
    if (!tiled) continue;
    // Refused for the reason loadRecordings refuses a missing sibling: a named tiled recording
    // with no frame would silently paint the single recording's frame in every tiled still.
    if (typeof tiled.record.serialized !== 'string' || tiled.record.serialized.length === 0) {
      throw new Error(`${sessionId}: its tiled recording ${tiled.file} carries no serialized frame. Re-run "node scripts/capture-demo-sessions.mjs --only ${tiled.file.replace(/\.json$/, '')}"`);
    }
    const session = DEMO_SESSIONS.find((candidate) => candidate.id === sessionId);
    let openFrame: DemoTiledFrames['openFrame'] = null;
    if (session?.activity === 'thinking') {
      const stream = Array.isArray(record.stream) ? record.stream : [];
      const singleDurationMs = stream.length > 0 ? stream[stream.length - 1].t : 0;
      const opensAtMs = Math.max(0, singleDurationMs - (session.liveTailMs ?? liveTailMs));
      const timeline = Array.isArray(tiled.record.frameTimeline) ? tiled.record.frameTimeline : [];
      if (timeline.length === 0) {
        throw new Error(`${tiled.file} carries no frame timeline, so the moment the live frame opens ${sessionId} at cannot be painted; re-run "node scripts/backfill-demo-timelines.mjs"`);
      }
      let current = timeline[0].frame;
      for (const step of timeline) {
        if (step.t > opensAtMs) break;
        current = step.frame;
      }
      const tiledDurationMs = timeline[timeline.length - 1].t;
      openFrame = { serialized: opensAtMs >= tiledDurationMs ? tiled.record.serialized : current, peek: [] };
    }
    frames[sessionId] = { serialized: tiled.record.serialized, openFrame };
  }
  return frames;
}

/**
 * The agent's transcript behind a session, keyed by session id, for the conversation viewer:
 * main's own parser output (tests/captures/helpers/message-trail-extract.ts derives it from the
 * transcript the agent wrote during its capture), sanitized and committed under transcripts/.
 * Only the sessions the manifest marks `transcript: true` carry one; a marked session with no
 * file is a backfill that has not run, and fails here rather than opening an empty viewer.
 */
export function loadDemoTranscripts(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, TranscriptEntry[]> {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8')) as DemoManifest;
  const transcripts: Record<string, TranscriptEntry[]> = {};
  for (const entry of manifest.captures) {
    if (!entry.transcript) continue;
    const transcriptPath = path.join(fixturesDir, 'transcripts', entry.file);
    if (!fs.existsSync(transcriptPath)) {
      throw new Error(`${entry.sessionId}: the manifest marks its transcript but ${transcriptPath} is not on disk. Run "node scripts/backfill-demo-transcripts.mjs"`);
    }
    const parsed = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      throw new Error(`${transcriptPath} carries no entries; re-run "node scripts/backfill-demo-transcripts.mjs --force"`);
    }
    transcripts[entry.sessionId] = parsed.entries as TranscriptEntry[];
  }
  return transcripts;
}

/**
 * How each session's Monitor peek changes over its recording, keyed by session id, on the
 * recording's own clock. A Monitor card shows the last lines its terminal is displaying, and on
 * the desktop those change as the agent works; the live frame schedules these against the same
 * clock it replays the bytes on, so the card changes when the terminal does.
 *
 * Whole-recording, deliberately: no window constant to keep in step with liveTailMs, and nothing
 * that goes stale when a session's tail changes. It costs 2.5 KB gzipped across the sample
 * install's working sessions (demo/README.md).
 */
export function loadDemoPeekTimelines(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, Array<{ t: number; lines: string[] }>> {
  const timelines: Record<string, Array<{ t: number; lines: string[] }>> = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    if (!Array.isArray(record.peekTimeline) || record.peekTimeline.length === 0) continue;
    const session = DEMO_SESSIONS.find((candidate) => candidate.id === sessionId);
    if (session?.activity !== 'thinking') continue;
    timelines[sessionId] = record.peekTimeline;
  }
  return timelines;
}

/**
 * What each session's agent said over its recording, keyed by session id, on the recording's own
 * clock. The board card's default Card Preview prints the agent's newest message, so this is what
 * a card shows where the description used to be, and it changes as the replay runs.
 *
 * Whole-recording, for the same reason loadDemoPeekTimelines is: no window constant to keep in step
 * with liveTailMs, and nothing that goes stale when a session's tail changes. It is small, 95 lines
 * and 24.5 KB of raw JSON across every recording on disk, of which only the sessions ride the eager
 * seed. Unlike the peek timeline this is NOT limited to working sessions: a resting session still
 * shows the trail its agent finished on, seeded before the first paint.
 *
 * A recording with an empty trail is absent here, and that is a real state rather than a gap. A
 * Command Terminal's session is transient, Cursor and Copilot have no transcript parser at all, and
 * one Gemini capture put all its prose in thinking blocks, which assistantMessagePreviews excludes.
 * Each of those shows its description on the desktop too. tests/unit/demo-message-trail-seeded.test.ts
 * holds the enumerated list so a NEW empty one fails instead of passing quietly.
 */
export function loadDemoMessageTrails(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, DemoMessageTrailEntry[]> {
  const trails: Record<string, DemoMessageTrailEntry[]> = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    if (!Array.isArray(record.messageTrail) || record.messageTrail.length === 0) continue;
    trails[sessionId] = record.messageTrail;
  }
  return trails;
}

/** The working-tree diff each recorded session left behind, keyed by session id. */
export function loadDemoChanges(fixturesDir: string = DEMO_FIXTURES_DIR): DemoChangesMap {
  const map: DemoChangesMap = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    if (record.changes && Array.isArray(record.changes.files) && record.changes.files.length > 0) {
      map[sessionId] = record.changes;
    }
  }
  return map;
}

/**
 * The git history behind a scaffolded project (scripts/capture-demo-history.mjs): its commits
 * newest first in git:commitGraph's shape, the diff each commit introduces, and the blame of
 * every file a recorded session modified, keyed by session id and then path. Keyed by project
 * NAME, the key the manifest's `repos` uses. A project without a history file (the two upstream
 * clones) has none, and its History pane shows the empty state a shallow clone would.
 */
export function loadDemoHistory(fixturesDir: string = DEMO_FIXTURES_DIR): Record<string, DemoHistory> {
  const historyDir = path.join(fixturesDir, 'history');
  if (!fs.existsSync(historyDir)) return {};
  const histories: Record<string, DemoHistory> = {};
  for (const name of fs.readdirSync(historyDir)) {
    if (!name.endsWith('.json')) continue;
    const history = JSON.parse(fs.readFileSync(path.join(historyDir, name), 'utf-8')) as DemoHistory;
    if (!Array.isArray(history.commits) || history.commits.length === 0) {
      throw new Error(`[demo] ${name} carries no commits; re-run node scripts/capture-demo-history.mjs`);
    }
    histories[history.project] = history;
  }
  return histories;
}
