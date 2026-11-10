import fs from 'node:fs';
import path from 'node:path';
import type { AccountIdentity, FolderAccountSupport, SharedEntry } from '../../../accounts/account-support';
import { isPlainRecord } from '../../shared/plain-record';
import { geminiHomeDir } from './gemini-home';

/**
 * BUILT, NOT ENABLED: the adapter does not declare this, so Gemini has no card in Settings >
 * Accounts. To enable it, add `readonly accounts = GEMINI_ACCOUNT_SUPPORT` to `GeminiAdapter` and
 * the agent to `tests/unit/agent-accounts-enabled.test.ts`, once a sign-in, a chat written under
 * the account and a resume on a second Google account have been run.
 *
 * Gemini CLI accounts (task #1057). `GEMINI_CLI_HOME` replaces the user's home folder, so an
 * account folder holds a `.gemini` of its own with that account's Google login
 * (`oauth_creds.json`, `google_accounts.json`), and everything else links or copies back to the
 * user's `~/.gemini`.
 *
 * Built from the 0.67.0 bundle and docs, and from runs that need no login: a second home whose
 * `tmp` and `history` were links listed and found a session the first home held, and gave a
 * project the slug the first home had given it. No Google sign-in, no model turn and no resume on
 * a second account was run, so the sign-in screen and a cross-account resume are unproven.
 *
 * What the layout rests on (line numbers are the bundle's core chunk):
 * - Every conversation path hangs off `tmp/` or `history/` (`Storage.getGlobalTempDir`,
 *   `getHistoryDir`), keyed by a project slug.
 * - The slug registry, `projects.json`, is saved by rename under a lock, so it cannot be a link.
 *   It is copied before each spawn: with an empty registry, a second home claimed the slug of a
 *   project folder that had no ownership marker, and the owner's chats were then filed under
 *   another project (measured). A copy that cannot be made blocks the account.
 * - `settings.json` holds `security.auth.selectedType`, which is the account's own, beside
 *   `general.sessionRetention`, which decides when Gemini deletes old chats from the shared
 *   `tmp/`. So the account gets every setting but that one, and an account never runs on default
 *   retention because the user's file could not be read.
 * - Under the macOS seatbelt sandbox (`SANDBOX=sandbox-exec`) Gemini keeps `tmp/`, `history/` and
 *   the registry in `<home>/.cache/.gemini` (`getGlobalRuntimeDir`), so that folder is linked
 *   whole on macOS. Not run on a Mac.
 */

const SELECTED_AUTH_PATH = ['security', 'auth', 'selectedType'] as const;


/**
 * Gemini reads its settings with comments allowed (`strip-json-comments`), so this drops `//` and
 * block comments outside strings before parsing. Null when the text is still not a JSON object.
 */
export function parseGeminiSettings(text: string): Record<string, unknown> | null {
  let stripped = '';
  let inString = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      stripped += character;
      if (character === '\\' && next !== undefined) {
        stripped += next;
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
    } else if (character === '"') {
      inString = true;
      stripped += character;
      index += 1;
    } else if (character === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      stripped += character;
      index += 1;
    }
  }
  try {
    const parsed: unknown = JSON.parse(stripped);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function selectedAuthType(settings: Record<string, unknown>): unknown {
  let value: unknown = settings;
  for (const key of SELECTED_AUTH_PATH) {
    if (!isPlainRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * The account's `settings.json`: the user's own settings, with the sign-in method the account
 * chose in place of theirs. A user on an API key would otherwise put every account on that key,
 * and a sign-in made in the account would be undone by the next refresh.
 */
export function deriveGeminiAccountSettings(
  source: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(source);
  const security = isPlainRecord(next.security) ? next.security : {};
  const auth = isPlainRecord(security.auth) ? { ...security.auth } : {};
  delete auth.selectedType;
  const own = selectedAuthType(current);
  if (own !== undefined) auth.selectedType = own;
  if (Object.keys(auth).length > 0) {
    next.security = { ...security, auth };
  } else if (isPlainRecord(next.security)) {
    const { auth: _auth, ...restOfSecurity } = security;
    if (Object.keys(restOfSecurity).length > 0) next.security = restOfSecurity;
    else delete next.security;
  }
  return next;
}

const SHARED_ENTRIES: readonly SharedEntry[] = [
  // Chats, checkpoints, per-project logs and memory; and the shadow git repos behind checkpoints.
  { name: 'tmp', how: 'link-dir', conversationBearing: true },
  { name: 'history', how: 'link-dir', conversationBearing: true },
  // The seatbelt sandbox's runtime folder, which then holds `tmp`, `history` and the registry.
  { name: '../.cache/.gemini', how: 'link-dir', conversationBearing: true, onlyOn: ['darwin'] },
  { name: 'projects.json', how: 'copy-file', required: true },
  {
    name: 'settings.json',
    how: 'derive-json',
    derive: deriveGeminiAccountSettings,
    parse: parseGeminiSettings,
    required: true,
  },
  ...['commands', 'skills', 'agents', 'policies', 'acknowledgments', 'extensions'].map(
    (name): SharedEntry => ({ name, how: 'link-dir', conversationBearing: false }),
  ),
  // `~/.agents/skills`, which Gemini reads beside its own folder.
  { name: '../.agents', how: 'link-dir', conversationBearing: false },
  // The global memory file. A hard link, so a memory saved from an account session lands in the
  // user's own file; a copy would be replaced by the next refresh.
  { name: 'GEMINI.md', how: 'hardlink-file', conversationBearing: false, holds: 'other' },
  // Saved by replacing the file, or records that go with a linked folder above.
  ...['keybindings.json', 'mcp-server-enablement.json', 'trusted_hooks.json', 'extension_integrity.json', 'policy_integrity.json'].map(
    (name): SharedEntry => ({ name, how: 'copy-file' }),
  ),
];

function readJson(filePath: string, parse: (text: string) => unknown = JSON.parse): unknown {
  try {
    return parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Who is signed in, read from Gemini's own files with no CLI run: `google_accounts.json` is
 * `{ active, old }` with the signed-in email in `active`, and the Google login is
 * `oauth_creds.json` (the default storage on every platform in 0.67.0). Only the presence of the
 * refresh token is checked; its value is never read out.
 *
 * The user's own home may be on an API key or Vertex instead (`security.auth.selectedType`),
 * which is a working login with no email. An account folder is always a Google sign-in: a key
 * typed into Gemini's dialog goes to one keychain entry every home shares, so it cannot be a
 * second account.
 */
export function identifyGeminiHome(dataFolder: string, isOwnHome: boolean): AccountIdentity {
  const credentials = readJson(path.join(dataFolder, 'oauth_creds.json'));
  const hasGoogleLogin = isPlainRecord(credentials) && typeof credentials.refresh_token === 'string' && credentials.refresh_token !== '';
  const accounts = readJson(path.join(dataFolder, 'google_accounts.json'));
  const email = isPlainRecord(accounts) && typeof accounts.active === 'string' && accounts.active !== '' ? accounts.active : null;
  const settings = readJson(path.join(dataFolder, 'settings.json'), parseGeminiSettings);
  const selected = isPlainRecord(settings) ? selectedAuthType(settings) : undefined;
  if (isOwnHome && typeof selected === 'string' && selected !== 'oauth-personal') {
    return { signedIn: true, email: null, plan: null, hasSubscription: null };
  }
  return { signedIn: hasGoogleLogin, email: hasGoogleLogin ? email : null, plan: null, hasSubscription: null };
}

export const GEMINI_ACCOUNT_SUPPORT: FolderAccountSupport = {
  kind: 'folder',
  // `~/.gemini` itself, or the `.gemini` under an inherited `GEMINI_CLI_HOME`.
  defaultHome: () => geminiHomeDir(),
  accountDataSubfolder: '.gemini',
  accountEnv: (accountFolder, defaultHome) => ({
    GEMINI_CLI_HOME: accountFolder,
    // One trust file for every account, the one Kangentic's trust step writes, under Gemini's
    // own lock. A path the user already set stays theirs.
    ...(process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH ? {} : { GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(defaultHome, 'trustedFolders.json') }),
    // Set to `true`, this keeps the Google login in one keychain entry every home shares and
    // deletes the folder's own file, so an account's sign-in would replace the user's. An
    // account folder always uses the file.
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
  }),
  // Gemini has no sign-in command. Started with no method chosen, it opens its own sign-in
  // screen; the user picks Sign in with Google, restarts when asked, and leaves with /quit.
  loginArgs: [],
  loginIsInteractive: true,
  unproven: true,
  sharedEntries: SHARED_ENTRIES,
  identify: async (_cliPath, home) => (home
    ? identifyGeminiHome(path.join(home, '.gemini'), false)
    : identifyGeminiHome(geminiHomeDir(), true)),
  // Each feeds or replaces the sign-in Gemini uses (`refreshAuth` and the non-interactive
  // auth-type order in the 0.67.0 bundle).
  overridingCredentialEnvVars: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    'GOOGLE_CLOUD_ACCESS_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GEMINI_BASE_URL',
    'GEMINI_CLI_USE_COMPUTE_ADC',
  ],
};
