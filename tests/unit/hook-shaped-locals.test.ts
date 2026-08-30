/**
 * No `use`-prefixed LOCAL variables in renderer components.
 *
 * react-refresh's Babel transform treats a call to any identifier starting with
 * `use` as a custom hook, and records it in the component's refresh signature so
 * it can tell whether a hot update may preserve state. A signature entry has to
 * resolve to a stable binding; a local variable cannot, so the transform falls
 * back to `forceReset: true` - and React then REMOUNTS the component on every
 * Fast Refresh of its module instead of preserving its state.
 *
 * That is invisible in almost every component (a remount just re-runs effects),
 * which is why `const useStore = useLayerStore()` survived review five times. It
 * is not invisible in the window manager: a remounted task-detail window rebuilds
 * its Browser pane, an Electron `<webview>` guest dies with its DOM node, and the
 * browser an agent was driving is destroyed - with no page reload and no Fast
 * Refresh bailout to point at. See `.claude/rules/hmr-patterns.md`, and measure
 * with `scripts/hmr-guest-probe.mjs`.
 *
 * MODULE-SCOPE `use*` consts are the legitimate case (`export const useBoardStore =
 * create(...)`) and are not matched: the scan looks only at INDENTED declarations,
 * which is what makes a binding local.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../src/renderer');
const REPO_ROOT = path.resolve(__dirname, '../..');

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('hook-shaped local variables', () => {
  it('no renderer file binds a `use`-prefixed name to a local variable', () => {
    // Indented (so: inside a function body) `const`/`let` whose name starts with
    // `use` followed by an uppercase letter - the shape react-refresh mistakes for
    // a custom hook. A destructure (`const { useX } = ...`) is not matched and has
    // never occurred here; extend the pattern if it does.
    const pattern = /^[ \t]+(?:const|let)\s+(use[A-Z][A-Za-z0-9_]*)\s*=/gm;
    const violations: string[] = [];

    for (const file of collectSourceFiles(RENDERER_DIR)) {
      const source = fs.readFileSync(file, 'utf-8');
      const lines = source.split('\n');
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(source)) !== null) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        // Per-line opt-out for a local that genuinely IS a hook resolved from a
        // stable binding and has been checked against the probe.
        const sameLine = lines[lineNumber - 1] ?? '';
        const previousLine = lines[lineNumber - 2] ?? '';
        if (/\/\/\s*hook-local-ok:/.test(sameLine) || /\/\/\s*hook-local-ok:/.test(previousLine)) continue;
        const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        violations.push(`${relative}:${lineNumber} -> ${match[1]}`);
      }
    }

    expect(
      violations,
      'A `use`-prefixed LOCAL variable makes react-refresh set forceReset, so React\n'
      + 'REMOUNTS the component on every Fast Refresh - which destroys live Browser\n'
      + 'pane <webview> guests in the window manager. Rename it (e.g. `useStore` ->\n'
      + '`layerStore`), or add `// hook-local-ok: <reason>`:\n'
      + violations.map((violation) => `  - ${violation}`).join('\n'),
    ).toEqual([]);
  });
});
