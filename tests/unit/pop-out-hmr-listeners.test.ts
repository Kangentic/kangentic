/**
 * The pop-out window's own HMR re-sync listeners (`pop-out/usePopOutBootstrap.ts`).
 *
 * Tier and why this reads source text: the listeners register only under
 * `if (import.meta.hot)`, and `import.meta.hot` is undefined in vitest. A module's
 * `import.meta` cannot be faked from a test without changing production code or
 * bundling a rewritten copy of the module (a copy is not the real code), so the
 * behavior cannot be driven for real in this tier. `tests/unit/hmr-resync.test.ts`
 * reads App.tsx's HMR block the same way. The scheduler's own behavior (burst runs
 * once, hold, ceiling) is driven for real in `hmr-resync-scheduler.test.ts`, and the
 * hand-off the listeners rely on (`sharedModuleState`) in `hmr-store-pin.test.ts`.
 *
 * What a user loses if it goes: a listener registered in a React effect is dropped
 * by Vite when the module re-evaluates (the dev restart notice vanished that way) and
 * stacks a pair per effect run; a pop-out sharing the main window's scheduler lets
 * each caller replace the other's ask; a missing hold re-syncs the pop-out twice per
 * burst; a missing null check re-syncs from a window with no pop-out root.
 *
 * Red-green: move the block into the hook, swap in `hmrResyncScheduler`, delete the
 * `holdWhileUpdating()` call, or drop the `resync === null` guard, and a case fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/pop-out/usePopOutBootstrap.ts'),
  'utf-8',
);

/** Blank out comments, keeping newlines, so prose that quotes a call is never counted. */
function stripComments(rawSource: string): string {
  return rawSource
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length));
}

const CODE = stripComments(SOURCE);
const HOOK_START = CODE.indexOf('export function usePopOutBootstrap');
const HOT_BLOCK_START = CODE.search(/^if \(import\.meta\.hot\) \{/m);

/** The text of a module-scope `if (import.meta.hot) { ... }` block, brace matched. */
function moduleScopeHotBlock(): string {
  let depth = 0;
  const openIndex = CODE.indexOf('{', HOT_BLOCK_START);
  for (let cursor = openIndex; cursor < CODE.length; cursor += 1) {
    if (CODE[cursor] === '{') depth += 1;
    else if (CODE[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(openIndex, cursor + 1);
    }
  }
  throw new Error('unbalanced braces in the pop-out HMR block');
}

describe('pop-out HMR listeners', () => {
  it('registers its Vite listeners at module scope, never inside the hook', () => {
    expect(HOOK_START).toBeGreaterThan(0);
    expect(HOT_BLOCK_START, 'no column-0 `if (import.meta.hot) {` block found').toBeGreaterThanOrEqual(0);
    expect(HOT_BLOCK_START).toBeLessThan(HOOK_START);

    const hotBlock = moduleScopeHotBlock();
    expect(hotBlock).toContain("import.meta.hot.on('vite:beforeUpdate'");
    expect(hotBlock).toContain("import.meta.hot.on('vite:afterUpdate'");

    // Nothing registered from the hook body or any effect.
    const hookBody = CODE.slice(HOOK_START);
    expect(hookBody).not.toMatch(/import\.meta\.hot\??\.on\(/);
    // Exactly two registrations in the whole module.
    expect(CODE.match(/import\.meta\.hot\.on\(/g)).toHaveLength(2);
  });

  it('uses a scheduler of its own held in shared module state, never the main window singleton', () => {
    expect(CODE).not.toContain('hmrResyncScheduler');
    expect(CODE).toMatch(/sharedModuleState<PopOutHmrModuleState>\([\s\S]*?createHmrResyncScheduler\(\)/);
    expect(CODE).toContain("'popOutHmrModuleState'");
  });

  it('holds a pending re-sync from vite:beforeUpdate on its own scheduler', () => {
    const hotBlock = moduleScopeHotBlock();
    const match = hotBlock.match(/import\.meta\.hot\.on\('vite:beforeUpdate',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
    expect(match, 'no vite:beforeUpdate listener').toBeTruthy();
    expect(match![1]).toContain('popOutHmrModuleState.scheduler.holdWhileUpdating()');
  });

  it('does nothing on vite:afterUpdate with no mounted root, and otherwise schedules the root\'s re-sync once per burst', () => {
    const hotBlock = moduleScopeHotBlock();
    const afterStart = hotBlock.indexOf("import.meta.hot.on('vite:afterUpdate'");
    expect(afterStart).toBeGreaterThanOrEqual(0);
    const afterBlock = hotBlock.slice(afterStart);

    const guardIndex = afterBlock.search(/if \(popOutHmrModuleState\.resync === null\) return;/);
    const scheduleIndex = afterBlock.indexOf('popOutHmrModuleState.scheduler.schedule(');
    expect(guardIndex, 'no null-resync early return').toBeGreaterThanOrEqual(0);
    expect(scheduleIndex, 'no scheduler.schedule call').toBeGreaterThanOrEqual(0);
    // The guard comes first, so an unmounted window schedules nothing and clears nothing.
    expect(guardIndex).toBeLessThan(scheduleIndex);
    // The callback reads the mounted root's resync when it runs.
    expect(afterBlock.slice(scheduleIndex)).toContain('popOutHmrModuleState.resync?.()');
  });

  it('hands the mounted root\'s re-sync (config reload, then the surface\'s) to the listeners and clears it on unmount', () => {
    expect(CODE).toMatch(/popOutHmrModuleState\.resync = \(\) => \{\s*reloadConfig\(\);\s*surface\.hmrResync\(\);\s*\};/);
    expect(CODE).toMatch(/popOutHmrModuleState\.resync = null;/);
  });
});
