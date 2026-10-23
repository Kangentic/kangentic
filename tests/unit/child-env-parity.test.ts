import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasOptOutMarker } from './helpers/opt-out-marker';

// On Windows Chromium's Crashpad puts its handler pipe in main's environment
// (CHROME_CRASHPAD_PIPE_NAME) so Kangentic's own processes can reach it. A child
// that inherits it hands it to whatever it starts, and an Electron program among
// those registers with our handler, so its crash lands in our database (Sentry
// DESKTOP-1S). Every child env is built by childProcessEnv or
// withoutCrashpadPipeName (src/main/shared/child-env.ts), which drop it.
//
// Two checks keep that true:
//   - no `...process.env` spread and no `env: process.env` outside child-env.ts,
//     the usual ways to hand a child main's environment whole. A deliberate
//     exception carries `// crashpad-env-ok: <reason>`.
//   - no `delete process.env` of the Crashpad variable anywhere: main must keep
//     it, or Kangentic's own renderer, GPU and utility processes lose the
//     handler and their crash dumps with it.
//
// Not covered: a spawn that passes no env at all and so inherits main's. The
// chokepoints (buildSpawnEnv, the off-main runners, spawnWithAbort) each set an
// env, and the rest are decided case by case in docs/platforms/windows.md.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = path.join(REPO_ROOT, 'src', 'main');
const CHILD_ENV_MODULE = 'src/main/shared/child-env.ts';
const MARKER = 'crashpad-env-ok';

const WHOLE_ENV_HANDOFF = /\.\.\.process\.env\b|\benv\s*:\s*process\.env\b(?![.[])/;
const CRASHPAD_DELETE = /\bdelete\s+process\.env\b.*crashpad/i;

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

/** Unmarked lines matching `pattern` in one file's text, as `file:line`. */
function offendersIn(label: string, text: string, pattern: RegExp): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (!pattern.test(line)) return;
    if (hasOptOutMarker(lines, index, MARKER)) return;
    found.push(`${label}:${index + 1}`);
  });
  return found;
}

describe('child processes never inherit Crashpad\'s pipe name', () => {
  const files = collectSourceFiles(SCAN_DIR);

  it('walks the whole of src/main', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no `...process.env` spread or `env: process.env` outside child-env.ts', () => {
    const offenders = files
      .filter((filePath) => repoRelative(filePath) !== CHILD_ENV_MODULE)
      .flatMap((filePath) => offendersIn(repoRelative(filePath), fs.readFileSync(filePath, 'utf-8'), WHOLE_ENV_HANDOFF));

    expect(
      offenders,
      'A copy of process.env carries CHROME_CRASHPAD_PIPE_NAME on Windows, and a child that inherits it can ' +
        'write its crash into our database. Build the env with childProcessEnv(overrides) or ' +
        'withoutCrashpadPipeName(env) from src/main/shared/child-env.ts, or mark a deliberate exception ' +
        `\`// ${MARKER}: <reason>\`.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never deletes the Crashpad variable from main\'s own environment', () => {
    const offenders = files.flatMap((filePath) => {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      return lines.flatMap((line, index) => (
        !isCommentLine(line) && CRASHPAD_DELETE.test(line) ? [`${repoRelative(filePath)}:${index + 1}`] : []
      ));
    });

    expect(
      offenders,
      'Kangentic\'s renderer, GPU and utility processes find the Crashpad handler through main\'s copy. ' +
        `Strip it per launch with childProcessEnv instead.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('still matches the spread inside child-env.ts, so the scan above is not blind', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, CHILD_ENV_MODULE), 'utf-8');
    expect(offendersIn(CHILD_ENV_MODULE, source, WHOLE_ENV_HANDOFF).length).toBeGreaterThan(0);
  });

  it('flags the handoff shapes it exists for, and honors a marker with a reason', () => {
    const sample = [
      'spawn(file, args, { env: { ...process.env, EXTRA: "1" } });',
      'spawn(file, args, { env: process.env });',
      '// crashpad-env-ok: a fixed system tool that starts nothing',
      'spawn(file, args, { env: { ...process.env } });',
      'const home = process.env.HOME;',
      'spawn(file, args, { env: process.env.PATH ? childProcessEnv() : {} });',
    ].join('\n');

    expect(offendersIn('sample.ts', sample, WHOLE_ENV_HANDOFF)).toEqual(['sample.ts:1', 'sample.ts:2']);
    expect(CRASHPAD_DELETE.test('delete process.env.CHROME_CRASHPAD_PIPE_NAME;')).toBe(true);
    expect(CRASHPAD_DELETE.test('delete environment[TASK_PROCESS_TAG_ENV];')).toBe(false);
  });
});
