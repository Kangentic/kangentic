/**
 * The faces the web demo ships, so the frame draws the same text on every visitor's OS.
 *
 * kangentic.com shows a poster of each demo scene until the live frame is ready, and the two have
 * to match line for line (kangentic.com #137). A frame that drew the visitor's own UI face (Segoe UI,
 * SF, Roboto, Liberation Sans) and Consolas wraps and measures differently on every OS, so no poster
 * could match. The demo therefore ships its faces, demo only, and never `local()`, so an installed
 * copy with other metrics cannot stand in:
 *
 *   Kangentic Demo Sans     Roboto 400, 500, 600 and 700 (the weights the board uses), for every
 *                           --font-sans text.
 *   Kangentic Demo Mono     Inconsolata 400 to 700, for xterm and every --font-mono text. Its advance
 *                           is exactly half an em, so the 12px cell is 6 CSS px wide, the Consolas
 *                           grid the sessions were recorded at; with line height 1.17 it is 14 tall.
 *   Kangentic Demo Symbols  The glyphs neither covers that the demo shows (an agent's spinner, its
 *                           arrows and bullets, the language picker's native names), cut from Noto
 *                           faces by scripts/cut-demo-fonts.mjs into demo/fonts/, one regular face
 *                           per source file, each with exactly its codepoints as its unicode-range.
 *
 * demo/vite.config.mts emits each file under a content hash and hands demo/boot.js the list as
 * `window.__demoFonts`; boot.js registers every face with the FontFace API, waits for the ones
 * marked `awaited` before it reports ready, and puts the stacks first in --font-sans and
 * --font-mono. A face not awaited (the latin-ext and Cyrillic subsets) loads when a text first
 * needs it, as a stylesheet face would. The trade-off is on record in .claude/rules/web-demo-parity.md:
 * a Windows visitor sees Roboto in the demo and Segoe UI in the installed app.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEMO_FONT_FAMILIES = {
  sans: 'Kangentic Demo Sans',
  mono: 'Kangentic Demo Mono',
  symbols: 'Kangentic Demo Symbols',
};

/** What boot.js puts first in --font-sans and --font-mono, and the terminal's fontFamily. */
export const DEMO_FONT_STACKS = {
  sans: `'${DEMO_FONT_FAMILIES.sans}', '${DEMO_FONT_FAMILIES.symbols}', sans-serif`,
  mono: `'${DEMO_FONT_FAMILIES.mono}', '${DEMO_FONT_FAMILIES.symbols}', monospace`,
};

/**
 * xterm's line height in the demo: Inconsolata's 12px glyph box is 12 device pixels at 100
 * percent, and xterm floors 12 x 1.17 to the 14px row the recordings were made at.
 */
export const DEMO_TERMINAL_LINE_HEIGHT = 1.17;

/** The weights the board draws (Tailwind's font-normal, -medium, -semibold, -bold). */
export const DEMO_FONT_WEIGHTS = [400, 500, 600, 700];

/**
 * The two Fontsource packages the primary faces come from, and the subsets each ships. The
 * `latin` subset is awaited before ready, since every scene draws it; the others load on demand.
 */
export const DEMO_PRIMARY_SOURCES = [
  { family: DEMO_FONT_FAMILIES.sans, packageName: '@fontsource/roboto', filePrefix: 'roboto', subsets: ['latin', 'latin-ext', 'cyrillic'] },
  { family: DEMO_FONT_FAMILIES.mono, packageName: '@fontsource/inconsolata', filePrefix: 'inconsolata', subsets: ['latin', 'latin-ext'] },
];
const AWAITED_SUBSET = 'latin';

/** Where the cut symbol faces live, committed, beside the manifest the cut writes. */
export const DEMO_SYMBOL_FONTS_DIR = path.join('demo', 'fonts');
export const DEMO_SYMBOL_MANIFEST = 'symbols.json';

/**
 * A subset's unicode-range as Fontsource's own stylesheet declares it (`<weight>.css`, one block
 * per subset under a `/* <prefix>-<subset>-<weight>-normal *\/` comment), so the range a face
 * carries here is the one the package was built with.
 */
export function fontsourceUnicodeRange(packageDir, filePrefix, subset, weight) {
  const cssPath = path.join(packageDir, `${weight}.css`);
  const css = fs.readFileSync(cssPath, 'utf8');
  const marker = `/* ${filePrefix}-${subset}-${weight}-normal */`;
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`${cssPath} declares no ${subset} subset at ${weight}`);
  const block = css.slice(start, css.indexOf('}', start));
  const range = block.match(/unicode-range:\s*([^;]+);/);
  if (!range) throw new Error(`${cssPath}'s ${subset} block at ${weight} carries no unicode-range`);
  return range[1].trim();
}

/** Codepoints as the shortest unicode-range that names exactly them (`U+2190,U+2713-2714`). */
export function unicodeRangeOf(codepoints) {
  const sorted = [...new Set(codepoints)].sort((left, right) => left - right);
  const parts = [];
  const hex = (code) => code.toString(16).toUpperCase().padStart(4, '0');
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index];
    parts.push(start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
  }
  return parts.join(',');
}

/** The cut's manifest: `{ faces: [{ file, source, codepoints }], gaps }`, or a throw naming the fix. */
export function readSymbolManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, DEMO_SYMBOL_FONTS_DIR, DEMO_SYMBOL_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${manifestPath} is missing. Run "node scripts/cut-demo-fonts.mjs" to cut the symbol faces.`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/**
 * Every face the demo registers, primary ones first, each with the file it loads from. Throws
 * naming the file when one is missing, so the build fails rather than shipping a frame that falls
 * back to the visitor's faces. `primaryOnly` leaves out the cut symbol faces, which is what the cut
 * itself measures against before it has written them.
 *
 * @param {string} repoRoot
 * @param {{ primaryOnly?: boolean }} [options]
 */
export function demoFontFaces(repoRoot, options = {}) {
  const faces = [];
  for (const source of DEMO_PRIMARY_SOURCES) {
    const packageDir = path.join(repoRoot, 'node_modules', ...source.packageName.split('/'));
    for (const weight of DEMO_FONT_WEIGHTS) {
      for (const subset of source.subsets) {
        const file = path.join(packageDir, 'files', `${source.filePrefix}-${subset}-${weight}-normal.woff2`);
        if (!fs.existsSync(file)) throw new Error(`${file} is missing; is ${source.packageName} installed?`);
        faces.push({
          family: source.family,
          weight,
          file,
          name: `${source.filePrefix}-${subset}-${weight}.woff2`,
          unicodeRange: fontsourceUnicodeRange(packageDir, source.filePrefix, subset, weight),
          awaited: subset === AWAITED_SUBSET,
        });
      }
    }
  }
  if (options.primaryOnly) return faces;
  for (const face of readSymbolManifest(repoRoot).faces) {
    const file = path.join(repoRoot, DEMO_SYMBOL_FONTS_DIR, face.file);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing. Run "node scripts/cut-demo-fonts.mjs".`);
    faces.push({
      family: DEMO_FONT_FAMILIES.symbols,
      weight: 400,
      file,
      name: face.file,
      unicodeRange: unicodeRangeOf(face.codepoints),
      awaited: true,
    });
  }
  return faces;
}
