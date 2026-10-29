/**
 * Guards the release pre-flight's node_modules gate.
 *
 * The gate replaced `npm ci`, so its whole value is that a stale tree still
 * stops the release. A comparison that silently passes everything would remove
 * the check without anyone noticing, which is the failure this pins. See
 * `.claude/rules/release-gates-fail-loudly.md`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNodeModules, compareTrees, isExcludedFromThisPlatform } from '../../scripts/verify-node-modules.js';

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

describe('checkNodeModules', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A checkout with `lockfile` committed and, unless null, `installed` as npm's own record. */
  function makeCheckout(lockfile: unknown, installed: unknown | null): string {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-verify-modules-'));
    temporaryRoots.push(checkout);
    fs.writeFileSync(path.join(checkout, 'package-lock.json'), JSON.stringify(lockfile));
    if (installed !== null) {
      fs.mkdirSync(path.join(checkout, 'node_modules'));
      fs.writeFileSync(path.join(checkout, 'node_modules', '.package-lock.json'), JSON.stringify(installed));
    }
    return checkout;
  }

  const lockfile = lockfileWith({ 'node_modules/left-pad': { version: '1.3.0' } });

  it('returns 2 when the tree was never installed', () => {
    const result = checkNodeModules(makeCheckout(lockfile, null));

    expect(result.exitCode).toBe(2);
    expect(result.report.join('\n')).toContain('never been installed');
  });

  it('returns 1 with the differing package in the report, and no release advice', () => {
    const result = checkNodeModules(makeCheckout(lockfile, lockfileWith({ 'node_modules/left-pad': { version: '1.2.0' } })));

    expect(result.exitCode).toBe(1);
    expect(result.report.join('\n')).toContain('node_modules/left-pad: expected 1.3.0, installed 1.2.0');
    expect(result.report.join('\n')).not.toContain('releasing');
  });

  it('returns 0 with an empty report when the tree matches', () => {
    const result = checkNodeModules(makeCheckout(lockfile, lockfile));

    expect(result).toEqual({ exitCode: 0, report: [], checked: 1 });
  });

  it('returns 1 when the lockfile version differs from the installed tree, even with identical packages', () => {
    // Same packages on both sides, so only the version check can fail this tree.
    const installed = { lockfileVersion: 2, packages: { 'node_modules/left-pad': { version: '1.3.0' } } };

    const result = checkNodeModules(makeCheckout(lockfile, installed));

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("Lockfile version 3 does not match the installed tree's 2.");
  });

  describe('report sections', () => {
    const REPORT_HEADER = 'node_modules does not match package-lock.json.';

    it('lists a missing package under a count label', () => {
      const result = checkNodeModules(makeCheckout(lockfile, lockfileWith({})));

      expect(result.exitCode).toBe(1);
      expect(result.report).toEqual([REPORT_HEADER, '  1 missing:', '    node_modules/left-pad']);
    });

    it('lists a package that is installed but not in the lockfile under a count label', () => {
      const installed = lockfileWith({ 'node_modules/stowaway': { version: '9.9.9' } });

      const result = checkNodeModules(makeCheckout(lockfileWith({}), installed));

      expect(result.exitCode).toBe(1);
      expect(result.report).toEqual([REPORT_HEADER, '  1 not in the lockfile:', '    node_modules/stowaway']);
    });

    // Zero-padded, so a substring check on one name cannot match another.
    function packagePaths(count: number): string[] {
      return Array.from({ length: count }, (_, index) => `node_modules/pkg-${String(index + 1).padStart(2, '0')}`);
    }

    function lockfileOf(paths: string[]) {
      return lockfileWith(Object.fromEntries(paths.map((packagePath) => [packagePath, { version: '1.0.0' }])));
    }

    it('lists only the first 10 of 12 missing packages, then says how many more', () => {
      const paths = packagePaths(12);

      const result = checkNodeModules(makeCheckout(lockfileOf(paths), lockfileWith({})));

      expect(result.exitCode).toBe(1);
      expect(result.report).toEqual([
        REPORT_HEADER,
        '  12 missing:',
        ...paths.slice(0, 10).map((packagePath) => `    ${packagePath}`),
        '    ... and 2 more',
      ]);
    });

    it('lists exactly 10 missing packages in full, with no "more" line', () => {
      const paths = packagePaths(10);

      const result = checkNodeModules(makeCheckout(lockfileOf(paths), lockfileWith({})));

      expect(result.report).toEqual([
        REPORT_HEADER,
        '  10 missing:',
        ...paths.map((packagePath) => `    ${packagePath}`),
      ]);
    });
  });

  // main() is the release gate's CLI: it turns the check's result into an exit
  // code and the advice a person acts on. It runs a copy of the script beside
  // a fixture, because the script reads the lockfile of the checkout it sits in.
  describe('the CLI', () => {
    const SCRIPT_SOURCE = path.resolve(__dirname, '../../scripts/verify-node-modules.js');
    const RELEASE_ADVICE = 'Run `npm ci` before releasing.';
    const DEV_SERVER_ADVICE = 'Close the dev server first if it is running.';

    function runCli(checkout: string, flags: string[] = []) {
      fs.mkdirSync(path.join(checkout, 'scripts'));
      const scriptCopy = path.join(checkout, 'scripts', 'verify-node-modules.js');
      fs.copyFileSync(SCRIPT_SOURCE, scriptCopy);
      const result = spawnSync(process.execPath, [scriptCopy, ...flags], { encoding: 'utf8', windowsHide: true });
      expect(result.error).toBeUndefined();
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    // One package on both sides and no root entry, so the "checked" count is 1.
    const singlePackage = lockfileWith({ 'node_modules/left-pad': { version: '1.3.0' } });
    const olderPackage = lockfileWith({ 'node_modules/left-pad': { version: '1.2.0' } });

    it('exits 2 with the never-installed line and the release advice when there is no installed manifest', () => {
      const result = runCli(makeCheckout(singlePackage, null));

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('node_modules has never been installed in this checkout.');
      expect(result.stderr).toContain(RELEASE_ADVICE);
      // The dev-server advice belongs to a mismatch only, not to a tree that does not exist.
      expect(result.stderr).not.toContain(DEV_SERVER_ADVICE);
      expect(result.stdout).toBe('');
    });

    it('exits 1 with the differing package and the dev-server advice on a mismatch', () => {
      const result = runCli(makeCheckout(singlePackage, olderPackage));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/left-pad: expected 1.3.0, installed 1.2.0');
      expect(result.stderr).toContain(`${RELEASE_ADVICE} ${DEV_SERVER_ADVICE}`);
      expect(result.stdout).toBe('');
    });

    it('exits 0 and says how many packages matched when the tree is current', () => {
      const result = runCli(makeCheckout(singlePackage, singlePackage));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('node_modules matches package-lock.json (1 packages). No install needed.');
      expect(result.stderr).toBe('');
    });

    it('prints nothing on a match under --quiet, and still exits 0', () => {
      const result = runCli(makeCheckout(singlePackage, singlePackage), ['--quiet']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('still fails loudly on a mismatch under --quiet', () => {
      const result = runCli(makeCheckout(singlePackage, olderPackage), ['--quiet']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/left-pad: expected 1.3.0, installed 1.2.0');
      expect(result.stderr).toContain(`${RELEASE_ADVICE} ${DEV_SERVER_ADVICE}`);
    });
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
