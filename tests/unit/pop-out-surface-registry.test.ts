import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { POP_OUT_SURFACES } from '../../src/shared/pop-out';
import { IPC } from '../../src/shared/ipc-channels';

/**
 * Enforces .claude/rules/pop-out-surface-registry.md: every OS BrowserWindow goes
 * through the pop-out engine's two sanctioned creation sites, and every PopOutKind
 * has both a shared metadata entry and a renderer registration.
 *
 * The renderer half is checked by static text scan (not by importing the *-surface.tsx
 * modules), since those transitively pull in the full React/chart dependency tree -
 * exactly what the SurfaceDescriptor design keeps out of this lightweight unit test.
 * Mirrors tests/unit/central-embedding-engine-boundary.test.ts's scan-and-collect shape.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
/**
 * The only files allowed to construct an OS BrowserWindow.
 *
 * The third entry is a deliberate carve-out, not creep. A browser LANE is an
 * OFFSCREEN window (`show: false`, `offscreen: true`): it is never presented to
 * the user, never persists bounds, never appears in `POP_OUT_SURFACES`, and has
 * no renderer-side surface descriptor - so routing it through the pop-out
 * manager would mean teaching that manager about a window it can never show.
 * It has its own lifecycle (owned by the agent session that opened it) and its
 * own synchronous teardown, in BOTH `shutdown.ts` and the main window's
 * `closed` handler - the second is not redundant: an offscreen window still
 * counts in `getAllWindows()`, so a lane outliving the main window stops
 * `window-all-closed` firing and `shutdown.ts` then never runs at all. Adding a
 * FOURTH entry needs the same kind of justification, not an appeal to this one,
 * and needs a main-window teardown of its own.
 */
const ALLOWED_BROWSER_WINDOW_FILES = new Set([
  'src/main/index.ts',
  'src/main/pop-out/pop-out-window-manager.ts',
  'src/main/browser/browser-lane-manager.ts',
]);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('pop-out surface registry', () => {
  it('constructs BrowserWindow only from the main window or the pop-out manager', () => {
    const offenders: string[] = [];
    const scanRoot = path.join(REPO_ROOT, 'src/main');
    for (const filePath of collectSourceFiles(scanRoot)) {
      const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      if (ALLOWED_BROWSER_WINDOW_FILES.has(relPath)) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (/\bnew BrowserWindow\s*\(/.test(line)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Only ${[...ALLOWED_BROWSER_WINDOW_FILES].join(', ')} may construct a BrowserWindow - ` +
      `every other window must go through the pop-out registry. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every declared pop-out fan-out channel is a real IPC constant', () => {
    const validChannels = new Set(Object.values(IPC));
    const offenders: string[] = [];
    for (const [kind, meta] of Object.entries(POP_OUT_SURFACES)) {
      if (meta.channels.length === 0) {
        offenders.push(`${kind}: declares zero fan-out channels`);
        continue;
      }
      for (const channel of meta.channels) {
        if (!validChannels.has(channel)) {
          offenders.push(`${kind}: channel "${channel}" is not a member of IPC`);
        }
      }
    }
    expect(offenders, `Invalid pop-out surface channel declarations:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every PopOutKind has both a shared metadata entry and a renderer registration', () => {
    const sharedKinds = Object.keys(POP_OUT_SURFACES).sort();

    const surfacesDir = path.join(REPO_ROOT, 'src/renderer/pop-out/surfaces');
    const surfaceFiles = fs.readdirSync(surfacesDir).filter((name) => name.endsWith('-surface.tsx'));

    const rendererKinds: string[] = [];
    const exportedDescriptorNames: string[] = [];
    for (const fileName of surfaceFiles) {
      const source = fs.readFileSync(path.join(surfacesDir, fileName), 'utf-8');
      // [a-z-]: kind literals may be hyphenated ('changes-file'); a bare [a-z]+
      // would stop at the hyphen, silently drop the kind from rendererKinds, and
      // fail the parity assertion below with a confusing shared-vs-renderer diff.
      const kindMatch = source.match(/kind:\s*'([a-z][a-z-]*)'/);
      if (kindMatch) rendererKinds.push(kindMatch[1]);
      const exportMatch = source.match(/export const (\w+):\s*SurfaceDescriptor/);
      if (exportMatch) exportedDescriptorNames.push(exportMatch[1]);
    }

    expect(
      rendererKinds.sort(),
      `POP_OUT_SURFACES (src/shared/pop-out.ts) kinds must match the kinds declared across ` +
      `src/renderer/pop-out/surfaces/*-surface.tsx. shared=[${sharedKinds.join(',')}] renderer=[${rendererKinds.sort().join(',')}]`,
    ).toEqual(sharedKinds);

    const indexSource = fs.readFileSync(path.join(surfacesDir, 'index.ts'), 'utf-8');
    const registeredNames = [...indexSource.matchAll(/registerSurface\((\w+)\)/g)].map((match) => match[1]);
    const missingRegistrations = exportedDescriptorNames.filter((name) => !registeredNames.includes(name));
    expect(
      missingRegistrations,
      `Surface descriptor(s) exported but never passed to registerSurface() in ` +
      `src/renderer/pop-out/surfaces/index.ts: ${missingRegistrations.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The Critical bug this pins (fixed 2026-08): a browser LANE is an OFFSCREEN
   * BrowserWindow, but it is still counted by Electron's own
   * `BrowserWindow.getAllWindows()`. If the main window closes while a lane
   * survives, `window-all-closed` never fires, so `app.quit()` never fires,
   * so `before-quit` never fires - and `before-quit` is the ONLY thing that
   * runs `syncShutdownCleanup` (which is where `destroyAllLanes()` ALSO
   * lives, per the test above). Without a teardown on the main window's own
   * close, the app cannot quit at all: PTYs are never killed, session
   * records never marked suspended, DBs never closed.
   *
   * The teardown must be on 'closed', not 'close': destroying the window
   * tears down its <webview> guests, which is what fires the pane hand-off
   * (browser-lane-handoff.ts) that would otherwise construct a BRAND NEW
   * lane after the window is gone. 'close' handlers run before those guests
   * are torn down; 'closed' runs once they already are.
   */
  it('destroys every browser lane from mainWindow "closed" (not "close"), so a fresh lane cannot be constructed after teardown starts', () => {
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

    const closedHandlerMatch = indexSource.match(/mainWindow\.on\('closed',\s*\(\)\s*=>\s*\{([^}]*)\}\)/);
    expect(
      closedHandlerMatch,
      `Expected to find a mainWindow.on('closed', () => { ... }) handler in src/main/index.ts`,
    ).not.toBeNull();
    expect(closedHandlerMatch?.[1] ?? '').toContain('destroyAllLanes()');

    const closeHandlerMatch = indexSource.match(/mainWindow\.on\('close',\s*\(\)\s*=>\s*\{([^}]*)\}\)/);
    expect(
      closeHandlerMatch,
      `Expected to find a mainWindow.on('close', () => { ... }) handler in src/main/index.ts`,
    ).not.toBeNull();
    // The 'close' handler owns popOutWindowManager.destroyAll() only - if
    // destroyAllLanes() moves there, the <webview> guests it tears down are
    // still alive at that point and the hand-off would resurrect a lane.
    expect(closeHandlerMatch?.[1] ?? '').not.toContain('destroyAllLanes()');
  });
});
