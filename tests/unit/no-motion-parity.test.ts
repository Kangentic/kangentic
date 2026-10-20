import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The desktop app never matches `prefers-reduced-motion: reduce`: main appends
// Chromium's force-prefers-no-reduced-motion switch (src/main/index.ts), and
// the only motion off switch is Settings > Performance > Animations, which puts
// `.no-motion` on <html>. The reduced-motion styles stay for the web build.
//
// So anything the reduced-motion styles stop must also be stopped by
// `.no-motion`, or the desktop app cannot stop it at all. `.no-motion *` zeroes
// `animation-duration` on every element, which covers animations. It does not
// touch transitions or any other property, so those need their own
// `.no-motion` rule. These scans hold both places the renderer reads the query:
// the `@media` blocks in index.css and Tailwind's `motion-reduce:` variant.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');
const INDEX_CSS_PATH = path.join(RENDERER_ROOT, 'index.css');

// Any spelling of the header: extra media features, no space after the colon.
const REDUCED_MOTION_MEDIA = /@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{/g;
const NO_MOTION_VARIANT = '[.no-motion_&]:';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

/** Split a selector list on its top-level commas, so `:is(a, b)` stays whole. */
function splitSelectorList(selectorList: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of selectorList) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      selectors.push(normalizeSelector(current));
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') selectors.push(normalizeSelector(current));
  return selectors;
}

/** The inner text of every reduced-motion media block, braces matched. */
function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  const header = new RegExp(REDUCED_MOTION_MEDIA.source, 'g');
  for (;;) {
    const match = header.exec(css);
    if (match === null) return blocks;
    const openBraceIndex = match.index + match[0].length - 1;
    let depth = 0;
    let closeBraceIndex = -1;
    for (let index = openBraceIndex; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          closeBraceIndex = index;
          break;
        }
      }
    }
    if (closeBraceIndex === -1) throw new Error('Unbalanced braces after a reduced-motion media block');
    blocks.push(css.slice(openBraceIndex + 1, closeBraceIndex));
    header.lastIndex = closeBraceIndex + 1;
  }
}

/** Every selector any rule in the file is written for, at any nesting depth. */
function allSelectors(css: string): Set<string> {
  const selectors = new Set<string>();
  for (const match of css.matchAll(/([^{};]+)\{/g)) {
    for (const selector of splitSelectorList(match[1])) selectors.add(selector);
  }
  return selectors;
}

/**
 * Selectors a reduced-motion block stops something on that no `.no-motion`
 * rule also stops. A rule that only sets animation properties is covered by
 * `.no-motion *`, provided that rule exists (checked separately).
 */
function missingNoMotionCounterparts(rawCss: string): string[] {
  const css = stripComments(rawCss);
  const knownSelectors = allSelectors(css);
  const missing: string[] = [];
  for (const block of reducedMotionBlocks(css)) {
    for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const properties = rule[2]
        .split(';')
        .map((declaration) => declaration.split(':')[0].trim())
        .filter((property) => property !== '');
      if (properties.every((property) => /^animation(-|$)/.test(property))) continue;
      for (const selector of splitSelectorList(rule[1])) {
        if (!knownSelectors.has(`.no-motion ${selector}`)) missing.push(selector);
      }
    }
  }
  return missing;
}

/**
 * `motion-reduce:` utilities on a line that has no `[.no-motion_&]:` twin. The
 * twin must sit on the same source line, and it must be the whole utility, so
 * `[.no-motion_&]:transition-none` does not pair with `motion-reduce:transition`.
 */
function unpairedMotionReduceUtilities(source: string): string[] {
  const unpaired: string[] = [];
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(/motion-reduce:([^\s'"`]+)/g)) {
      const twin = new RegExp(`${escapeRegExp(`${NO_MOTION_VARIANT}${match[1]}`)}(?=[\\s'"\`]|$)`);
      if (!twin.test(line)) unpaired.push(match[0]);
    }
  }
  return unpaired;
}

function rendererSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...rendererSourceFiles(entryPath));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

const indexCss = fs.readFileSync(INDEX_CSS_PATH, 'utf-8');

describe('.no-motion stops everything reduced motion stops', () => {
  it('keeps the rule that zeroes every animation under .no-motion', () => {
    const normalized = stripComments(indexCss).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      '.no-motion *, .no-motion *::before, .no-motion *::after { animation-duration: 0s !important; }',
    );
  });

  it('gives every non-animation rule in a reduced-motion block a .no-motion counterpart', () => {
    expect(reducedMotionBlocks(stripComments(indexCss)).length).toBeGreaterThan(0);
    expect(missingNoMotionCounterparts(indexCss)).toEqual([]);
  });

  it('flags a reduced-motion transition with no .no-motion counterpart', () => {
    const css = `
      .thumb { transition: transform 150ms; }
      .pulse { animation: pulse 1s infinite; }
      @media (prefers-reduced-motion: reduce) {
        .thumb, .other:is(.a, .b) { transition: none; }
        .pulse { animation: none; }
      }
      @media screen and (prefers-reduced-motion:reduce) {
        .tight { transition: none; }
      }
      .no-motion .other:is(.a, .b) { transition: none; }
    `;
    expect(missingNoMotionCounterparts(css)).toEqual(['.thumb', '.tight']);
  });

  it('gives every Tailwind motion-reduce: utility a [.no-motion_&]: twin', () => {
    const unpairedByFile: Record<string, string[]> = {};
    let motionReduceSites = 0;
    for (const file of rendererSourceFiles(RENDERER_ROOT)) {
      const source = fs.readFileSync(file, 'utf-8');
      motionReduceSites += (source.match(/motion-reduce:/g) ?? []).length;
      const unpaired = unpairedMotionReduceUtilities(source);
      if (unpaired.length > 0) unpairedByFile[path.relative(REPO_ROOT, file)] = unpaired;
    }
    expect(motionReduceSites).toBeGreaterThan(0);
    expect(unpairedByFile).toEqual({});
  });

  it('flags a motion-reduce: utility whose line lacks the twin', () => {
    const source = [
      "const paired = 'transition-[height] motion-reduce:transition-none [.no-motion_&]:transition-none';",
      "const unpaired = 'transition-transform motion-reduce:transition-none';",
      "const prefixOnly = 'transition motion-reduce:transition [.no-motion_&]:transition-none';",
    ].join('\n');
    expect(unpairedMotionReduceUtilities(source)).toEqual([
      'motion-reduce:transition-none',
      'motion-reduce:transition',
    ]);
  });
});
