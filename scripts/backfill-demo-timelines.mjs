/**
 * Bring a recording on disk up to what the capture script writes today, from its own stream.
 *
 * Everything here is derived from the timed stream, so it needs no agent, no API credit, and no
 * re-record: replaying the stream through a headless xterm produces exactly what the capture
 * script would have produced at record time. Same modules, same result. Three things are
 * rewritten:
 *
 * - the peek and frame timelines (recordings made before the capture script computed them);
 * - the final frame (`serialized`) and the open frame (`openFrame.serialized`, at the cut the
 *   recording was made with), re-serialized as physical rows with an absolute cursor
 *   (scripts/lib/demo-frame-serializer.js), which every consumer of a frame now expects. A
 *   working session's TILED recording gets an open frame too, which the capture script cannot
 *   write (it is cut where the single recording's clock opens the session, and the single is
 *   another run): the still a tiled window paints (loadDemoTiledFrames), with every row above
 *   the screen, so a pane taller than the recording shows them rather than blank rows;
 * - the stored peeks, which come from the same chrome filter as the peek timeline.
 *
 * Usage:
 *   node scripts/backfill-demo-timelines.mjs            write every recording that is out of date
 *   node scripts/backfill-demo-timelines.mjs --force    rewrite every recording
 *   node scripts/backfill-demo-timelines.mjs --check    report only, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { computeReplayTimelines, createReplayTerminal, peekFromTerminal } = require('./lib/demo-replay-timelines.js');
const { serializePhysicalRows, CURSOR_SUFFIX } = require('./lib/demo-frame-serializer.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
// Node strips the types itself; the dataset module has no Node imports by design.
const dataset = await import(pathToFileURL(path.join(repoRoot, 'tests', 'captures', 'helpers', 'demo-dataset.ts')).href);
const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');

/** The final frame of a stream, and the frame `beforeEndMs` before its end, both as physical rows. */
async function serializeFrames(record) {
  const stream = Array.isArray(record.stream) ? record.stream : [];
  const lastWindow = stream[stream.length - 1];
  const beforeEndMs = record.openFrame && typeof record.openFrame.beforeEndMs === 'number' ? record.openFrame.beforeEndMs : 0;
  // The open frame's cut is the capture script's own: every window up to the moment this long
  // before the end (scripts/capture-agent-scrollback.js, "open frame").
  const openAt = lastWindow && beforeEndMs > 0 && lastWindow.t > beforeEndMs ? lastWindow.t - beforeEndMs : null;
  const terminal = createReplayTerminal(record.cols, record.rows);
  let openFrame = null;
  for (const window of stream) {
    if (openAt !== null && window.t > openAt && openFrame === null) {
      openFrame = { beforeEndMs, serialized: serializePhysicalRows(terminal, { scrollback: 5000 }), peek: peekFromTerminal(terminal) };
    }
    await new Promise((resolve) => terminal.write(window.data, resolve));
  }
  if (openAt !== null && openFrame === null) {
    openFrame = { beforeEndMs, serialized: serializePhysicalRows(terminal, { scrollback: 5000 }), peek: peekFromTerminal(terminal) };
  }
  const serialized = serializePhysicalRows(terminal, { scrollback: 5000 });
  const peek = peekFromTerminal(terminal);
  terminal.dispose();
  return { serialized, peek, openFrame };
}

/**
 * A recording is current when it has both timelines and its frames are physical rows, and a
 * tiled recording a still opens mid-run carries its open frame at that moment.
 */
function isCurrent(record, expectedOpenBeforeEndMs) {
  return Array.isArray(record.peekTimeline)
    && Array.isArray(record.frameTimeline)
    && typeof record.serialized === 'string' && CURSOR_SUFFIX.test(record.serialized)
    && (record.openFrame == null || CURSOR_SUFFIX.test(String(record.openFrame.serialized)))
    && (expectedOpenBeforeEndMs === undefined || (record.openFrame != null && record.openFrame.beforeEndMs === expectedOpenBeforeEndMs));
}

function streamEndMs(record) {
  const stream = Array.isArray(record.stream) ? record.stream : [];
  return stream.length > 0 ? stream[stream.length - 1].t : 0;
}

/**
 * For each tiled recording a still paints mid-run, how long before its own end its open frame
 * is cut: the single recording's clock opens a working session its live tail before the single's
 * end, and the tiled run starts where the single's clock does (loadDemoTiledFrames). A tiled run
 * that has ended by then paints its final frame, and needs none.
 */
function tiledOpenFrameCuts() {
  const cuts = new Map();
  for (const entry of manifest.captures) {
    if (!entry.tiled) continue;
    const session = dataset.DEMO_SESSIONS.find((candidate) => candidate.id === entry.sessionId);
    if (!session || session.activity !== 'thinking') continue;
    const singlePath = path.join(fixturesDir, entry.file);
    const tiledPath = path.join(fixturesDir, entry.tiled);
    if (!fs.existsSync(singlePath) || !fs.existsSync(tiledPath)) continue;
    const opensAtMs = Math.max(0, streamEndMs(JSON.parse(fs.readFileSync(singlePath, 'utf-8'))) - (session.liveTailMs ?? manifest.liveTailMs));
    const tiledEndMs = streamEndMs(JSON.parse(fs.readFileSync(tiledPath, 'utf-8')));
    if (opensAtMs < tiledEndMs) cuts.set(entry.tiled, tiledEndMs - opensAtMs);
  }
  return cuts;
}

/**
 * Keep the keys where the capture script writes them, between the open frame and the working
 * tree, so a backfilled recording and a freshly captured one are the same file shape.
 */
function rebuild(record, frames, timelines) {
  const rebuilt = {};
  for (const key of Object.keys(record)) {
    if (key === 'peekTimeline' || key === 'frameTimeline') continue;
    if (key === 'serialized') rebuilt.serialized = frames.serialized;
    // The stored peek is re-derived too: it comes from the same filter as the timeline, so a
    // change to what counts as chrome has to reach both or the row jumps at the replay's end.
    else if (key === 'peek') rebuilt.peek = timelines.finalPeek && timelines.finalPeek.length > 0 ? timelines.finalPeek : frames.peek;
    else if (key === 'openFrame') rebuilt.openFrame = record.openFrame == null ? record.openFrame : frames.openFrame;
    else rebuilt[key] = record[key];
    if (key === 'openFrame') {
      rebuilt.peekTimeline = timelines.peekTimeline;
      rebuilt.frameTimeline = timelines.frameTimeline;
    }
  }
  if (rebuilt.peekTimeline === undefined) rebuilt.peekTimeline = timelines.peekTimeline;
  if (rebuilt.frameTimeline === undefined) rebuilt.frameTimeline = timelines.frameTimeline;
  return rebuilt;
}

const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));
const files = new Set(manifest.captures.flatMap((entry) => (entry.tiled ? [entry.file, entry.tiled] : [entry.file])));
for (const file of fs.readdirSync(fixturesDir)) {
  if (/^(spawn|terminal)-.+\.json$/.test(file)) files.add(file);
}
const openFrameCuts = tiledOpenFrameCuts();

let written = 0;
let skipped = 0;
for (const file of [...files].sort()) {
  const recordPath = path.join(fixturesDir, file);
  if (!fs.existsSync(recordPath)) {
    console.error(`[backfill] ${file}: not on disk, skipped`);
    continue;
  }
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  const openFrameCut = openFrameCuts.get(file);
  if (isCurrent(record, openFrameCut) && !force) {
    skipped += 1;
    continue;
  }
  // The cut serializeFrames makes the open frame at; rebuild writes it where the key sits.
  if (openFrameCut !== undefined) record.openFrame = { beforeEndMs: openFrameCut };
  if (typeof record.cols !== 'number' || typeof record.rows !== 'number') {
    throw new Error(`[backfill] ${file} carries no cols/rows, so its stream cannot be replayed at the recorded grid`);
  }
  const timelines = await computeReplayTimelines({ stream: record.stream, cols: record.cols, rows: record.rows });
  const frames = await serializeFrames(record);
  const stream = Array.isArray(record.stream) ? record.stream : [];
  const duration = stream.length > 0 ? stream[stream.length - 1].t : 0;
  console.error(
    `[backfill] ${file}: ${timelines.peekTimeline.length} peek change(s), `
    + `${timelines.frameTimeline.length} frame(s) across ${(duration / 1000).toFixed(0)}s, `
    + `final frame ${frames.serialized.length} bytes${frames.openFrame ? `, open frame ${frames.openFrame.serialized.length} bytes` : ''}`,
  );
  if (checkOnly) continue;
  // Byte for byte the shape capture-agent-scrollback.js writes, trailing newline included (there
  // is none), so a backfill shows up in the diff as the rewritten values and nothing else.
  fs.writeFileSync(recordPath, JSON.stringify(rebuild(record, frames, timelines), null, 2), 'utf-8');
  written += 1;
}
console.error(`[backfill] ${checkOnly ? 'checked' : 'wrote'} ${checkOnly ? files.size - skipped : written} recording(s), ${skipped} already current`);
