import type { SessionRecord } from '../../shared/types';
import type { CommitsSince } from '../git/worktree-head';
import type { IsolatedRunRecord } from '../db/repositories/session-repository';
import { isSlashCommand } from '../automations/turn-end/agent-message-delivery';

/**
 * What the task's main conversation is told when it resumes after an isolated
 * column's session (task #952). Overnight, Code Review ran in its own
 * conversation, committed its fixes and ended Ready; Testing resumed the main
 * conversation, which never saw any of it, and ran its gate against a branch it
 * believed it knew. The recap names the commits since that session began, the
 * HEAD now, and the session's final message.
 *
 * It works for every agent and every column setup, with no vendor hook: it is
 * text in the resume's opening message.
 *
 * - **A plain-text opening message** gets the recap ahead of it, in one turn.
 *   Messages held for the task count as one.
 * - **A slash command** cannot: text ahead of one stops it running, in every
 *   agent CLI. The recap is then the resume's whole prompt, answered in a line,
 *   and that turn runs no turn-end rows or workflow step (`recap-turns.ts`,
 *   kind `return`). The command goes once that turn has ended.
 * - **No opening message** at all: the recap is the whole prompt, answered in
 *   a line, and the agent waits. Its turn runs no rows or step either. That is
 *   a send-back, whose findings follow the move as its own message once this
 *   turn ends, or a person who moved the task to type the next instruction. A
 *   recap that told the agent to carry on had it working a whole turn before
 *   the findings arrived.
 */

/** At most this many commits are listed; the count of the rest is said. */
export const RETURN_RECAP_COMMIT_LIMIT = 20;
/** Each isolated session's final message is cut to this many characters. */
const RECAP_REPLY_CHARS = 1_500;
/** At most this many isolated sessions' final messages are quoted, the latest ones. */
const RECAP_REPLY_SESSIONS = 3;
/** How long a final-message read may take. The recap is built under the task lock. */
export const RETURN_RECAP_REPLY_TIMEOUT_MS = 2_000;
/** How long the whole recap may take to build before the resume goes without it. */
export const RETURN_RECAP_BUDGET_MS = 3_000;
/** How long a column message waits on the recap's turn before it goes anyway. */
export const RETURN_RECAP_TURN_WAIT_MS = 20 * 60_000;

export interface ReturnRecapSources {
  /** The commits since `fromSha` in the checkout, or null when git cannot say. */
  readCommitsSince: (cwd: string, fromSha: string, limit: number) => Promise<CommitsSince | null>;
  /** An isolated session's final message, or null. */
  readFinalReply: (record: IsolatedRunRecord) => Promise<string | null>;
  /** A column's name, or null when it no longer exists. */
  columnName: (swimlaneId: string) => string | null;
}

/** What the recap says, before it is worded for one opening. */
export interface ReturnRecapFacts {
  /** The isolated columns that ran, in order, each once. */
  columns: string[];
  /** Null when no session recorded where it began, or git could not read the range. */
  commits: CommitsSince | null;
  /** The latest sessions' final messages, oldest first. */
  replies: Array<{ column: string; text: string }>;
}

/**
 * When the main conversation last ran: its record's suspend, else its exit,
 * else its start. Isolated sessions started at or after it are the ones it
 * never saw.
 */
export function mainConversationLeftAt(record: Pick<SessionRecord, 'suspended_at' | 'exited_at' | 'started_at'>): string {
  return record.suspended_at ?? record.exited_at ?? record.started_at;
}

/**
 * Gather what the isolated sessions did. Null when there is nothing to say: no
 * session, or none left a commit or a message.
 *
 * The commit range starts at the EARLIEST session that recorded its start HEAD,
 * so a column re-entered after a send-back, or two isolated columns in a row,
 * all count. A session from before `start_head_sha` existed has none, and a
 * later one's anchor then says less than the whole story, never something false.
 */
export async function gatherReturnRecap(
  input: { cwd: string; isolatedRuns: IsolatedRunRecord[]; includeReplies: boolean },
  sources: ReturnRecapSources,
): Promise<ReturnRecapFacts | null> {
  const runs = input.isolatedRuns;
  if (runs.length === 0) return null;
  const columns: string[] = [];
  const nameOf = (run: IsolatedRunRecord): string => (run.isolated_swimlane_id && sources.columnName(run.isolated_swimlane_id)) || 'another column';
  for (const run of runs) {
    const name = nameOf(run);
    if (!columns.includes(name)) columns.push(name);
  }
  const anchor = runs.find((run) => run.start_head_sha)?.start_head_sha ?? null;
  const [commits, replies] = await Promise.all([
    anchor ? sources.readCommitsSince(input.cwd, anchor, RETURN_RECAP_COMMIT_LIMIT) : Promise.resolve(null),
    input.includeReplies
      ? Promise.all(runs.slice(-RECAP_REPLY_SESSIONS).map(async (run) => {
        const text = (await sources.readFinalReply(run))?.trim() ?? '';
        return text ? { column: nameOf(run), text: cutReply(text) } : null;
      }))
      : Promise.resolve([]),
  ]);
  const quoted = replies.filter((reply): reply is { column: string; text: string } => reply !== null);
  const committed = commits !== null && commits.commits.length + commits.omitted > 0;
  if (!committed && quoted.length === 0) return null;
  return { columns, commits, replies: quoted };
}

/**
 * How the recap opens the resume, given the lead the column would have sent
 * (its message, the task's own command, or a plan continuation, interpolated)
 * and whether messages held for the task go with it:
 * - `prefix`: ahead of a plain-text lead, or of the held messages when there
 *   is no lead, in one turn;
 * - `before-command`: the whole prompt, ahead of a slash command that waits for
 *   its turn to end;
 * - `acknowledge`: the whole prompt, with nothing to follow it in this start:
 *   answered in a line, and the agent waits for its next instruction.
 */
export type ReturnRecapOpening = 'prefix' | 'before-command' | 'acknowledge';

export function returnRecapOpeningFor(lead: string | undefined, hasHeldMessages: boolean): ReturnRecapOpening {
  if (lead === undefined || lead.trim() === '') return hasHeldMessages ? 'prefix' : 'acknowledge';
  return isSlashCommand(lead) ? 'before-command' : 'prefix';
}

/** The recap as the agent reads it, worded for its opening. Agent text: English. */
export function formatReturnRecap(facts: ReturnRecapFacts, opening: ReturnRecapOpening): string {
  const lines: string[] = [];
  lines.push(`While this conversation was away, the task ran in ${joinNames(facts.columns)} in a conversation of its own, which you have not seen.`);
  const commits = facts.commits;
  if (commits !== null) {
    const total = commits.commits.length + commits.omitted;
    if (total === 0) {
      lines.push(`It made no commits. The branch is still at ${commits.head}.`);
    } else {
      lines.push(total === 1 ? 'It made this commit on the branch:' : 'It made these commits on the branch, oldest first:');
      if (commits.omitted > 0) lines.push(`(${commits.omitted} earlier ${commits.omitted === 1 ? 'commit is' : 'commits are'} not listed.)`);
      for (const commit of commits.commits) lines.push(`- ${commit.sha} ${commit.subject}`.trimEnd());
      lines.push(`The branch is now at ${commits.head}.`);
    }
  }
  for (const reply of facts.replies) {
    lines.push('', `${reply.column} ended on this message:`, reply.text);
  }
  if (opening === 'before-command') {
    lines.push('', 'Reply with one line saying you have read this. The next instruction follows once you do.');
  } else if (opening === 'acknowledge') {
    lines.push('', 'Reply with one line saying you have read this, then wait for the next instruction.');
  }
  return lines.join('\n');
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'another column';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function cutReply(text: string): string {
  if (text.length <= RECAP_REPLY_CHARS) return text;
  const cut = text.slice(0, RECAP_REPLY_CHARS);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(lastBreak > RECAP_REPLY_CHARS * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}...`;
}

/** `promise`, or `fallback` once `timeoutMs` passes first. Never rejects when `promise` does not. */
export function withinBudget<Value>(promise: Promise<Value>, timeoutMs: number, fallback: Value): Promise<Value> {
  return new Promise<Value>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
