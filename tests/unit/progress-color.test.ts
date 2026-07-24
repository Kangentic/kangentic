/**
 * Unit tests for the progress-fill severity classifier.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getProgressColor } from '../../src/renderer/utils/progress-color';

describe('getProgressColor', () => {
  it('is active just below the warning boundary and warning at it (69 vs 70)', () => {
    // Pins the strict >= 70 boundary. Flipping it to > 70 would turn 70 green
    // instead of yellow while leaving every other case in this file green.
    expect(getProgressColor(69)).toBe('var(--kng-active)');
    expect(getProgressColor(70)).toBe('var(--kng-warning)');
  });

  it('is warning just below the danger boundary and danger at it (89 vs 90)', () => {
    // Pins the strict >= 90 boundary, the one that fixes the original bug: 90%
    // must read as critical, not an ambiguous mid-ramp hue.
    expect(getProgressColor(89)).toBe('var(--kng-warning)');
    expect(getProgressColor(90)).toBe('var(--kng-danger)');
  });

  it('is active at the 0 endpoint and danger at the 100 endpoint', () => {
    expect(getProgressColor(0)).toBe('var(--kng-active)');
    expect(getProgressColor(100)).toBe('var(--kng-danger)');
  });

  it('stays danger for an over-budget percentage above 100', () => {
    // Rate-limit usedPercentage is not pre-clamped before reaching this function,
    // so a value past 100 must not fall through to an unmapped band.
    expect(getProgressColor(150)).toBe('var(--kng-danger)');
  });

  it('falls back to active for a negative percentage', () => {
    expect(getProgressColor(-5)).toBe('var(--kng-active)');
  });

  it('falls back to active for NaN rather than an unmapped or malformed value', () => {
    expect(getProgressColor(NaN)).toBe('var(--kng-active)');
  });

  it('only ever returns one of the three known token references across the full range', () => {
    // The assertion a future retune-to-a-gradient cannot pass: exactly 3 distinct
    // values across 0-100, each a var(--kng-*) reference, never a hex or a blend.
    const seen = new Set<string>();
    for (let percentage = 0; percentage <= 100; percentage++) {
      const color = getProgressColor(percentage);
      expect(color).toMatch(/^var\(--kng-(active|warning|danger)\)$/);
      seen.add(color);
    }
    expect(seen.size).toBe(3);
  });
});

describe('getProgressColor CSS token declarations', () => {
  it('declares every var(--kng-*) token getProgressColor can return in the :root block of index.css', () => {
    // Derive the expected token list from the function itself, not from a
    // hardcoded list, so a future fourth band automatically extends this
    // check instead of silently escaping it.
    const returnedTokenReferences = new Set<string>();
    for (let percentage = -10; percentage <= 150; percentage++) {
      returnedTokenReferences.add(getProgressColor(percentage));
    }
    expect(returnedTokenReferences.size).toBeGreaterThan(0);

    const tokenNames = Array.from(returnedTokenReferences).map((tokenReference) => {
      const referenceMatch = tokenReference.match(/^var\((--[a-zA-Z0-9-]+)\)$/);
      if (!referenceMatch) {
        throw new Error(`getProgressColor returned a non-var() value: ${tokenReference}`);
      }
      return referenceMatch[1];
    });

    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDirectoryPath = path.dirname(currentFilePath);
    const indexCssPath = path.join(currentDirectoryPath, '../../src/renderer/index.css');
    const indexCssContents = readFileSync(indexCssPath, 'utf8');

    // Strip CSS comments before locating the :root block, otherwise a
    // token name merely mentioned in a comment (including a commented-out
    // declaration) would be mistaken for a live declaration.
    const indexCssWithoutComments = indexCssContents.replace(/\/\*[\s\S]*?\*\//g, '');

    const rootBlockMatch = indexCssWithoutComments.match(/:root\s*\{([\s\S]*?)\}/);
    if (!rootBlockMatch) {
      throw new Error('Could not locate the :root block in src/renderer/index.css');
    }
    const rootBlockContents = rootBlockMatch[1];

    for (const tokenName of tokenNames) {
      const declarationPattern = new RegExp(`(^|\\s)${tokenName}\\s*:`);
      expect(
        declarationPattern.test(rootBlockContents),
        `Expected the :root block in index.css to declare ${tokenName}, since getProgressColor can return var(${tokenName})`,
      ).toBe(true);
    }
  });
});
