// DEVELOPER UTILITY - not run in CI.
//
// One-shot helper: read a real events.jsonl from local sessions, sanitize
// personal info (usernames, session UUIDs, transcript paths), and write
// a fixture file. Run manually:
//
//   node tests/fixtures/replay/_sanitize.mjs <input.jsonl> <output-name>
//
// The output is committed to the repo as a replay fixture. Add new
// fixtures when production captures reveal an event sequence that
// the engine doesn't already cover.

import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
const outputName = process.argv[3] ?? 'session-events.jsonl';
if (!inputPath) {
  console.error('Usage: node _sanitize.mjs <input.jsonl> <output-name>');
  process.exit(1);
}

const rawLines = fs.readFileSync(inputPath, 'utf-8').trim().split('\n');

const usernameRegex = /\\Users\\tyler\\/gi;
const usernameRegexFwd = /\/Users\/tyler\//gi;
const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;

function sanitize(line) {
  let cleaned = line;
  // Windows paths in JSON-escaped form (\\Users\\tyler\\)
  cleaned = cleaned.replace(/\\\\Users\\\\tyler\\\\/g, '\\\\Users\\\\dev\\\\');
  // Plain Windows paths
  cleaned = cleaned.replace(usernameRegex, '\\Users\\dev\\');
  // Forward-slash unix-style
  cleaned = cleaned.replace(usernameRegexFwd, '/Users/dev/');
  // Claude project-dir slug form (path separators collapsed to hyphens), e.g.
  // C--Users-tyler-Documents-GitHub-... -> C--Users-dev-Documents-GitHub-...
  cleaned = cleaned.replace(/-Users-tyler-/gi, '-Users-dev-');
  // General catch-all: any `Users<sep>tyler` with one-or-more slash/backslash
  // separators (covers JSON-in-JSON paths escaped to 4 backslashes, which the
  // fixed-form regexes above miss). Preserves the separators, swaps the name.
  cleaned = cleaned.replace(/(Users[\\/]+)tyler/gi, '$1dev');
  // Anonymize all UUIDs (session ids, transcript ids)
  cleaned = cleaned.replace(uuidRegex, '00000000-0000-0000-0000-000000000000');
  // Bare username, with no path around it to anchor on. A captured tool_start
  // carries the command line verbatim, so a session that grepped for its own
  // author's name puts that name in the fixture in a form every path-shaped
  // rule above misses. Over-scrubbing is the right error here: these fixtures
  // are committed to a public repo, and no assertion reads a `detail` string.
  cleaned = cleaned.replace(/tyler/gi, 'dev');
  // Email literals, likewise banned in committed files.
  cleaned = cleaned.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'dev@example.com');
  return cleaned;
}

const sanitized = rawLines.map(sanitize);
const outDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const outPath = path.join(outDir, outputName);
fs.writeFileSync(outPath, sanitized.join('\n') + '\n');
console.log(`wrote ${sanitized.length} events to ${outPath}`);
