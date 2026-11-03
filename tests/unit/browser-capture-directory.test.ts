/**
 * Where `saveToFile` on the browser tools writes (task #977). The agent reads
 * the file back with its own Read tool, and a read outside its working
 * directories can stop on a permission prompt nobody is there to answer in an
 * unattended column. So the folder is always inside the caller's working
 * directory when that is known, and always under a gitignored `.kangentic/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { browserCaptureDirectory, writeBrowserCaptureFile } from '../../src/main/agent/mcp-http/browser-capture-file';

const PROJECT = path.join(os.tmpdir(), 'kangentic-capture-project');
const WORKTREE = path.join(PROJECT, '.kangentic', 'worktrees', 'fix-login-5ff16815');

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('browserCaptureDirectory', () => {
  it('uses the session folder for a task on the main checkout, which sits inside its cwd', () => {
    const directory = browserCaptureDirectory({ projectPath: PROJECT, callerSessionId: 'sess-1', sessionCwd: PROJECT, projectId: 'p1' });
    expect(directory).toBe(path.join(PROJECT, '.kangentic', 'sessions', 'sess-1', 'captures'));
  });

  it('uses a folder inside the worktree for a worktree task, never the session folder outside it', () => {
    const directory = browserCaptureDirectory({ projectPath: PROJECT, callerSessionId: 'sess-2', sessionCwd: WORKTREE, projectId: 'p1' });
    expect(directory).toBe(path.join(WORKTREE, '.kangentic', 'captures', 'sess-2'));
    expect(isInside(WORKTREE, directory)).toBe(true);
  });

  it('uses the project root for a caller with no session, such as a Command Terminal', () => {
    const directory = browserCaptureDirectory({ projectPath: PROJECT, callerSessionId: undefined, sessionCwd: null, projectId: 'p1' });
    expect(directory).toBe(path.join(PROJECT, '.kangentic', 'captures', 'shared'));
  });

  it('never lets a session id climb out of its folder', () => {
    const directory = browserCaptureDirectory({ projectPath: PROJECT, callerSessionId: '../../escape', sessionCwd: WORKTREE, projectId: 'p1' });
    expect(isInside(PROJECT, directory)).toBe(true);
    expect(directory).not.toContain('escape');
  });

  it('falls back to a temp folder only when nothing else is known', () => {
    const directory = browserCaptureDirectory({ projectPath: null, callerSessionId: undefined, sessionCwd: null, projectId: 'p1' });
    expect(directory).toBe(path.join(os.tmpdir(), 'kangentic-captures', 'p1'));
  });
});

describe('writeBrowserCaptureFile', () => {
  // The folder lives as long as its session or worktree, so a long run of
  // captures would grow it without bound. Each write prunes it first.
  it('drops a capture older than a day before it writes the new one', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-capture-prune-'));
    try {
      const stale = path.join(directory, 'screenshot-old.png');
      fs.writeFileSync(stale, 'old');
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
      const recent = path.join(directory, 'screenshot-recent.png');
      fs.writeFileSync(recent, 'recent');

      const saved = await writeBrowserCaptureFile(directory, 'dom', 'html', '<html></html>');

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(recent)).toBe(true);
      expect(fs.readFileSync(saved.filePath, 'utf8')).toBe('<html></html>');
      expect(saved.bytes).toBe(13);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // The session's captures folder is shared with the pane's Send capture, which
  // is named capture-<stamp>.png. A save must prune only its own files.
  it('leaves a stale Send capture alone and removes only the stale screenshot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-capture-prune-own-'));
    try {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const sendCapture = path.join(directory, 'capture-2026-01-01T00-00-00-000Z.png');
      const staleScreenshot = path.join(directory, 'screenshot-2026-01-01T00-00-00-000Z-abc123.png');
      fs.writeFileSync(sendCapture, 'send');
      fs.writeFileSync(staleScreenshot, 'shot');
      fs.utimesSync(sendCapture, twoDaysAgo, twoDaysAgo);
      fs.utimesSync(staleScreenshot, twoDaysAgo, twoDaysAgo);

      await writeBrowserCaptureFile(directory, 'eval', 'txt', 'value');

      expect(fs.existsSync(sendCapture)).toBe(true);
      expect(fs.existsSync(staleScreenshot)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('trims own files past the 100 cap, oldest first, and neither counts nor removes foreign files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-capture-prune-cap-'));
    try {
      const baseTime = Date.now() - 60 * 60 * 1000;
      const ownNames: string[] = [];
      for (let index = 0; index < 105; index += 1) {
        const name = `dom-${String(index).padStart(3, '0')}.html`;
        ownNames.push(name);
        const filePath = path.join(directory, name);
        fs.writeFileSync(filePath, 'x');
        const modified = new Date(baseTime + index * 1000);
        fs.utimesSync(filePath, modified, modified);
      }
      const foreignNames: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const name = `capture-${index}.png`;
        foreignNames.push(name);
        const filePath = path.join(directory, name);
        fs.writeFileSync(filePath, 'x');
        // Older than every own file, so a filter that counted them would evict them first.
        const modified = new Date(baseTime - (index + 1) * 1000);
        fs.utimesSync(filePath, modified, modified);
      }

      const saved = await writeBrowserCaptureFile(directory, 'screenshot', 'png', Buffer.from([1, 2, 3]));

      const remaining = fs.readdirSync(directory);
      // 105 own files are pruned to 100, then the new one is written.
      expect(remaining.filter((name) => name.startsWith('dom-'))).toHaveLength(100);
      expect(remaining).not.toContain(ownNames[0]);
      expect(remaining).not.toContain(ownNames[4]);
      expect(remaining).toContain(ownNames[5]);
      expect(remaining).toContain(path.basename(saved.filePath));
      for (const name of foreignNames) expect(remaining).toContain(name);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
