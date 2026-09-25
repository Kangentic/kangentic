/**
 * Derive the agent's transcript for a recording already on disk, for the conversation viewer.
 *
 * Like scripts/backfill-demo-message-trails.mjs this is NOT reproducible from a recording alone:
 * the source is the transcript the agent wrote during the capture, which lives on the machine that
 * made the recording, matched to the recording by its prompt and start time
 * (tests/captures/helpers/message-trail-extract.ts, the same match the trail uses). The durable
 * half is capture-agent-scrollback.js --transcript-out, which the matrix passes for every manifest
 * entry marked `transcript`; this is the rescue for a recording made before that existed.
 *
 * Only the entries the manifest marks are derived. A transcript is main's own parser output,
 * sanitized whole (tool inputs and results quote absolute paths), written to
 * tests/captures/fixtures/demo/transcripts/<recording file>; the web build refuses to seed a marked
 * session whose file is missing, and tests/unit/demo-transcript-seeded.test.ts asserts the file
 * carries a real conversation.
 *
 * Usage:
 *   node scripts/backfill-demo-transcripts.mjs            write every marked transcript that is missing
 *   node scripts/backfill-demo-transcripts.mjs --force    rewrite every marked transcript
 *   node scripts/backfill-demo-transcripts.mjs --check    report only, write nothing
 *   node scripts/backfill-demo-transcripts.mjs --only middleware   restrict to matching file names
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importTsModule } from './lib/bundle-ts-module.mjs';

const require = createRequire(import.meta.url);
const { buildSanitizer, sanitizeDeep } = require('./lib/demo-sanitizer.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
const transcriptsDir = path.join(fixturesDir, 'transcripts');
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const checkOnly = argv.includes('--check');
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];

// Node cannot import the adapter transcript parsers directly (extensionless relative specifiers),
// so the derivation is bundled first. See scripts/lib/bundle-ts-module.mjs.
const extract = await importTsModule(path.join(repoRoot, 'tests', 'captures', 'helpers', 'message-trail-extract.ts'));
const dataset = await import(pathToFileURL(path.join(repoRoot, 'tests', 'captures', 'helpers', 'demo-dataset.ts')).href);

const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf-8'));

/** The capture cwd for a project, the same derivation capture-demo-sessions.mjs uses. */
function captureCwd(projectName) {
  const project = dataset.DEMO_PROJECTS.find((candidate) => candidate.name === projectName);
  if (!project) throw new Error(`no project named "${projectName}" in the dataset`);
  // C:\Users\dev\<group>\<name>: everything after the user's directory, under the real home.
  return path.join(os.homedir(), ...project.path.split(/[\\/]+/).slice(3));
}

let written = 0;
let skipped = 0;
let failed = 0;
for (const entry of manifest.captures) {
  if (!entry.transcript) continue;
  if (only && !entry.file.includes(only)) continue;
  const recordPath = path.join(fixturesDir, entry.file);
  const outPath = path.join(transcriptsDir, entry.file);
  if (!fs.existsSync(recordPath)) {
    console.error(`[transcripts] ${entry.file}: recording not on disk, skipped`);
    continue;
  }
  if (fs.existsSync(outPath) && !force) {
    skipped += 1;
    continue;
  }
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  const cwd = captureCwd(record.project);
  let transcript;
  try {
    transcript = await extract.extractTranscript(record, cwd);
    if (!transcript) throw new Error(`${record.agent} has no transcript parser (AGENTS_WITHOUT_TRANSCRIPTS); drop "transcript" from its manifest entry`);
  } catch (error) {
    // Loudly, per file, and never by guessing: an unmatched transcript writes nothing.
    console.error(`[transcripts] ${entry.file}: FAILED. ${error.message}`);
    failed += 1;
    continue;
  }
  // The viewer ends where the terminal does: the rig's exit sequence comes after the last byte.
  const stream = Array.isArray(record.stream) ? record.stream : [];
  const streamEndMs = stream.length > 0 ? stream[stream.length - 1].t : record.durationMs;
  const within = extract.transcriptWithinRecording(transcript.entries, transcript.startMs, streamEndMs);
  const sanitizer = buildSanitizer({ project: record.project, cwd });
  const sanitized = sanitizeDeep(within, sanitizer);
  sanitizer.assertClean(JSON.stringify(sanitized), `${entry.file} transcript`);
  const kinds = sanitized.reduce((counts, item) => Object.assign(counts, { [item.kind]: (counts[item.kind] || 0) + 1 }), {});
  console.error(`[transcripts] ${entry.file}: ${sanitized.length} entries (${Object.entries(kinds).map(([kind, count]) => `${count} ${kind}`).join(', ')}) from ${transcript.sourcePath}`);
  if (checkOnly) continue;
  // The same shape capture-agent-scrollback.js's writeTranscript produces at record time.
  const output = { agent: record.agent, project: record.project, prompt: record.prompt, capturedAt: record.capturedAt, durationMs: record.durationMs, entries: sanitized };
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  written += 1;
}

console.error(`[transcripts] ${checkOnly ? 'checked' : 'wrote'} ${written}, ${skipped} already on disk, ${failed} failed`);
if (failed > 0) process.exit(1);
