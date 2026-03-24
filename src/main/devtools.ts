import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { session } from 'electron';

/** Load React DevTools Chrome extension in development builds (fire-and-forget). */
export function loadReactDevTools(): void {
  const reactDevToolsId = 'fmkadmapgofadopljbjfkapdkoienihi';
  let chromeExtensionsBase: string;
  switch (process.platform) {
    case 'darwin':
      chromeExtensionsBase = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
      break;
    case 'linux':
      chromeExtensionsBase = path.join(os.homedir(), '.config', 'google-chrome', 'Default', 'Extensions');
      break;
    default:
      chromeExtensionsBase = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
      break;
  }
  const extensionDir = path.join(chromeExtensionsBase, reactDevToolsId);
  if (!fs.existsSync(extensionDir)) return;

  const versions = fs.readdirSync(extensionDir).sort();
  const latest = versions[versions.length - 1];
  if (!latest) return;

  session.defaultSession.extensions.loadExtension(path.join(extensionDir, latest))
    .then(() => console.log('[APP] React DevTools loaded'))
    .catch((err: unknown) => console.log('[APP] Failed to load React DevTools:', err));
}
