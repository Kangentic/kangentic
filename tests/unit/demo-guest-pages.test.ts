/**
 * demo/README.md ("Browser guest") states three constraints every page under demo/guest/ must
 * hold whatever it shows, because the frame's iframe stands in for a real webview and stills and
 * posters must be deterministic: (1) it fetches nothing off-origin (no remote font, icon, image,
 * stylesheet, or script), (2) one fixed light palette with no `prefers-color-scheme` (the iframe
 * follows the visitor's OS, not the frame's `theme=`), (3) no CSS animation or transition, and
 * (4) it draws in the demo's own sans face, which demo/boot.js registers in its document: a page
 * that asked for `system-ui` drew in DejaVu, Segoe UI or SF by the visitor's OS, and its text
 * wrapped and measured differently from its Linux-shot poster (v0.62.0's poster gate).
 * Nothing mechanical enforced any of these before this test: the off-origin assertion in
 * tests/demo/static-demo.spec.ts ("the board scene makes no request off the serving origin")
 * runs only for the `board` scene, which never loads a guest page.
 *
 * This is driven by DEMO_PROJECTS' own `guest_page` field rather than a hardcoded filename, so a
 * newly authored guest page is covered with no test change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_PROJECTS } from '../captures/helpers/demo-dataset';
import { DEMO_FONT_FAMILIES } from '../../scripts/lib/demo-fonts.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GUEST_DIRECTORY = path.join(REPO_ROOT, 'demo', 'guest');

/**
 * Strips HTML comments before scanning. A guest page's own head comment documents this exact
 * rule in prose (it names off-origin fetches and the OS color scheme as concepts), so a check that
 * matched words rather than syntax could trip on that documentation.
 */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

// A `src`/`href` attribute value that starts with a scheme or is protocol-relative ("//...") is
// off-origin. A same-origin absolute path ("/logo.svg") or a fragment ("#anchor") has no leading
// "//" right after the quote, so neither matches. The lookbehind requires a preceding whitespace
// character so "data-src" or "aria-href"-shaped attributes are never mistaken for "src"/"href".
const OFF_ORIGIN_ATTRIBUTE = /(?<=\s)(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+["']/gi;
const OFF_ORIGIN_CSS_URL = /url\(\s*["']?(?:https?:)?\/\/[^"')]+["']?\s*\)/gi;
const OFF_ORIGIN_CSS_IMPORT = /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/[^"');]+/gi;
const PREFERS_COLOR_SCHEME = /prefers-color-scheme/gi;
const CSS_KEYFRAMES = /@keyframes\b/gi;
// Requires the actual declaration syntax ("property:"), not just the word, so a selector like
// `.transition-panel {` or prose mentioning "animation" never trips this.
const CSS_ANIMATION_DECLARATION = /\banimation(?:-[a-z]+)?\s*:/gi;
const CSS_TRANSITION_DECLARATION = /\btransition(?:-[a-z]+)?\s*:/gi;
// A `font-family` or `font` declaration, its value up to the semicolon or the block's end.
const CSS_FONT_DECLARATION = /(?<![-\w])font(?:-family)?\s*:\s*([^;}]+)/gi;
/** A font value a guest page may declare: the demo's sans family first, or the parent's font. */
function drawsInShippedFace(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === 'inherit' || trimmed.startsWith(`"${DEMO_FONT_FAMILIES.sans}"`) || trimmed.startsWith(`'${DEMO_FONT_FAMILIES.sans}'`);
}

/**
 * Finds every violation of the guest-page constraints above in the given HTML source. Returns an
 * empty array for a clean page. Every check matches CSS/HTML syntax (an attribute, a url(), an
 * at-rule, a property declaration), never a bare word, so prose that names these concepts (like a
 * page's own head comment) never trips it.
 */
function findGuestPageViolations(html: string): string[] {
  const withoutComments = stripHtmlComments(html);
  const violations: string[] = [];

  for (const match of withoutComments.matchAll(OFF_ORIGIN_ATTRIBUTE)) {
    violations.push(`off-origin src/href attribute: ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(OFF_ORIGIN_CSS_URL)) {
    violations.push(`off-origin CSS url(): ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(OFF_ORIGIN_CSS_IMPORT)) {
    violations.push(`off-origin CSS @import: ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(PREFERS_COLOR_SCHEME)) {
    violations.push(`follows the visitor's OS color scheme: ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(CSS_KEYFRAMES)) {
    violations.push(`declares a CSS animation: ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(CSS_ANIMATION_DECLARATION)) {
    violations.push(`declares a CSS animation: ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(CSS_TRANSITION_DECLARATION)) {
    violations.push(`declares a CSS transition: ${match[0]}`);
  }
  for (const match of withoutComments.matchAll(CSS_FONT_DECLARATION)) {
    if (!drawsInShippedFace(match[1])) violations.push(`draws in a face the demo does not ship: ${match[0].trim()}`);
  }

  return violations;
}

describe('findGuestPageViolations()', () => {
  const CLEAN_FIXTURE = `<!doctype html>
<html>
  <head>
    <!-- mentions off-origin and prefers-color-scheme in prose only, never as syntax -->
    <style>
      :root { --page: #ffffff; }
      body { background: var(--page); }
    </style>
  </head>
  <body>
    <img src="/local/logo.svg" alt="logo" />
    <a href="#anchor">Anchor</a>
  </body>
</html>`;

  it('returns no violations for a clean page', () => {
    expect(findGuestPageViolations(CLEAN_FIXTURE)).toEqual([]);
  });

  it('does not flag a same-origin absolute path or a hyphenated attribute name', () => {
    const html = CLEAN_FIXTURE.replace(
      '<img src="/local/logo.svg" alt="logo" />',
      '<img src="/local/logo.svg" data-src="https://cdn.example.com/ignored.svg" alt="logo" />',
    );
    // data-src is a data attribute, not the src attribute the renderer or browser would fetch,
    // so it must never be flagged even though it contains an off-origin-looking value.
    expect(findGuestPageViolations(html)).toEqual([]);
  });

  it('flags an off-origin script src', () => {
    const html = CLEAN_FIXTURE.replace(
      '<img src="/local/logo.svg" alt="logo" />',
      '<script src="https://cdn.example.com/lib.js"></script>',
    );
    expect(findGuestPageViolations(html).some((violation) => violation.includes('off-origin src/href attribute'))).toBe(true);
  });

  it('flags a protocol-relative stylesheet href', () => {
    const html = CLEAN_FIXTURE.replace('</head>', '    <link rel="stylesheet" href="//fonts.example.com/css" />\n  </head>');
    expect(findGuestPageViolations(html).some((violation) => violation.includes('off-origin src/href attribute'))).toBe(true);
  });

  it('flags an off-origin CSS url()', () => {
    const html = CLEAN_FIXTURE.replace(
      'body { background: var(--page); }',
      "body { background: url('https://cdn.example.com/bg.png'); }",
    );
    expect(findGuestPageViolations(html).some((violation) => violation.includes('off-origin CSS url()'))).toBe(true);
  });

  it('flags an off-origin CSS @import', () => {
    const html = CLEAN_FIXTURE.replace('<style>', "<style>\n      @import url('https://fonts.example.com/css');");
    expect(findGuestPageViolations(html).some((violation) => violation.includes('off-origin CSS @import'))).toBe(true);
  });

  it('flags a prefers-color-scheme media query', () => {
    const html = CLEAN_FIXTURE.replace(
      'body { background: var(--page); }',
      '@media (prefers-color-scheme: dark) { body { background: #000000; } }\n      body { background: var(--page); }',
    );
    expect(findGuestPageViolations(html).some((violation) => violation.includes("visitor's OS color scheme"))).toBe(true);
  });

  it('flags a CSS transition declaration', () => {
    const html = CLEAN_FIXTURE.replace(
      'body { background: var(--page); }',
      'body { background: var(--page); transition: opacity 0.2s; }',
    );
    expect(findGuestPageViolations(html).some((violation) => violation.includes('CSS transition'))).toBe(true);
  });

  it('flags a CSS animation declaration', () => {
    const html = CLEAN_FIXTURE.replace(
      'body { background: var(--page); }',
      'body { background: var(--page); animation: spin 1s linear infinite; }',
    );
    expect(findGuestPageViolations(html).some((violation) => violation.includes('CSS animation'))).toBe(true);
  });

  it('flags an @keyframes rule with no separate animation declaration', () => {
    const html = CLEAN_FIXTURE.replace(
      '</style>',
      '      @keyframes spin { from { transform: rotate(0deg); } }\n    </style>',
    );
    expect(findGuestPageViolations(html).some((violation) => violation.includes('CSS animation'))).toBe(true);
  });

  it('flags a page that draws in the visitor\'s system face, and passes the shipped face or an inherited font', () => {
    const systemFace = CLEAN_FIXTURE.replace('body { background: var(--page); }', 'body { background: var(--page); font-family: system-ui, sans-serif; }');
    expect(findGuestPageViolations(systemFace).some((violation) => violation.includes('a face the demo does not ship'))).toBe(true);
    const shorthand = CLEAN_FIXTURE.replace('body { background: var(--page); }', 'button { font: 14px Arial; }');
    expect(findGuestPageViolations(shorthand).some((violation) => violation.includes('a face the demo does not ship'))).toBe(true);
    const shipped = CLEAN_FIXTURE.replace('body { background: var(--page); }', `body { font-family: "${DEMO_FONT_FAMILIES.sans}", sans-serif; font-size: 16px; } button { font: inherit; }`);
    expect(findGuestPageViolations(shipped)).toEqual([]);
  });

  it('does not flag a selector or class name that merely contains the word transition or animation', () => {
    const html = CLEAN_FIXTURE.replace(
      'body { background: var(--page); }',
      '.transition-panel, .animation-frame { background: var(--page); }',
    );
    expect(findGuestPageViolations(html)).toEqual([]);
  });
});

describe('every DEMO_PROJECTS guest_page holds the constraints demo/README.md documents', () => {
  const guestPages = DEMO_PROJECTS
    .map((project) => project.guest_page)
    .filter((guestPage): guestPage is string => Boolean(guestPage));

  it('DEMO_PROJECTS names at least one guest page (vacuity guard)', () => {
    expect(guestPages.length).toBeGreaterThan(0);
  });

  it.each(guestPages)('%s exists under demo/guest/', (guestPage) => {
    const filePath = path.join(GUEST_DIRECTORY, guestPage);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it.each(guestPages)('%s fetches nothing off-origin, follows no OS color scheme, animates nothing, and draws in the shipped face', (guestPage) => {
    const filePath = path.join(GUEST_DIRECTORY, guestPage);
    const html = fs.readFileSync(filePath, 'utf-8');
    expect(findGuestPageViolations(html)).toEqual([]);
  });
});
