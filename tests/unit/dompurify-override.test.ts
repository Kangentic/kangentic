/**
 * What the `overrides.monaco-editor.dompurify` entry does, and what it does not.
 *
 * monaco-editor 0.57.0 declares `dompurify` at exactly 3.4.15, which GHSA-p98j-92pf-mc4p (patched
 * in 3.4.16) covers, so package.json overrides that dependency to 3.4.16. That changes only
 * `node_modules/dompurify`, a dev-scoped copy nothing imports. The DOMPurify that ships is the copy
 * monaco VENDORS at `esm/vs/base/browser/dompurify/dompurify.js` and imports by relative path from
 * `domSanitize.js`, so the renderer bundle carries 3.4.15 whatever the override says. The override
 * keeps the lockfile out of Dependabot's alerts; it is not a fix for shipped code. The exposure in
 * the shipped copy is low: the advisory needs `IN_PLACE` plus a node-removing hook, and monaco calls
 * DOMPurify with `RETURN_DOM_FRAGMENT` / `RETURN_TRUSTED_TYPE` only.
 *
 * An override is a pin: once a later monaco asks for a newer DOMPurify on its own, this entry would
 * silently force the older one back. The tests fail at that point, and when monaco vendors a
 * patched copy, so the entry is removed rather than outliving its reason.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VENDORED_DOMPURIFY = 'node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js';
const MONACO_SANITIZER = 'node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js';

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as T;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Compares two exact `major.minor.patch` versions; a range such as `^3.4.15` reads as its floor. */
function compareVersions(left: string, right: string): number {
  const parse = (version: string) => version.replace(/^[^\d]*/, '').split('.').map((part) => Number.parseInt(part, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe('the monaco-editor DOMPurify override', () => {
  const manifest = readJson<{ overrides?: Record<string, Record<string, string>> }>('package.json');
  const overridden = manifest.overrides?.['monaco-editor']?.dompurify;
  const monacoManifest = readJson<{ version: string; dependencies?: Record<string, string> }>(
    'node_modules/monaco-editor/package.json',
  );
  const monacoWants = monacoManifest.dependencies?.dompurify;

  it('is still needed: monaco itself asks for an older DOMPurify than the override', () => {
    if (overridden === undefined) return; // removed: nothing left to guard
    expect(monacoWants, 'monaco-editor no longer depends on dompurify; remove the override').toBeTypeOf('string');
    expect(
      compareVersions(overridden, monacoWants as string),
      `monaco-editor ${monacoManifest.version} now asks for dompurify ${monacoWants}, at or past the `
      + `override's ${overridden}. Remove "overrides.monaco-editor.dompurify" from package.json, or it `
      + 'pins DOMPurify back once monaco moves further ahead.',
    ).toBeGreaterThan(0);
  });

  it('is what installs into node_modules/dompurify', () => {
    if (overridden === undefined) return;
    const installed = readJson<{ version: string }>('node_modules/dompurify/package.json').version;
    expect(installed).toBe(overridden);
  });

  // The claim this test once made was that the override fixes the shipped copy. It does not, and
  // these two pin why, so the claim cannot quietly come back.
  it('does not reach shipped code: monaco imports its own vendored copy by relative path', () => {
    const sanitizer = readText(MONACO_SANITIZER);
    expect(sanitizer).toMatch(/import\s+\w+\s+from\s+'\.\/dompurify\/dompurify\.js'/);
    expect(sanitizer).not.toMatch(/from\s+'dompurify'/);
  });

  it('leaves the vendored copy below the override; when monaco vendors a patched copy, remove the entry', () => {
    if (overridden === undefined) return;
    const vendoredVersion = readText(VENDORED_DOMPURIFY).match(/DOMPurify\.version\s*=\s*'([\d.]+)'/)?.[1];
    expect(vendoredVersion, `no DOMPurify.version found in ${VENDORED_DOMPURIFY}`).toBeTypeOf('string');
    expect(
      compareVersions(vendoredVersion as string, overridden),
      `monaco-editor ${monacoManifest.version} now vendors DOMPurify ${vendoredVersion}, at or past the `
      + `override's ${overridden}, so the advisory is fixed in shipped code. Remove `
      + '"overrides.monaco-editor.dompurify" and its section in .claude/rules/dependency-block-parity.md.',
    ).toBeLessThan(0);
  });

  it('compares versions numerically, not as text', () => {
    expect(compareVersions('3.4.16', '3.4.15')).toBeGreaterThan(0);
    expect(compareVersions('3.4.9', '3.4.15')).toBeLessThan(0);
    expect(compareVersions('3.4.16', '^3.4.16')).toBe(0);
    expect(compareVersions('3.4.16', '3.5.0')).toBeLessThan(0);
  });
});
