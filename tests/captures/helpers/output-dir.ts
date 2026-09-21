import path from 'node:path';
import fs from 'node:fs';

/**
 * Shared timestamped output directory for all captures in a single run.
 * Structure: captures/<timestamp>/agent-orchestration/, captures/<timestamp>/task-detail/, etc.
 *
 * The timestamp is created once per process so all capture specs in the same
 * `npm run capture` invocation share the same folder.
 */
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * `CAPTURE_OUTPUT_ROOT` replaces the timestamped root with a directory the caller names. It is
 * how demo/posters.mjs gets every scene still into one known place (dist/demo-posters/) to
 * verify and zip, and it is load-bearing there rather than a convenience: a Playwright retry runs
 * in a fresh worker process, which loads this module again and mints a new timestamp, so without
 * a fixed root the retried shot lands in a second captures/<timestamp>/ and reads as missing.
 */
const CAPTURES_ROOT = process.env.CAPTURE_OUTPUT_ROOT
  ? path.resolve(process.env.CAPTURE_OUTPUT_ROOT)
  : path.join(__dirname, '..', '..', '..', 'captures', timestamp);

export function getOutputDir(feature: string): string {
  const dir = path.join(CAPTURES_ROOT, feature);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { CAPTURES_ROOT };
