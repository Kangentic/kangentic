/**
 * The workflow engine's core (`src/main/workflows/engine/`) stays pure, so it
 * can move to a utility process later as a transport change rather than a
 * rewrite (#732, Open questions 2): no Electron, no IPC layer, no database, no
 * analytics or Sentry, and no timer of its own. The host on main owns all of
 * those (`workflow-engine-host.ts`).
 *
 * A static scan of each core file's imports, followed transitively through the
 * relative ones, so a helper module cannot smuggle a forbidden import in.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CORE_DIR = path.join(REPO_ROOT, 'src', 'main', 'workflows', 'engine');

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^electron$/, why: 'Electron belongs to the host' },
  { pattern: /\/ipc\//, why: 'the IPC layer belongs to the host' },
  { pattern: /\/db\//, why: 'database reads belong to the host' },
  { pattern: /better-sqlite3/, why: 'database reads belong to the host' },
  { pattern: /analytics/, why: 'analytics belongs to the host' },
  { pattern: /sentry/i, why: 'error reporting belongs to the host' },
  { pattern: /\/pty\//, why: 'sessions belong to the host' },
];

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) specifiers.push(match[1]);
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file the core reaches through relative imports, the core included. */
function coreGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = fs.readdirSync(CORE_DIR).filter((name) => name.endsWith('.ts')).map((name) => path.join(CORE_DIR, name));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const specifiers = importsOf(fs.readFileSync(file, 'utf8'));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelative(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return graph;
}

describe('the workflow engine core boundary', () => {
  it('reaches at least the core modules, so the scan cannot pass vacuously', () => {
    const files = [...coreGraph().keys()].map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    // The lock predicate is shared with the board (`src/shared/workflow-lock.ts`), so it is pure by
    // living in `shared/`, which imports nothing from main.
    expect(files).toEqual(expect.arrayContaining([
      'src/main/workflows/engine/workflow-engine-core.ts',
    ]));
  });

  it('imports nothing that belongs to the host', () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of coreGraph()) {
      for (const specifier of specifiers) {
        const resolved = specifier.startsWith('.') ? resolveRelative(file, specifier) : null;
        const shown = resolved ? path.relative(REPO_ROOT, resolved).replace(/\\/g, '/') : specifier;
        for (const { pattern, why } of FORBIDDEN_PATTERNS) {
          if (pattern.test(shown)) offenders.push(`${path.relative(REPO_ROOT, file)} imports ${shown}: ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('schedules no timer of its own', () => {
    const offenders: string[] = [];
    for (const file of coreGraph().keys()) {
      const source = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const timer of ['setTimeout(', 'setInterval(', 'setImmediate(', 'queueMicrotask(']) {
        if (source.includes(timer)) offenders.push(`${path.relative(REPO_ROOT, file)} calls ${timer}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
