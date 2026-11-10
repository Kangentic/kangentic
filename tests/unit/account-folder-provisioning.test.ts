import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isInsideOrSame, provisionAccountFolder } from '../../src/main/accounts/account-folder';
import type { SharedEntry } from '../../src/main/accounts/account-support';

let root: string;
let home: string;
let account: string;

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function linkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function allNames(folder: string): string[] {
  const names: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      names.push(entry.name);
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
    }
  };
  walk(folder);
  return names;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-account-provision-'));
  home = path.join(root, 'home');
  account = path.join(root, 'accounts', 'agent', '2');
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isInsideOrSame', () => {
  it('treats a name that only starts with two dots as inside, and a parent reference as outside', () => {
    const parent = path.join(root, 'parent');
    fs.mkdirSync(parent, { recursive: true });
    expect(isInsideOrSame(path.join(parent, '..cache'), parent)).toBe(true);
    expect(isInsideOrSame(path.join(parent, '..'), parent)).toBe(false);
    expect(isInsideOrSame(path.join(parent, '..', 'x'), parent)).toBe(false);
    expect(isInsideOrSame(parent, parent)).toBe(true);
  });
});

describe('provisionAccountFolder links', () => {
  it('replaces a dangling link at a link target with a good one', async () => {
    write(path.join(home, 'skills', 'review', 'SKILL.md'), 'skill');
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    fs.mkdirSync(account, { recursive: true });
    fs.symlinkSync(gone, path.join(account, 'skills'), linkType());
    fs.rmSync(gone, { recursive: true, force: true });

    const entries: SharedEntry[] = [{ name: 'skills', how: 'link-dir', conversationBearing: false }];
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });

    expect(report.problems).toEqual([]);
    expect(fs.lstatSync(path.join(account, 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(account, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('skill');
  });

  it('skips an entry that exists only on another platform', async () => {
    const otherPlatform: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32';
    const entries: SharedEntry[] = [{ name: 'sandbox', how: 'link-dir', conversationBearing: true, onlyOn: [otherPlatform] }];
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });
    expect(report.problems).toEqual([]);
    expect(fs.existsSync(path.join(home, 'sandbox'))).toBe(false);
    expect(fs.existsSync(path.join(account, 'sandbox'))).toBe(false);
  });

  it('skips a non-conversation link missing in the home and creates a conversation-bearing one there', async () => {
    const entries: SharedEntry[] = [
      { name: 'skills', how: 'link-dir', conversationBearing: false },
      { name: 'projects', how: 'link-dir', conversationBearing: true },
    ];
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(account, 'skills'))).toBe(false);
    expect(fs.statSync(path.join(home, 'projects')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(account, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('keeps a directory aside when the default home has a file of that name, never merging over it', async () => {
    write(path.join(home, 'projects', 'C--repo'), 'a file in the home');
    write(path.join(account, 'projects', 'C--repo', 'session.jsonl'), 'account own');
    const entries: SharedEntry[] = [{ name: 'projects', how: 'link-dir', conversationBearing: true }];

    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });

    expect(report.problems.map((problem) => problem.code)).toEqual(['kept-aside']);
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.readFileSync(path.join(home, 'projects', 'C--repo'), 'utf8')).toBe('a file in the home');
    const aside = fs.readdirSync(account).find((name) => name.startsWith('projects.kangentic-kept'));
    expect(aside).toBeDefined();
    expect(fs.readFileSync(path.join(account, aside as string, 'C--repo', 'session.jsonl'), 'utf8')).toBe('account own');
  });
});

describe('provisionAccountFolder copies and derived files', () => {
  it('reports a copy whose target is a link as user-owned, and blocks only for a required one', async () => {
    write(path.join(home, 'settings.json'), '{}');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(account, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(account, 'settings.json'), linkType());

    const optional = await provisionAccountFolder({
      accountFolder: account,
      defaultHome: home,
      entries: [{ name: 'settings.json', how: 'copy-file' }],
    });
    expect(optional.problems.map((problem) => problem.code)).toEqual(['user-owned']);
    expect(optional.conversationLinkFailed).toBe(false);

    const required = await provisionAccountFolder({
      accountFolder: account,
      defaultHome: home,
      entries: [{ name: 'settings.json', how: 'copy-file', required: true }],
    });
    expect(required.problems.map((problem) => problem.code)).toEqual(['user-owned']);
    expect(required.conversationLinkFailed).toBe(true);
  });

  it('blocks the account when a required copy cannot be written, and not for an optional one', async () => {
    write(path.join(home, 'settings.json'), '{"theme":"dark"}');
    // A folder where the file goes: the copy cannot replace it.
    fs.mkdirSync(path.join(account, 'settings.json'), { recursive: true });

    const optional = await provisionAccountFolder({
      accountFolder: account,
      defaultHome: home,
      entries: [{ name: 'settings.json', how: 'copy-file' }],
    });
    expect(optional.conversationLinkFailed).toBe(false);

    const required = await provisionAccountFolder({
      accountFolder: account,
      defaultHome: home,
      entries: [{ name: 'settings.json', how: 'copy-file', required: true }],
    });
    expect(required.conversationLinkFailed).toBe(true);
    expect(required.problems.map((problem) => problem.code)).toEqual(['link-failed']);
    expect(allNames(account).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('blocks the account on a required derive source that is unreadable, and leaves the target as it was', async () => {
    write(path.join(home, 'config.json'), '{ this is not json');
    write(path.join(account, 'config.json'), '{"keep":"me"}');
    const derive = vi.fn((_source: Record<string, unknown>, current: Record<string, unknown>) => ({ ...current, derived: true }));

    const report = await provisionAccountFolder({
      accountFolder: account,
      defaultHome: home,
      entries: [{ name: 'config.json', how: 'derive-json', required: true, derive }],
    });

    expect(report.conversationLinkFailed).toBe(true);
    expect(report.problems.map((problem) => problem.code)).toEqual(['link-failed']);
    expect(derive).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(account, 'config.json'), 'utf8')).toBe('{"keep":"me"}');
  });

  it('derives from defaults, without blocking, when the unreadable source is not required', async () => {
    write(path.join(home, 'config.json'), '{ this is not json');
    const report = await provisionAccountFolder({
      accountFolder: account,
      defaultHome: home,
      entries: [{ name: 'config.json', how: 'derive-json', derive: (_source, current) => ({ ...current, derived: true }) }],
    });
    expect(report.conversationLinkFailed).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(account, 'config.json'), 'utf8'))).toEqual({ derived: true });
  });

  it('runs the derive write inside the entry lock and waits for the lock', async () => {
    write(path.join(home, 'config.json'), '{"shared":1}');
    const events: string[] = [];
    const target = path.join(account, 'config.json');
    const entries: SharedEntry[] = [{
      name: 'config.json',
      how: 'derive-json',
      derive: (source, current) => {
        events.push('derive');
        return { ...current, ...source };
      },
      lock: async (lockedTarget, operation) => {
        events.push(`lock-start:${lockedTarget === target}`);
        await new Promise((resolve) => setImmediate(resolve));
        events.push(`exists-before:${fs.existsSync(target)}`);
        operation();
        events.push(`exists-after:${fs.existsSync(target)}`);
        await new Promise((resolve) => setImmediate(resolve));
        events.push('lock-end');
      },
    }];

    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });

    expect(events).toEqual(['lock-start:true', 'exists-before:false', 'derive', 'exists-after:true', 'lock-end']);
  });

  it('puts every entry under the account data subfolder when one is named', async () => {
    write(path.join(home, 'settings.json'), '{"theme":"dark"}');
    write(path.join(home, 'tmp', 'x'), 'x');
    write(path.join(home, 'state.json'), '{"a":1}');
    const entries: SharedEntry[] = [
      { name: 'settings.json', how: 'copy-file' },
      { name: 'tmp', how: 'link-dir', conversationBearing: true },
      { name: 'state.json', how: 'derive-json', derive: (source, current) => ({ ...current, ...source }) },
    ];

    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries, accountDataSubfolder: '.gemini' });

    expect(fs.readFileSync(path.join(account, '.gemini', 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.lstatSync(path.join(account, '.gemini', 'tmp')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(account, '.gemini', 'state.json'), 'utf8'))).toEqual({ a: 1 });
    expect(fs.existsSync(path.join(account, 'settings.json'))).toBe(false);
  });

  it('writes a text entry only when the default home has that file', async () => {
    const entries: SharedEntry[] = [{ name: 'NOTES.md', how: 'text', text: (defaultHome) => `@${path.join(defaultHome, 'NOTES.md')}\n` }];

    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });
    expect(fs.existsSync(path.join(account, 'NOTES.md'))).toBe(false);

    write(path.join(home, 'NOTES.md'), 'notes');
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe(`@${path.join(home, 'NOTES.md')}\n`);
  });
});

describe('provisionAccountFolder run twice together', () => {
  it('lets two provisions of one account both succeed and leaves no temporary file', async () => {
    write(path.join(home, 'settings.json'), '{"theme":"dark"}');
    write(path.join(home, 'config.json'), '{"shared":1}');
    const entries: SharedEntry[] = [
      { name: 'settings.json', how: 'copy-file', required: true },
      {
        name: 'config.json',
        how: 'derive-json',
        derive: (source, current) => ({ ...current, ...source }),
        lock: async (_target, operation) => {
          await new Promise((resolve) => setImmediate(resolve));
          operation();
        },
      },
    ];

    const [first, second] = await Promise.all([
      provisionAccountFolder({ accountFolder: account, defaultHome: home, entries }),
      provisionAccountFolder({ accountFolder: account, defaultHome: home, entries }),
    ]);

    expect(first.conversationLinkFailed).toBe(false);
    expect(second.conversationLinkFailed).toBe(false);
    expect(first.problems).toEqual([]);
    expect(second.problems).toEqual([]);
    expect(fs.readFileSync(path.join(account, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(JSON.parse(fs.readFileSync(path.join(account, 'config.json'), 'utf8'))).toEqual({ shared: 1 });
    expect(allNames(account).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });
});
