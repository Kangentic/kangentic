/**
 * How src/main/index.ts drives the launch settle signal (src/main/boot-settle.ts).
 *
 * index.ts makes top-level electron calls and cannot be imported by a unit test, so these read
 * its source as text, in the style of before-quit-drain-wiring.test.ts. The engine is pinned in
 * boot-settle.test.ts and the other call sites are driven for real (register-all, projects,
 * accounts); this is the only pin of the entry point's four calls.
 *
 * Red-green: delete `beginBoot()` and every other call site reads "settled" and the launch's
 * background work runs at once; move `noteWindowLoaded()` above the `trackBootWork(` call and the
 * floor can run out before the all-projects pass is counted; delete the wrapper and the launch
 * settles while that pass resumes agents; delete `disposeBootSettle()` and a quit still starts
 * what waited for the launch.
 *
 * Tier: Unit.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

/** Source with `//` comment lines blanked, so a call named in a comment is never counted. */
const CODE = INDEX_SOURCE
  .split('\n')
  .map((line) => (line.trimStart().startsWith('//') ? '' : line))
  .join('\n');

function indexOfCall(callText: string): number {
  const first = CODE.indexOf(callText);
  expect(first, `${callText} is not called in src/main/index.ts`).toBeGreaterThanOrEqual(0);
  expect(CODE.indexOf(callText, first + 1), `${callText} is called more than once in src/main/index.ts`).toBe(-1);
  return first;
}

describe('src/main/index.ts and the launch settle signal', () => {
  it('begins the launch before the IPC layer is registered, so nothing can spawn untracked', () => {
    expect(indexOfCall('beginBoot();')).toBeLessThan(indexOfCall('registerAllIpc(mainWindow, mcpServerHandle);'));
  });

  it('counts the all-projects activation as launch work, resolved when the pass ends either way', () => {
    const trackStart = indexOfCall('trackBootWork(new Promise<void>(');
    const noteLoaded = indexOfCall('noteWindowLoaded();');
    const tracked = CODE.slice(trackStart, noteLoaded);

    expect(tracked).toContain('activateAllProjectsTimer = setTimeout(');
    expect(tracked).toContain('activateAllProjects()');
    // The promise settles from `finally`, so a failed pass does not hold the launch to the cap.
    expect(tracked).toMatch(/\.finally\(\(\) => \{[\s\S]*resolve\(\);[\s\S]*\}\)/);
  });

  it('notes the window loaded only after that work is registered', () => {
    expect(indexOfCall('trackBootWork(new Promise<void>(')).toBeLessThan(indexOfCall('noteWindowLoaded();'));
  });

  it('disposes the settle signal on the quit path, with the other pending timers', () => {
    const clearPendingStart = indexOfCall('clearPendingTimers: () => {');
    const disposeCall = indexOfCall('disposeBootSettle();');
    const heartbeatClear = CODE.indexOf('clearInterval(heartbeatInterval)', clearPendingStart);

    expect(disposeCall).toBeGreaterThan(clearPendingStart);
    expect(disposeCall).toBeLessThan(heartbeatClear);
  });
});
