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
import { DEMO_SESSIONS, type DemoChangesMap, type DemoDiff, type DemoScrollbackMap } from './demo-dataset';

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
}

interface DemoManifest {
  captures: Array<{ file: string; sessionId: string; agent: string; project: string }>;
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
 * Drop the default-styled spaces that end each row of a serialized frame. A ConPTY frame pads
 * every row to the recorded width with plain spaces. On the recorded grid they paint nothing;
 * on a narrower grid (the frame a scaled display or a smaller surface falls back to) each padded
 * row wraps into a blank row, and the wraps push the frame's final cursor position off its row.
 * Styled padding is kept, since it paints (a diff row's background): the trim applies only when
 * the last SGR sequence before the trailing spaces is a reset, or there is none. A logical line
 * the serializer joined across wrapped rows is one row here, so only its end is touched.
 */
export function trimRowPadding(serialized: string): string {
  const SGR_RESET = /^\x1b\[0?m$/;
  return serialized.split('\r\n').map((row) => {
    const trailing = /( +)((?:\x1b\[[0-9;]*m)*)$/.exec(row);
    if (!trailing) return row;
    const prefix = row.slice(0, row.length - trailing[0].length);
    const sequences = prefix.match(/\x1b\[[0-9;]*m/g);
    const lastSequence = sequences ? sequences[sequences.length - 1] : null;
    if (lastSequence !== null && !SGR_RESET.test(lastSequence)) return row;
    return prefix + trailing[2];
  }).join('\r\n');
}


export function loadDemoRecordings(fixturesDir: string = DEMO_FIXTURES_DIR): DemoRecordingsIndex {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8')) as DemoManifest;
  const index: DemoRecordingsIndex = { sessions: {}, spawns: {}, terminals: {}, geometry: manifest.geometry ?? {} };
  const read = (file: string): DemoRecordingEntry | null => {
    const record = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf-8')) as DemoCaptureRecord;
    if (typeof record.serialized !== 'string' || record.serialized.length === 0) return null;
    return { file, serialized: trimRowPadding(record.serialized), stream: Array.isArray(record.stream) ? record.stream : [], peek: Array.isArray(record.peek) ? record.peek : [], cols: record.cols ?? 0, rows: record.rows ?? 0, stopReason: record.stopReason ?? '' };
  };
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    const manifestEntry = (JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8')) as DemoManifest).captures
      .find((entry) => entry.sessionId === sessionId);
    if (!manifestEntry || typeof record.serialized !== 'string') continue;
    index.sessions[sessionId] = { file: manifestEntry.file, serialized: trimRowPadding(record.serialized), stream: Array.isArray(record.stream) ? record.stream : [], peek: Array.isArray(record.peek) ? record.peek : [], cols: record.cols ?? 0, rows: record.rows ?? 0, stopReason: record.stopReason ?? '' };
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

function loadRecordings(fixturesDir: string): Array<{ sessionId: string; record: DemoCaptureRecord }> {
  const manifestPath = path.join(fixturesDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as DemoManifest;
  const recordings: Array<{ sessionId: string; record: DemoCaptureRecord }> = [];
  for (const entry of manifest.captures) {
    const recordingPath = path.join(fixturesDir, entry.file);
    if (!fs.existsSync(recordingPath)) continue;
    recordings.push({ sessionId: entry.sessionId, record: JSON.parse(fs.readFileSync(recordingPath, 'utf-8')) as DemoCaptureRecord });
  }
  return recordings;
}

export function loadDemoScrollback(fixturesDir: string = DEMO_FIXTURES_DIR): DemoScrollbackMap {
  const map: DemoScrollbackMap = {};
  for (const { sessionId, record } of loadRecordings(fixturesDir)) {
    if (typeof record.serialized === 'string' && record.serialized.length > 0) {
      map[sessionId] = trimRowPadding(record.serialized);
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
    if (!record.openFrame) continue;
    const session = DEMO_SESSIONS.find((candidate) => candidate.id === sessionId);
    const expectedTail = session?.liveTailMs ?? liveTailMs;
    if (record.openFrame.beforeEndMs !== expectedTail) {
      throw new Error(`${sessionId}: its recording's open frame was kept ${record.openFrame.beforeEndMs} ms before the end, but the live frame opens it ${expectedTail} ms before. Re-run scripts/capture-demo-sessions.mjs --only ${sessionId.replace(/^sess-[a-z]+-/, '')}`);
    }
    frames[sessionId] = { serialized: trimRowPadding(record.openFrame.serialized), peek: Array.isArray(record.openFrame.peek) ? record.openFrame.peek : [] };
  }
  return frames;
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
