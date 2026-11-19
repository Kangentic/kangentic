import { reportHandledError, type ErrorReportContexts } from '../analytics/error-reporting';
import { createChokepointReporter, errorCodeOf, errorNameOf, markReported } from '../analytics/handled-report';

/**
 * Reports an account problem to Sentry (task #1057). Most agents' account support was built from
 * each CLI's source and docs, with no second account to run it on, so a wrong guess shows up
 * first on a user's machine: this is how it reaches us.
 *
 * Only fixed facts leave the process: the agent, the problem, an entry's name, a kind. Never a
 * folder path (it holds the user's name), an email, or a key. A provider's own error text goes
 * through `scrubFailureDetail`, which cuts addresses and paths out of it.
 */
export type AccountProblem =
  /** A link or required copy of an account folder could not be made, so the account is blocked. */
  | 'folder-link-failed'
  /** An entry in an account folder is not Kangentic's to replace (a file where a link goes). */
  | 'folder-entry-user-owned'
  /**
   * What an account folder held was the account's own and was kept aside: entries that clashed
   * with the default home's, or text a person wrote where an import line goes.
   */
  | 'folder-entries-kept-aside'
  /**
   * A setting, server or approval changed from a session on an account was replaced by the
   * default home's at that account's next spawn. Nothing is copied back, so this is the only
   * word that it happened. Sent with the entry's name, never what changed.
   */
  | 'folder-change-replaced'
  /** No account could be prepared for a spawn, so it ran on the agent's own login. */
  | 'spawn-account-unresolved'
  /** A sign-in's terminal ended by itself and the login could not be read back. */
  | 'sign-in-not-recognized'
  /** A session on an account Kangentic read as signed in started signed out. */
  | 'session-not-signed-in'
  /** A session's turn failed soon after it was moved to another account. */
  | 'turn-failed-after-move'
  /** The provider refused a conversation on this account (the adapter knows its words). */
  | 'conversation-refused'
  /** The CLI answered a usage read with something the adapter could not read. */
  | 'usage-read-unreadable'
  /** A usage read gave no windows (the run failed, or its cache was missing or old), so the account kept its last values. */
  | 'usage-read-empty'
  /** The CLI gave no answer about an account's login, so the account kept its last status. */
  | 'identity-read-failed'
  /**
   * The login in an account's home is no longer the one its row named (a `/login` in a session, a
   * sign-in outside Kangentic). Sent with how it was reconciled, never the email.
   */
  | 'identity-changed';

export type AccountProblemFacts = Record<string, string | number | boolean | null>;

/**
 * Fixed words a caller wants searchable on the event, beside the three every report carries: how a
 * CLI run failed, its exit code, the CLI's version. Facts go in a context, which Sentry cannot
 * filter by.
 */
export type AccountProblemTags = Record<string, string>;

/**
 * One report per problem, agent and reason per run. A refresh repeats every few minutes, and the
 * facts vary (a provider's text, a count), so a key that held them all never latched. The reason is
 * the one fact in the key, because it is a fixed word and names a different failure: a usage read's
 * `cache-stale` early in a run used to spend the report a later `run-failed` needed.
 */
const reported = new Set<string>();

/** A fixed word, as every `reason` a caller sends is. Anything else stays out of the latch key. */
const FIXED_REASON = /^[a-z][a-z-]{0,31}$/;

function reasonOf(facts: AccountProblemFacts): string {
  return typeof facts.reason === 'string' && FIXED_REASON.test(facts.reason) ? facts.reason : '';
}

const TAG_NAME = /^[a-z][a-z_]{0,31}$/;
/** One short token: a fixed word, a number, a version. No space, slash or backslash, so no path or sentence. */
const TAG_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,47}$/;

/** The caller's tags that are safe to send: a plain name and one short token each. */
function sendableTags(tags: AccountProblemTags): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(tags)) {
    if (TAG_NAME.test(name) && TAG_VALUE.test(value)) kept[name] = value;
  }
  return kept;
}

/**
 * What a provider's failure text is about, in one fixed word. The text itself is never sent:
 * `scrubFailureDetail` removes addresses and paths, but a provider's own words can still name the
 * user's organization or workspace.
 */
export type FailureDetailClass = 'usage_limit' | 'auth' | 'network' | 'server' | 'refused' | 'empty' | 'other';

export function classifyFailureDetail(detail: string): FailureDetailClass {
  const text = detail.toLowerCase();
  if (text.trim().length === 0) return 'empty';
  if (/usage limit|rate limit|quota|too many requests|\b429\b|limit reached/.test(text)) return 'usage_limit';
  if (/unauthori[sz]ed|forbidden|\b401\b|\b403\b|log ?in|sign ?in|credential|token|api key/.test(text)) return 'auth';
  if (/network|econn|enotfound|etimedout|timed? ?out|offline|socket|dns/.test(text)) return 'network';
  if (/\b5\d\d\b|overloaded|internal server|service unavailable|bad gateway/.test(text)) return 'server';
  if (/refus|not allowed|denied|not found/.test(text)) return 'refused';
  return 'other';
}

/** The facts with any `detail` text replaced by its class and length. */
function sendableFacts(facts: AccountProblemFacts): AccountProblemFacts {
  const { detail, ...rest } = facts;
  if (typeof detail !== 'string') return facts;
  return { ...rest, detail_class: classifyFailureDetail(detail), detail_length: detail.length };
}

export function reportAccountProblem(
  problem: AccountProblem,
  agent: string,
  facts: AccountProblemFacts = {},
  error?: unknown,
  tags: AccountProblemTags = {},
): void {
  // Mark the caller's error first, so a chokepoint it is rethrown into skips it even
  // when this problem already reported and the latch below returns early.
  if (error !== undefined) markReported(error);
  const key = `${problem}:${agent}:${reasonOf(facts)}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[ACCOUNTS] ${problem} (${agent})`, facts);
  // A caller's error names what failed, and its message can hold a folder path or an address:
  // only its class and errno leave, never its text, each through the shared shape checks.
  const errno = errorCodeOf(error);
  const causeContext: ErrorReportContexts = error instanceof Error
    ? { cause: { name: errorNameOf(error), ...(errno ? { errno } : {}) } }
    : {};
  reportHandledError(
    new Error(`Agent account problem: ${problem} (${agent})`),
    // The three fixed tags last, so a caller's tag can never replace one.
    { ...sendableTags(tags), subsystem: 'agent_accounts', account_problem: problem, agent },
    { account: sendableFacts(facts), ...causeContext },
    // One issue per problem and agent, whatever call path or reason found it.
    ['agent-accounts', problem, agent],
  );
}

/**
 * A defect in the accounts code itself, outside `reportAccountProblem`'s named
 * problems: a session that could not continue at its usage limit, or move to
 * another account. The `stage` tag says which.
 */
export const accountsReporter = createChokepointReporter('accounts');

/** For tests: forget what this run reported. */
export function resetAccountProblemReports(): void {
  reported.clear();
  accountsReporter.reset();
}

const DETAIL_LIMIT = 200;

/**
 * A provider's error text made safe to send: addresses, home folders, any other absolute path and
 * long opaque runs (ids, tokens) replaced, and cut to a line. A web address keeps its path.
 */
export function scrubFailureDetail(detail: string): string {
  return detail
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/(?:[A-Za-z]:\\|\/)(?:Users|home)[\\/][^\\/\s"']+/g, '<home>')
    // Any path left: a drive path, or a rooted one that is not part of a web address.
    .replace(/(?<![\w:/<>])(?:[A-Za-z]:\\|\/)[^\\/\s"'<>]+(?:[\\/][^\\/\s"'<>]+)+/g, '<path>')
    .replace(/[A-Za-z0-9_-]{24,}/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_LIMIT);
}
