import { retrievalClient } from '../retrieval/retrieval-client';
import { runGitCommand } from '../git/git-client';
import type { ExpiredConversationRecapSources, RecapGitState } from '../agent/shared/expired-conversation-recap';

/**
 * How long a spawn waits on the retrieval worker for the recap's summary and
 * the old conversation's tail. The spawn is the user's move or Resume, so a
 * worker that is down, restarting or busy costs those parts, never the spawn.
 * The wait is the recap's own; the call keeps the client's own budget, because
 * a call that runs out of it restarts the worker for every caller.
 */
const WORKER_WAIT_MS = 1_500;
/** The branch state is three local git reads in the pty host. */
const GIT_WAIT_MS = 3_000;
const MAX_COMMITS = 20;
const MAX_CHANGES = 30;

/**
 * The recap's sources for one project: the index's task summary and the old
 * conversation's tail through the retrieval worker
 * (`.claude/rules/retrieval-out-of-process.md`), and the branch from git run in
 * the pty host. Shared by both spawn chokepoints, so a board resume and a
 * startup recovery carry the same recap.
 *
 * One set serves every recap its caller builds. A startup pass builds one per
 * expired task, in turn, before any of them spawns, and a worker still starting
 * would cost each of them the whole wait. So once a worker read runs out of
 * it, the set's later worker reads answer null at once. The board path builds
 * a set per spawn, so its next spawn asks the worker again.
 */
export function createExpiredRecapSources(projectId: string): ExpiredConversationRecapSources {
  let workerWaitRanOut = false;
  const fromWorker = async <Result>(read: () => Promise<Result | null>): Promise<Result | null> => {
    if (workerWaitRanOut) return null;
    const outcome = await within(read(), WORKER_WAIT_MS);
    if (outcome.timedOut) workerWaitRanOut = true;
    return outcome.value;
  };
  return {
    readTaskSummary: (taskId) => fromWorker(() => retrievalClient.call('summary.forTask', { projectId, taskId })),
    readConversationTail: (agentSessionId, maxChars) => fromWorker(
      () => retrievalClient.call('transcript.recapTail', { projectId, agentSessionId, maxChars }),
    ),
    readGitState: async (cwd, baseBranch) => (await within(readRecapGitState(cwd, baseBranch), GIT_WAIT_MS)).value,
  };
}

/**
 * The branch, its commits past the base, and its uncommitted changes. Never
 * fetches: the base is tried as `origin/<base>` then `<base>`, whichever the
 * checkout already has. Null when the directory is not a git checkout.
 */
async function readRecapGitState(cwd: string, baseBranch: string): Promise<RecapGitState | null> {
  let branch: string | null;
  try {
    branch = (await runGitCommand(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
  let commits: string[] = [];
  for (const base of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const verified = (await runGitCommand(cwd, ['rev-parse', '--verify', '--quiet', base])).trim();
      if (!verified) continue;
      const log = await runGitCommand(cwd, ['log', '--oneline', '--no-decorate', `-n${MAX_COMMITS}`, `${base}..HEAD`]);
      commits = splitLines(log);
      break;
    } catch {
      // Try the next form of the base.
    }
  }
  let changes: string[] = [];
  try {
    // No optional locks: a plain status refreshes the index under index.lock,
    // and a read the wait gave up on keeps running into the agent's own git.
    changes = splitLines(await runGitCommand(cwd, ['--no-optional-locks', 'status', '--short'])).slice(0, MAX_CHANGES);
  } catch {
    // The branch and commits still help.
  }
  return { branch, commits, changes };
}

function splitLines(output: string): string[] {
  return output.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

/** The read's answer, or null once `waitMs` passes (`timedOut`) or it fails. */
async function within<Result>(
  read: Promise<Result | null>,
  waitMs: number,
): Promise<{ value: Result | null; timedOut: boolean }> {
  const reading = read.then(
    (value) => ({ value, timedOut: false }),
    (error: unknown) => {
      console.warn('[expired-recap] A recap read failed:', error instanceof Error ? error.message : error);
      return { value: null, timedOut: false };
    },
  );
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<{ value: null; timedOut: true }>((resolve) => {
    waitTimer = setTimeout(() => resolve({ value: null, timedOut: true }), waitMs);
  });
  try {
    return await Promise.race([reading, waited]);
  } finally {
    clearTimeout(waitTimer);
  }
}
