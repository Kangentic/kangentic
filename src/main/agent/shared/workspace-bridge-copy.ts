import fs from 'node:fs';
import path from 'node:path';
import { resolveBridgeScript } from './bridge-utils';

/** The unbundled bridges a CLI may need copied into its workspace. */
export type WorkspaceBridgeScript = 'event-bridge' | 'background-shell-hint-bridge';

/**
 * The shipped bridge. One literal `resolveBridgeScript` call per script, so
 * `tests/unit/external-scripts-parity.test.ts` can verify each is registered.
 */
function workspaceBridgeSource(script: WorkspaceBridgeScript): string {
  switch (script) {
    case 'event-bridge':
      return resolveBridgeScript('event-bridge');
    case 'background-shell-hint-bridge':
      return resolveBridgeScript('background-shell-hint-bridge');
  }
}

/**
 * Copy a bridge into `<directory>/.kangentic/<copyName>` and return the copy's
 * path, for a CLI whose hook command can only carry bare, space-free tokens:
 * the command then names the copy relative to the hook's cwd. Checked on every
 * spawn and rewritten only when its bytes differ from the app's bridge, so an
 * app update never leaves a stale copy behind and a spawn that finds an
 * identical copy leaves it alone. A hook already running keeps the copy it
 * loaded. A copy name ending in `.cjs` keeps a user's `"type": "module"` from
 * loading the CommonJS bridge as ESM.
 *
 * `copyName` must contain the script's name: that is what lets
 * `isKangenticHookCommand` recognize a hook naming the copy, so cleanup strips
 * it. Throws when the copy fails.
 */
export function copyBridgeInto(directory: string, script: WorkspaceBridgeScript, copyName: string): string {
  if (!copyName.includes(script)) {
    throw new Error(`workspace copy ${copyName} must contain ${script}, or hook cleanup cannot recognize it`);
  }
  const sourcePath = workspaceBridgeSource(script);
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

/** `copyBridgeInto` for the event bridge. */
export function copyEventBridgeInto(directory: string, copyName: string): string {
  return copyBridgeInto(directory, 'event-bridge', copyName);
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
