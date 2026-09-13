/**
 * The sample install ships in a public repo and on a public web page, so nothing under
 * tests/captures/fixtures/demo/ or in the dataset modules may carry a personal or machine-specific
 * marker: a real home directory, a user name, an email address, a host name, or a client's name.
 * The capture script sanitizes at record time (scripts/capture-agent-scrollback.js) and refuses to
 * write when a marker survives; this test is the CI backstop for anything hand-edited afterwards.
 *
 * This is the mechanical check .claude/rules/no-personal-info.md names as a candidate, scoped to
 * the demo fixtures, where the exposure is largest.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'captures', 'fixtures', 'demo');
const DATASET_FILES = [
  path.join(REPO_ROOT, 'tests', 'captures', 'helpers', 'demo-dataset.ts'),
  path.join(REPO_ROOT, 'tests', 'captures', 'scenes.ts'),
];

/** Patterns that mean a real machine or person leaked into the sample install. */
const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'a Windows home directory', pattern: /C:[\\/]+Users[\\/]+(?!dev\b)[A-Za-z0-9._-]+/ },
  { label: 'a macOS home directory', pattern: /\/Users\/(?!dev\b)[A-Za-z0-9._-]+/ },
  { label: 'a Linux home directory other than /home/dev', pattern: /\/home\/(?!dev\b)[A-Za-z0-9._-]+/ },
  { label: 'an email address', pattern: /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // The sample install is a Windows machine whose user is "dev", so C:\Users\dev\AppData\Local\Temp
  // is a legitimate path; only the capture rig's scratch root under it may never appear.
  { label: 'the capture scratch directory', pattern: /kng-demo/ },
  { label: 'the TroyWeb client organization', pattern: /troyweb/i },
  { label: 'a client project name', pattern: /RBDMS|OKIES|GWPC|AKWISE|NYSDOT/i },
];

function listFixtureFiles(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs.readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(FIXTURES_DIR, name));
}

function findLeak(text: string): string | null {
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    const match = text.match(pattern);
    if (match) return `${label} ("${match[0].slice(0, 60)}")`;
  }
  return null;
}

describe('demo fixtures carry no personal or machine-specific markers', () => {
  const files = [...listFixtureFiles(), ...DATASET_FILES.filter((file) => fs.existsSync(file))];

  it('has files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is clean', (file) => {
    const leak = findLeak(fs.readFileSync(file, 'utf-8'));
    expect(leak, `${path.relative(REPO_ROOT, file)} contains ${leak}`).toBeNull();
  });

  it('recorded sessions ship a clean, non-empty serialized stream and never the raw bytes', () => {
    for (const file of listFixtureFiles()) {
      if (path.basename(file) === 'manifest.json') continue;
      const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        raw?: unknown; rawBytes?: unknown; serialized?: unknown; agent?: unknown;
        stream?: Array<{ t: number; data: string }>; peek?: string[];
        openFrame?: { beforeEndMs?: unknown; serialized?: unknown; peek?: unknown } | null;
      };
      expect(typeof record.agent, `${path.basename(file)} has no agent`).toBe('string');
      expect(typeof record.serialized === 'string' && record.serialized.length > 0, `${path.basename(file)} has an empty serialized stream`).toBe(true);
      // The unsanitized raw PTY stream never ships; the timed stream is the same bytes, sanitized
      // per window and checked here as one string, since a path can straddle two windows.
      expect(record.raw, `${path.basename(file)} carries the raw PTY stream`).toBeUndefined();
      expect(typeof record.rawBytes === 'number' && record.rawBytes > 0, `${path.basename(file)} has no raw byte count`).toBe(true);
      expect(Array.isArray(record.stream) && record.stream.length > 0, `${path.basename(file)} has no timed stream`).toBe(true);
      expect(findLeak(String(record.serialized ?? '')), `${path.basename(file)} serialized stream`).toBeNull();
      expect(findLeak((record.stream ?? []).map((window) => window.data).join('')), `${path.basename(file)} timed stream`).toBeNull();
      expect(findLeak((record.peek ?? []).join('\n')), `${path.basename(file)} peek`).toBeNull();
      // A session the app shows as working also ships the frame at the moment the live frame
      // opens it. Null is legitimate (a recording shorter than the tail never reaches such a
      // moment); present means it must be a real frame, or a still paints an empty terminal.
      if (record.openFrame != null) {
        const openFrame = record.openFrame;
        expect(typeof openFrame.beforeEndMs === 'number' && (openFrame.beforeEndMs as number) > 0, `${path.basename(file)} open frame has no beforeEndMs`).toBe(true);
        expect(typeof openFrame.serialized === 'string' && (openFrame.serialized as string).length > 0, `${path.basename(file)} has an empty open frame`).toBe(true);
        expect(findLeak(String(openFrame.serialized ?? '')), `${path.basename(file)} open frame`).toBeNull();
        expect(findLeak(((openFrame.peek as string[]) ?? []).join('\n')), `${path.basename(file)} open frame peek`).toBeNull();
      }
    }
  });
});
