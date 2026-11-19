import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isInsideOrSame, provisionAccountFolder } from '../../src/main/accounts/account-folder';
import type { SharedEntry } from '../../src/main/accounts/account-support';
import { HOME_RECORD_FILE } from '../../src/main/accounts/home-record';
import { __resetForTest } from '../../src/main/config/write-failure-notice';

// A state file write that fails reports through the write-failure latch, which reaches Sentry.
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: vi.fn(),
}));

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

  // Skipping a setup folder the home lacked left the account a real folder only it read: an
  // agent or command made from an account session reached no other account and not the home.
  it('makes a folder the home lacks before linking it, so what an account writes there lands in the home', async () => {
    const entries: SharedEntry[] = [
      { name: 'agents', how: 'link-dir', conversationBearing: false },
      { name: 'projects', how: 'link-dir', conversationBearing: true },
    ];
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });
    expect(report.problems).toEqual([]);
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.lstatSync(path.join(account, 'agents')).isSymbolicLink()).toBe(true);
    write(path.join(account, 'agents', 'reviewer.md'), 'made from the account');
    expect(fs.readFileSync(path.join(home, 'agents', 'reviewer.md'), 'utf8')).toBe('made from the account');
    expect(fs.statSync(path.join(home, 'projects')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(account, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('moves what an account already made in such a folder into the home', async () => {
    write(path.join(account, 'agents', 'reviewer.md'), 'made before the folder was linked');
    const entries: SharedEntry[] = [{ name: 'agents', how: 'link-dir', conversationBearing: false }];

    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });

    expect(report.problems).toEqual([]);
    expect(fs.readFileSync(path.join(home, 'agents', 'reviewer.md'), 'utf8')).toBe('made before the folder was linked');
    expect(fs.lstatSync(path.join(account, 'agents')).isSymbolicLink()).toBe(true);
  });

  // The failure is forced on the one mkdir, not built from a file where a folder goes: a path
  // under a file reads as missing on Windows and throws ENOTDIR from lstat on Linux and macOS.
  it('reports a setup folder it cannot make in the home, and does not block the account', async () => {
    const entries: SharedEntry[] = [{ name: 'agents', how: 'link-dir', conversationBearing: false }];
    const realMkdir = fs.mkdirSync;
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
      if (String(target) === path.join(home, 'agents')) throw denied;
      return realMkdir(target, options);
    });
    let report: Awaited<ReturnType<typeof provisionAccountFolder>>;
    try {
      report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries });
    } finally {
      mkdirSpy.mockRestore();
    }

    expect(report.problems.map((problem) => problem.code)).toEqual(['link-failed']);
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.existsSync(path.join(home, 'agents'))).toBe(false);
    expect(fs.existsSync(path.join(account, 'agents'))).toBe(false);
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

function provision(entries: SharedEntry[], accountFolder: string = account) {
  return provisionAccountFolder({ accountFolder, defaultHome: home, entries });
}

function codes(report: Awaited<ReturnType<typeof provisionAccountFolder>>): string[] {
  return report.problems.map((problem) => problem.code);
}

function keptAside(name: string): string[] {
  return fs.readdirSync(account).filter((entry) => entry.startsWith(`${name}.kangentic-kept`));
}

// A user-memory edit from an account session lands in the account folder's own file. Writing the
// import line over it destroyed text a person wrote, with no copy kept.
describe('provisionAccountFolder keeps text an account wrote', () => {
  const IMPORT: SharedEntry[] = [{ name: 'NOTES.md', how: 'text', text: () => '@home/NOTES.md\n' }];
  const COPY: SharedEntry[] = [
    { name: 'NOTES.md', how: 'text', text: (defaultHome) => fs.readFileSync(path.join(defaultHome, 'NOTES.md'), 'utf8') },
  ];

  it('keeps a file the account made aside, with its text, when the home gains one', async () => {
    write(path.join(account, 'NOTES.md'), 'written from the account');
    // While the home has none, the account's file is left alone.
    expect((await provision(IMPORT)).problems).toEqual([]);
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe('written from the account');

    write(path.join(home, 'NOTES.md'), 'the notes in the home');
    const report = await provision(IMPORT);

    expect(codes(report)).toEqual(['kept-aside']);
    expect(report.problems[0].entry).toBe('NOTES.md');
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe('@home/NOTES.md\n');
    const aside = keptAside('NOTES.md');
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(account, aside[0]), 'utf8')).toBe('written from the account');
    // Kept once: the next refresh finds the import line in place.
    expect((await provision(IMPORT)).problems).toEqual([]);
    expect(keptAside('NOTES.md')).toHaveLength(1);
  });

  it('keeps what an account added under the import line', async () => {
    write(path.join(home, 'NOTES.md'), 'the notes in the home');
    await provision(IMPORT);
    fs.appendFileSync(path.join(account, 'NOTES.md'), 'a line added from the account\n');

    const report = await provision(IMPORT);

    expect(codes(report)).toEqual(['kept-aside']);
    expect(fs.readFileSync(path.join(account, keptAside('NOTES.md')[0]), 'utf8')).toBe('@home/NOTES.md\na line added from the account\n');
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe('@home/NOTES.md\n');
  });

  it('replaces its own earlier write when the home text changes, keeping nothing aside', async () => {
    write(path.join(home, 'NOTES.md'), 'first');
    await provision(COPY);
    write(path.join(home, 'NOTES.md'), 'second');

    const report = await provision(COPY);

    expect(report.problems).toEqual([]);
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe('second');
    expect(keptAside('NOTES.md')).toEqual([]);
  });

  it('leaves a link at the entry in place and reports it user-owned', async () => {
    write(path.join(home, 'NOTES.md'), 'the notes in the home');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(account, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(account, 'NOTES.md'), linkType());

    const report = await provision(IMPORT);

    expect(codes(report)).toEqual(['user-owned']);
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.lstatSync(path.join(account, 'NOTES.md')).isSymbolicLink()).toBe(true);
  });

  it('reports a target it cannot look at, and still runs the entries after it', async () => {
    write(path.join(account, 'NOTES.md'), 'written from the account');
    write(path.join(home, 'NOTES.md'), 'the notes in the home');
    write(path.join(home, 'settings.json'), '{"theme":"dark"}\n');
    const entries: SharedEntry[] = [...IMPORT, { name: 'settings.json', how: 'copy-file' }];
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const realLstat = fs.lstatSync.bind(fs) as (target: fs.PathLike) => fs.Stats;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target) === path.join(account, 'NOTES.md')) throw denied;
      return realLstat(target);
    }) as unknown as typeof fs.lstatSync);
    let report: Awaited<ReturnType<typeof provisionAccountFolder>>;
    try {
      report = await provision(entries);
    } finally {
      lstatSpy.mockRestore();
    }

    expect(codes(report)).toEqual(['link-failed']);
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe('written from the account');
    expect(fs.readFileSync(path.join(account, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
  });

  it('leaves a file it cannot move aside where it is, never writing over it', async () => {
    write(path.join(account, 'NOTES.md'), 'written from the account');
    write(path.join(home, 'NOTES.md'), 'the notes in the home');
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy; });
    let report: Awaited<ReturnType<typeof provisionAccountFolder>>;
    try {
      report = await provision(IMPORT);
    } finally {
      renameSpy.mockRestore();
    }

    expect(codes(report)).toEqual(['link-failed']);
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.readFileSync(path.join(account, 'NOTES.md'), 'utf8')).toBe('written from the account');
    // The next spawn tries again, and then the text is kept.
    expect(codes(await provision(IMPORT))).toEqual(['kept-aside']);
    expect(fs.readFileSync(path.join(account, keptAside('NOTES.md')[0]), 'utf8')).toBe('written from the account');
  });
});

// A copy runs one way, home to account, so a setting changed from an account session is gone at
// that account's next spawn. It is still replaced; what changed is that it is said.
describe('provisionAccountFolder reports a change made on the account that a copy replaces', () => {
  const SETTINGS: SharedEntry[] = [{ name: 'settings.json', how: 'copy-file', reportReplaced: true }];
  const settingsInHome = (): string => path.join(home, 'settings.json');
  const settingsInAccount = (): string => path.join(account, 'settings.json');

  it('reports an edit made on the account since the last copy, once, and replaces it', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    expect((await provision(SETTINGS)).problems).toEqual([]);
    write(settingsInAccount(), '{"theme":"dark","model":"opus"}\n');

    const report = await provision(SETTINGS);

    expect(report.problems.map(({ entry, code }) => ({ entry, code }))).toEqual([{ entry: 'settings.json', code: 'change-replaced' }]);
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.readFileSync(settingsInAccount(), 'utf8')).toBe('{"theme":"dark"}\n');
    expect((await provision(SETTINGS)).problems).toEqual([]);
  });

  it('says nothing when only the home changed', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    await provision(SETTINGS);
    write(settingsInHome(), '{"theme":"light"}\n');

    const report = await provision(SETTINGS);

    expect(report.problems).toEqual([]);
    expect(fs.readFileSync(settingsInAccount(), 'utf8')).toBe('{"theme":"light"}\n');
  });

  it('says nothing for a copy the CLI wrote again in another layout', async () => {
    write(settingsInHome(), '{"theme":"dark","model":"opus"}\n');
    await provision(SETTINGS);
    write(settingsInAccount(), '{\r\n    "model": "opus",\r\n    "theme": "dark"\r\n}\r\n');

    expect((await provision(SETTINGS)).problems).toEqual([]);
  });

  it('judges nothing on the first refresh of a folder with no record, then judges from it', async () => {
    // A folder made before the record existed: its copy may only be an older copy of the home's.
    write(settingsInHome(), '{"theme":"dark"}\n');
    write(settingsInAccount(), '{"theme":"light"}\n');
    expect((await provision(SETTINGS)).problems).toEqual([]);

    write(settingsInAccount(), '{"theme":"light"}\n');
    expect(codes(await provision(SETTINGS))).toEqual(['change-replaced']);
  });

  it('reports a file the account made itself once the home gains one', async () => {
    const keybindings: SharedEntry[] = [{ name: 'keybindings.json', how: 'copy-file', reportReplaced: true }];
    await provision(keybindings);
    write(path.join(account, 'keybindings.json'), '{"bindings":[{"key":"ctrl+k"}]}');
    // The home still has none: the account's file is its own and stays.
    expect((await provision(keybindings)).problems).toEqual([]);
    expect(fs.readFileSync(path.join(account, 'keybindings.json'), 'utf8')).toBe('{"bindings":[{"key":"ctrl+k"}]}');

    write(path.join(home, 'keybindings.json'), '{"bindings":[]}');
    const report = await provision(keybindings);

    expect(codes(report)).toEqual(['change-replaced']);
    expect(fs.readFileSync(path.join(account, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}');
  });

  it('judges only an entry that asks for it', async () => {
    const unjudged: SharedEntry[] = [{ name: 'settings.json', how: 'copy-file' }];
    write(settingsInHome(), '{"theme":"dark"}\n');
    await provision(unjudged);
    write(settingsInAccount(), '{"theme":"light"}\n');

    expect((await provision(unjudged)).problems).toEqual([]);
    expect(fs.existsSync(path.join(account, HOME_RECORD_FILE))).toBe(false);
  });

  it('reports nothing for a copy that did not land, and still knows the change is the account\'s', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    await provision(SETTINGS);
    write(settingsInAccount(), '{"theme":"light"}\n');
    const realRename = fs.renameSync.bind(fs);
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === settingsInAccount()) throw busy;
      realRename(from, to);
    });
    let failed: Awaited<ReturnType<typeof provisionAccountFolder>>;
    try {
      failed = await provision(SETTINGS);
    } finally {
      renameSpy.mockRestore();
    }

    expect(failed.problems).toEqual([]);
    expect(fs.readFileSync(settingsInAccount(), 'utf8')).toBe('{"theme":"light"}\n');
    expect(codes(await provision(SETTINGS))).toEqual(['change-replaced']);
  });

  it('saves the record for the entries written before a later entry throws', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    write(path.join(home, 'config.json'), '{"shared":1}');
    const entries: SharedEntry[] = [
      ...SETTINGS,
      {
        name: 'config.json',
        how: 'derive-json',
        derive: (source, current) => ({ ...current, ...source }),
        lock: async () => { throw new Error('lock failed'); },
      },
    ];

    await expect(provision(entries)).rejects.toThrow('lock failed');

    const record = JSON.parse(fs.readFileSync(path.join(account, HOME_RECORD_FILE), 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(record.entries)).toContain('settings.json');
  });

  it('treats a record this version cannot read as no record', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    await provision(SETTINGS);
    const recordPath = path.join(account, HOME_RECORD_FILE);
    const good = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { version: number; entries: Record<string, unknown> };
    const badRecords = [
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ version: 1, entries: { 'settings.json': { file: 123 } } }),
      'not json',
    ];

    for (const [index, badRecord] of badRecords.entries()) {
      write(recordPath, badRecord);
      write(settingsInAccount(), '{"theme":"light"}\n');

      expect((await provision(SETTINGS)).problems).toEqual([]);

      if (index === 0) {
        const rewritten = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { version: number };
        expect(rewritten.version).toBe(1);
      }
    }
  });

  it('does not forget what the home held while its file is missing', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    await provision(SETTINGS);
    fs.rmSync(settingsInHome());
    expect((await provision(SETTINGS)).problems).toEqual([]);
    expect(fs.readFileSync(settingsInAccount(), 'utf8')).toBe('{"theme":"dark"}\n');

    write(settingsInHome(), '{"theme":"light"}\n');
    const report = await provision(SETTINGS);

    expect(report.problems).toEqual([]);
    expect(fs.readFileSync(settingsInAccount(), 'utf8')).toBe('{"theme":"light"}\n');
  });

  it('says nothing for a copy saved again without the home\'s byte order mark', async () => {
    // Built from its code: an invisible character typed into the source is one an editor can drop.
    const byteOrderMark = String.fromCharCode(0xfeff);
    write(settingsInHome(), `${byteOrderMark}{"theme":"dark"}\n`);
    await provision(SETTINGS);
    write(settingsInAccount(), '{"theme":"dark"}\n');

    expect((await provision(SETTINGS)).problems).toEqual([]);
  });

  it('keeps its record in the account folder, never the home', async () => {
    write(settingsInHome(), '{"theme":"dark"}\n');
    await provision(SETTINGS);

    expect(fs.existsSync(path.join(account, HOME_RECORD_FILE))).toBe(true);
    expect(allNames(home)).toEqual(['settings.json']);
    // The record holds hashes: nothing a setting says is written a second time.
    expect(fs.readFileSync(path.join(account, HOME_RECORD_FILE), 'utf8')).not.toContain('dark');
  });
});

// A derived state file mixes what a user sets with what the CLI counts for itself, which it
// rewrites on every run. Only the first is watched, by the parts its declaration names.
describe('provisionAccountFolder reports a part of a derived file the account changed', () => {
  type Servers = Record<string, unknown>;
  const serversOf = (state: Record<string, unknown>): Servers => (state.servers ?? {}) as Servers;
  const stateInHome = (): string => path.join(home, 'state.json');
  const stateInAccount = (): string => path.join(account, 'state.json');
  const readState = (filePath: string): Record<string, unknown> => JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const writeState = (filePath: string, state: Record<string, unknown>): void => write(filePath, JSON.stringify(state));

  /** The home wins for a server both have, the account keeps its own, and one the home dropped goes. */
  function stateEntry(removedSeen: string[][] = []): SharedEntry[] {
    return [{
      name: 'state.json',
      how: 'derive-json',
      derive: (source, current, context) => {
        removedSeen.push([...context.removedFromHome].sort());
        const servers: Servers = { ...serversOf(current), ...serversOf(source) };
        for (const part of context.removedFromHome) delete servers[part.slice('servers/'.length)];
        return { ...current, ...source, servers };
      },
      userParts: (state) => Object.fromEntries(Object.entries(serversOf(state)).map(([name, server]) => [`servers/${name}`, server])),
    }];
  }

  beforeEach(() => {
    writeState(stateInHome(), { startups: 1, servers: { docs: { command: 'npx' }, search: { command: 'uvx' } } });
  });

  it('reports parts the account changed that the home\'s replace, as one problem, once', async () => {
    const entries = stateEntry();
    expect((await provision(entries)).problems).toEqual([]);
    writeState(stateInAccount(), { startups: 1, servers: { docs: { command: 'node' }, search: { command: 'bun' } } });

    const report = await provision(entries);

    expect(report.problems.map(({ entry, code }) => ({ entry, code }))).toEqual([{ entry: 'state.json', code: 'change-replaced' }]);
    expect(report.conversationLinkFailed).toBe(false);
    expect(serversOf(readState(stateInAccount()))).toEqual({ docs: { command: 'npx' }, search: { command: 'uvx' } });
    expect((await provision(entries)).problems).toEqual([]);
  });

  it('says nothing for what the CLI counts for itself', async () => {
    const entries = stateEntry();
    await provision(entries);
    writeState(stateInAccount(), { ...readState(stateInAccount()), startups: 9 });

    const report = await provision(entries);

    expect(report.problems).toEqual([]);
    expect(readState(stateInAccount()).startups).toBe(1);
  });

  it('says nothing when only the home changed, or when the account added a part the home never had', async () => {
    const entries = stateEntry();
    await provision(entries);
    writeState(stateInHome(), { startups: 1, servers: { docs: { command: 'deno' }, search: { command: 'uvx' } } });
    const state = readState(stateInAccount());
    writeState(stateInAccount(), { ...state, servers: { ...serversOf(state), mine: { command: 'node' } } });

    const report = await provision(entries);

    expect(report.problems).toEqual([]);
    expect(serversOf(readState(stateInAccount()))).toEqual({ docs: { command: 'deno' }, search: { command: 'uvx' }, mine: { command: 'node' } });
  });

  it('reports a part the account added once the home adds another under its name', async () => {
    const entries = stateEntry();
    await provision(entries);
    const state = readState(stateInAccount());
    writeState(stateInAccount(), { ...state, servers: { ...serversOf(state), mine: { command: 'node' } } });
    expect((await provision(entries)).problems).toEqual([]);
    writeState(stateInHome(), { startups: 1, servers: { docs: { command: 'npx' }, search: { command: 'uvx' }, mine: { command: 'python' } } });

    expect(codes(await provision(entries))).toEqual(['change-replaced']);
  });

  it('reports a part the account removed that the home puts back', async () => {
    const entries = stateEntry();
    await provision(entries);
    writeState(stateInAccount(), { startups: 1, servers: { docs: { command: 'npx' } } });

    expect(codes(await provision(entries))).toEqual(['change-replaced']);
    expect(Object.keys(serversOf(readState(stateInAccount()))).sort()).toEqual(['docs', 'search']);
  });

  it('judges nothing on the first refresh of a file the account already had', async () => {
    writeState(stateInAccount(), { startups: 4, servers: { docs: { command: 'node' } } });

    expect((await provision(stateEntry())).problems).toEqual([]);
  });

  it('tells the derive which parts the home dropped, and nothing when the home gives no answer', async () => {
    const removedSeen: string[][] = [];
    const lastSeen = (): string[] => removedSeen[removedSeen.length - 1];
    const entries = stateEntry(removedSeen);
    await provision(entries);
    expect(lastSeen()).toEqual([]);

    // A file caught empty or half written is no answer: it never reads as "everything removed".
    write(stateInHome(), '');
    await provision(entries);
    expect(lastSeen()).toEqual([]);
    write(stateInHome(), '{ "servers": ');
    await provision(entries);
    expect(lastSeen()).toEqual([]);
    expect(Object.keys(serversOf(readState(stateInAccount()))).sort()).toEqual(['docs', 'search']);

    writeState(stateInHome(), { startups: 1, servers: { docs: { command: 'npx' } } });
    const report = await provision(entries);
    expect(lastSeen()).toEqual(['servers/search']);
    expect(report.problems).toEqual([]);
    expect(serversOf(readState(stateInAccount()))).toEqual({ docs: { command: 'npx' } });
    // Told once: the record now says the home holds one server.
    await provision(entries);
    expect(lastSeen()).toEqual([]);
  });

  it('treats a home state file that is {} or missing as no answer, and keeps the record through both', async () => {
    const removedSeen: string[][] = [];
    const lastSeen = (): string[] => removedSeen[removedSeen.length - 1];
    const entries = stateEntry(removedSeen);
    await provision(entries);

    write(stateInHome(), '{}');
    await provision(entries);
    expect(lastSeen()).toEqual([]);
    expect(Object.keys(serversOf(readState(stateInAccount()))).sort()).toEqual(['docs', 'search']);

    fs.rmSync(stateInHome());
    await provision(entries);
    expect(lastSeen()).toEqual([]);
    expect(Object.keys(serversOf(readState(stateInAccount()))).sort()).toEqual(['docs', 'search']);

    // The record survived both: it still says the home held two servers.
    writeState(stateInHome(), { startups: 1, servers: { docs: { command: 'npx' } } });
    await provision(entries);
    expect(lastSeen()).toEqual(['servers/search']);
  });

  describe('when the write of the account state file does not land', () => {
    const realRename = fs.renameSync.bind(fs);
    const refused = Object.assign(new Error('input output error'), { code: 'EIO' });

    /** Provisions with only the state file's own rename refused; the record file still saves. */
    async function provisionWithStateWriteFailing(entries: SharedEntry[]): Promise<Awaited<ReturnType<typeof provisionAccountFolder>>> {
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === stateInAccount()) throw refused;
        realRename(from, to);
      });
      try {
        return await provision(entries);
      } finally {
        renameSpy.mockRestore();
        __resetForTest();
      }
    }

    it('reports nothing and still knows the account\'s change is its own', async () => {
      const entries = stateEntry();
      await provision(entries);
      writeState(stateInAccount(), { startups: 1, servers: { docs: { command: 'node' }, search: { command: 'uvx' } } });

      const failed = await provisionWithStateWriteFailing(entries);

      expect(failed.problems).toEqual([]);
      expect(serversOf(readState(stateInAccount())).docs).toEqual({ command: 'node' });
      expect(codes(await provision(entries))).toEqual(['change-replaced']);
    });

    it('does not record the home\'s new state, so an untouched account copy is not read as a change', async () => {
      const entries = stateEntry();
      await provision(entries);
      writeState(stateInHome(), { startups: 1, servers: { docs: { command: 'deno' }, search: { command: 'uvx' } } });

      const failed = await provisionWithStateWriteFailing(entries);

      expect(failed.problems).toEqual([]);
      expect(serversOf(readState(stateInAccount())).docs).toEqual({ command: 'npx' });

      const retried = await provision(entries);
      expect(retried.problems).toEqual([]);
      expect(serversOf(readState(stateInAccount())).docs).toEqual({ command: 'deno' });
    });
  });

  it('has no change to replace when the account state file is missing or empty', async () => {
    const entries = stateEntry();
    await provision(entries);

    fs.rmSync(stateInAccount());
    expect((await provision(entries)).problems).toEqual([]);
    expect(Object.keys(serversOf(readState(stateInAccount()))).sort()).toEqual(['docs', 'search']);

    write(stateInAccount(), '');
    expect((await provision(entries)).problems).toEqual([]);
  });

  it('judges nothing for an entry that names no parts', async () => {
    const entries: SharedEntry[] = [{ name: 'state.json', how: 'derive-json', derive: (source, current) => ({ ...current, ...source }) }];
    await provision(entries);
    writeState(stateInAccount(), { startups: 1, servers: { docs: { command: 'node' } } });

    expect((await provision(entries)).problems).toEqual([]);
    expect(fs.existsSync(path.join(account, HOME_RECORD_FILE))).toBe(false);
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
