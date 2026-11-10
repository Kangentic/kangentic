/**
 * Codex's and Grok's account declarations, run for real against temp homes. What a user loses if
 * these go: a Codex conversation written where Kangentic cannot read it, every Codex account
 * sharing one database (measured to break resume), or a Grok account running on the wrong login.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionAccountFolder } from '../../src/main/accounts/account-folder';
import { conversationAccountOf } from '../../src/main/accounts/account-service';
import { CODEX_ACCOUNT_SUPPORT, identifyCodexAuthFile, withoutSqliteHome } from '../../src/main/agent/adapters/codex/accounts';
import { GROK_ACCOUNT_SUPPORT, identifyGrokAuthFile } from '../../src/main/agent/adapters/grok/accounts';
import { GrokCommandBuilder } from '../../src/main/agent/adapters/grok/command-builder';

let root: string;
let home: string;
let account: string;

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** An unsigned token with these claims: only its payload is ever read. */
function tokenWith(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-agent-accounts-'));
  home = path.join(root, 'home');
  account = path.join(root, 'accounts', '2');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a Codex account folder', () => {
  beforeEach(() => {
    write(path.join(home, 'sessions', '2026', '11', '09', 'rollout-2026-11-09T10-00-00-thread-1.jsonl'), '{"type":"session_meta"}\n');
    write(path.join(home, 'config.toml'), 'model = "x"\nsqlite_home = "/shared/db"\n\n[projects."/work"]\ntrust_level = "trusted"\nsqlite_home = "kept, a table key"\n');
    write(path.join(home, 'history.jsonl'), '{"text":"first"}\n');
  });

  it('writes a rollout under the account into the user\'s own sessions, and links what guards it', async () => {
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: CODEX_ACCOUNT_SUPPORT.sharedEntries });
    expect(report.conversationLinkFailed).toBe(false);
    write(path.join(account, 'sessions', '2026', '11', '09', 'rollout-2026-11-09T11-00-00-thread-2.jsonl'), '{}\n');
    expect(fs.existsSync(path.join(home, 'sessions', '2026', '11', '09', 'rollout-2026-11-09T11-00-00-thread-2.jsonl'))).toBe(true);
    // One lock folder, so two accounts never write one rollout at once; made in the home when missing.
    expect(fs.realpathSync(path.join(account, 'thread-writer-locks'))).toBe(fs.realpathSync(path.join(home, 'thread-writer-locks')));
    // Thread names and prompt history are the user's own files.
    fs.appendFileSync(path.join(account, 'session_index.jsonl'), '{"id":"thread-2","thread_name":"second"}\n');
    expect(fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8')).toContain('thread-2');
  });

  it('keeps its own database: the config copy drops a shared sqlite_home, and the env names the folder', async () => {
    await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: CODEX_ACCOUNT_SUPPORT.sharedEntries });
    const copied = fs.readFileSync(path.join(account, 'config.toml'), 'utf8');
    expect(copied).not.toContain('/shared/db');
    expect(copied).toContain('model = "x"');
    expect(copied).toContain('trust_level = "trusted"');
    expect(CODEX_ACCOUNT_SUPPORT.accountEnv(account, home)).toEqual({ CODEX_HOME: account, CODEX_SQLITE_HOME: account });
  });

  it('drops only the top-level sqlite_home', () => {
    expect(withoutSqliteHome('a = 1\n  sqlite_home = "x"\n[t]\nsqlite_home = "y"\n')).toBe('a = 1\n[t]\nsqlite_home = "y"\n');
  });
});

describe('identifyCodexAuthFile', () => {
  it('names the person and plan of a ChatGPT login from its id token\'s claims', () => {
    const idToken = tokenWith({ email: 'second@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } });
    expect(identifyCodexAuthFile(JSON.stringify({ tokens: { id_token: idToken, access_token: 'opaque' } })))
      .toEqual({ signedIn: true, email: 'second@example.com', plan: 'Plus', hasSubscription: null });
  });

  it('reads an API key login as signed in with no person, and anything else as no login', () => {
    expect(identifyCodexAuthFile(JSON.stringify({ OPENAI_API_KEY: 'present', tokens: null }))).toEqual({ signedIn: true, email: null, plan: null, hasSubscription: null });
    expect(identifyCodexAuthFile('{}')).toBeNull();
    expect(identifyCodexAuthFile('not json')).toBeNull();
  });
});

describe('conversationAccountOf', () => {
  const records = [
    { agent_session_id: 'thread-2', account_id: 'account-b' },
    { agent_session_id: 'thread-1', account_id: null },
  ];

  it('names the account a resumed conversation ran on, and the agent\'s own login as null', () => {
    expect(conversationAccountOf(records, 'thread-2', true)).toBe('account-b');
    expect(conversationAccountOf(records, 'thread-1', true)).toBeNull();
  });

  it('is undefined when nothing is being resumed', () => {
    expect(conversationAccountOf(records, 'thread-2', false)).toBeUndefined();
    expect(conversationAccountOf(records, null, true)).toBeUndefined();
  });
});

describe('a Grok account', () => {
  it('is a login file of its own: the env names the file, and nothing is linked', async () => {
    expect(GROK_ACCOUNT_SUPPORT.accountEnv(account, home)).toEqual({ GROK_AUTH_PATH: path.join(account, 'auth.json') });
    const report = await provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: GROK_ACCOUNT_SUPPORT.sharedEntries });
    expect(report.conversationLinkFailed).toBe(false);
    expect(fs.readdirSync(account)).toEqual([]);
  });

  it('reads who a login file belongs to without the token', () => {
    const login = { 'https://auth.x.ai::client': { key: 'opaque', refresh_token: 'opaque', email: 'second@example.com', user_id: 'u-1' } };
    expect(identifyGrokAuthFile(JSON.stringify(login))).toEqual({ signedIn: true, email: 'second@example.com', plan: null, hasSubscription: null });
    // A stored API key is a working login with no person.
    expect(identifyGrokAuthFile(JSON.stringify({ 'xai::api_key': { key: 'opaque' } }))).toEqual({ signedIn: true, email: null, plan: null, hasSubscription: null });
  });

  it('reads a missing, empty or broken login file as signed out', () => {
    expect(identifyGrokAuthFile(null).signedIn).toBe(false);
    expect(identifyGrokAuthFile('{}').signedIn).toBe(false);
    expect(identifyGrokAuthFile('{ "scope": ').signedIn).toBe(false);
  });

  it('runs its sessions standalone, ahead of every other flag, and leaves a headless run alone', () => {
    const builder = new GrokCommandBuilder();
    const options = { grokPath: '/usr/bin/grok', taskId: 'task-1', cwd: root, permissionMode: 'acceptEdits' as const, shell: 'bash' };
    expect(builder.buildGrokCommand({ ...options, standalone: true })).toMatch(/^\/usr\/bin\/grok --no-leader /);
    expect(builder.buildGrokCommand(options)).not.toContain('--no-leader');
    expect(builder.buildGrokCommand({ ...options, standalone: true, nonInteractive: true, prompt: 'hi' })).not.toContain('--no-leader');
  });
});
