/**
 * Send a task's failed PR checks, with the tail of each one's log, and any
 * merge conflict to the task's agent: pasted into the agent when one is
 * running, else held for the task's next agent (src/main/held-messages).
 *
 * Main re-lists the checks itself rather than trusting the renderer's copy,
 * which can be a poll behind. The message is English: an agent reads it
 * (.claude/rules/i18n.md).
 */

import type { IpcContext } from '../ipc/ipc-context';
import type { PRCheck, PRChecks, PrChecksSendResult, Task } from '../../shared/types';
import { getProjectRepos, resolveProjectContext } from '../ipc/helpers/project-repos';
import { translatePasteSubmitError } from '../ipc/helpers/paste-error-message';
import { PasteSubmitError } from '../pty/terminal-submit';
import { agentRegistry } from '../agent/agent-registry';
import { holdTaskMessage } from '../held-messages/held-messages';
import { MOVE_MESSAGE_MAX_CHARS } from '../agent/commands/move-message-limit';
import { listPRChecks, fetchPRCheckLog } from './pr-registry';
import { RefusalError } from '../../shared/refusal';

/** The most one check's log may take, however few checks failed. */
export const PER_CHECK_LOG_MAX_CHARS = 6_000;
/** Kept free under the hold limit beyond the measured skeleton, so a rounding or a reason never tips it over. */
const MESSAGE_SLACK_CHARS = 200;
/** "No log: " and the closing "." around a reason that stands in for a log. */
const NO_LOG_WRAPPER_CHARS = 'No log: .'.length;

/** One failed check as the message carries it: its log tail, or why there is none. */
export interface FailedCheckReport {
  check: PRCheck;
  log: string | null;
  /** Why `log` is null ("this check has no log", or the fetch's error). */
  noLogReason: string | null;
}

export interface FailedChecksMessageInput {
  prNumber: number;
  /** The base branch a conflict is against, or null when the task does not record one. */
  baseBranch: string | null;
  conflicting: boolean;
  failed: FailedCheckReport[];
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The message the agent gets: one lead line naming what to fix, then one
 * `<failed_check>` block per check with its link and log tail. Nothing about
 * pushing or merging: the agent's own column decides what happens after.
 */
export function buildFailedChecksMessage(input: FailedChecksMessageInput): string {
  const count = input.failed.length;
  const checks = `${count} failed check${count === 1 ? '' : 's'}`;
  const base = input.baseBranch ?? 'its base branch';
  let lead: string;
  if (input.conflicting && count > 0) {
    lead = `PR #${input.prNumber} conflicts with ${base} and has ${checks}. Merge ${base} into this branch and resolve the conflicts, then find the cause of each failure in the logs below and fix it.`;
  } else if (input.conflicting) {
    lead = `PR #${input.prNumber} conflicts with ${base}. Merge ${base} into this branch and resolve the conflicts.`;
  } else {
    lead = `PR #${input.prNumber} has ${checks}. Find the cause in the logs below and fix it.`;
  }
  const blocks = input.failed.map(({ check, log, noLogReason }) => {
    const attributes = [`name="${escapeAttribute(check.name)}"`];
    if (check.group) attributes.push(`workflow="${escapeAttribute(check.group)}"`);
    if (check.url) attributes.push(`url="${escapeAttribute(check.url)}"`);
    const body = log ?? `No log: ${noLogReason ?? 'this check has no log'}.`;
    return `<failed_check ${attributes.join(' ')}>\n${body}\n</failed_check>`;
  });
  return [lead, ...blocks].join('\n\n');
}

/**
 * Each check's share of the log budget: what the hold limit leaves after the
 * message's skeleton (`skeletonChars`, the message built with every body
 * empty, which grows with each check's tag and link), split evenly and capped.
 */
export function perCheckLogBudget(failedCount: number, skeletonChars: number): number {
  if (failedCount <= 0) return 0;
  const available = MOVE_MESSAGE_MAX_CHARS - MESSAGE_SLACK_CHARS - skeletonChars;
  return Math.max(0, Math.min(PER_CHECK_LOG_MAX_CHARS, Math.floor(available / failedCount)));
}

/** A reason short enough that "No log: <reason>." fits the same budget as a log. */
function boundedReason(reason: string, budget: number): string {
  return reason.slice(0, Math.max(0, budget - NO_LOG_WRAPPER_CHARS));
}

/** The repository the task's PR checks are read from: the one `linkPR` resolves it in. */
function repoCwdFor(task: Task, projectPath: string): string {
  return task.worktree_path ?? projectPath;
}

/**
 * The checks of a task's linked PR, for the Changes panel. Null when the task
 * or its PR is gone, or its host lists no checks. Throws the connector's
 * resolver errors (gh or az unavailable), which the renderer shows.
 */
export async function listTaskPrChecks(
  context: IpcContext,
  taskId: string,
  projectId?: string | null,
): Promise<PRChecks | null> {
  const { projectId: resolvedProjectId, projectPath } = resolveProjectContext(context, projectId);
  if (!resolvedProjectId || !projectPath) return null;
  const task = getProjectRepos(context, resolvedProjectId).tasks.getById(taskId);
  if (!task || task.pr_number === null) return null;
  return listPRChecks(repoCwdFor(task, projectPath), task.pr_number);
}

/**
 * List, fetch, build, and deliver. Throws a plain Error (its message is shown
 * to the user) when the task has no PR, nothing failed and nothing conflicts,
 * or the agent refused the paste.
 */
export async function sendFailedPrChecks(
  context: IpcContext,
  taskId: string,
  projectId?: string | null,
): Promise<PrChecksSendResult> {
  const { projectId: resolvedProjectId, projectPath } = resolveProjectContext(context, projectId);
  if (!resolvedProjectId || !projectPath) throw new RefusalError('No project is open');
  const task = getProjectRepos(context, resolvedProjectId).tasks.getById(taskId);
  if (!task) throw new RefusalError('Task not found');
  if (task.pr_number === null) throw new RefusalError('This task has no pull request');

  const repoCwd = repoCwdFor(task, projectPath);
  const listed = await listPRChecks(repoCwd, task.pr_number);
  const failedChecks = (listed?.checks ?? []).filter((check) => check.status === 'failed');
  const conflicting = task.pr_merge_readiness === 'conflicting';
  if (failedChecks.length === 0 && !conflicting) throw new RefusalError('Nothing on this pull request needs fixing');

  const prNumber = task.pr_number;
  const baseBranch = task.base_branch;
  // Every body is at most `budget` long, so the full message is at most the
  // skeleton plus one budget per check, which the budget keeps under the limit.
  const skeleton = buildFailedChecksMessage({
    prNumber,
    baseBranch,
    conflicting,
    failed: failedChecks.map((check) => ({ check, log: '', noLogReason: null })),
  });
  const budget = perCheckLogBudget(failedChecks.length, skeleton.length);
  const noLog = (check: PRCheck, reason: string): FailedCheckReport => ({ check, log: null, noLogReason: boundedReason(reason, budget) });
  const failed = await Promise.all(failedChecks.map(async (check): Promise<FailedCheckReport> => {
    if (!check.hasLog) return noLog(check, 'this check has no log');
    try {
      const log = await fetchPRCheckLog(repoCwd, prNumber, check, budget);
      return log ? { check, log, noLogReason: null } : noLog(check, 'the log could not be read');
    } catch (error) {
      return noLog(check, error instanceof Error ? error.message : String(error));
    }
  }));

  const message = buildFailedChecksMessage({ prNumber, baseBranch, conflicting, failed });
  const count = failed.length + (conflicting ? 1 : 0);

  // Liveness, not `task.session_id`: a paused agent's id can outlive its PTY.
  const liveSession = context.sessionManager.findLiveSessionByTaskId(taskId);
  const sessionId = liveSession && context.sessionManager.isWritable(liveSession.id) ? liveSession.id : null;
  if (!sessionId) {
    const outcome = holdTaskMessage(context, { projectId: resolvedProjectId, taskId, message });
    if (outcome.status === 'refused') throw new RefusalError(outcome.error);
    return { outcome: 'held', count };
  }

  const agentName = context.sessionManager.getSessionAgentName(sessionId);
  const adapter = agentName ? agentRegistry.get(agentName) : undefined;
  const verifier = adapter?.getSubmissionVerifier?.('paste') ?? undefined;
  try {
    await context.terminalSubmit.submitContent(sessionId, message, { bracketed: true, source: 'pr-checks', verifier });
  } catch (caught) {
    if (caught instanceof PasteSubmitError) {
      const error = new RefusalError(translatePasteSubmitError(caught));
      (error as Error & { cause?: unknown }).cause = caught;
      throw error;
    }
    throw caught;
  }
  return { outcome: 'sent', count };
}
