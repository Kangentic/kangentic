import fs from 'node:fs';
import path from 'node:path';
import type { AccountIdentity, FolderAccountSupport, SharedEntry } from '../../../accounts/account-support';
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
 * The account's `.claude.json`: every shared answer from the default home (onboarding, trusted
 * folders, MCP servers), and its own login fields and caches untouched. A folder trusted only in
 * this account stays trusted.
 */
export function deriveClaudeAccountState(
  source: Record<string, unknown>,
  current: Record<string, unknown>,
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
  // Claude saves these by replacing the file, which would break a link.
  { name: 'settings.json', how: 'copy-file' },
  { name: 'keybindings.json', how: 'copy-file' },
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
    lock: (targetPath, operation) => withClaudeJsonFileLock(targetPath, operation),
  },
];

/** Reads `claude auth status` (JSON, never a token). A signed-out folder exits non-zero. */
export function parseClaudeAuthStatus(output: string): AccountIdentity {
  let parsed: Record<string, unknown> | null;
  try {
    const value: unknown = JSON.parse(output);
    parsed = isPlainRecord(value) ? value : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { signedIn: false, email: null, plan: null, hasSubscription: null };
  const signedIn = parsed.loggedIn === true;
  const email = typeof parsed.email === 'string' ? parsed.email : null;
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
    plan,
    hasSubscription: signedIn && usesSubscription ? plan !== null : null,
  };
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
 * `/usage` printed "99% used"), and `resets_at` is an ISO time. Null when the cache is missing,
 * older than `maxAgeMs`, or not in that shape.
 */
export function parseClaudeCachedUsage(state: unknown, nowMs: number, maxAgeMs: number = IDLE_USAGE_MAX_AGE_MS): RateLimitWindow[] | null {
  if (!isPlainRecord(state)) return null;
  const cache = state.cachedUsageUtilization;
  if (!isPlainRecord(cache) || typeof cache.fetchedAtMs !== 'number' || nowMs - cache.fetchedAtMs > maxAgeMs) return null;
  const utilization = cache.utilization;
  if (!isPlainRecord(utilization)) return null;
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
  return windows;
}

/**
 * An idle account's usage, from `claude -p /usage`. Measured on 2.1.319 (task #1057): the run
 * takes about 1.2 s, makes no model turn and costs nothing, and with `--no-session-persistence`
 * adds no line to the shared `history.jsonl` and no transcript. Typing `/usage` into a hidden
 * terminal added both, and `--safe-mode` there runs no status line, so that route was dropped.
 * The run refreshes the account's cached usage once it is stale, and the cache is what is read:
 * the printed text carries the same numbers as prose in the machine's time zone.
 */
async function readClaudeIdleUsage(cliPath: string, home: string | null): Promise<RateLimitWindow[] | null> {
  try {
    await runClaudeCli(cliPath, ['-p', '/usage', '--no-session-persistence', '--safe-mode'], 30_000, homeEnv(home));
    const statePath = claudeStatePathForHome(home ?? claudeHomeDir());
    const state: unknown = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
    return parseClaudeCachedUsage(state, Date.now());
  } catch (error) {
    console.warn('[ACCOUNTS] Could not read Claude usage:', error instanceof Error ? error.message.split('\n')[0] : String(error));
    return null;
  }
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

async function identifyClaudeAccount(cliPath: string, home: string | null): Promise<AccountIdentity> {
  let identity: AccountIdentity;
  try {
    identity = parseClaudeAuthStatus(await runClaudeCli(cliPath, ['auth', 'status'], 30_000, homeEnv(home)));
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    identity = parseClaudeAuthStatus(typeof stdout === 'string' ? stdout : '');
  }
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
