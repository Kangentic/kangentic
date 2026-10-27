/**
 * `geminiHomeDir`: Gemini CLI's user directory, `<GEMINI_CLI_HOME>/.gemini`
 * when set, else `~/.gemini`. Trust is written there and chats are read from
 * there, so it must be the folder Gemini itself uses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiHomeDir } from '../../src/main/agent/adapters/gemini/gemini-home';
import { ensureWorktreeTrust } from '../../src/main/agent/adapters/gemini/trust-manager';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.GEMINI_CLI_HOME;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('geminiHomeDir', () => {
  it('is ~/.gemini with no GEMINI_CLI_HOME, an empty one, or a relative one', () => {
    expect(geminiHomeDir()).toBe(path.join(os.homedir(), '.gemini'));
    process.env.GEMINI_CLI_HOME = ' ';
    expect(geminiHomeDir()).toBe(path.join(os.homedir(), '.gemini'));
    process.env.GEMINI_CLI_HOME = 'relative-root';
    expect(geminiHomeDir()).toBe(path.join(os.homedir(), '.gemini'));
  });

  it('is the .gemini folder inside an absolute GEMINI_CLI_HOME, where the trust write lands', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-gemini-home-'));
    temporaryDirectories.push(root);
    process.env.GEMINI_CLI_HOME = root;
    expect(geminiHomeDir()).toBe(path.join(root, '.gemini'));

    await ensureWorktreeTrust(path.join(root, 'project', '.kangentic', 'worktrees', '1'));
    const trusted = JSON.parse(fs.readFileSync(path.join(root, '.gemini', 'trustedFolders.json'), 'utf-8')) as Record<string, string>;
    expect(Object.values(trusted)).toEqual(['TRUST_FOLDER']);
  });
});
