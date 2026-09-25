/**
 * Add the agent message trail to recordings made before the capture script derived one.
 *
 * Unlike scripts/backfill-demo-timelines.mjs, this is NOT reproducible from a recording alone. The
 * peek and frame timelines come out of the recording's own byte stream; assistant prose does not,
 * and reconstructing it from TUI bytes is the fragile path .claude/rules/web-demo-parity.md exists
 * to avoid. The source is the transcript the agent wrote during the capture, which lives on the
 * machine that made the recording.
 *
 * So this is a ONE-TIME rescue for what is already on disk. The durable half is in
 * capture-agent-scrollback.js, which derives the same key at record time. The derived data is
 * committed into the recording JSONs, and tests/unit/demo-message-trail-seeded.test.ts asserts it
 * is PRESENT rather than trying to recompute it.
 *
 * Usage:
 *   node scripts/backfill-demo-message-trails.mjs            write every recording that lacks one
 *   node scripts/backfill-demo-message-trails.mjs --force    recompute every recording
 *   node scripts/backfill-demo-message-trails.mjs --check    report only, write nothing
 *   node scripts/backfill-demo-message-trails.mjs --only codex   restrict to matching file names
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importTsModule } from './lib/bundle-ts-module.mjs';

const require = createRequire(import.meta.url);
const { buildSanitizer } = require('./lib/demo-sanitizer.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'captures', 'fixtures', 'demo');
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

/**
 * Recordings that must carry no trail because their session is a Command Terminal.
 *
 * MessageTrailTracker.schedule returns early for a transient session, so a Command Terminal shows
 * no trail on the desktop either. Seeding one here would be the divergence.
 */
const transientSessionIds = new Set(
  dataset.DEMO_SESSIONS.filter((session) => session.transient).map((session) => session.id),
);
const transientFiles = new Set(
  manifest.captures.filter((entry) => transientSessionIds.has(entry.sessionId)).map((entry) => entry.file),
);

/** Keep the key where the capture script writes it, so a backfill and a fresh capture agree. */
function withMessageTrail(record, messageTrail) {
  const rebuilt = {};
  for (const key of Object.keys(record)) {
    if (key === 'messageTrail') continue;
    rebuilt[key] = record[key];
    if (key === 'frameTimeline') rebuilt.messageTrail = messageTrail;
  }
  if (rebuilt.messageTrail === undefined) rebuilt.messageTrail = messageTrail;
  return rebuilt;
}

const files = new Set(manifest.captures.map((entry) => entry.file));
for (const file of fs.readdirSync(fixturesDir)) {
  if (/^(spawn|terminal)-.+\.json$/.test(file)) files.add(file);
}

let written = 0;
let skipped = 0;
let failed = 0;
for (const file of [...files].sort()) {
  if (only && !file.includes(only)) continue;
  const recordPath = path.join(fixturesDir, file);
  if (!fs.existsSync(recordPath)) {
    console.error(`[trails] ${file}: not on disk, skipped`);
    continue;
  }
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  if (Array.isArray(record.messageTrail) && !force) {
    skipped += 1;
    continue;
  }

  // A Command Terminal and an agent with no transcript both get an explicit empty trail rather
  // than a missing key, so the guard can tell "derived, legitimately empty" from "never run".
  const isTransient = transientFiles.has(file) || file.startsWith('terminal-');
  const reason = isTransient
    ? 'a Command Terminal session is transient, and MessageTrailTracker skips those'
    : extract.AGENTS_WITHOUT_TRANSCRIPTS[record.agent];
  if (reason) {
    console.error(`[trails] ${file}: no trail by design (${reason})`);
    if (!checkOnly) fs.writeFileSync(recordPath, JSON.stringify(withMessageTrail(record, []), null, 2), 'utf-8');
    written += 1;
    continue;
  }

  const cwd = captureCwd(record.project);
  let trail;
  try {
    trail = await extract.extractMessageTrail(record, cwd);
  } catch (error) {
    // Loudly, per file, and never by guessing: an unmatched transcript leaves the recording alone.
    console.error(`[trails] ${file}: FAILED. ${error.message}`);
    failed += 1;
    continue;
  }

  const sanitizer = buildSanitizer({ project: record.project, cwd });
  const sanitized = trail.map((entry) => ({ ...entry, text: sanitizer.apply(entry.text) }));
  for (const entry of sanitized) sanitizer.assertClean(entry.text, `${file} message trail`);

  const span = sanitized.length > 0 ? `${sanitized[0].t}..${sanitized[sanitized.length - 1].t}ms` : 'empty';
  console.error(`[trails] ${file}: ${sanitized.length} line(s), ${span} of ${record.durationMs}ms`);
  if (checkOnly) continue;
  fs.writeFileSync(recordPath, JSON.stringify(withMessageTrail(record, sanitized), null, 2), 'utf-8');
  written += 1;
}

console.error(`[trails] ${checkOnly ? 'checked' : 'wrote'} ${written}, ${skipped} already had one, ${failed} failed`);
if (failed > 0) process.exit(1);
