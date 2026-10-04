/**
 * The `overrides` entry that lifts monaco-editor's DOMPurify must only ever lift it.
 *
 * monaco-editor 0.57.0 pins `dompurify` at exactly 3.4.15, which GHSA-p98j-92pf-mc4p
 * (patched in 3.4.16) covers, and monaco ships inside the renderer bundle. So
 * package.json overrides monaco's copy to the patched release. An override is a
 * pin: once a later monaco asks for a newer DOMPurify on its own, this entry would
 * silently force the older one back. This fails at that point so the override is
 * removed instead of turning into a downgrade.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as T;
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

  it('is what actually installs', () => {
    if (overridden === undefined) return;
    const installed = readJson<{ version: string }>('node_modules/dompurify/package.json').version;
    expect(installed).toBe(overridden);
  });

  it('compares versions numerically, not as text', () => {
    expect(compareVersions('3.4.16', '3.4.15')).toBeGreaterThan(0);
    expect(compareVersions('3.4.9', '3.4.15')).toBeLessThan(0);
    expect(compareVersions('3.4.16', '^3.4.16')).toBe(0);
    expect(compareVersions('3.4.16', '3.5.0')).toBeLessThan(0);
  });
});
