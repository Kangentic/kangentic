/**
 * The web demo draws only in faces it ships (scripts/lib/demo-fonts.mjs), so a poster and the live
 * frame lay out the same text the same way on every OS (kangentic.com #137). A glyph no shipped face
 * covers falls back to the visitor's own face, a different glyph and advance on each OS, and the
 * frame no longer matches its poster. Nothing at runtime says so: the text still renders. This file
 * is that check, run over the real recordings, catalogs and source, and over the real font files:
 *
 *   - every face the build registers exists, and the latin subset of each weight is awaited;
 *   - the committed symbol cut (demo/fonts/) carries exactly the codepoints its manifest claims,
 *     and no two symbol faces claim one, so the browser never has to choose between them;
 *   - every codepoint the demo carries is in a shipped face, or is a named gap whose reason still
 *     holds (DEMO_GLYPH_GAPS); a new recording with a new glyph fails here, naming the command
 *     that cuts it (`node scripts/cut-demo-fonts.mjs`);
 *   - boot.js runs the terminal in the shipped mono stack at the shipped line height.
 *
 * Tier: Unit.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { woff2FileCodepoints } from '../../scripts/lib/font-cmap.mjs';
import {
  DEMO_FONT_FAMILIES,
  DEMO_FONT_STACKS,
  DEMO_FONT_WEIGHTS,
  DEMO_SYMBOL_FONTS_DIR,
  DEMO_TERMINAL_LINE_HEIGHT,
  demoFontFaces,
  readSymbolManifest,
  unicodeRangeOf,
} from '../../scripts/lib/demo-fonts.mjs';
import { DEMO_GLYPH_GAPS, collectDemoCodepoints, isDrawnByXterm } from '../../scripts/lib/demo-glyphs.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const faces = demoFontFaces(REPO_ROOT);
const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

function coverageOf(family: string): Set<number> {
  const covered = new Set<number>();
  for (const face of faces.filter((candidate) => candidate.family === family)) {
    for (const code of woff2FileCodepoints(face.file)) covered.add(code);
  }
  return covered;
}

describe('the faces the demo ships', () => {
  it('registers every weight the board draws in both primary families, awaiting each latin subset', () => {
    for (const family of [DEMO_FONT_FAMILIES.sans, DEMO_FONT_FAMILIES.mono]) {
      for (const weight of DEMO_FONT_WEIGHTS) {
        const awaited = faces.filter((face) => face.family === family && face.weight === weight && face.awaited);
        expect(awaited.map((face) => face.name), `${family} ${weight}`).toHaveLength(1);
        expect(awaited[0].name).toContain('-latin-');
      }
    }
  });

  it('gives every face a unicode-range and a file that is a WOFF2', () => {
    for (const face of faces) {
      expect(face.unicodeRange, face.name).toMatch(/^U\+[0-9A-F]+/);
      expect(woff2FileCodepoints(face.file).size, face.name).toBeGreaterThan(0);
    }
  });

  it('puts the shipped families first in both stacks, the symbols right behind', () => {
    expect(DEMO_FONT_STACKS.sans.startsWith(`'${DEMO_FONT_FAMILIES.sans}', '${DEMO_FONT_FAMILIES.symbols}'`)).toBe(true);
    expect(DEMO_FONT_STACKS.mono.startsWith(`'${DEMO_FONT_FAMILIES.mono}', '${DEMO_FONT_FAMILIES.symbols}'`)).toBe(true);
  });

  it('runs the terminal in the mono stack at the shipped line height', () => {
    // boot.js is a classic script that cannot import the plan; the build hands it these values.
    const boot = fs.readFileSync(path.join(REPO_ROOT, 'demo', 'boot.js'), 'utf8');
    expect(boot).toContain('fontFamily: demoFonts ? demoFonts.stacks.mono');
    expect(boot).toContain('lineHeight: demoFonts ? demoFonts.terminalLineHeight');
    const config = fs.readFileSync(path.join(REPO_ROOT, 'demo', 'vite.config.mts'), 'utf8');
    expect(config).toContain('stacks: DEMO_FONT_STACKS, terminalLineHeight: DEMO_TERMINAL_LINE_HEIGHT');
    expect(DEMO_TERMINAL_LINE_HEIGHT).toBe(1.17);
  });
});

describe('the cut symbol faces (demo/fonts/)', () => {
  const manifest = readSymbolManifest(REPO_ROOT) as { faces: Array<{ file: string; codepoints: number[] }>; licences: string[] };

  // Every, not exactly: the subsetter keeps a glyph a layout feature reaches (U+22B7, U+276E), and
  // the unicode-range is built from the manifest, so a face's extra glyph is never drawn from it.
  it('carry every codepoint the manifest names, which the unicode-range then claims', () => {
    for (const face of manifest.faces) {
      const covered = woff2FileCodepoints(path.join(REPO_ROOT, DEMO_SYMBOL_FONTS_DIR, face.file));
      for (const code of face.codepoints) expect(covered.has(code), `${face.file} ${hex(code)}`).toBe(true);
    }
  });

  it('never claim one codepoint twice', () => {
    const owners = new Map<number, string>();
    for (const face of manifest.faces) {
      for (const code of face.codepoints) {
        expect(owners.get(code), `${hex(code)} is in ${owners.get(code)} and ${face.file}`).toBeUndefined();
        owners.set(code, face.file);
      }
    }
  });

  it('ship the licence of every source they were cut from', () => {
    expect(manifest.licences.length).toBeGreaterThan(0);
    for (const licence of manifest.licences) {
      expect(fs.readFileSync(path.join(REPO_ROOT, DEMO_SYMBOL_FONTS_DIR, licence), 'utf8')).toContain('SIL OPEN FONT LICENSE');
    }
  });

  it('is the only thing under demo/fonts/ besides its manifest and licences', () => {
    const named = new Set([...manifest.faces.map((face) => face.file), ...manifest.licences, 'symbols.json']);
    for (const file of fs.readdirSync(path.join(REPO_ROOT, DEMO_SYMBOL_FONTS_DIR))) expect(named.has(file), file).toBe(true);
  });
});

describe('every glyph the demo carries is in a shipped face', () => {
  const { terminal, ui } = collectDemoCodepoints(REPO_ROOT);
  const sans = coverageOf(DEMO_FONT_FAMILIES.sans);
  const mono = coverageOf(DEMO_FONT_FAMILIES.mono);
  const symbols = coverageOf(DEMO_FONT_FAMILIES.symbols);
  const fix = 'Run "node scripts/cut-demo-fonts.mjs" to cut it, or name it in DEMO_GLYPH_GAPS with the reason it is left.';

  it('reads the recordings and the UI text at all', () => {
    // A collector that read nothing would pass every check below.
    expect(terminal.size).toBeGreaterThan(20);
    expect(ui.size).toBeGreaterThan(20);
    expect(terminal.has(0x23bf)).toBe(true); // Claude's result elbow
  });

  it('draws every terminal glyph in the mono stack', () => {
    const missing = [...terminal].filter(([code]) => !mono.has(code) && !symbols.has(code) && !(code in DEMO_GLYPH_GAPS));
    expect(missing.map(([code, file]) => `${hex(code)} ${String.fromCodePoint(code)} (${file})`), fix).toEqual([]);
  });

  it('draws every UI glyph in both the sans and the mono stack', () => {
    const missing = [...ui].filter(([code]) => (!(sans.has(code) || symbols.has(code)) || !(mono.has(code) || symbols.has(code))) && !(code in DEMO_GLYPH_GAPS));
    expect(missing.map(([code, file]) => `${hex(code)} ${String.fromCodePoint(code)} (${file})`), fix).toEqual([]);
  });

  it('names no gap the demo no longer carries or a face now covers', () => {
    for (const code of Object.keys(DEMO_GLYPH_GAPS).map(Number)) {
      expect(terminal.has(code) || ui.has(code), `${hex(code)} is a named gap the demo no longer carries`).toBe(true);
      expect(symbols.has(code) || (mono.has(code) && sans.has(code)), `${hex(code)} is a named gap a shipped face covers`).toBe(false);
    }
  });

  it('leaves out of the terminal set only what xterm draws itself', () => {
    expect(isDrawnByXterm(0x2500)).toBe(true);
    expect(isDrawnByXterm(0x2800)).toBe(true);
    expect(isDrawnByXterm(0x23bf)).toBe(false);
  });
});

describe('unicodeRangeOf', () => {
  it('names exactly the codepoints, joining runs', () => {
    expect(unicodeRangeOf([0x2713, 0x2190, 0x2714, 0x2192, 0x2191])).toBe('U+2190-2192,U+2713-2714');
    expect(unicodeRangeOf([0x1f600])).toBe('U+1F600');
  });
});
