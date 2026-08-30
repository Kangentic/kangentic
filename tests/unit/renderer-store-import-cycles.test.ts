/**
 * No import cycles among the renderer stores.
 *
 * A cycle between two Zustand stores is harmless at RUNTIME when both sides only
 * call `getState()` - which is why `project-store` <-> `session-store` stood for a
 * long time unnoticed. It is not harmless in dev. Pattern E stores self-accept
 * with `import.meta.hot.accept(() => import.meta.hot.invalidate())`, and Vite
 * answers an `invalidate()` raised from inside a cycle by giving up on the hot
 * update entirely:
 *
 *     page reload src/renderer/stores/project-store.ts (circular import invalidate)
 *
 * A full page reload destroys every live Browser pane `<webview>` guest and every
 * `import.meta.hot.data` pin, so saving an unrelated store slice reset the browser
 * an agent was driving. See `.claude/rules/hmr-patterns.md` and measure with
 * `scripts/hmr-guest-probe.mjs`.
 *
 * The scan is deliberately limited to `src/renderer/stores/**`: that is where the
 * self-accepts live, so that is where a cycle turns into a page reload. It follows
 * VALUE imports only - `import type` is erased before Vite ever sees it and cannot
 * create a runtime edge.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const STORES_DIR = path.resolve(__dirname, '../../src/renderer/stores');

function collectStoreFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectStoreFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** Resolve a relative specifier to a real file under stores/, or null if it
 *  points outside the scanned tree (utils, hooks, shared - not our concern). */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function valueImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf-8');
  const edges: string[] = [];
  // `import ... from '...'` and bare `import '...'`, skipping `import type`.
  const pattern = /^import\s+(?!type\b)([\s\S]*?)from\s+'([^']+)'|^import\s+'([^']+)'/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? match[3];
    if (!specifier) continue;
    // A clause whose every member is `type X` contributes no runtime edge.
    const members = clause.replace(/[{}]/g, '').split(',').map((part) => part.trim()).filter(Boolean);
    if (members.length > 0 && members.every((member) => member.startsWith('type '))) continue;
    const resolved = resolveLocal(file, specifier);
    if (resolved) edges.push(resolved);
  }
  return edges;
}

describe('renderer store import cycles', () => {
  it('has no value-import cycle among src/renderer/stores/**', () => {
    const files = collectStoreFiles(STORES_DIR);
    const graph = new Map<string, string[]>();
    for (const file of files) graph.set(file, valueImports(file));

    const relative = (file: string) =>
      path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');

    // Iterative DFS with an explicit on-stack set, reporting the first cycle found
    // per start node so the failure names the actual loop rather than "a cycle".
    const cycles: string[] = [];
    const permanentlyDone = new Set<string>();

    const visit = (start: string): void => {
      const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }];
      const onStack: string[] = [start];
      const onStackSet = new Set([start]);

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const edges = graph.get(frame.node) ?? [];
        if (frame.index >= edges.length) {
          permanentlyDone.add(frame.node);
          onStackSet.delete(frame.node);
          onStack.pop();
          stack.pop();
          continue;
        }
        const next = edges[frame.index];
        frame.index += 1;
        if (onStackSet.has(next)) {
          const loopStart = onStack.indexOf(next);
          const loop = onStack.slice(loopStart).concat(next).map(relative).join('\n        -> ');
          cycles.push(loop);
          continue;
        }
        if (permanentlyDone.has(next)) continue;
        stack.push({ node: next, index: 0 });
        onStack.push(next);
        onStackSet.add(next);
      }
    };

    for (const file of files) if (!permanentlyDone.has(file)) visit(file);

    expect(
      cycles,
      'Import cycle(s) among the renderer stores. Vite turns an `invalidate()` raised\n'
      + 'from inside a cycle into a FULL PAGE RELOAD, which destroys live Browser pane\n'
      + 'guests. Break the cycle with a late-bound handler module (see\n'
      + 'stores/session-lifecycle-hooks.ts) rather than importing the store directly:\n\n'
      + cycles.map((cycle) => `  - ${cycle}`).join('\n\n'),
    ).toEqual([]);
  });
});
