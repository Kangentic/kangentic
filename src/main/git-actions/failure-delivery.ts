/**
 * Send a git action's failure to the agent that can fix it: the task's running
 * agent, its next one when none runs, or the Command Terminal's own. The message
 * is English, since an agent reads it (.claude/rules/i18n.md).
 */

import type { IpcContext } from '../ipc/ipc-context';
import type { GitActionResult, GitCreatePullRequestInput } from '../../shared/git-work-state';
import { holdTaskMessage } from '../held-messages/held-messages';
import { pasteAgentMessageInBackground } from '../automations/turn-end/agent-message-delivery';
import { agentRegistry } from '../agent/agent-registry';
import { MOVE_MESSAGE_MAX_CHARS } from '../agent/commands/move-message-limit';
import { createChokepointReporter } from '../analytics/handled-report';
import type { GitActionFailure } from './failure';
import type { ResolvedGitTarget } from './action-target';
import { block, cutText } from './prompt-text';

export const gitActionsReporter = createChokepointReporter('git_actions');

/** What the user asked for, so the agent can finish it with the same words. */
export type AskedGitAction =
  | { step: 'commit'; message: string; stagedOnly: boolean; pushAfter: boolean; pushTo: string | null }
  | { step: 'push'; pushTo: string | null }
  | { step: 'create-pull-request'; pullRequest: GitCreatePullRequestInput; head: string };

/** Kept free under the hold limit beyond the parts measured. */
const MESSAGE_SLACK_CHARS = 200;
/** What the user wrote (a commit message, or a title and body) may take, so git's output always fits beside it. */
const ASKED_TEXT_MAX_CHARS = 12_000;
/** A pull request's title, well past what a platform takes. */
const ASKED_TITLE_MAX_CHARS = 1_000;
const CUT_MARK = '[cut]';
const CLEARANCE_TIMEOUT_MS = 30_000;

function askedText(text: string, maxChars: number = ASKED_TEXT_MAX_CHARS): string {
  return text.length > maxChars ? `${cutText(text, maxChars)}\n${CUT_MARK}` : text;
}

function pullRequestParts(pullRequest: GitCreatePullRequestInput): string[] {
  return [block('title', askedText(pullRequest.title, ASKED_TITLE_MAX_CHARS)), block('body', askedText(pullRequest.body))];
}

function leadAndParts(asked: AskedGitAction, failedStep: GitActionFailure['step']): { lead: string; parts: string[] } {
  if (asked.step === 'commit' && failedStep === 'commit') {
    const files = asked.stagedOnly ? 'the files that are staged' : 'every change';
    const then = asked.pushAfter ? ` Then push${asked.pushTo ? ` to ${asked.pushTo}` : ''}.` : '';
    return {
      lead: `The user's commit of ${files} in this checkout failed. Fix the cause, then commit with exactly this message.${then} Never skip hooks and never force push.`,
      parts: [block('commit_message', askedText(asked.message))],
    };
  }
  if (asked.step === 'create-pull-request' && failedStep === 'create-pull-request') {
    const { pullRequest } = asked;
    return {
      lead: `The user's pull request from ${asked.head} into ${pullRequest.baseBranch} could not be created. Fix the cause, then create it${pullRequest.draft ? ' as a draft' : ''} with exactly this title and body.`,
      parts: pullRequestParts(pullRequest),
    };
  }
  const pushTo = asked.step === 'create-pull-request' ? asked.head : asked.pushTo;
  const then = asked.step === 'create-pull-request'
    ? ` Then create the pull request into ${asked.pullRequest.baseBranch}${asked.pullRequest.draft ? ' as a draft' : ''} with exactly this title and body.`
    : '';
  return {
    lead: `The user's push${pushTo ? ` to ${pushTo}` : ''} from this checkout failed. Fix the cause, then push again.${then} Never force push.`,
    parts: asked.step === 'create-pull-request' ? pullRequestParts(asked.pullRequest) : [],
  };
}

/** The message, with git's output cut from the front to fit what a held message may be. What the user wrote is cut first. */
export function buildGitFailureMessage(asked: AskedGitAction, failure: Extract<GitActionFailure, { for: 'agent' }>): string {
  const { lead, parts } = leadAndParts(asked, failure.step);
  const skeleton = [lead, ...parts, block('git_output', '')].join('\n\n');
  const room = Math.max(0, MOVE_MESSAGE_MAX_CHARS - MESSAGE_SLACK_CHARS - skeleton.length);
  return [lead, ...parts, block('git_output', cutText(failure.output, room, 'tail'))].join('\n\n');
}

function holdForNextAgent(context: IpcContext, resolved: ResolvedGitTarget, message: string): GitActionResult['outcome'] | null {
  if (!resolved.task) return null;
  const held = holdTaskMessage(context, { projectId: resolved.projectId, taskId: resolved.task.id, message });
  return held.status === 'held' ? 'held' : null;
}

/** Deliver the failure, and say how it ended. */
export async function deliverGitFailure(
  context: IpcContext,
  resolved: ResolvedGitTarget,
  asked: AskedGitAction,
  failure: GitActionFailure,
): Promise<GitActionResult> {
  if (failure.for === 'user') return { outcome: 'failed', step: failure.step, message: failure.message };
  const message = buildGitFailureMessage(asked, failure);
  const lastLine = failure.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? '';

  // Read again: a commit's hooks can run for minutes, and the agent may have ended.
  const liveSession = resolved.task
    ? context.sessionManager.findLiveSessionByTaskId(resolved.task.id)
    : resolved.target.kind === 'terminal'
      ? context.sessionManager.findLiveCommandTerminalSession(resolved.projectId, resolved.target.slot)
      : undefined;
  const sessionId = liveSession && context.sessionManager.isWritable(liveSession.id) ? liveSession.id : null;

  if (resolved.task) {
    const taskId = resolved.task.id;
    if (!sessionId) {
      return holdForNextAgent(context, resolved, message) === 'held'
        ? { outcome: 'held' }
        : { outcome: 'failed', step: failure.step, message: lastLine };
    }
    // After the turn, in order with the column's own messages. A paste that never
    // reached the agent goes on hold, so a failure is never lost.
    pasteAgentMessageInBackground(context, {
      taskId,
      sessionId,
      message,
      acceptHeld: true,
      onOutcome: (report) => {
        if (report.outcome !== 'confirmed' && report.textReachedAgent === false) holdForNextAgent(context, resolved, message);
      },
    });
    return { outcome: 'sent-to-agent' };
  }

  // A Command Terminal has no task to hold a message for.
  if (!sessionId) return { outcome: 'failed', step: failure.step, message: lastLine };
  const agentName = context.sessionManager.getSessionAgentName(sessionId);
  const verifier = (agentName ? agentRegistry.get(agentName) : undefined)?.getSubmissionVerifier?.('paste') ?? undefined;
  void context.terminalSubmit.submitContent(sessionId, message, {
    bracketed: true,
    source: 'git-action',
    verifier,
    automated: true,
    clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS,
  }).catch((error: unknown) => {
    gitActionsReporter.report(error, { tags: { stage: 'terminal_delivery' } });
  });
  return { outcome: 'sent-to-agent' };
}
