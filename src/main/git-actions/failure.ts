import type { GitActionStep } from '../../shared/git-work-state';
import type { CapturedGitRun } from './run-git-captured';
import { stripAnsiControlCodes } from '../../shared/ansi-strip';

/**
 * A git action that did not finish. `agent` is a failure the task's agent can
 * fix in the checkout (a hook, a rejected push); `user` is one it cannot (no
 * network, not signed in, git not set up), which the user is shown instead,
 * because each message to an agent costs a turn.
 */
export type GitActionFailure =
  | { for: 'agent'; step: GitActionStep; output: string }
  | { for: 'user'; step: GitActionStep; message: string };

/** Enough of git's output for an agent to act on, well under a held message's cap. */
export const FAILURE_OUTPUT_MAX_CHARS = 12_000;

/** A push git could not make: what an agent in the checkout cannot change. */
const PUSH_USER_PATTERNS: readonly RegExp[] = [
  // Sign-in and permission. "Permission denied" only with ssh's parenthetical: git for Windows
  // prints a bare one for a local file lock.
  /authentication failed|could not read Username|could not read Password|Permission denied \(|publickey|Invalid username or (password|token)|terminal prompts disabled|returned error: 40[13]|HTTP 40[13]|Permission to .+ denied/i,
  // Network.
  /Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|Network is unreachable|Could not read from remote repository|unable to access '/i,
  // No usable remote.
  /does not appear to be a git repository|No such remote|No configured push destination|repository not found/i,
];

/** Git itself cannot run here: no name or email set, or another git process holds the index. */
const SETUP_PATTERN = /Please tell me who you are|unable to auto-detect email address|empty ident name|index\.lock': File exists|Another git process seems to be running/i;

/** A hook of the repository's own ran and refused, whatever its output says. Never read in a URL: a repository can be named for one. */
const HOOK_PATTERN = /hook declined|pre-commit|pre-push|commit-msg|husky|lefthook/i;

/** The one line of git's output that says why: its `fatal:` or `error:` line, else its last. */
export function failureLine(run: Pick<CapturedGitRun, 'stdout' | 'stderr'>): string {
  const lines = stripAnsiControlCodes(`${run.stderr}\n${run.stdout}`).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const reason = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[lines.length - 1] ?? '';
  return reason.replace(/^(fatal|error):\s*/i, '').slice(0, 300);
}

/** Who a failed run is for. `output` is what the agent would read. */
export function classifyGitRun(step: GitActionStep, run: CapturedGitRun, output: string): GitActionFailure {
  if (run.unfinished === 'timeout') return { for: 'user', step, message: 'Git did not finish' };
  if (run.unfinished === 'unavailable') return { for: 'user', step, message: run.stderr || 'The host did not answer' };
  // Nothing was committed and nothing is wrong: the changes are gone.
  if (step === 'commit' && /nothing to commit|nothing added to commit|no changes added to commit/i.test(run.stdout)) {
    return { for: 'user', step, message: 'There is nothing to commit' };
  }
  if (SETUP_PATTERN.test(run.stderr)) return { for: 'user', step, message: failureLine(run) };
  // A commit never reaches the network, so one that did not commit was refused by a hook. A
  // hook's own output can say anything, a network error included.
  const stderrWithoutUrls = run.stderr.replace(/\w+:\/\/\S+|\S+@\S+:\S+/g, '');
  if (step === 'commit' || HOOK_PATTERN.test(stderrWithoutUrls)) return { for: 'agent', step, output };
  if (PUSH_USER_PATTERNS.some((pattern) => pattern.test(run.stderr))) return { for: 'user', step, message: failureLine(run) };
  return { for: 'agent', step, output };
}
