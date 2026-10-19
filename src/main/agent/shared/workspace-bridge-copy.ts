import fs from 'node:fs';
import path from 'node:path';
import { resolveBridgeScript } from './bridge-utils';

/**
 * Copy the event bridge into `<directory>/.kangentic/<copyName>` and return the
 * copy's path, for a CLI whose hook command can only carry bare, space-free
 * tokens: the command then names the copy relative to the hook's cwd. Checked
 * on every spawn and rewritten only when its bytes differ from the app's
 * bridge, so an app update never leaves a stale copy behind and a spawn that
 * finds an identical copy leaves it alone. A hook already running keeps the
 * copy it loaded. A copy name ending in
 * `.cjs` keeps a user's `"type": "module"` from loading the CommonJS bridge as
 * ESM. Throws when the copy fails.
 */
export function copyEventBridgeInto(directory: string, copyName: string): string {
  const sourcePath = resolveBridgeScript('event-bridge');
  const copyPath = path.join(directory, '.kangentic', copyName);
  if (copyMatchesSource(sourcePath, copyPath)) return copyPath;
  // sync-write-ok: a hook command names this copy, so the CLI cannot run its
  // hooks without it. Qwen's settings build throws to `spawnAgent`'s catch,
  // which reports the blocked spawn; Antigravity's deployWorkspaceBridgeCopy
  // catches it and spawns without hooks.
  fs.mkdirSync(path.dirname(copyPath), { recursive: true });
  fs.copyFileSync(sourcePath, copyPath);
  return copyPath;
}

function copyMatchesSource(sourcePath: string, copyPath: string): boolean {
  let copy: Buffer;
  try {
    copy = fs.readFileSync(copyPath);
  } catch {
    return false;
  }
  return copy.equals(fs.readFileSync(sourcePath));
}
