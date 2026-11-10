import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountIdentity, FolderAccountSupport, SharedEntry } from '../../../accounts/account-support';
import { spawnCli, stopCli } from '../../shared/cli-print';
import { isPlainRecord } from '../../shared/plain-record';
import { codexHomeDir } from './config-toml';

/**
 * BUILT, NOT ENABLED: the adapter does not declare this, so Codex has no card in Settings >
 * Accounts. To enable it, add `readonly accounts = CODEX_ACCOUNT_SUPPORT` to `CodexAdapter` and the
 * agent to `tests/unit/agent-accounts-enabled.test.ts`, once `scripts/probe-agent-accounts.mjs`
 * has passed with two ChatGPT logins.
 *
 * Codex CLI accounts (task #1057). `CODEX_HOME` moves everything, the login included
 * (`auth.json` by default), so an account folder keeps its own login and links every folder that
 * holds a conversation back to the user's `~/.codex`.
 *
 * Built from Codex's source at `rust-v0.163.0` and from runs on that version that need no login:
 * a second home whose `sessions` was a link answered `thread/read`, `thread/list` and
 * `thread/resume` for conversations the first home held, and the resume grew the first home's own
 * rollout files. No ChatGPT sign-in was available, so a signed-in run and a resume under a second
 * account are unproven.
 *
 * What the layout rests on:
 * - The rollout files under `sessions/` are the conversation. Codex finds one by its id in the
 *   file name when its database has no row (`thread_rollout_resolver.rs`), so each account keeps
 *   its own SQLite files. Sharing them was measured to break: a shared row holds a path through
 *   the account folder, and once that folder was gone the user's own home could not resume the
 *   conversation though the file sat in its `sessions/`. So `CODEX_SQLITE_HOME` is set to the
 *   account folder, and a `sqlite_home` the user's `config.toml` sets is not carried over.
 * - `history.jsonl` and `session_index.jsonl` are appended in place, so a hard link holds.
 *   `config.toml` is saved by rename, so it is a copy, made after Kangentic's own trust write.
 * - `thread-writer-locks/` is linked, so two accounts never write one rollout at once.
 * - A conversation stays on the account that started it (`conversationsStayOnAccount`). Rollouts
 *   hold encrypted reasoning, and OpenAI's backend has refused a resume across logins with
 *   "Encrypted content organization_id did not match the target organization" (reported for a
 *   ChatGPT login against an API key). Whether two ChatGPT accounts hit it is not known.
 */

const CONVERSATION_FOLDERS = ['sessions', 'archived_sessions', 'generated_images', 'attachments', 'thread-writer-locks'];
const SETUP_FOLDERS = ['rules', 'skills', 'agents', 'themes', 'plugins'];
const COPIED_FILES = ['AGENTS.md', 'AGENTS.override.md', 'hooks.json', 'environments.toml', 'managed_config.toml', '.env'];

/**
 * The user's `config.toml` without a top-level `sqlite_home`: that key outranks
 * `CODEX_SQLITE_HOME`, and carried into an account folder it would point every account at one
 * database. Only lines ahead of the first table header are top-level keys.
 */
export function withoutSqliteHome(configToml: string): string {
  const lines = configToml.split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevelEnd = firstTable < 0 ? lines.length : firstTable;
  return lines.filter((line, index) => index >= topLevelEnd || !/^\s*sqlite_home\s*=/.test(line)).join('\n');
}

const SHARED_ENTRIES: readonly SharedEntry[] = [
  ...CONVERSATION_FOLDERS.map((name): SharedEntry => ({ name, how: 'link-dir', conversationBearing: true })),
  ...SETUP_FOLDERS.map((name): SharedEntry => ({ name, how: 'link-dir', conversationBearing: false })),
  { name: 'history.jsonl', how: 'hardlink-file', conversationBearing: false },
  // Thread names. A delete rewrites it by rename; the next refresh merges and relinks.
  { name: 'session_index.jsonl', how: 'hardlink-file', conversationBearing: false, holds: 'other' },
  { name: 'config.toml', how: 'copy-file', transform: withoutSqliteHome },
  ...COPIED_FILES.map((name): SharedEntry => ({ name, how: 'copy-file' })),
];


/** A JWT's claims. The token is only decoded for its two public fields, never kept or logged. */
function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isPlainRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** `plus` reads "Plus", `edu_plus` reads "Edu plus": the plan as Codex names it, made readable. */
function planName(planType: unknown): string | null {
  if (typeof planType !== 'string' || planType === '' || planType === 'unknown') return null;
  const words = planType.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Who `auth.json` belongs to (`login/src/auth/storage.rs`, `token_data.rs`): a ChatGPT login
 * keeps an id token whose claims carry `email` and, under `https://api.openai.com/auth`,
 * `chatgpt_plan_type` as of the last refresh. An API key login has `OPENAI_API_KEY` and no
 * person. Null when the text is not a login at all.
 */
export function identifyCodexAuthFile(text: string): AccountIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const tokens = isPlainRecord(parsed.tokens) ? parsed.tokens : null;
  const claims = tokens ? jwtClaims(tokens.id_token) : null;
  if (tokens && claims) {
    const profile = isPlainRecord(claims['https://api.openai.com/profile']) ? claims['https://api.openai.com/profile'] : {};
    const auth = isPlainRecord(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : {};
    const email = typeof claims.email === 'string' ? claims.email : typeof profile.email === 'string' ? profile.email : null;
    return { signedIn: true, email, plan: planName(auth.chatgpt_plan_type), hasSubscription: null };
  }
  if (tokens || (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY !== '')) {
    return { signedIn: true, email: null, plan: null, hasSubscription: null };
  }
  return null;
}

/** The env that points one CLI run at an account's home. None for the agent's own login. */
function homeEnv(home: string | null): Record<string, string> | undefined {
  return home ? { CODEX_HOME: home, CODEX_SQLITE_HOME: home } : undefined;
}

/**
 * `codex login status`: exit 0 signed in, 1 signed out, and it creates nothing in the home
 * (measured signed out on 0.163.0). The answer for a login kept outside `auth.json` (the keyring
 * store), which names no person.
 */
function codexLoginStatus(cliPath: string, home: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnCli(cliPath, ['login', 'status'], os.tmpdir(), homeEnv(home));
    let settled = false;
    const finish = (signedIn: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(signedIn);
    };
    const timer = setTimeout(() => {
      stopCli(child);
      finish(false);
    }, 20_000);
    timer.unref?.();
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', () => finish(false));
    child.once('exit', (code: number | null) => finish(code === 0));
  });
}

async function identifyCodexAccount(cliPath: string, home: string | null): Promise<AccountIdentity> {
  try {
    const fromFile = identifyCodexAuthFile(await fs.promises.readFile(path.join(home ?? codexHomeDir(), 'auth.json'), 'utf8'));
    if (fromFile) return fromFile;
  } catch {
    // No `auth.json`: signed out, or a login kept in the keyring. The CLI knows which.
  }
  return { signedIn: await codexLoginStatus(cliPath, home), email: null, plan: null, hasSubscription: null };
}

export const CODEX_ACCOUNT_SUPPORT: FolderAccountSupport = {
  kind: 'folder',
  defaultHome: () => codexHomeDir(),
  accountEnv: (accountFolder) => ({ CODEX_HOME: accountFolder, CODEX_SQLITE_HOME: accountFolder }),
  // The browser sign-in. It replaces only the login already in that home.
  loginArgs: ['login'],
  sharedEntries: SHARED_ENTRIES,
  conversationsStayOnAccount: true,
  unproven: true,
  // OpenAI's words when a rollout's encrypted reasoning belongs to another login.
  isConversationRefusal: (detail) => /encrypted content|organization_id did not match/i.test(detail),
  identify: identifyCodexAccount,
  // `load_auth` takes these ahead of the stored login (`login/src/auth/manager.rs`).
  // `CODEX_API_KEY` only for `codex exec`.
  overridingCredentialEnvVars: ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY'],
};
