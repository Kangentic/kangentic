/**
 * Every codepoint the web demo can draw, and the ones it knowingly cannot, for the faces it ships
 * (scripts/lib/demo-fonts.mjs). scripts/cut-demo-fonts.mjs cuts the symbol faces from this set, and
 * tests/unit/demo-fonts.test.ts fails when a codepoint in it is in no shipped face, so a
 * new recording or a new UI string cannot quietly bring back a per-OS fallback glyph.
 *
 * Two kinds of text, read from what the frame shows:
 *
 *   terminal  the recordings (tests/captures/fixtures/demo/). xterm draws box drawing, block
 *             elements, braille and the powerline and legacy-computing symbols itself
 *             (`customGlyphs`), so those never need a face.
 *   ui        the renderer and shared source (literal glyphs in the UI and the language picker's
 *             native names), the dataset the seed builds the board from, and the English and German
 *             catalogs (the `settings-language` scene switches to German). Source comments are read
 *             too, which costs a few extra glyphs and is why a gap below names one.
 *
 * Only codepoints past ASCII count, and invisible format characters (variation selectors, zero
 * width joiners and marks) are skipped, since no face draws them.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Codepoints the demo carries and no shipped face covers, each with why it is left. */
export const DEMO_GLYPH_GAPS = {
  0x2139: 'Gemini prints it in one recording (spring-petclinic-gemini-owner-search), and no OFL face on Fontsource carries U+2139, so it falls back to the visitor\'s own face',
  0x257f: 'only in a source comment in terminal-links/buffer-line-text.ts; xterm draws it in the terminal',
};

/** What xterm's WebGL renderer draws itself rather than from a face. */
export function isDrawnByXterm(code) {
  return (code >= 0x2500 && code <= 0x259f)
    || (code >= 0x2800 && code <= 0x28ff)
    || (code >= 0xe0a0 && code <= 0xe0d4)
    || (code >= 0x1fb00 && code <= 0x1fbff);
}

function isInvisibleFormat(code) {
  return (code >= 0x200b && code <= 0x200f)
    || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2064)
    || (code >= 0xfe00 && code <= 0xfe0f)
    || code === 0xfeff;
}

const TERMINAL_SOURCES = [{ dir: 'tests/captures/fixtures/demo', pattern: /\.json$/ }];
const UI_SOURCES = [
  { dir: 'src/renderer', pattern: /\.(tsx?|css)$/ },
  { dir: 'src/shared', pattern: /\.tsx?$/ },
  { dir: 'tests/captures/helpers', pattern: /\.ts$/ },
  { dir: 'src/locales/en', pattern: /\.po$/ },
  { dir: 'src/locales/de', pattern: /\.po$/ },
];

function filesUnder(root, pattern) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  // Sorted by the forward-slash form, so the first file a codepoint is seen in, which a failure
  // names, is the same on every OS (`\` and `/` order differently against letters).
  const sortKey = (file) => file.split(path.sep).join('/');
  return found.sort((left, right) => (sortKey(left) < sortKey(right) ? -1 : sortKey(left) > sortKey(right) ? 1 : 0));
}

/**
 * The codepoints in each kind of text, each with the first file it was seen in, keyed by
 * codepoint: `{ terminal: Map<code, file>, ui: Map<code, file> }`. The terminal map leaves out
 * what xterm draws.
 */
export function collectDemoCodepoints(repoRoot) {
  const read = (sources, skip) => {
    const seen = new Map();
    for (const source of sources) {
      for (const file of filesUnder(path.join(repoRoot, source.dir), source.pattern)) {
        for (const character of fs.readFileSync(file, 'utf8')) {
          const code = character.codePointAt(0);
          if (code < 0x80 || isInvisibleFormat(code) || skip(code) || seen.has(code)) continue;
          seen.set(code, path.relative(repoRoot, file).split(path.sep).join('/'));
        }
      }
    }
    return seen;
  };
  return { terminal: read(TERMINAL_SOURCES, isDrawnByXterm), ui: read(UI_SOURCES, () => false) };
}
