import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// shell.openPath() never rejects and nothing bounds how long it takes: on Linux
// it shells out to xdg-open, which can wait on whatever viewer it launches. A
// handler that returns that promise straight to ipcMain.handle can therefore
// outlive the renderer's ipcRenderer.invoke(), and Electron's
// ReplyChannel::EnsureReplySent then raises "reply was never sent" as an
// unhandled rejection in the renderer.
//
// That shipped twice: once for attachments (task #487) and again for every
// "open folder" control (Sentry DESKTOP-P), because the first fix was a
// private race inside the attachment helper rather than a shared one. The race
// now lives in openPathBounded, and this scan is what stops a third unbounded
// call site from re-opening the bug.

const REPO_ROOT = path.resolve(__dirname, '../..');
// Both main-process trees. src/devtools/main is dev-only (build-excluded via
// __KANGENTIC_DEV__) so it cannot produce a production Sentry event, but the
// team dogfoods from npm start and would hit the same hang there. Its renderer
// and preload siblings are deliberately NOT scanned: they reach openPath
// through window.electronAPI, which is the bridge, not Electron's shell.
const SCAN_DIRS = ['src/main', 'src/devtools/main'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const OPEN_PATH_CALL = /\bshell\s*\.\s*openPath\s*\(/;
// The one module allowed to call it: it owns the timeout race that guarantees
// the caller's promise settles.
const CHOKEPOINT = 'src/main/ipc/helpers/open-path.ts';

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

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function toPosixRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

describe('shell.openPath is only called through the bounded helper', () => {
  it(`main-process code calls shell.openPath only in ${CHOKEPOINT}`, () => {
    const offenders: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      for (const filePath of collectSourceFiles(path.join(REPO_ROOT, scanDir))) {
        const relativePath = toPosixRelative(filePath);
        if (relativePath === CHOKEPOINT) continue;
        fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line, index) => {
          if (isCommentLine(line)) return;
          if (!OPEN_PATH_CALL.test(line)) return;
          offenders.push(`${relativePath}:${index + 1}`);
        });
      }
    }

    expect(
      offenders,
      `shell.openPath must be called only from ${CHOKEPOINT}. An unbounded call can outlive the renderer's ipcRenderer.invoke() and surface as "reply was never sent" (Sentry DESKTOP-P). Call openPathBounded() instead.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it(`${CHOKEPOINT} exists and is the module that calls shell.openPath`, () => {
    // Guards the scan itself: if the helper is renamed or its call inlined
    // away, the test above would silently pass with nothing left to protect.
    const chokepoint = fs.readFileSync(path.join(REPO_ROOT, CHOKEPOINT), 'utf-8');

    expect(OPEN_PATH_CALL.test(chokepoint)).toBe(true);
    expect(chokepoint).toContain('export function openPathBounded');
  });
});
