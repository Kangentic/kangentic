/**
 * Guards the release pre-flight's node_modules gate.
 *
 * The gate replaced `npm ci`, so its whole value is that a stale tree still
 * stops the release. A comparison that silently passes everything would remove
 * the check without anyone noticing, which is the failure this pins. See
 * `.claude/rules/release-gates-fail-loudly.md`.
 */
import { describe, expect, it } from 'vitest';
import { compareTrees, isExcludedFromThisPlatform } from '../../scripts/verify-node-modules.js';

function lockfileWith(packages: Record<string, unknown>) {
  return { lockfileVersion: 3, packages };
}

describe('compareTrees', () => {
  it('passes when the installed tree matches the lockfile', () => {
    const lockfile = lockfileWith({
      '': { name: 'kangentic' },
      'node_modules/left-pad': { version: '1.3.0' },
    });
    const installed = lockfileWith({ 'node_modules/left-pad': { version: '1.3.0' } });

    expect(compareTrees(lockfile, installed)).toEqual({
      missing: [],
      wrongVersion: [],
      extraneous: [],
    });
  });

  it('reports a package the lockfile requires but the tree does not have', () => {
    const lockfile = lockfileWith({ 'node_modules/left-pad': { version: '1.3.0' } });

    expect(compareTrees(lockfile, lockfileWith({})).missing).toEqual(['node_modules/left-pad']);
  });

  it('reports a package installed at the wrong version', () => {
    const lockfile = lockfileWith({ 'node_modules/left-pad': { version: '1.3.0' } });
    const installed = lockfileWith({ 'node_modules/left-pad': { version: '1.2.0' } });

    expect(compareTrees(lockfile, installed).wrongVersion).toEqual([
      { packagePath: 'node_modules/left-pad', expected: '1.3.0', installed: '1.2.0' },
    ]);
  });

  it('reports a package present in the tree but absent from the lockfile', () => {
    const installed = lockfileWith({ 'node_modules/stowaway': { version: '9.9.9' } });

    expect(compareTrees(lockfileWith({}), installed).extraneous).toEqual([
      'node_modules/stowaway',
    ]);
  });

  it('allows an optional or platform-excluded package to be absent', () => {
    const otherPlatform = process.platform === 'linux' ? 'darwin' : 'linux';
    const lockfile = lockfileWith({
      'node_modules/fsevents': { version: '2.3.3', optional: true },
      'node_modules/rollup-other': { version: '4.0.0', os: [otherPlatform] },
      'node_modules/esbuild-other': { version: '0.20.0', cpu: ['mips'] },
    });

    expect(compareTrees(lockfile, lockfileWith({})).missing).toEqual([]);
  });

  it('still reports a platform-matched package as missing', () => {
    const lockfile = lockfileWith({
      'node_modules/node-pty': { version: '1.0.0', os: [process.platform] },
    });

    expect(compareTrees(lockfile, lockfileWith({})).missing).toEqual(['node_modules/node-pty']);
  });

  it('ignores the version of a workspace link, which carries a path instead', () => {
    const lockfile = lockfileWith({
      'node_modules/kangentic': { resolved: 'packages/launcher', link: true },
    });
    const installed = lockfileWith({
      'node_modules/kangentic': { resolved: 'packages/launcher', link: true },
    });

    expect(compareTrees(lockfile, installed).wrongVersion).toEqual([]);
  });

  it('skips workspace roots, which are not installed under node_modules', () => {
    const lockfile = lockfileWith({
      '': { name: 'kangentic' },
      'packages/launcher': { version: '0.39.0' },
    });

    expect(compareTrees(lockfile, lockfileWith({})).missing).toEqual([]);
  });
});

describe('isExcludedFromThisPlatform', () => {
  it('does not exclude a package that constrains os to this platform', () => {
    expect(isExcludedFromThisPlatform({ os: [process.platform] })).toBe(false);
  });

  it('does not exclude a package with no constraints at all', () => {
    expect(isExcludedFromThisPlatform({ version: '1.0.0' })).toBe(false);
  });
});
