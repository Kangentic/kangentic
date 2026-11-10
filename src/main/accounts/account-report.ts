import { reportHandledError } from '../analytics/error-reporting';

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

/** One report per problem, agent and facts per run: a refresh repeats every few minutes. */
const reported = new Set<string>();

export function reportAccountProblem(
  problem: AccountProblem,
  agent: string,
  facts: AccountProblemFacts = {},
  error?: unknown,
): void {
  const key = `${problem}:${agent}:${JSON.stringify(facts)}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[ACCOUNTS] ${problem} (${agent})`, facts);
  // A caller's error names what failed, and its message can hold a folder path or an address:
  // only its scrubbed text leaves, never the error itself.
  const cause = error instanceof Error ? scrubFailureDetail(error.message) : null;
  reportHandledError(
    new Error(cause ? `Agent account problem: ${problem} (${agent}): ${cause}` : `Agent account problem: ${problem} (${agent})`),
    { subsystem: 'agent_accounts', account_problem: problem, agent },
    { account: facts },
    // One issue per problem and agent, whatever call path found it.
    ['agent-accounts', problem, agent],
  );
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
