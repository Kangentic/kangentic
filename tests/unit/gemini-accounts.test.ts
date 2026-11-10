/**
 * Gemini's account folder, provisioned from its real declaration against temp homes: where a
 * session on a second account files its chats, which settings it runs on, and who a home says is
 * signed in. What a user loses if these go: a chat written where Kangentic cannot read it, old
 * chats deleted because an account ran on default retention, or an account on the wrong login.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionAccountFolder } from '../../src/main/accounts/account-folder';
import type { SharedEntry } from '../../src/main/accounts/account-support';
import {
  GEMINI_ACCOUNT_SUPPORT,
  deriveGeminiAccountSettings,
  identifyGeminiHome,
  parseGeminiSettings,
} from '../../src/main/agent/adapters/gemini/accounts';

let root: string;
/** The user's `~/.gemini`. */
let home: string;
/** The account folder `GEMINI_CLI_HOME` names; its data is `<account>/.gemini`. */
let account: string;
let accountData: string;

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function provision(entries: readonly SharedEntry[] = GEMINI_ACCOUNT_SUPPORT.sharedEntries, platform: NodeJS.Platform = process.platform) {
  return provisionAccountFolder({ accountFolder: account, defaultHome: home, entries, accountDataSubfolder: '.gemini', platform });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-gemini-accounts-'));
  home = path.join(root, 'user', '.gemini');
  account = path.join(root, 'accounts', 'gemini', '2');
  accountData = path.join(account, '.gemini');
  write(path.join(home, 'tmp', 'proj', 'chats', 'session-1.jsonl'), '{"sessionId":"one"}\n');
  write(path.join(home, 'projects.json'), JSON.stringify({ projects: { '/work/proj': 'proj' } }));
  write(path.join(home, 'settings.json'), '{\n  // kept for a year\n  "general": { "sessionRetention": { "enabled": false } },\n  "security": { "auth": { "selectedType": "gemini-api-key" } }\n}\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a Gemini account folder', () => {
  it('files a chat written under the account in the user\'s own tmp', async () => {
    const report = await provision();
    expect(report.conversationLinkFailed).toBe(false);
    write(path.join(accountData, 'tmp', 'proj', 'chats', 'session-2.jsonl'), '{"sessionId":"two"}\n');
    expect(fs.existsSync(path.join(home, 'tmp', 'proj', 'chats', 'session-2.jsonl'))).toBe(true);
    // The shadow repos behind checkpoints are made in the user's home when it has none yet.
    expect(fs.realpathSync(path.join(accountData, 'history'))).toBe(fs.realpathSync(path.join(home, 'history')));
  });

  it('starts from the user\'s project registry, so a slug is never claimed twice', async () => {
    await provision();
    expect(fs.readFileSync(path.join(accountData, 'projects.json'), 'utf8')).toBe(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'));
    // The account's own additions are replaced by the user's registry on the next spawn.
    fs.writeFileSync(path.join(accountData, 'projects.json'), '{"projects":{}}');
    await provision();
    expect(JSON.parse(fs.readFileSync(path.join(accountData, 'projects.json'), 'utf8')).projects).toEqual({ '/work/proj': 'proj' });
  });

  it('is blocked when the registry cannot be copied', async () => {
    // A link where the copy goes is not Kangentic's to replace.
    fs.mkdirSync(accountData, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(accountData, 'projects.json'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await provision()).conversationLinkFailed).toBe(true);
  });

  it('runs on the user\'s settings with its own sign-in method', async () => {
    await provision();
    const first = JSON.parse(fs.readFileSync(path.join(accountData, 'settings.json'), 'utf8'));
    // The user's API-key choice is not the account's, and their retention choice is.
    expect(first).toEqual({ general: { sessionRetention: { enabled: false } } });
    // Gemini records the account's own choice at sign-in; a refresh keeps it.
    write(path.join(accountData, 'settings.json'), JSON.stringify({ ...first, security: { auth: { selectedType: 'oauth-personal' } } }));
    await provision();
    expect(JSON.parse(fs.readFileSync(path.join(accountData, 'settings.json'), 'utf8')).security).toEqual({ auth: { selectedType: 'oauth-personal' } });
  });

  it('is blocked while the user\'s settings cannot be read, never run on defaults', async () => {
    fs.writeFileSync(path.join(home, 'settings.json'), '{ "general": ');
    const report = await provision();
    expect(report.conversationLinkFailed).toBe(true);
    expect(fs.existsSync(path.join(accountData, 'settings.json'))).toBe(false);
  });

  it('links the folder beside .gemini that Gemini reads skills from', async () => {
    write(path.join(root, 'user', '.agents', 'skills', 'review', 'SKILL.md'), 'skill');
    await provision();
    expect(fs.readFileSync(path.join(account, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('skill');
  });

  it('links the seatbelt sandbox\'s runtime folder only where that sandbox exists', async () => {
    await provision(GEMINI_ACCOUNT_SUPPORT.sharedEntries, 'linux');
    expect(fs.existsSync(path.join(account, '.cache'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'user', '.cache'))).toBe(false);
    // The same entry on a platform it names is made, in the user's home too.
    const here: SharedEntry = { name: '../.cache/.gemini', how: 'link-dir', conversationBearing: true, onlyOn: [process.platform] };
    await provision([here]);
    write(path.join(account, '.cache', '.gemini', 'tmp', 'proj', 'chats', 'session-3.jsonl'), '{}\n');
    expect(fs.existsSync(path.join(root, 'user', '.cache', '.gemini', 'tmp', 'proj', 'chats', 'session-3.jsonl'))).toBe(true);
  });

  it('points a session at the account, the shared trust file, and its own login file', () => {
    const previous = process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
    delete process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
    try {
      expect(GEMINI_ACCOUNT_SUPPORT.accountEnv(account, home)).toEqual({
        GEMINI_CLI_HOME: account,
        GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(home, 'trustedFolders.json'),
        GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      });
      // A trust file the user already moved stays theirs: the session inherits it.
      process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = path.join(root, 'trust.json');
      expect(GEMINI_ACCOUNT_SUPPORT.accountEnv(account, home)).not.toHaveProperty('GEMINI_CLI_TRUSTED_FOLDERS_PATH');
    } finally {
      if (previous === undefined) delete process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
      else process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = previous;
    }
  });
});

describe('parseGeminiSettings', () => {
  it('reads settings with comments, as Gemini does', () => {
    expect(parseGeminiSettings('{\n  // a note\n  "a": "http://x/*y*/", /* block */ "b": 1\n}')).toEqual({ a: 'http://x/*y*/', b: 1 });
  });

  it('is null for text that is not an object', () => {
    expect(parseGeminiSettings('{ "a": ')).toBeNull();
    expect(parseGeminiSettings('[1]')).toBeNull();
  });
});

describe('deriveGeminiAccountSettings', () => {
  it('keeps the other sign-in settings the user set', () => {
    const derived = deriveGeminiAccountSettings(
      { security: { auth: { selectedType: 'vertex-ai', enforcedType: 'oauth-personal' }, folderTrust: { enabled: true } } },
      {},
    );
    expect(derived).toEqual({ security: { auth: { enforcedType: 'oauth-personal' }, folderTrust: { enabled: true } } });
  });
});

describe('identifyGeminiHome', () => {
  it('names the Google account of a folder that holds a login', () => {
    write(path.join(accountData, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'present' }));
    write(path.join(accountData, 'google_accounts.json'), JSON.stringify({ active: 'second@example.com', old: [] }));
    expect(identifyGeminiHome(accountData, false)).toEqual({ signedIn: true, email: 'second@example.com', plan: null, hasSubscription: null });
  });

  it('reads a folder with no Google login as signed out, whatever method it names', () => {
    write(path.join(accountData, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
    write(path.join(accountData, 'google_accounts.json'), JSON.stringify({ active: null, old: ['old@example.com'] }));
    expect(identifyGeminiHome(accountData, false).signedIn).toBe(false);
  });

  it('reads the user\'s own home on an API key as a working login with no email', () => {
    expect(identifyGeminiHome(home, true)).toEqual({ signedIn: true, email: null, plan: null, hasSubscription: null });
  });
});
