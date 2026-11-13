import { reportHandledError, type ErrorReportContexts } from '../analytics/error-reporting';
import { markReported } from '../analytics/handled-report';

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
  /** Entries an account folder held clashed with the default home's and were kept aside. */
  | 'folder-entries-kept-aside'
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
  | 'usage-read-unreadable';

export type AccountProblemFacts = Record<string, string | number | boolean | null>;

/**
 * One report per problem and agent per run. A refresh repeats every few minutes, and the facts
 * vary (a provider's text, a count), so a key that held them never latched.
 */
const reported = new Set<string>();

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
): void {
  const key = `${problem}:${agent}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[ACCOUNTS] ${problem} (${agent})`, facts);
  // A caller's error names what failed, and its message can hold a folder path or an address:
  // only its class and errno leave, never its text.
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const causeContext: ErrorReportContexts = error instanceof Error
    ? { cause: { name: error.name, ...(typeof errno === 'string' ? { errno } : {}) } }
    : {};
  reportHandledError(
    new Error(`Agent account problem: ${problem} (${agent})`),
    { subsystem: 'agent_accounts', account_problem: problem, agent },
    { account: sendableFacts(facts), ...causeContext },
    // One issue per problem and agent, whatever call path found it.
    ['agent-accounts', problem, agent],
  );
  if (error !== undefined) markReported(error);
}

/** For tests: forget what this run reported. */
export function resetAccountProblemReports(): void {
  reported.clear();
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
