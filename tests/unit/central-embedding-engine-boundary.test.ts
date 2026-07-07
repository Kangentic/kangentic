import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Enforces .claude/rules/central-embedding-engine.md: embedding work is
 * triggered ONLY by embed-engine.ts's own duty-cycle-throttled drain loop,
 * never inline from a lifecycle/IPC handler or a navigation event. This is
 * the mechanical backstop for the core fix in the central-background-
 * embedding refactor - a project switch must perform zero synchronous
 * embedding, and that invariant only holds if nothing outside the engine can
 * construct an EmbedClient or call embed() directly.
 *
 * Mirrors tests/unit/esbuild-cjs-imports.test.ts's scan-and-collect shape.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
/** The only file allowed to construct the embed worker or run the drain loop. */
const ENGINE_FILE = 'src/main/retrieval/embedder/embed-engine.ts';

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeLines(filePath: string): { relPath: string; lines: string[] } {
  const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  return { relPath, lines };
}

describe('central embedding engine boundary', () => {
  it('constructs EmbedClient only from embed-engine.ts', () => {
    const offenders: string[] = [];
    const scanRoot = path.join(REPO_ROOT, 'src/main');
    for (const filePath of collectSourceFiles(scanRoot)) {
      const { relPath, lines } = relativeLines(filePath);
      if (relPath === ENGINE_FILE) continue;
      lines.forEach((line, index) => {
        if (/\bnew EmbedClient\s*\(/.test(line)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Only embed-engine.ts may construct EmbedClient - the background drain and the interactive query path must share the ONE worker instance the engine owns. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never reintroduces an inline embed pass or heal poll outside the engine', () => {
    // embedPass and scheduleEmbedHeal were the pre-refactor inline embedders,
    // triggered by navigation/lifecycle events and a getStatus poll
    // respectively. Both were deleted entirely - embedEngine.markDirty() is
    // the only path a chunk-producing event may use. Their reappearance as a
    // call or declaration anywhere signals the coupling has crept back in.
    // Matches a call/declaration form (name immediately followed by '(') so a
    // prose mention in a doc comment - e.g. explaining what this replaced -
    // does not false-positive.
    const offenders: string[] = [];
    const scanRoot = path.join(REPO_ROOT, 'src/main');
    for (const filePath of collectSourceFiles(scanRoot)) {
      const { relPath, lines } = relativeLines(filePath);
      lines.forEach((line, index) => {
        if (/\b(embedPass|scheduleEmbedHeal)\s*\(/.test(line)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `embedPass/scheduleEmbedHeal must not exist - embedding is driven ONLY by embedEngine's background drain loop (see embed-engine.ts). Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never calls .embed( directly from an IPC handler', () => {
    // Handlers may only reach the embed worker through the sanctioned facade
    // (retrievalService.getEmbedder / reconcileEmbedWorker / startForProject,
    // which all delegate to embedEngine) - never a direct `.embed(` call,
    // which would bypass the engine's interactive-vs-background lane and duty
    // cycle entirely.
    const offenders: string[] = [];
    const scanRoot = path.join(REPO_ROOT, 'src/main/ipc/handlers');
    for (const filePath of collectSourceFiles(scanRoot)) {
      const { relPath, lines } = relativeLines(filePath);
      lines.forEach((line, index) => {
        if (/\.embed\s*\(/.test(line)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `IPC handlers must not call .embed( directly - go through retrievalService.getEmbedder()/embedEngine. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
