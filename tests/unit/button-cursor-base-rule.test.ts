import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Guards the Tailwind v4 Preflight regression fix: v4 dropped v3's default
// `button { cursor: pointer }`, so src/renderer/index.css restores it in a
// @layer base block. This is load-bearing beyond aesthetics: the window
// light-dismiss heuristic (useClickOutsideToClose.ts) reads the computed cursor
// to decide whether a click target is actionable. A silent deletion of this
// rule would regress both the button cursor and that dismissal behavior.
//
// The @layer base wrapping is itself load-bearing: in Tailwind v4 an unlayered
// rule outranks the utilities layer, so hoisting these declarations out of the
// layer would silently break cursor-* / select-text utility overrides. The tests
// below therefore assert the rules live INSIDE the @layer base block, so that
// removing either the rule or its layer wrapper turns the guard red.

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_CSS_PATH = path.join(REPO_ROOT, 'src/renderer/index.css');

function normalizeWhitespace(css: string): string {
  return css.replace(/\s+/g, ' ').trim();
}

// Returns the inner text of the first `@layer base { ... }` block, matching
// braces so the nested rule blocks are captured. Empty string if the layer is
// absent (which fails the assertions below, catching a hoist-out-of-layer edit).
function extractLayerBaseBlock(css: string): string {
  const marker = '@layer base {';
  const blockStart = css.indexOf(marker);
  if (blockStart === -1) return '';
  const openBraceIndex = blockStart + marker.length - 1;
  let braceDepth = 0;
  for (let index = openBraceIndex; index < css.length; index += 1) {
    if (css[index] === '{') braceDepth += 1;
    else if (css[index] === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return css.slice(openBraceIndex + 1, index);
    }
  }
  return '';
}

const normalizedCss = normalizeWhitespace(fs.readFileSync(INDEX_CSS_PATH, 'utf-8'));
const layerBaseBlock = extractLayerBaseBlock(normalizedCss);

describe('button cursor base rule (Tailwind v4 Preflight regression guard)', () => {
  it('restores cursor:pointer on buttons and role="button" inside @layer base', () => {
    expect(layerBaseBlock).toContain(
      normalizeWhitespace('button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; }'),
    );
  });

  it('disables text selection on native buttons inside @layer base', () => {
    expect(layerBaseBlock).toContain(normalizeWhitespace('button { user-select: none; }'));
  });
});
