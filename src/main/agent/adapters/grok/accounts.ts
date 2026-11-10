import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnreadableUsageError, type AccountIdentity, type FolderAccountSupport } from '../../../accounts/account-support';
import type { RateLimitWindow } from '../../../../shared/types';
import { spawnCli, stopCli } from '../../shared/cli-print';
import { isPlainRecord } from '../../shared/plain-record';
import { grokHomeDir } from './session-paths';

/**
 * BUILT, NOT ENABLED: the adapter does not declare this, so Grok has no card in Settings >
 * Accounts. To enable it, add `readonly accounts = GROK_ACCOUNT_SUPPORT` to `GrokAdapter` and the
 * agent to `tests/unit/agent-accounts-enabled.test.ts`, once `grok login` and a session have been
 * run with `GROK_AUTH_PATH` set on a current Grok.
 *
 * Grok Build accounts (task #1057). An account is only a login file: `GROK_AUTH_PATH` names the
 * `auth.json` one run reads and writes, and `GROK_HOME` stays the user's own. So every
 * conversation, the config, folder trust and the caches stay where they are, and an account
 * folder holds nothing but `auth.json`, its `auth.json.lock`, and a `.corrupt` copy if Grok ever
 * sets one aside. Nothing is linked.
 *
 * Measured on grok 1.0.0 with `grok models`: with `GROK_AUTH_PATH` at a missing file and the real
 * home, Grok said it was not authenticated and the real `auth.json` did not change; with an empty
 * `GROK_HOME` and `GROK_AUTH_PATH` at the real login, it said it was logged in. From xAI's source
 * (1.0.45): one resolver (`xai-grok-login/src/storage.rs`) feeds the TUI, headless runs,
 * `grok login`, `grok logout` and the token refresh, and the file is a plain file on every OS,
 * never a keychain. The variable is undocumented: its one public mention is the 1.0.19 changelog.
 * No sign-in was run here, and two real accounts have not been run side by side.
 *
 * Two things follow the home, not the login file, so an account's sessions must run standalone
 * (`--no-leader`, set by the command builder): a leader process is one per home and reloads
 * `<GROK_HOME>/auth.json`, which would put every account on the user's own login.
 */


/** The login file the user's own Grok reads: a `GROK_AUTH_PATH` they export, else the home's. */
function ownAuthPath(): string {
  const inherited = process.env.GROK_AUTH_PATH?.trim();
  return inherited ? path.resolve(inherited) : path.join(grokHomeDir(), 'auth.json');
}

/**
 * Who a login file belongs to. `auth.json` is an object keyed by scope, each entry one login
 * with its token in `key` and the person's `email` beside it. Only the token's presence is
 * checked; its value is never read out. A stored API key (scope `xai::api_key`) is a working
 * login with no email. The plan is not in the file.
 */
export function identifyGrokAuthFile(text: string | null): AccountIdentity {
  const signedOut: AccountIdentity = { signedIn: false, email: null, plan: null, hasSubscription: null };
  if (text === null) return signedOut;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return signedOut;
  }
  if (!isPlainRecord(parsed)) return signedOut;
  const logins = Object.values(parsed).filter(
    (entry): entry is Record<string, unknown> => isPlainRecord(entry) && typeof entry.key === 'string' && entry.key !== '',
  );
  if (logins.length === 0) return signedOut;
  const named = logins.find((entry) => typeof entry.email === 'string' && entry.email !== '');
  return { signedIn: true, email: named ? (named.email as string) : null, plan: null, hasSubscription: null };
}

async function identifyGrokAccount(_cliPath: string, home: string | null): Promise<AccountIdentity> {
  const authPath = home ? path.join(home, 'auth.json') : ownAuthPath();
  try {
    return identifyGrokAuthFile(await fs.promises.readFile(authPath, 'utf8'));
  } catch {
    return identifyGrokAuthFile(null);
  }
}

/**
 * The plan's usage from Grok's billing answer (`extensions/billing.rs` in xAI's source):
 * `config.creditUsagePercent` is the share of the period's credits used, 0 to 100, and
 * `config.currentPeriod` gives the period's `type`, `start` and `end` (RFC 3339). xAI's backend
 * leaves a zero value out, and the one account measured (1.0.0, no usage) had no percent at all,
 * so a missing percent reads 0. That reading is a best guess until an account with usage is seen.
 * Null when the answer has no `config`.
 */
export function parseGrokBilling(result: unknown): RateLimitWindow[] | null {
  if (!isPlainRecord(result) || !isPlainRecord(result.config)) return null;
  const config = result.config;
  const period = isPlainRecord(config.currentPeriod) ? config.currentPeriod : {};
  const timeOf = (first: unknown, second: unknown): number => {
    const text = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
    return text ? Date.parse(text) : Number.NaN;
  };
  const startMs = timeOf(period.start, config.billingPeriodStart);
  const endMs = timeOf(period.end, config.billingPeriodEnd);
  const used = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent) ? config.creditUsagePercent : 0;
  const weekly = typeof period.type === 'string' && period.type.toUpperCase().includes('WEEK');
  return [{
    id: 'grok-credits',
    label: weekly ? '7d weekly' : 'Plan credits',
    iconKind: 'period',
    usedPercentage: Math.min(100, Math.max(0, used)),
    resetsAt: Number.isFinite(endMs) ? Math.floor(endMs / 1000) : 0,
    ...(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { windowDurationSeconds: Math.round((endMs - startMs) / 1000) } : {}),
  }];
}

const BILLING_READ_TIMEOUT_MS = 20_000;

/**
 * Asks Grok for the account's billing over `grok agent stdio`: `initialize`, then the
 * `_x.ai/billing` extension request. Measured on 1.0.0: answered in about 2.4 s, made no model
 * turn, created no session folder, and left the login file unchanged. Standalone (`--no-leader`,
 * which the agent subcommand takes after its name), so a leader process never answers for another
 * account. Resolves the request's result, or null when Grok refused it (signed out) or said nothing.
 */
function readGrokBilling(cliPath: string, home: string | null): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawnCli(cliPath, ['agent', '--no-leader', 'stdio'], os.tmpdir(), home ? { GROK_AUTH_PATH: path.join(home, 'auth.json') } : undefined);
    let buffered = '';
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCli(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), BILLING_READ_TIMEOUT_MS);
    timer.unref?.();
    const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdin.on('error', () => undefined);
    child.stderr.resume();
    child.once('error', () => finish(null));
    child.once('exit', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0 && !settled) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        // Only an answer: a request of Grok's own carries a `method` and may reuse these ids.
        if (!isPlainRecord(message) || typeof message.method === 'string') continue;
        if (message.id === 1) {
          if (message.error) finish(null);
          else send({ jsonrpc: '2.0', id: 2, method: '_x.ai/billing', params: {} });
        } else if (message.id === 2) {
          finish(message.error ? null : message.result ?? null);
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
  });
}

async function readGrokIdleUsage(cliPath: string, home: string | null): Promise<RateLimitWindow[] | null> {
  const result = await readGrokBilling(cliPath, home);
  if (result === null) return null;
  const windows = parseGrokBilling(result);
  // Grok answered, in a shape this reader does not know: the guess above needs correcting.
  if (!windows) throw new UnreadableUsageError(isPlainRecord(result) ? Object.keys(result).sort().join(',').slice(0, 120) : typeof result);
  return windows;
}

export const GROK_ACCOUNT_SUPPORT: FolderAccountSupport = {
  kind: 'folder',
  defaultHome: () => grokHomeDir(),
  // The file, not the folder, and absolute: Grok resolves a relative value against its cwd.
  accountEnv: (accountFolder) => ({ GROK_AUTH_PATH: path.join(accountFolder, 'auth.json') }),
  // `grok login` always starts a new browser sign-in and writes the login where the variable says.
  loginArgs: ['login'],
  sharedEntries: [],
  unproven: true,
  identify: identifyGrokAccount,
  readIdleUsage: readGrokIdleUsage,
  // Grok's StopFailure names a spent plan `invalid_request` (HTTP 402) or `rate_limit` (429), the
  // same words as a bad request and a momentary throttle (`turn_end.rs`), with the provider's own
  // sentence beside it. The account layer tells them apart by reading the account's usage: only a
  // full account is continued elsewhere. Not captured from a real spent plan.
  isUsageLimitFailure: (detail) => /rate_limit|invalid_request|out of credits|usage limit|credit limit|spending cap|spending-limit|usage-exhausted/i.test(detail),
  // Each replaces the login file outright (xAI's `AuthManager`, and the shipped user guide's
  // auth precedence). `XAI_API_KEY` is not here: Grok uses it only when no login is stored.
  overridingCredentialEnvVars: ['GROK_AUTH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_DEPLOYMENT_KEY'],
};
