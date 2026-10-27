/**
 * `qwenHomeDir`: Qwen Code's global directory, `$QWEN_HOME` when set, else
 * `~/.qwen`. Trust is written there and chats are read from there, so it must
 * be the directory Qwen itself uses.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { qwenHomeDir } from '../../src/main/agent/adapters/qwen-code/qwen-home';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { ensureWorktreeTrust } from '../../src/main/agent/adapters/qwen-code/trust-manager';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.QWEN_HOME;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('qwenHomeDir', () => {
  it('is ~/.qwen with no QWEN_HOME, and with an empty one', () => {
    expect(qwenHomeDir()).toBe(path.join(os.homedir(), '.qwen'));
    process.env.QWEN_HOME = '  ';
    expect(qwenHomeDir()).toBe(path.join(os.homedir(), '.qwen'));
  });

  it('is an absolute QWEN_HOME as given, and expands a leading ~', () => {
    const custom = path.join(os.tmpdir(), 'qwen-elsewhere');
    process.env.QWEN_HOME = custom;
    expect(qwenHomeDir()).toBe(custom);
    process.env.QWEN_HOME = '~/qwen-elsewhere';
    expect(qwenHomeDir()).toBe(path.join(os.homedir(), 'qwen-elsewhere'));
  });

  it('keeps the default for a relative QWEN_HOME, which Qwen resolves against its own cwd', () => {
    process.env.QWEN_HOME = 'relative-qwen';
    expect(qwenHomeDir()).toBe(path.join(os.homedir(), '.qwen'));
  });

  it('is where the chats are read and the trust is written', async () => {
    const custom = makeDirectory('kangentic-qwen-home-');
    process.env.QWEN_HOME = custom;
    expect(qwenChatsDir(path.join(custom, 'project')).startsWith(path.join(custom, 'projects'))).toBe(true);

    fs.writeFileSync(path.join(custom, 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
    const worktree = path.join(custom, 'project', '.kangentic', 'worktrees', '1');
    await ensureWorktreeTrust(worktree);
    const trusted = JSON.parse(fs.readFileSync(path.join(custom, 'trustedFolders.json'), 'utf-8')) as Record<string, string>;
    expect(Object.values(trusted)).toEqual(['TRUST_FOLDER']);
  });
});
