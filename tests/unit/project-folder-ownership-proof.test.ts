/**
 * `tsc` makes every sweep take a `VerifiedOwnership`. A cast is the one way past
 * that, and it would turn the sweep back on for a database that proved nothing,
 * which is how 23 worktrees and 216 attachments went on 2026-11-05. So only
 * `project-ownership.ts` may make one (`.claude/rules/project-folder-ownership.md`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = path.join(__dirname, '..', '..', 'src');
const THE_ONE_MAKER = path.join('main', 'project-ownership', 'project-ownership.ts');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

describe('VerifiedOwnership', () => {
  const files = sourceFiles(SOURCE_ROOT);

  it('is made in one place', () => {
    const makers = files
      .filter((file) => /\bas\s+(unknown\s+as\s+)?VerifiedOwnership\b/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(SOURCE_ROOT, file));

    expect(makers).toEqual([THE_ONE_MAKER]);
  });

  it('is what every sweep takes, so the scan above is not guarding nothing', () => {
    const cleanup = fs.readFileSync(path.join(SOURCE_ROOT, 'main', 'transition-engine', 'resource-cleanup.ts'), 'utf-8');

    expect(cleanup).toMatch(/export async function cleanupStaleResourcesAsync\(\s*ownership: VerifiedOwnership/);
    expect(cleanup).toMatch(/export async function pruneOrphanedDirectories\(\s*ownership: VerifiedOwnership/);
  });
});
