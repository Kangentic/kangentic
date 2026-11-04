/**
 * `qwenHomeDir`: Qwen Code's global directory, `$QWEN_HOME` when set, else
 * `~/.qwen`. Trust is written there and chats are read from there, so it must
 * be the directory Qwen itself uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { qwenHomeDir, qwenRuntimeDir } from '../../src/main/agent/adapters/qwen-code/qwen-home';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { ensureWorktreeTrust } from '../../src/main/agent/adapters/qwen-code/trust-manager';

const temporaryDirectories: string[] = [];

// A developer's own shell may export either; every case sets what it needs.
beforeEach(() => {
  delete process.env.QWEN_HOME;
  delete process.env.QWEN_RUNTIME_DIR;
});

afterEach(() => {
  delete process.env.QWEN_HOME;
  delete process.env.QWEN_RUNTIME_DIR;
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

/**
 * `qwenRuntimeDir`: where Qwen writes the chats, in its own order
 * (`Storage.getRuntimeBaseDir`, packages/core/src/config/storage.ts, v0.26.6):
 * QWEN_RUNTIME_DIR, then `advanced.runtimeOutputDir`, then QWEN_HOME. Read
 * from QWEN_HOME alone, a user with either override gets no history,
 * transcript or model list in Kangentic.
 */
describe('qwenRuntimeDir', () => {
  it('is the global directory with no override', () => {
    const home = makeDirectory('kangentic-qwen-runtime-');
    process.env.QWEN_HOME = home;
    expect(qwenRuntimeDir(path.join(home, 'project'))).toBe(home);
    expect(qwenRuntimeDir(null)).toBe(home);
  });

  it('takes QWEN_RUNTIME_DIR over every setting, while trust stays in QWEN_HOME', () => {
    const home = makeDirectory('kangentic-qwen-runtime-');
    const runtime = makeDirectory('kangentic-qwen-runtime-env-');
    process.env.QWEN_HOME = home;
    process.env.QWEN_RUNTIME_DIR = runtime;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: path.join(home, 'from-settings') } }));
    const cwd = path.join(home, 'project');
    expect(qwenRuntimeDir(cwd)).toBe(runtime);
    expect(qwenChatsDir(cwd).startsWith(path.join(runtime, 'projects'))).toBe(true);
    expect(qwenHomeDir()).toBe(home);
  });

  it('reads advanced.runtimeOutputDir from the workspace before the user settings', () => {
    const home = makeDirectory('kangentic-qwen-runtime-');
    process.env.QWEN_HOME = home;
    const cwd = path.join(home, 'project');
    fs.mkdirSync(path.join(cwd, '.qwen'), { recursive: true });
    const fromUser = path.join(home, 'user-runtime');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: fromUser } }));
    expect(qwenRuntimeDir(cwd)).toBe(fromUser);

    // A relative workspace value resolves against the workspace.
    fs.writeFileSync(path.join(cwd, '.qwen', 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: '.qwen-runtime' } }));
    expect(qwenRuntimeDir(cwd)).toBe(path.join(cwd, '.qwen-runtime'));
  });

  it('expands a leading ~, and skips a relative value it has no workspace for', () => {
    const home = makeDirectory('kangentic-qwen-runtime-');
    process.env.QWEN_HOME = home;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: '~/qwen-runtime' } }));
    expect(qwenRuntimeDir(null)).toBe(path.join(os.homedir(), 'qwen-runtime'));

    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: 'relative-runtime' } }));
    expect(qwenRuntimeDir(null)).toBe(home);
  });

  it('falls through an invalid workspace settings file to the user\'s value', () => {
    const home = makeDirectory('kangentic-qwen-runtime-');
    process.env.QWEN_HOME = home;
    const cwd = path.join(home, 'project');
    fs.mkdirSync(path.join(cwd, '.qwen'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.qwen', 'settings.json'), '{ not json');
    const fromUser = path.join(home, 'user-runtime');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ advanced: { runtimeOutputDir: fromUser } }));
    expect(qwenRuntimeDir(cwd)).toBe(fromUser);
  });

  it('skips a settings file it cannot parse', () => {
    const home = makeDirectory('kangentic-qwen-runtime-');
    process.env.QWEN_HOME = home;
    fs.writeFileSync(path.join(home, 'settings.json'), '{ // a comment\n "advanced": {} }');
    expect(qwenRuntimeDir(null)).toBe(home);
  });
});
