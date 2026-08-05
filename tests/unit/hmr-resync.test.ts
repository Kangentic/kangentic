import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Ensures every IPC-backed Zustand store is re-synced in the HMR handler.
//
// When Vite HMR replaces a module, its Zustand store reverts to defaults.
// The vite:afterUpdate handler in App.tsx must call each store's load/sync
// method to restore state from the main process. This test fails if a store
// has a load or sync method but that method isn't called in the HMR block.
//
// Exclusions: toast-store is client-only (no IPC load method).

const STORES_DIR = path.resolve(__dirname, '../../src/renderer/stores');
const APP_TSX = path.resolve(__dirname, '../../src/renderer/App.tsx');

// Methods that are project-scoped (called on project switch, not on HMR re-sync).
// These depend on a specific project being open and would be redundant or harmful
// to call globally in the HMR handler -- loadBoard and loadConfig already re-fetch
// the current project's data.
const EXCLUDED_METHODS = new Set([
  'loadArchivedTasks', // only loaded when archive panel is opened
  'loadAppVersion',    // static, doesn't change during a session
  'loadProjectOverrides', // called internally by loadConfig
  'loadShortcuts',     // called internally by loadBoard
]);

describe('HMR store re-sync', () => {
  it('App.tsx HMR handler calls load/sync for every IPC-backed store', () => {
    const appSource = fs.readFileSync(APP_TSX, 'utf-8');

    // Extract the HMR block: everything between import.meta.hot.on('vite:afterUpdate'
    // and the closing of that callback.
    const hmrMatch = appSource.match(/import\.meta\.hot\.on\('vite:afterUpdate',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
    expect(hmrMatch, 'Could not find vite:afterUpdate HMR handler in App.tsx').toBeTruthy();
    const hmrBlock = hmrMatch![1];

    // Scan top-level store files + per-store slice subfolders for
    // load*/sync* method definitions. The slice split means methods live
    // in e.g. board-store/board-hydration-slice.ts, not board-store.ts
    // directly - the test must recurse into those subfolders to preserve
    // coverage.
    const storeSourcePaths: string[] = [];
    for (const entry of fs.readdirSync(STORES_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('-store.ts')) {
        storeSourcePaths.push(path.join(STORES_DIR, entry.name));
      } else if (entry.isDirectory() && entry.name.endsWith('-store')) {
        for (const sliceEntry of fs.readdirSync(path.join(STORES_DIR, entry.name))) {
          if (sliceEntry.endsWith('.ts')) {
            storeSourcePaths.push(path.join(STORES_DIR, entry.name, sliceEntry));
          }
        }
      }
    }
    const missingMethods: string[] = [];

    for (const storeSourcePath of storeSourcePaths) {
      const storeSource = fs.readFileSync(storeSourcePath, 'utf-8');
      // Match method definitions like "loadBoard: async () =>" or "syncSessions: async () =>"
      const methodRegex = /^\s+(load\w+|sync\w+):\s*async/gm;
      let match;
      while ((match = methodRegex.exec(storeSource)) !== null) {
        const methodName = match[1];
        if (EXCLUDED_METHODS.has(methodName)) continue;
        if (!hmrBlock.includes(`.${methodName}(`)) {
          const relativePath = path.relative(STORES_DIR, storeSourcePath).replace(/\\/g, '/');
          missingMethods.push(`${relativePath} -> ${methodName}()`);
        }
      }
    }

    expect(
      missingMethods,
      `IPC-backed store methods missing from HMR handler in App.tsx.\n` +
      `Add these calls to the vite:afterUpdate block, or add to EXCLUDED_METHODS with a comment:\n` +
      missingMethods.map((m) => `  - ${m}`).join('\n'),
    ).toHaveLength(0);
  });

  // Catch new top-level mutable module state under stores/ and utils/ that
  // would silently reset on every Fast Refresh. Each such declaration must
  // either preserve itself via `import.meta.hot.dispose(` (the canonical
  // pattern in task-slice.ts, session-store.ts, hmr-flag.ts, etc.) or
  // opt out with an `// hmr-safe:` directive comment that names the reason.
  //
  // Per-variable invariant: a file having ANY dispose() block is not enough.
  // The specific variable name must appear inside the dispose callback body
  // (e.g. `data.myVar = myVar`). A blanket file-level `hasDispose` check is
  // a false-negative: it passes files where a variable is never stashed even
  // though a sibling variable is. We extract the dispose callback body and
  // require the literal token for each unprotected `let` to appear there.
  it('top-level mutable module state has HMR preservation or opt-out', () => {
    const UTILS_DIR = path.resolve(__dirname, '../../src/renderer/utils');
    const WINDOW_MANAGER_DIR = path.resolve(__dirname, '../../src/renderer/window-manager');
    const sourceFiles: string[] = [];
    const collect = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) sourceFiles.push(full);
      }
    };
    collect(STORES_DIR);
    collect(UTILS_DIR);
    collect(WINDOW_MANAGER_DIR);

    // Match any top-level `let` declaration (column-0 = module scope, since
    // intra-function locals are indented). The dispose-block check and the
    // per-line opt-out directive below decide whether each match is OK.
    // Standalone `null`/`undefined` initializers are excluded because there's
    // nothing to preserve until the first reassignment, and that reassignment
    // path is responsible for triggering its own preservation if needed.
    const letPattern = /^let\s+(\w+)\b[^=]*=\s*(.+?);?\s*$/gm;
    // A `const` binding can still hold MUTABLE module state: a Map/Set seeded
    // from hot.data is mutated in place for the module's whole life, so it needs
    // preservation exactly as a `let` does. A `let`-only scan silently loses the
    // declaration the moment someone converts a scalar counter into a keyed Map
    // (which is how task-slice.ts's per-task `moveGenerations` dropped out).
    // Deliberately narrow: it requires BOTH `import.meta.hot` and a collection
    // constructor, so the many Pattern-E `const preservedXStore = hot.data.x`
    // bindings (pinned by direct assignment, not a dispose stash) are not swept
    // in, and plain `const` constants are untouched.
    const hotCollectionPattern =
      /^const\s+(\w+)\b[^=]*=\s*(import\.meta\.hot[^;]*new (?:Map|Set|WeakMap)[^;]*);?\s*$/gm;
    const TRIVIAL_INITIALIZERS = new Set(['null', 'undefined', 'false', 'true']);

    // Extract all dispose callback bodies from the source. A file may have
    // multiple dispose blocks; we collect all of them and check each variable
    // against the union.
    function extractDisposeBodies(source: string): string {
      // Match `import.meta.hot.dispose((data) => { ... })` with arbitrary
      // whitespace. We need to find the matching closing brace; a simple
      // non-greedy [\s\S]*? works well enough for the code patterns in this
      // repo where dispose blocks are short and not deeply nested.
      const disposePattern = /import\.meta\.hot\.dispose\s*\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/g;
      const bodies: string[] = [];
      let disposeMatch;
      while ((disposeMatch = disposePattern.exec(source)) !== null) {
        bodies.push(disposeMatch[1]);
      }
      return bodies.join('\n');
    }

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      const lines = source.split('\n');
      const disposeBodies = extractDisposeBodies(source);

      let match;
      for (const declarationPattern of [letPattern, hotCollectionPattern]) {
      declarationPattern.lastIndex = 0;
      while ((match = declarationPattern.exec(source)) !== null) {
        const name = match[1];
        const initializer = match[2].trim();
        if (TRIVIAL_INITIALIZERS.has(initializer)) continue;

        const matchIndex = match.index;
        const lineNumber = source.slice(0, matchIndex).split('\n').length;
        const sameLine = lines[lineNumber - 1] ?? '';
        const prevLine = lines[lineNumber - 2] ?? '';
        // Per-declaration opt-out via `// hmr-safe: <reason>` on the same
        // line or the line immediately above.
        if (/\/\/\s*hmr-safe:/.test(sameLine) || /\/\/\s*hmr-safe:/.test(prevLine)) continue;

        // Per-variable check: the variable name must appear in at least one
        // dispose callback body (e.g. `data.name = name` or `data[name]`).
        // A file-level hasDispose is insufficient - it would pass files where
        // a sibling variable is stashed but this particular one is not.
        if (disposeBodies.length > 0 && new RegExp(`\\b${name}\\b`).test(disposeBodies)) continue;

        // No dispose body references this variable AND no hmr-safe opt-out:
        // this is a violation.
        if (disposeBodies.length === 0) {
          // No dispose block at all in the file.
          const relativePath = path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');
          violations.push(`${relativePath}:${lineNumber} -> let ${name} = ${initializer}`);
        } else {
          // Has a dispose block but this variable is not stashed inside it.
          const relativePath = path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');
          violations.push(`${relativePath}:${lineNumber} -> let ${name} = ${initializer} (not stashed in dispose)`);
        }
      }
      }
    }

    expect(
      violations,
      `Top-level mutable module state lacks HMR preservation.\n` +
      `Either add an import.meta.hot.dispose() block that stashes the value into hot.data,\n` +
      `or annotate the declaration with "// hmr-safe: <reason>" if reset-on-HMR is intentional:\n` +
      violations.map((v) => `  - ${v}`).join('\n'),
    ).toHaveLength(0);
  });

  // dnd-kit's per-droppable subscriptions go stale across Vite Fast Refresh
  // while the surrounding DndContext keeps running. The fix is to re-key the
  // DndContext on every HMR cycle so the dnd-kit manager remounts cleanly.
  // This test guards against a new <DndContext> being added without that key
  // and silently regressing the dev-mode dropzone animation (or similar).
  it('every <DndContext> has key={...HmrGeneration...} for dev-mode parity', () => {
    const RENDERER_DIR = path.resolve(__dirname, '../../src/renderer');
    const sourceFiles: string[] = [];
    const collect = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && /\.(tsx|jsx)$/.test(entry.name)) sourceFiles.push(full);
      }
    };
    collect(RENDERER_DIR);

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const rawSource = fs.readFileSync(file, 'utf-8');
      // Strip block + line comments so doc references like
      // `// Force every <DndContext> to remount...` don't false-positive.
      // We preserve line breaks (only strip content within them) so reported
      // line numbers below stay accurate.
      const source = rawSource
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
      // Locate every <DndContext ...> opening tag. Two forms: same-line
      // `<DndContext ...>` and multi-line. We capture from the opening `<`
      // to the closing `>` (non-greedy) and look for a `key=` attribute in
      // that span.
      const dndContextPattern = /<DndContext\b([\s\S]*?)>/g;
      let match;
      while ((match = dndContextPattern.exec(source)) !== null) {
        const attrSpan = match[1];
        const lineNumber = source.slice(0, match.index).split('\n').length;
        // The convention is `key={hmrGeneration}` (the result of
        // useHmrGeneration()). We accept any `key=` referencing a name
        // ending in HmrGeneration to leave room for renames, but reject
        // a missing key entirely.
        const hasHmrKey = /key=\{[^}]*[Hh]mrGeneration[^}]*\}/.test(attrSpan);
        if (hasHmrKey) continue;

        const relativePath = path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');
        violations.push(`${relativePath}:${lineNumber} -> <DndContext> without key={hmrGeneration}`);
      }
    }

    expect(
      violations,
      `<DndContext> sites missing the HMR generation key.\n` +
      `Add: const hmrGeneration = useHmrGeneration(); ... <DndContext key={hmrGeneration} ...>\n` +
      `See src/renderer/utils/hmr-generation.ts and .claude/rules/hmr-patterns.md:\n` +
      violations.map((v) => `  - ${v}`).join('\n'),
    ).toHaveLength(0);
  });

  // Pattern E (single-instance store boundary). A Zustand store whose only
  // runtime export is the non-component hook is not a React Fast Refresh
  // boundary: a re-eval (a slice edit, or an edit to a store it imports) can
  // construct a SECOND store instance while a mounted view stays subscribed to
  // the first. That is the agent/MCP-created-task split-brain (the card lands in
  // the store but the board never re-renders until a full reload). Each such
  // store must pin its instance - read it from import.meta.hot.data, write it
  // back, and self-accept so editing the store's own code forces a clean reload
  // instead of running stale closures. See .claude/rules/hmr-patterns.md.
  it('instance-pinned stores read, write, and self-accept across HMR (Pattern E)', () => {
    const PATTERN_E_STORES = ['board-store.ts', 'backlog-store.ts', 'project-store.ts', 'dictation-store.ts', 'usage-dashboard-store.ts', 'pop-out-store.ts', 'updater-store.ts', 'monitor-store.ts', 'announcements-store.ts'];
    const violations: string[] = [];
    for (const fileName of PATTERN_E_STORES) {
      const source = fs.readFileSync(path.join(STORES_DIR, fileName), 'utf-8');
      const readsPreserved = /import\.meta\.hot\?\.data\?\.\w+/.test(source);
      const writesPreserved = /import\.meta\.hot\.data\.\w+\s*=/.test(source);
      const selfAccepts = /import\.meta\.hot\.accept\s*\(/.test(source);
      if (!readsPreserved || !writesPreserved || !selfAccepts) {
        violations.push(
          `${fileName} -> reads:${readsPreserved} writes:${writesPreserved} accepts:${selfAccepts}`,
        );
      }
    }

    // window-store.ts (under window-manager/store/, not the Zustand stores/ dir) is
    // also a Pattern E boundary: it builds THREE layer instances and pins ALL of
    // them (boardWindowManager + commandWindowManager + monitorWindowManager) in
    // import.meta.hot.data, then self-accepts. Guard them here so a later edit that
    // drops a pin is caught mechanically, not only at runtime (a split-brain second
    // store makes that layer's windows vanish on every save while dogfooding). It
    // reads via `const HMR_DATA = import.meta.hot?.data`, so the read check is
    // looser than the stores/ ones above.
    const WINDOW_MANAGER_STORE = path.resolve(
      __dirname,
      '../../src/renderer/window-manager/store/window-store.ts',
    );
    const windowStoreSource = fs.readFileSync(WINDOW_MANAGER_STORE, 'utf-8');
    const windowStoreReads = /import\.meta\.hot\?\.data/.test(windowStoreSource);
    const windowStoreWritesBoard = /import\.meta\.hot\.data\.boardWindowManager\s*=/.test(windowStoreSource);
    const windowStoreWritesCommand = /import\.meta\.hot\.data\.commandWindowManager\s*=/.test(windowStoreSource);
    const windowStoreWritesMonitor = /import\.meta\.hot\.data\.monitorWindowManager\s*=/.test(windowStoreSource);
    const windowStoreAccepts = /import\.meta\.hot\.accept\s*\(/.test(windowStoreSource);
    if (
      !windowStoreReads
      || !windowStoreWritesBoard
      || !windowStoreWritesCommand
      || !windowStoreWritesMonitor
      || !windowStoreAccepts
    ) {
      violations.push(
        `window-manager/store/window-store.ts -> reads:${windowStoreReads} writesBoard:${windowStoreWritesBoard} writesCommand:${windowStoreWritesCommand} writesMonitor:${windowStoreWritesMonitor} accepts:${windowStoreAccepts}`,
      );
    }

    expect(
      violations,
      `Pattern E stores must pin their Zustand instance across HMR.\n` +
      `Each must read import.meta.hot?.data?.<key>, assign import.meta.hot.data.<key> = useXStore,\n` +
      `and call import.meta.hot.accept(() => import.meta.hot.invalidate()).\n` +
      `See .claude/rules/hmr-patterns.md (Pattern E):\n` +
      violations.map((v) => `  - ${v}`).join('\n'),
    ).toHaveLength(0);
  });
});
