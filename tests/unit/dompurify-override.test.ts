/**
 * What the `overrides.monaco-editor.dompurify` entry does, and what it does not.
 *
 * monaco-editor 0.57.0 declares `dompurify` at exactly 3.4.15. Four advisories cover that release:
 * GHSA-p98j-92pf-mc4p, patched in 3.4.16, and GHSA-mrv2-3pqr-j5jr, GHSA-cg2g-xh64-v4q7 and
 * GHSA-c6gr-qvv4-5v3f, patched in 3.4.17. So package.json overrides that dependency to 3.4.17. That
 * changes only `node_modules/dompurify`, a dev-scoped copy nothing imports. The DOMPurify that ships
 * is the copy monaco VENDORS at `esm/vs/base/browser/dompurify/dompurify.js` and imports by relative
 * path from `domSanitize.js`, so the renderer bundle carries 3.4.15 whatever the override says. The
 * override keeps the lockfile out of Dependabot's alerts; it is not a fix for shipped code.
 *
 * The shipped copy is not reachable through any of the four, because each needs a config option
 * monaco never sets. `domSanitize.js` builds its config from its own allowlists and adds only
 * `RETURN_DOM_FRAGMENT` or `RETURN_TRUSTED_TYPE`:
 * - GHSA-p98j, and GHSA-mrv2 (its incomplete fix), need `IN_PLACE` plus a hook that removes a node.
 * - GHSA-cg2g needs `SAFE_FOR_TEMPLATES`.
 * - GHSA-c6gr needs `PARSER_MEDIA_TYPE` set to `application/xhtml+xml`.
 * A test below fails once monaco's sanitizer names any of the three options.
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

  it('is at or past 3.4.17, the release that patches all four advisories', () => {
    if (overridden === undefined) return;
    expect(
      compareVersions(overridden, '3.4.17'),
      `the override's ${overridden} is below 3.4.17, which patches GHSA-mrv2-3pqr-j5jr, `
      + 'GHSA-cg2g-xh64-v4q7 and GHSA-c6gr-qvv4-5v3f. The override must not drop below the release '
      + 'that patches them.',
    ).toBeGreaterThanOrEqual(0);
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
      + `override's ${overridden}, so the advisories are fixed in shipped code. Remove `
      + '"overrides.monaco-editor.dompurify" and its section in .claude/rules/dependency-block-parity.md.',
    ).toBeLessThan(0);
  });

  // The vendored copy is below the patch, so what keeps it safe is monaco's call shape. Each
  // advisory needs one of these options; once monaco sets one, the shipped copy is exposed.
  it('is not reachable in shipped code: monaco sets none of the options the advisories need', () => {
    const sanitizer = readText(MONACO_SANITIZER);
    // Positive control: this is the file that calls DOMPurify, so an absent option means something.
    expect(sanitizer).toContain('RETURN_DOM_FRAGMENT');
    for (const option of ['IN_PLACE', 'SAFE_FOR_TEMPLATES', 'PARSER_MEDIA_TYPE']) {
      expect(
        sanitizer,
        `${MONACO_SANITIZER} now sets ${option}, which a DOMPurify advisory needs. The vendored copy `
        + 'is exposed in shipped code; re-check the advisories in this file\'s header.',
      ).not.toContain(option);
    }
  });

  it('compares versions numerically, not as text', () => {
    expect(compareVersions('3.4.16', '3.4.15')).toBeGreaterThan(0);
    expect(compareVersions('3.4.9', '3.4.15')).toBeLessThan(0);
    expect(compareVersions('3.4.16', '^3.4.16')).toBe(0);
    expect(compareVersions('3.4.16', '3.5.0')).toBeLessThan(0);
  });
});
