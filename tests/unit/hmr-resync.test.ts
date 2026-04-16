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
  'detectAgent',       // static CLI detection, doesn't change during a session
  'loadAgentList',     // static agent detection, doesn't change during a session
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
});
