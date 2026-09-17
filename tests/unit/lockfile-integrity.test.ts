import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// package-lock.json is the only thing standing between `npm ci` and an unverified tarball.
// An entry with no `integrity` hash installs whatever the registry hands back, with nothing
// checking it is the same bytes anyone else got.
//
// This is not hypothetical here. Regenerating the lockfile against a populated node_modules
// silently strips `resolved` and `integrity` from every package already on disk: npm reads
// the installed version out of the on-disk package.json, which since npm 7 carries no
// `_resolved` / `_integrity`, and writes an entry with neither. Packages NOT on disk
// (wrong-platform optionals) get resolved from the registry and keep full metadata, so the
// damage is invisible unless you count. That happened in 4de7b2e9 and left 1009 of 1211
// entries unverified for two months, across every CI job and the signed release build.
//
// `npm install --package-lock-only` does not repair it (arborist will not re-fetch a manifest
// for an already-satisfied node), which is why the fix is a dedicated script.

const REPO_ROOT = path.resolve(__dirname, '../..');
const LOCKFILE_PATH = path.join(REPO_ROOT, 'package-lock.json');
const REPAIR_COMMAND = 'node scripts/repair-lockfile-integrity.js';

interface LockfileEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
}

/**
 * Registry-installed packages only. Three kinds of entry legitimately have no tarball:
 * the root project (`''`), the workspace roots under `packages/`, and the `link: true`
 * symlinks npm creates for those workspaces inside node_modules.
 */
function findMetadataOffenders(packages: Record<string, LockfileEntry>): string[] {
  const offenders: string[] = [];
  for (const [lockfileKey, entry] of Object.entries(packages)) {
    if (!lockfileKey.startsWith('node_modules/')) continue;
    if (entry.link) continue;

    const missing: string[] = [];
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://')) {
      missing.push('resolved');
    }
    if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
      missing.push('integrity');
    }
    if (missing.length > 0) offenders.push(`${lockfileKey} (missing ${missing.join(' and ')})`);
  }
  return offenders;
}

describe('package-lock.json supply-chain metadata', () => {
  const lockfile = JSON.parse(fs.readFileSync(LOCKFILE_PATH, 'utf-8')) as {
    lockfileVersion: number;
    packages: Record<string, LockfileEntry>;
  };

  it('is lockfile version 3', () => {
    // The exemption logic below reads v3's `packages` map. A version change means this
    // scan needs rewriting rather than silently passing over a shape it does not know.
    expect(lockfile.lockfileVersion).toBe(3);
  });

  it('records resolved and integrity for every registry-installed package', () => {
    const offenders = findMetadataOffenders(lockfile.packages);
    const preview = offenders.slice(0, 15).join('\n  ');
    const overflow = offenders.length > 15 ? `\n  ...and ${offenders.length - 15} more` : '';

    expect(
      offenders,
      `${offenders.length} lockfile entries install with no integrity verification, so \`npm ci\` ` +
        `fetches them unchecked in CI and in the signed release build.\n\n` +
        `This is what regenerating package-lock.json against a populated node_modules does. ` +
        `\`npm install --package-lock-only\` will NOT fix it.\n\n` +
        `Repair with: ${REPAIR_COMMAND}\n\n  ${preview}${overflow}`,
    ).toEqual([]);
  });

  it('exempts the root project, workspace roots, and workspace symlinks', () => {
    // These three shapes are correct with no tarball. If the scan ever starts flagging them
    // it will fail on a healthy lockfile, which is how a guard gets disabled.
    expect(
      findMetadataOffenders({
        '': { version: '0.41.0' },
        'packages/protocol': { version: '0.14.0' },
        'node_modules/@kangentic/protocol': { resolved: 'packages/protocol', link: true },
      }),
    ).toEqual([]);
  });

  it('catches an entry stripped of either field', () => {
    // Red-green proof against a synthetic lockfile, so the guard is shown to fail on the
    // exact damage it exists to catch without mutating the real file to find out.
    const healthy = {
      resolved: 'https://registry.npmjs.org/semver/-/semver-6.3.1.tgz',
      integrity: 'sha512-BR7VvDCVHO+q2xBEWskxS6DJE1qRnb7DxzUrogb71CWoSficBxYsiAGd+Kl0mmq/MprG9yArRkyrQxTO6XjMzA==',
    };

    expect(findMetadataOffenders({ 'node_modules/semver': { ...healthy } })).toEqual([]);
    expect(
      findMetadataOffenders({ 'node_modules/semver': { resolved: healthy.resolved } }),
    ).toEqual(['node_modules/semver (missing integrity)']);
    expect(
      findMetadataOffenders({ 'node_modules/semver': { integrity: healthy.integrity } }),
    ).toEqual(['node_modules/semver (missing resolved)']);
    expect(findMetadataOffenders({ 'node_modules/semver': { version: '6.3.1' } })).toEqual([
      'node_modules/semver (missing resolved and integrity)',
    ]);
  });
});
