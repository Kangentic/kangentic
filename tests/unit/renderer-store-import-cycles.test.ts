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

/** Resolve a relative specifier to a real file on disk, or null when nothing
 *  matches (a bare package specifier, or a path with no file behind it).
 *
 *  It does NOT filter to `stores/`: an edge out to utils or shared resolves and is
 *  returned like any other. Those targets are harmless because the graph is keyed
 *  only by store files, so `graph.get(target) ?? []` makes an out-of-tree node a
 *  dead end with no outgoing edges - reachable, but unable to take part in a
 *  reported cycle. The scan's containment comes from the graph, not from here. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// `import ... from '...'` and bare `import '...'`, skipping `import type`.
const IMPORT_PATTERN = /^import\s+(?!type\b)([\s\S]*?)from\s+'([^']+)'|^import\s+'([^']+)'/gm;
// A value RE-EXPORT (`export * from './x'`, `export { a } from './x'`) is a
// runtime edge exactly like an import, and Vite walks it when deciding whether an
// `invalidate()` came from inside a cycle - so a cycle closed by a re-export
// reloads the page just the same. The clause here is pinned to `*` or one braced
// list rather than the import pattern's lazy `[\s\S]*?`: a lazy run would let
// `export const useSessionStore = ...` pair with a `from '...'` on some later line
// and invent an edge that does not exist.
const RE_EXPORT_PATTERN = /^export\s+(?!type\b)(\*|\{[^}]*\})\s+from\s+'([^']+)'/gm;

/** A clause whose every member is `type X` contributes no runtime edge. */
function isTypeOnlyClause(clause: string): boolean {
  const members = clause.replace(/[{}]/g, '').split(',').map((part) => part.trim()).filter(Boolean);
  return members.length > 0 && members.every((member) => member.startsWith('type '));
}

function valueImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf-8');
  const edges: string[] = [];

  const addEdge = (clause: string, specifier: string | undefined): void => {
    if (!specifier) return;
    if (isTypeOnlyClause(clause)) return;
    const resolved = resolveLocal(file, specifier);
    if (resolved) edges.push(resolved);
  };

  let match;
  IMPORT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_PATTERN.exec(source)) !== null) addEdge(match[1] ?? '', match[2] ?? match[3]);
  RE_EXPORT_PATTERN.lastIndex = 0;
  while ((match = RE_EXPORT_PATTERN.exec(source)) !== null) addEdge(match[1] ?? '', match[2]);
  return edges;
}

describe('renderer store import cycles', () => {
  // No store currently uses a value re-export, so the scan below cannot tell a
  // working RE_EXPORT_PATTERN from a broken one - it is green either way. Pin the
  // pattern directly, or the day someone closes a cycle with `export { x } from`
  // this guard waves it through.
  it('counts a value re-export as an edge, and a type-only one as none', () => {
    const matches = (pattern: RegExp, source: string): boolean => {
      pattern.lastIndex = 0;
      return pattern.test(source);
    };

    expect(matches(RE_EXPORT_PATTERN, "export { foo } from './session-store';"), 'named re-export').toBe(true);
    expect(matches(RE_EXPORT_PATTERN, "export * from './session-store';"), 'star re-export').toBe(true);
    expect(
      matches(RE_EXPORT_PATTERN, "export type { CompletionGate } from './completion-gate';"),
      '`export type` is erased and creates no runtime edge',
    ).toBe(false);
    // The clause is `*` or ONE braced list precisely so this cannot happen: a lazy
    // any-run would marry the `export const` line to the `from` three lines below.
    expect(
      matches(RE_EXPORT_PATTERN, "export const useSessionStore = create();\nconst x = 1;\nimport y from './project-store';"),
      'a declaration plus a later import must not fuse into a phantom edge',
    ).toBe(false);

    expect(isTypeOnlyClause('{ type Foo }'), 'inline type member').toBe(true);
    expect(isTypeOnlyClause('{ type A, type B }'), 'all inline type members').toBe(true);
    expect(isTypeOnlyClause('{ type A, b }'), 'one value member is enough for an edge').toBe(false);
    expect(isTypeOnlyClause('*'), 'star re-exports values').toBe(false);
  });

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
