import fs from 'node:fs';
import path from 'node:path';
import {
  EmptyUsageReadError,
  IdentityReadError,
  type AccountIdentity,
  type DeriveContext,
  type EmptyUsageReadReason,
  type FolderAccountSupport,
  type SharedEntry,
} from '../../../accounts/account-support';
import type { RateLimitWindow } from '../../../../shared/types';
import { isPlainRecord } from '../../shared/plain-record';
import { claudeHomeDir, claudeStatePathForHome, isDefaultClaudeHome, withClaudeJsonFileLock } from './claude-json-lock';
import { runClaudeCli } from './cli-run';
import { carryClaudePlanFiles } from './plan-carry';
import { RATE_LIMIT_WINDOWS } from './status-parser';

/**
 * Claude Code accounts (task #1057). `CLAUDE_CONFIG_DIR` is Claude's documented way to stay
 * signed in to several accounts (Authentication, "Log in with multiple accounts"): each folder
 * keeps its own `.credentials.json` and, on macOS, its own Keychain entry.
 *
 * Measured with three real accounts on Claude Code 2.1.319: a second login in its own folder left
 * the default one signed in; an interactive session wrote its transcript through a `projects`
 * junction into the default home; a conversation with a signed thinking block started on one
 * account resumed on another; two accounts writing at once left both transcripts whole; the
 * prompt history hard link survived Claude's writes.
 *
 * Measured on 2.1.322 (task #1070, `scripts/probe-claude-plan-tool-approval.js --layouts`, a
 * sandboxed home and a local API stand-in): Claude checks a Write through a link both as asked and
 * where it lands. Through a `plans` junction into `~/.claude` the plan file Write prompted ("Do you
 * want to create ...md?") and through a junction anywhere else plan mode refused it, so `plans` is
 * each account's own folder and a resume carries its plan file over (`plan-carry.ts`). An auto
 * memory Write through the `projects` junction prompted the same way in default and acceptEdits
 * mode, so an account session names its memory folder by its real path in the default home
 * (`auto-memory-folder.ts`), which wrote with no prompt. With every other folder linked, Write,
 * Read, Edit and Bash in the project ran with no prompt and the transcript landed through the
 * link. A real account session wrote `file-history`, `session-env` and `shell-snapshots` through
 * their links with no prompt. `todos`, `tasks` and `paste-cache` are unmeasured.
 */

/** Keys Claude resets on logout, plus install ids and caches: the account's own, never copied. */
const ACCOUNT_BOUND_KEYS = new Set([
  'oauthAccount',
  'userID',
  'machineID',
  'primaryApiKey',
  'firstStartTime',
  'firstStartVersion',
  'claudeCodeFirstTokenDate',
  'subscriptionNoticeCount',
  'hasAvailableSubscription',
  'additionalModelOptionsCache',
  'additionalModelOptionsAnsweredAt',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'cachedArtifactRoster',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
  'cachedUsageUtilization',
  'metricsStatusCache',
  'metricsStatusCacheByPrincipal',
  'githubWebConnectionStatusCache',
  'startupPrefetchedAt',
  // The fullscreen boot canary is per process and per folder. Copying another folder's record
  // would read as a failed start of this one (pty-teardown-grace.md).
  'fullscreenBootPending',
]);

function isAccountBound(key: string): boolean {
  return ACCOUNT_BOUND_KEYS.has(key) || key.includes('Cache') || key.startsWith('cached') || key.startsWith('passes');
}


/** Per-entry maps: the default home wins for entries it has, the account keeps its own others. */
const MERGED_BY_ENTRY = new Set(['projects', 'mcpServers']);

/**
 * The keys Claude's settings reference lists with the scope "Global config": settings `/config`
 * and its commands store in `.claude.json`, and ignore in `settings.json`
 * (code.claude.com/docs/en/settings-reference, read 2026-11-19, with the two keys it marks as
 * removed left out). Theme, model, effort and permission rules are not here: Claude keeps those
 * in `settings.json`. This list only decides what a refresh reports as replaced, so a key missing
 * from it costs a report and breaks nothing.
 */
const GLOBAL_CONFIG_KEYS = [
  'autoConnectIde',
  'autoInstallIdeExtension',
  'claudeInChromeDefaultEnabled',
  'copyFullResponse',
  'copyOnSelect',
  'defaultToAgentsView',
  'diffTool',
  'externalEditorContext',
  'leftArrowOpensAgents',
  'prStatusFooterEnabled',
];

/**
 * What a user sets in a folder's entry: its local-scope MCP servers (`claude mcp add`, the
 * default scope) and its approval lists. Every other field is Claude's own record of the last
 * run there, and trust is kept by the derive itself.
 */
const PROJECT_USER_FIELDS = ['mcpServers', 'allowedTools', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'disabledMcpServers'];

/**
 * The server Kangentic's own trust step approves in every folder it spawns in
 * (`applyMcpServerTrust` in `trust-manager.ts`). No user put it there, so it is no part of what
 * one configures. Measured on the dogfooding machine: it was in 6,146 of 6,643 folders, and
 * counting it made the record 1.4 MB.
 */
const KANGENTIC_MCP_SERVER = 'kangentic';

function userServerPart(name: string): string {
  return `mcpServers/${name}`;
}

/** A folder's approved `.mcp.json` servers, without the one Kangentic approves itself. */
function userApprovedServers(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((name) => name !== KANGENTIC_MCP_SERVER) : value;
}

/** A field's value as a part: nothing for an empty list or map, a list of names in one order. */
function userFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return value.every((item) => typeof item === 'string') ? [...value].sort() : value;
  }
  if (isPlainRecord(value)) return Object.keys(value).length === 0 ? undefined : value;
  return value ?? undefined;
}

/**
 * What a user configures in a Claude state file, as the parts a refresh watches (`userParts`):
 * each user-scope MCP server, each folder's local-scope servers and approval lists, and the
 * global config keys. Measured on Claude Code 2.1.328: one session rewrote eight shared top-level
 * keys of this file by itself (`numStartups`, `tipsHistory`, `lastReleaseNotesSeen`,
 * `githubRepoPaths` and others) and each folder's `last*` fields, so nothing of that kind is a
 * part, or every spawn would report a change nobody made.
 *
 * Empty lists and maps are left out, and so is the one server Kangentic approves by itself. A
 * home's file holds thousands of folders nobody configured, and the record of it stays a handful
 * of lines.
 */
export function claudeUserConfigParts(state: Record<string, unknown>): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  for (const key of GLOBAL_CONFIG_KEYS) {
    if (state[key] !== undefined) parts[`config/${key}`] = state[key];
  }
  if (isPlainRecord(state.mcpServers)) {
    for (const [name, server] of Object.entries(state.mcpServers)) parts[userServerPart(name)] = server;
  }
  if (isPlainRecord(state.projects)) {
    for (const [folder, entry] of Object.entries(state.projects)) {
      if (!isPlainRecord(entry)) continue;
      for (const field of PROJECT_USER_FIELDS) {
        const value = userFieldValue(field === 'enabledMcpjsonServers' ? userApprovedServers(entry[field]) : entry[field]);
        if (value !== undefined) parts[`projects/${folder}/${field}`] = value;
      }
    }
  }
  return parts;
}

const NOTHING_REMOVED: DeriveContext = { removedFromHome: new Set() };

/**
 * The account's `.claude.json`: every shared answer from the default home (onboarding, trusted
 * folders, MCP servers), and its own login fields and caches untouched. A folder trusted only in
 * this account stays trusted. A user-scope server the home held and removed goes from the
 * account too; one added on the account stays there.
 */
export function deriveClaudeAccountState(
  source: Record<string, unknown>,
  current: Record<string, unknown>,
  context: DeriveContext = NOTHING_REMOVED,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(source)) {
    if (isAccountBound(key)) continue;
    if (MERGED_BY_ENTRY.has(key) && isPlainRecord(value) && isPlainRecord(current[key])) {
      const own = current[key] as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...own, ...value };
      if (key === 'projects') {
        for (const [folder, entry] of Object.entries(value)) {
          const ownEntry = own[folder];
          if (isPlainRecord(ownEntry) && ownEntry.hasTrustDialogAccepted === true && isPlainRecord(entry)) {
            merged[folder] = { ...entry, hasTrustDialogAccepted: true };
          }
        }
      }
      next[key] = merged;
    } else {
      next[key] = value;
    }
  }
  // Done after the loop, which visits only keys the home still has: when the home removes its
  // last server its file has no `mcpServers` left, and the merge above never runs.
  if (context.removedFromHome.size > 0 && isPlainRecord(next.mcpServers)) {
    next.mcpServers = Object.fromEntries(
      Object.entries(next.mcpServers).filter(([name]) => !context.removedFromHome.has(userServerPart(name))),
    );
  }
  return next;
}

const CONVERSATION_FOLDERS = ['projects', 'file-history', 'session-env', 'shell-snapshots', 'todos', 'tasks', 'paste-cache', 'transcripts'];
const SETUP_FOLDERS = ['skills', 'agents', 'commands', 'plugins', 'rules', 'themes', 'workflows', 'output-styles'];

const SHARED_ENTRIES: readonly SharedEntry[] = [
  ...CONVERSATION_FOLDERS.map((name): SharedEntry => ({ name, how: 'link-dir', conversationBearing: true })),
  ...SETUP_FOLDERS.map((name): SharedEntry => ({ name, how: 'link-dir', conversationBearing: false })),
  // Plan mode allows a plan file Write only where it lands in the account's own `plans`, so this
  // one is never a link. A resume carries the conversation's plan file in (`carryConversation`).
  { name: 'plans', how: 'own-dir' },
  { name: 'history.jsonl', how: 'hardlink-file', conversationBearing: false },
  // Claude saves these by replacing the file, which would break a link. Both hold what a user
  // sets (`/config` options, the model, enabled plugins, permission rules, a status line, key
  // bindings), so a copy that replaces a change made from a session on the account is reported.
  { name: 'settings.json', how: 'copy-file', reportReplaced: true },
  { name: 'keybindings.json', how: 'copy-file', reportReplaced: true },
  {
    // An import, not a copy: Claude already loads ~/.claude/CLAUDE.md as a parent folder's memory
    // for projects under the home folder, so a copy would load it twice.
    name: 'CLAUDE.md',
    how: 'text',
    text: (home) => {
      if (isDefaultClaudeHome(home)) return '@~/.claude/CLAUDE.md\n';
      try {
        return fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8');
      } catch {
        return null;
      }
    },
  },
  {
    name: '.claude.json',
    how: 'derive-json',
    sourcePath: claudeStatePathForHome,
    targetPath: (accountFolder) => path.join(accountFolder, '.claude.json'),
    derive: deriveClaudeAccountState,
    userParts: claudeUserConfigParts,
    lock: (targetPath, operation) => withClaudeJsonFileLock(targetPath, operation),
  },
];

/**
 * Reads `claude auth status` (JSON, never a token). A signed-out folder exits non-zero and still
 * prints `{"loggedIn": false}` (measured on 2.1.327). Null for output that is not that JSON, or JSON
 * with no `loggedIn` answer: the CLI gave no answer, which is not the same as an answer that says
 * signed out.
 */
export function parseClaudeAuthStatus(output: string): AccountIdentity | null {
  let parsed: Record<string, unknown> | null;
  try {
    const value: unknown = JSON.parse(output);
    parsed = isPlainRecord(value) ? value : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.loggedIn !== 'boolean') return null;
  const signedIn = parsed.loggedIn;
  const email = typeof parsed.email === 'string' && parsed.email !== '' ? parsed.email : null;
  const orgId = typeof parsed.orgId === 'string' && parsed.orgId !== '' ? parsed.orgId : null;
  const planSource = typeof parsed.planTier === 'string' && parsed.planTier
    ? parsed.planTier
    : typeof parsed.subscriptionType === 'string' && parsed.subscriptionType
      ? parsed.subscriptionType
      : null;
  // The CLI's own name, made readable: `max_20x` reads "Max 20x".
  const planWords = planSource ? planSource.replace(/[_-]+/g, ' ').trim() : '';
  const plan = planWords ? planWords.charAt(0).toUpperCase() + planWords.slice(1) : null;
  const usesSubscription = parsed.authMethod === undefined || parsed.authMethod === 'claude.ai';
  return {
    signedIn,
    email,
    orgId,
    plan,
    hasSubscription: signedIn && usesSubscription ? plan !== null : null,
  };
}

/**
 * The login a Claude state file records (`oauthAccount.emailAddress` and `organizationUuid`,
 * present on 2.1.327), with no CLI run. Null when the file records none: no answer, never a
 * change of login.
 */
export function claudeStateLogin(state: unknown): { email: string; orgId: string | null } | null {
  if (!isPlainRecord(state) || !isPlainRecord(state.oauthAccount)) return null;
  const { emailAddress, organizationUuid } = state.oauthAccount;
  if (typeof emailAddress !== 'string' || emailAddress.trim() === '') return null;
  return {
    email: emailAddress.trim(),
    orgId: typeof organizationUuid === 'string' && organizationUuid !== '' ? organizationUuid : null,
  };
}

/** The last login read from each state file, with the size and time it was read at. */
const stateLoginCache = new Map<string, { size: number; changedAtMs: number; login: { email: string; orgId: string | null } | null }>();

/**
 * `readHomeIdentity` for Claude: the home's state file, read with no lock and no CLI. The file
 * also holds every project's history and runs past a megabyte, and this read runs at each turn
 * end, so it is parsed again only when its size or time has changed since the last read.
 */
async function readClaudeHomeLogin(home: string | null): Promise<{ email: string; orgId: string | null } | null> {
  const statePath = claudeStatePathForHome(home ?? claudeHomeDir());
  try {
    const stat = await fs.promises.stat(statePath);
    const cached = stateLoginCache.get(statePath);
    if (cached && cached.size === stat.size && cached.changedAtMs === stat.mtimeMs) return cached.login;
    const text = await fs.promises.readFile(statePath, 'utf8');
    const login = claudeStateLogin(JSON.parse(text));
    stateLoginCache.set(statePath, { size: stat.size, changedAtMs: stat.mtimeMs, login });
    return login;
  } catch {
    // report-ok: a state file that is missing or mid-write is no answer, which the caller treats
    // as no change; the CLI read that confirms a change reports its own failures.
    return null;
  }
}

/**
 * The file a Claude sign-in rewrites in a home: `.credentials.json` on Windows and Linux. On macOS
 * the login is in the Keychain, so there is nothing to watch, and a replaced login there is
 * noticed at the next turn end, session end or scheduled pass.
 */
function claudeLoginFiles(home: string | null): string[] {
  if (process.platform === 'darwin') return [];
  return [path.join(home ?? claudeHomeDir(), '.credentials.json')];
}

/** The env that points one CLI run at an account's home. None for the agent's own login. */
function homeEnv(home: string | null): Record<string, string> | undefined {
  return home ? { CLAUDE_CONFIG_DIR: home } : undefined;
}

/** How old Claude's cached usage may be and still count as this read's answer. */
const IDLE_USAGE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The windows in Claude's own cached usage (`cachedUsageUtilization` in the account's state
 * file), in the shape the status line's `rate_limits` parse to. Measured on 2.1.319: each window
 * is null when it does not apply (Ultra has no 5h window), `utilization` is a percentage (99 where
 * `/usage` printed "99% used"), and `resets_at` is an ISO time. Otherwise why it gives no current
 * windows: the cache is missing, older than `maxAgeMs`, or holds no window.
 */
export function readClaudeCachedUsage(
  state: unknown,
  nowMs: number,
  maxAgeMs: number = IDLE_USAGE_MAX_AGE_MS,
): { windows: RateLimitWindow[] } | { empty: EmptyUsageReadReason } {
  if (!isPlainRecord(state)) return { empty: 'cache-missing' };
  const cache = state.cachedUsageUtilization;
  if (!isPlainRecord(cache) || typeof cache.fetchedAtMs !== 'number') return { empty: 'cache-missing' };
  if (nowMs - cache.fetchedAtMs > maxAgeMs) return { empty: 'cache-stale' };
  const utilization = cache.utilization;
  if (!isPlainRecord(utilization)) return { empty: 'no-windows' };
  const windows: RateLimitWindow[] = [];
  for (const { key, ...windowShape } of RATE_LIMIT_WINDOWS) {
    const windowRaw = utilization[key];
    if (!isPlainRecord(windowRaw) || typeof windowRaw.utilization !== 'number' || !Number.isFinite(windowRaw.utilization)) continue;
    const resetsAtMs = typeof windowRaw.resets_at === 'string' ? Date.parse(windowRaw.resets_at) : Number.NaN;
    windows.push({
      ...windowShape,
      usedPercentage: Math.min(100, Math.max(0, windowRaw.utilization)),
      resetsAt: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : 0,
    });
  }
  return windows.length > 0 ? { windows } : { empty: 'no-windows' };
}

/**
 * An idle account's usage, from `claude -p /usage`. Measured on 2.1.319 (task #1057): the run
 * takes about 1.2 s, makes no model turn and costs nothing, and with `--no-session-persistence`
 * adds no line to the shared `history.jsonl` and no transcript. Typing `/usage` into a hidden
 * terminal added both, and `--safe-mode` there runs no status line, so that route was dropped.
 * The run refreshes the account's cached usage once it is stale, and the cache is what is read:
 * the printed text carries the same numbers as prose in the machine's time zone. Throws
 * `EmptyUsageReadError` naming why when the read gives no current windows.
 */
async function readClaudeIdleUsage(cliPath: string, home: string | null): Promise<RateLimitWindow[]> {
  try {
    await runClaudeCli(cliPath, ['-p', '/usage', '--no-session-persistence', '--safe-mode'], 30_000, homeEnv(home));
  } catch (error) {
    // The run's own text can name a folder, so only its first line stays here, in the local log.
    console.warn('[ACCOUNTS] Claude usage run failed:', error instanceof Error ? error.message.split('\n')[0] : String(error));
    throw new EmptyUsageReadError('run-failed');
  }
  let state: unknown;
  try {
    state = JSON.parse(await fs.promises.readFile(claudeStatePathForHome(home ?? claudeHomeDir()), 'utf8'));
  } catch {
    // report-ok: a state file that is missing or mid-write is what this error names, and the
    // account service reports it.
    throw new EmptyUsageReadError('cache-missing');
  }
  const reading = readClaudeCachedUsage(state, Date.now());
  if ('empty' in reading) throw new EmptyUsageReadError(reading.empty);
  return reading.windows;
}

/**
 * The plan's own name ("Ultra"), which Claude keeps in the account's state file
 * (`oauthAccount.planDisplayName`) and shows in its banner. `claude auth status` reports only
 * the tier (`max_20x`). Null when the file has none.
 */
export function claudePlanDisplayName(state: unknown): string | null {
  if (!isPlainRecord(state) || !isPlainRecord(state.oauthAccount)) return null;
  const name = state.oauthAccount.planDisplayName;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

async function readClaudePlanDisplayName(home: string | null): Promise<string | null> {
  try {
    const statePath = claudeStatePathForHome(home ?? claudeHomeDir());
    return claudePlanDisplayName(JSON.parse(await fs.promises.readFile(statePath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Who is signed in to a Claude home. A signed-out home exits non-zero and prints its JSON, which
 * is read as signed out. A run that printed no JSON (a timeout, a CLI mid-update) throws
 * `IdentityReadError`, so a busy machine never marks an account signed out. A run stopped at its
 * timeout is no answer whatever it printed.
 */
async function identifyClaudeAccount(cliPath: string, home: string | null): Promise<AccountIdentity> {
  let output: string;
  let runFailed = false;
  try {
    output = await runClaudeCli(cliPath, ['auth', 'status'], 30_000, homeEnv(home));
  } catch (error) {
    // report-ok: a signed-out home exits non-zero, so its printed answer is read below, and a run
    // with no answer throws `IdentityReadError`, which the account service reports.
    const failure = error as { stdout?: unknown; killed?: unknown };
    output = failure.killed !== true && typeof failure.stdout === 'string' ? failure.stdout : '';
    runFailed = true;
  }
  const identity = parseClaudeAuthStatus(output);
  if (!identity) throw new IdentityReadError(runFailed ? 'run-failed' : 'unreadable');
  if (!identity.signedIn) return identity;
  // The name the user knows their plan by, when Claude has recorded one; the tier otherwise.
  const displayName = await readClaudePlanDisplayName(home);
  return displayName ? { ...identity, plan: displayName } : identity;
}

export const CLAUDE_ACCOUNT_SUPPORT: FolderAccountSupport = {
  kind: 'folder',
  accountEnv: (accountFolder) => ({ CLAUDE_CONFIG_DIR: accountFolder }),
  // The agent's own home (account #1), which honours an inherited `CLAUDE_CONFIG_DIR`.
  defaultHome: claudeHomeDir,
  loginArgs: ['auth', 'login'],
  // `claude auth login --email` fills in the address on the sign-in page; the browser still signs
  // in whatever claude.ai login it holds.
  loginEmailArgs: (email) => ['--email', email],
  readHomeIdentity: readClaudeHomeLogin,
  loginFiles: claudeLoginFiles,
  sharedEntries: SHARED_ENTRIES,
  carryConversation: carryClaudePlanFiles,
  identify: identifyClaudeAccount,
  readIdleUsage: readClaudeIdleUsage,
  // The 5h and 7d windows every Claude subscription has. The 5h one is reported only once an
  // account has run in it, so the Accounts rows draw it as Not started until then.
  usageWindows: RATE_LIMIT_WINDOWS.map(({ id, label, iconKind, windowDurationSeconds }) => ({ id, label, iconKind, windowDurationSeconds })),
  // Claude's StopFailure hook names a usage limit `rate_limit`, the same word it uses for a
  // momentary 429 it retries by itself. The account layer tells the two apart by reading the
  // account's usage: only a full account is continued elsewhere.
  isUsageLimitFailure: (detail) => detail.includes('rate_limit'),
  // Claude's docs rank these above any stored login.
  overridingCredentialEnvVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE'],
};
