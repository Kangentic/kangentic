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
 * own synchronous teardown in `shutdown.ts`. Adding a FOURTH entry needs the
 * same kind of justification, not an appeal to this one.
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
      `Only src/main/index.ts (createWindow) and src/main/pop-out/pop-out-window-manager.ts may ` +
      `construct a BrowserWindow - every other window must go through the pop-out registry. Offenders:\n${offenders.join('\n')}`,
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
      const kindMatch = source.match(/kind:\s*'([a-z]+)'/);
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
});
