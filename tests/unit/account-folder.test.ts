import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkExistingFolder,
  provisionAccountFolder,
  refuseRealHomeUnderTest,
} from '../../src/main/accounts/account-folder';
import type { SharedEntry } from '../../src/main/accounts/account-support';

const ENTRIES: SharedEntry[] = [
  { name: 'projects', how: 'link-dir', conversationBearing: true },
  { name: 'file-history', how: 'link-dir', conversationBearing: true },
  { name: 'skills', how: 'link-dir', conversationBearing: false },
  { name: 'history.jsonl', how: 'hardlink-file', conversationBearing: false },
  { name: 'settings.json', how: 'copy-file' },
  { name: 'CLAUDE.md', how: 'text', text: (home) => `@${path.join(home, 'CLAUDE.md')}\n` },
  {
    name: '.claude.json',
    how: 'derive-json',
    derive: (source, current) => {
      const shared = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'oauthAccount'));
      return { ...current, ...shared, oauthAccount: current.oauthAccount };
    },
  },
];

let root: string;
let home: string;
let account: string;

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function snapshot(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(folder, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(folder);
  return files;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-folder-'));
  home = path.join(root, 'home');
  account = path.join(root, 'accounts', 'claude', '2');
  write(path.join(home, 'projects', 'C--repo', 'session-1.jsonl'), '{"type":"user"}\n');
  write(path.join(home, 'skills', 'review', 'SKILL.md'), 'skill');
  write(path.join(home, 'history.jsonl'), '{"display":"first"}\n');
  write(path.join(home, 'settings.json'), '{"theme":"dark"}\n');
  write(path.join(home, 'CLAUDE.md'), 'instructions');
  write(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'one@example.com' } }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('provisionAccountFolder', () => {
  it('links conversation folders into the default home, so a session writes there', async () => {
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    expect(report.conversationLinkFailed).toBe(false);
    expect(report.problems).toEqual([]);
    write(path.join(account, 'projects', 'C--repo', 'session-2.jsonl'), '{"type":"assistant"}\n');
    expect(fs.existsSync(path.join(home, 'projects', 'C--repo', 'session-2.jsonl'))).toBe(true);
    // A missing conversation folder is made empty in the default home and linked.
    write(path.join(account, 'file-history', 'snapshot'), 'x');
    expect(fs.existsSync(path.join(home, 'file-history', 'snapshot'))).toBe(true);
  });

  it('shares prompt history as one file and copies, imports and derives the rest', async () => {
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    fs.appendFileSync(path.join(account, 'history.jsonl'), '{"display":"second"}\n');
    expect(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8')).toContain('second');
    expect(fs.readFileSync(path.join(account, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
    expect(fs.readFileSync(path.join(account, 'CLAUDE.md'), 'utf8')).toBe(`@${path.join(home, 'CLAUDE.md')}\n`);
    const state = JSON.parse(fs.readFileSync(path.join(account, '.claude.json'), 'utf8'));
    expect(state.hasCompletedOnboarding).toBe(true);
    expect(state.oauthAccount).toBeUndefined();
  });

  it('keeps the account login fields when it refreshes the derived state', async () => {
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    const statePath = path.join(account, '.claude.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fs.writeFileSync(statePath, JSON.stringify({ ...state, oauthAccount: { emailAddress: 'two@example.com' } }));
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).oauthAccount.emailAddress).toBe('two@example.com');
  });

  it('never changes a file the default home already had', async () => {
    const before = snapshot(home);
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    const after = snapshot(home);
    for (const [file, content] of Object.entries(before)) {
      expect(after[file]).toBe(content);
    }
  });

  it('merges what the account folder already held into the default home and keeps a clash aside', async () => {
    write(path.join(account, 'projects', 'C--repo', 'session-9.jsonl'), 'account own');
    write(path.join(account, 'projects', 'C--repo', 'session-1.jsonl'), 'clashing copy');
    write(path.join(account, 'history.jsonl'), '{"display":"from account"}\n');
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    expect(fs.readFileSync(path.join(home, 'projects', 'C--repo', 'session-9.jsonl'), 'utf8')).toBe('account own');
    // The default home's own file wins; the account's clashing copy is kept, never dropped.
    expect(fs.readFileSync(path.join(home, 'projects', 'C--repo', 'session-1.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    const kept = report.problems.find((problem) => problem.code === 'kept-aside');
    expect(kept).toBeDefined();
    const asideFolder = fs.readdirSync(path.join(account)).find((name) => name.startsWith('projects.kangentic-kept'));
    expect(asideFolder).toBeDefined();
    expect(fs.readFileSync(path.join(account, asideFolder as string, 'C--repo', 'session-1.jsonl'), 'utf8')).toBe('clashing copy');
    expect(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8')).toContain('from account');
    expect(report.conversationLinkFailed).toBe(false);
  });

  it('blocks the account when a conversation folder links somewhere else', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(account, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(account, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    expect(report.conversationLinkFailed).toBe(true);
  });

  it('refuses an account folder that overlaps the default home', async () => {
    await expect(
      provisionAccountFolder({ accountFolder: path.join(home, 'nested'), defaultHome: home, entries: ENTRIES }),
    ).rejects.toThrow(/overlap/);
  });

  it('leaves every shared transcript in place when the account folder is deleted', async () => {
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: ENTRIES });
    fs.rmSync(account, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(home, 'projects', 'C--repo', 'session-1.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(fs.existsSync(path.join(home, 'skills', 'review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'history.jsonl'))).toBe(true);
  });
});

describe('checkExistingFolder', () => {
  it('refuses the default home, a folder inside it, and one containing it', () => {
    expect(checkExistingFolder(home, home)).toBe('is-default-home');
    fs.mkdirSync(path.join(home, 'inner'), { recursive: true });
    expect(checkExistingFolder(path.join(home, 'inner'), home)).toBe('inside-default-home');
    expect(checkExistingFolder(root, home)).toBe('contains-default-home');
  });

  it('refuses a folder that already links into the default home', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.symlinkSync(path.join(home, 'projects'), path.join(other, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(checkExistingFolder(other, home)).toBe('links-into-default-home');
  });

  it('accepts an unrelated folder and reports a missing one', () => {
    const other = path.join(root, 'claude-work');
    fs.mkdirSync(other, { recursive: true });
    expect(checkExistingFolder(other, home)).toBeNull();
    expect(checkExistingFolder(path.join(root, 'nope'), home)).toBe('missing');
  });
});

describe('refuseRealHomeUnderTest', () => {
  it('refuses the real user home while tests run and allows a temp folder', () => {
    expect(() => refuseRealHomeUnderTest(path.join(os.homedir(), '.claude'))).toThrow(/real home/);
    expect(() => refuseRealHomeUnderTest(home)).not.toThrow();
  });
});
