/**
 * Add the peek and frame timelines to recordings made before the capture script computed them.
 *
 * Both are derived from a recording's own stream, so this needs no agent, no API credit, and no
 * re-record: replaying the stream through a headless xterm produces exactly what the capture
 * script would have produced at record time. Same module, same result.
 *
 * Usage:
 *   node scripts/backfill-demo-timelines.mjs            write every recording that lacks one
 *   node scripts/backfill-demo-timelines.mjs --force    recompute every recording
 *   node scripts/backfill-demo-timelines.mjs --check    report only, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { computeReplayTimelines } = require('./lib/demo-replay-timelines.js');

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'captures', 'fixtures', 'demo');
const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');

/**
 * Keep the keys where the capture script writes them, between the open frame and the working
 * tree, so a backfilled recording and a freshly captured one are the same file shape.
 */
function withTimelines(record, timelines) {
  const rebuilt = {};
  for (const key of Object.keys(record)) {
    if (key === 'peekTimeline' || key === 'frameTimeline') continue;
    rebuilt[key] = record[key];
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
const files = new Set(manifest.captures.map((entry) => entry.file));
for (const file of fs.readdirSync(fixturesDir)) {
  if (/^(spawn|terminal)-.+\.json$/.test(file)) files.add(file);
}

let written = 0;
let skipped = 0;
for (const file of [...files].sort()) {
  const recordPath = path.join(fixturesDir, file);
  if (!fs.existsSync(recordPath)) {
    console.error(`[backfill] ${file}: not on disk, skipped`);
    continue;
  }
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  if (Array.isArray(record.peekTimeline) && Array.isArray(record.frameTimeline) && !force) {
    skipped += 1;
    continue;
  }
  const timelines = await computeReplayTimelines({ stream: record.stream, cols: record.cols, rows: record.rows });
  const stream = Array.isArray(record.stream) ? record.stream : [];
  const duration = stream.length > 0 ? stream[stream.length - 1].t : 0;
  console.error(
    `[backfill] ${file}: ${timelines.peekTimeline.length} peek change(s), `
    + `${timelines.frameTimeline.length} frame(s) across ${(duration / 1000).toFixed(0)}s`,
  );
  if (checkOnly) continue;
  // Byte for byte the shape capture-agent-scrollback.js writes, trailing newline included (there
  // is none), so a backfill shows up in the diff as the added keys and nothing else.
  fs.writeFileSync(recordPath, JSON.stringify(withTimelines(record, timelines), null, 2), 'utf-8');
  written += 1;
}
console.error(`[backfill] ${checkOnly ? 'checked' : 'wrote'} ${checkOnly ? files.size - skipped : written} recording(s), ${skipped} already had both`);
