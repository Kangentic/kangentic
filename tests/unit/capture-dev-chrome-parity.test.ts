import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Capture dev-chrome parity guard.
 *
 * TitleBar.tsx renders a `[data-testid="titlebar-dev-badge"]` "(dev)" badge
 * whenever `__KANGENTIC_DEV__` is true. Marketing captures under
 * tests/captures/ render against the shared Vite dev server
 * (playwright.config.ts's `webServer`), so `__KANGENTIC_DEV__` is always true
 * there and the badge WOULD appear in every screenshot and video unless a
 * capture explicitly hides it via `hideDevOnlyChrome` (capture-page.ts).
 * `launchCapturePage` calls it for every capture routed through it, but a
 * capture that builds its OWN Chromium page - the way
 * walkthrough.capture.ts does - has to call it separately, and nothing forces
 * that call to stay in place.
 *
 * tests/captures/** has no other gate that would catch a missing or deleted
 * call: tsconfig.json's `include` only covers src/** and
 * packages/protocol/src/**, so this tree is never typechecked; `npm run
 * lint` only runs eslint against src/ and packages/protocol/src/; and
 * .github/workflows/ci.yml has no captures tier. So a bespoke-page capture
 * that forgets the call, or a deleted call in an existing one, ships a
 * marketing screenshot/video with a raw "(dev)" badge and nothing fails.
 *
 * This test (pure source analysis, no Vite server or browser needed - runs
 * in CI via the unit tier) makes that regression unmergeable: every file
 * under tests/captures/** that constructs its own Playwright page
 * (chromium.launch / .newContext / .newPage) must also call
 * hideDevOnlyChrome(...) somewhere in that same file.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const CAPTURES_DIR = path.join(REPO_ROOT, 'tests/captures');

const PAGE_CONSTRUCTION_PATTERNS = [/chromium\.launch\(/, /\.newContext\(/, /\.newPage\(/];
const HIDE_CALL_PATTERN = /hideDevOnlyChrome\(/;

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (path.extname(entry.name) === '.ts') {
      files.push(fullPath);
    }
  }
  return files;
}

function toRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

/** Every tests/captures/**\/*.ts file that constructs its own Playwright
 *  page, i.e. matches at least one of PAGE_CONSTRUCTION_PATTERNS. */
const pageConstructingFiles = collectSourceFiles(CAPTURES_DIR)
  .filter((filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    return PAGE_CONSTRUCTION_PATTERNS.some((pattern) => pattern.test(content));
  })
  .map(toRelative)
  .sort();

describe('capture dev-chrome parity: scan is not vacuous', () => {
  it('finds both known bespoke-page capture files', () => {
    // If a future Playwright/Chromium refactor renames chromium.launch /
    // newContext / newPage, PAGE_CONSTRUCTION_PATTERNS would silently stop
    // matching anything and the check below would vacuously pass over zero
    // files. Pinning the two known offenders means that refactor fails here
    // instead of shipping a badge with nobody watching for it.
    expect(pageConstructingFiles).toContain('tests/captures/helpers/capture-page.ts');
    expect(pageConstructingFiles).toContain('tests/captures/features/walkthrough.capture.ts');
    expect(pageConstructingFiles.length).toBeGreaterThanOrEqual(2);
  });
});

describe('capture dev-chrome parity: every bespoke-page capture hides the dev badge', () => {
  it('every file that constructs its own page also calls hideDevOnlyChrome(...)', () => {
    const offenders = pageConstructingFiles.filter((relativePath) => {
      const content = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
      return !HIDE_CALL_PATTERN.test(content);
    });
    expect(
      offenders,
      `These tests/captures files construct their own Playwright page `
        + `(chromium.launch / .newContext / .newPage) but never call `
        + `hideDevOnlyChrome(page) (tests/captures/helpers/capture-page.ts). `
        + `Without that call the title bar's "(dev)" badge `
        + `([data-testid="titlebar-dev-badge"]) renders against the dev `
        + `server and ships in the marketing screenshot or video. Add `
        + `\`await hideDevOnlyChrome(page);\` right after the page is `
        + `created:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
