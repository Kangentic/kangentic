/**
 * `ensureNodeModulesLink` (scripts/worktree-preview.js): a preview junctions the
 * worktree's node_modules to the root's, EXCEPT when the branch declares its own
 * dependency tree. Deleting a real install there previewed the branch against
 * the root's packages, which cannot load a dependency only the branch adds.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureNodeModulesLink } from '../../scripts/worktree-preview.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeLayout(options: { worktreeLock: string; realInstall: boolean }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-preview-modules-'));
  temporaryRoots.push(base);
  const rootDir = path.join(base, 'root');
  const worktreeDir = path.join(base, 'worktree');
  fs.mkdirSync(path.join(rootDir, 'node_modules', 'root-only-package'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, 'package-lock.json'), options.worktreeLock);
  if (options.realInstall) {
    fs.mkdirSync(path.join(worktreeDir, 'node_modules', 'branch-only-package'), { recursive: true });
  }
  return { rootDir, worktreeDir, modules: path.join(worktreeDir, 'node_modules') };
}

function resolvesToRoot(modules: string, rootDir: string): boolean {
  return fs.realpathSync(modules) === fs.realpathSync(path.join(rootDir, 'node_modules'));
}

describe('ensureNodeModulesLink', () => {
  it("keeps the worktree's real install when its lockfile differs from the root's", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { rootDir, worktreeDir, modules } = makeLayout({
      worktreeLock: '{"lockfileVersion":3,"packages":{"node_modules/branch-only-package":{}}}\n',
      realInstall: true,
    });

    ensureNodeModulesLink(worktreeDir, rootDir);

    expect(resolvesToRoot(modules, rootDir)).toBe(false);
    expect(fs.existsSync(path.join(modules, 'branch-only-package'))).toBe(true);
  });

  it("replaces a real install with the root's junction when the lockfiles match", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { rootDir, worktreeDir, modules } = makeLayout({
      worktreeLock: '{"lockfileVersion":3,"packages":{}}\r\n',
      realInstall: true,
    });

    ensureNodeModulesLink(worktreeDir, rootDir);

    expect(resolvesToRoot(modules, rootDir)).toBe(true);
  });

  it('still junctions, but warns, when the lockfiles differ and there is no install to keep', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rootDir, worktreeDir, modules } = makeLayout({
      worktreeLock: '{"lockfileVersion":3,"packages":{"node_modules/branch-only-package":{}}}\n',
      realInstall: false,
    });

    ensureNodeModulesLink(worktreeDir, rootDir);

    expect(resolvesToRoot(modules, rootDir)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('runs the ROOT\'s packages'));
  });

  it('keeps a junction that is already correct, and warns when the lockfiles differ', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rootDir, worktreeDir, modules } = makeLayout({
      worktreeLock: '{"lockfileVersion":3,"packages":{"node_modules/branch-only-package":{}}}\n',
      realInstall: false,
    });
    fs.symlinkSync(path.join(rootDir, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');

    ensureNodeModulesLink(worktreeDir, rootDir);

    expect(resolvesToRoot(modules, rootDir)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('runs the ROOT\'s packages'));
  });
});
