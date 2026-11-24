/**
 * Draft a commit message or a pull request description on the Automation agent.
 *
 * The agent runs in the shared answer home with no tools, never in the checkout,
 * so the diff travels in the prompt. A draft is kept per folder and change, so
 * reopening a dialog costs nothing; `force` asks again.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext } from '../ipc/ipc-context';
import type { GitDraftInput, GitDraftResult } from '../../shared/git-work-state';
import { resolveAutomationAgent } from '../automations/automation-agent';
import { automationAgentDeps } from '../ipc/helpers/automation-agent-deps';
import { backgroundCallSink } from '../ipc/helpers/background-call-sink';
import { startRecordedCall } from '../background-calls/record-background-call';
import { ensureAnswerHomeDirectory, withAnswerRunDirectory } from '../agent/shared/answer-run-directory';
import { isOptionShapedRef } from '../git/base-ref';
import { remoteGitRunnerFor } from '../git/remote-git';
import { readTargetWork, type ResolvedGitTarget } from './action-target';
import { buildDraftPrompt, cleanDraft } from './draft-prompt';
import { runGitCaptured } from './run-git-captured';

const READ_TIMEOUT_MS = 30_000;
const UNTRACKED_FILES_MAX = 10;
const UNTRACKED_FILE_MAX_CHARS = 4_000;
const MAX_CACHED_DRAFTS = 32;

const drafts = new Map<string, { hash: string; text: string }>();

async function read(directory: string, args: readonly string[]): Promise<string> {
  const run = await runGitCaptured(directory, args, { timeoutMs: READ_TIMEOUT_MS, keepOutput: 'head' });
  return run.exitCode === 0 ? run.stdout : '';
}

/**
 * New files, which no diff shows: their names, and the start of the text ones on
 * this computer. Only a regular file inside the checkout is read. A link, or a
 * folder junction git walks into, can lead to a key outside it, and a pipe would
 * never answer.
 */
async function readUntracked(directory: string): Promise<string> {
  const names = (await read(directory, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if (names.length === 0) return '';
  const parts = [`New files:\n${names.join('\n')}`];
  if (!remoteGitRunnerFor(directory)) {
    const realDirectory = await fs.promises.realpath(directory);
    for (const name of names.slice(0, UNTRACKED_FILES_MAX)) {
      try {
        const filePath = path.join(directory, name);
        if (!(await fs.promises.lstat(filePath)).isFile()) continue;
        const fromCheckout = path.relative(realDirectory, await fs.promises.realpath(filePath));
        if (fromCheckout.startsWith('..') || path.isAbsolute(fromCheckout)) continue;
        const handle = await fs.promises.open(filePath, 'r');
        try {
          const { buffer, bytesRead } = await handle.read(Buffer.alloc(UNTRACKED_FILE_MAX_CHARS), 0, UNTRACKED_FILE_MAX_CHARS, 0);
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          if (!text.includes('\0')) parts.push(`--- new file ${name}\n${text}`);
        } finally {
          await handle.close();
        }
      } catch { // report-ok: a file that went away or cannot be read is named above and simply not quoted
        continue;
      }
    }
  }
  return parts.join('\n');
}

async function readCommitDiff(directory: string, stagedOnly: boolean): Promise<string> {
  if (stagedOnly) return read(directory, ['diff', '--cached']);
  const tracked = await read(directory, ['diff', 'HEAD']);
  return [tracked, await readUntracked(directory)].filter(Boolean).join('\n');
}

async function readBaseRange(directory: string, baseBranch: string): Promise<{ diff: string; commits: string }> {
  if (isOptionShapedRef(baseBranch)) return { diff: '', commits: '' };
  for (const baseRef of [`origin/${baseBranch}`, baseBranch]) {
    const commits = await runGitCaptured(directory, ['log', '--format=%s%n%b', `${baseRef}..HEAD`], { timeoutMs: READ_TIMEOUT_MS });
    if (commits.exitCode !== 0) continue;
    return { commits: commits.stdout.trim(), diff: await read(directory, ['diff', `${baseRef}...HEAD`]) };
  }
  return { diff: '', commits: '' };
}

/** What stands in when no agent can write the text. */
function fallbackText(resolved: ResolvedGitTarget, input: GitDraftInput): string {
  return input.kind === 'commit-message' ? resolved.task?.title ?? '' : '';
}

export async function draftGitText(context: IpcContext, resolved: ResolvedGitTarget, input: GitDraftInput): Promise<GitDraftResult> {
  const fallback: GitDraftResult = { text: fallbackText(resolved, input), drafted: false };
  const { directory, task } = resolved;

  const agent = await resolveAutomationAgent(automationAgentDeps(context, resolved.projectPath), 'drafting');
  if (!agent.ok || !agent.adapter.answerFromContext) return fallback;

  const work = await readTargetWork(resolved);
  const range = input.kind === 'pull-request-description'
    ? await readBaseRange(directory, input.baseBranch ?? resolved.baseBranch)
    : { commits: '', diff: await readCommitDiff(directory, work.stagedFileCount > 0) };
  if (!range.diff && !range.commits) return fallback;

  const prompt = buildDraftPrompt({
    kind: input.kind,
    diff: range.diff,
    commits: range.commits,
    recentSubjects: (await read(directory, ['log', '-10', '--format=%s'])).split(/\r?\n/).filter(Boolean),
    taskTitle: task?.title ?? null,
    taskDescription: task?.description ?? null,
  });
  const cacheKey = `${input.kind}\n${path.resolve(directory)}`;
  const hash = createHash('sha1').update(prompt).digest('hex');
  const cached = drafts.get(cacheKey);
  if (!input.force && cached?.hash === hash) return { text: cached.text, drafted: true };

  const answerHome = await ensureAnswerHomeDirectory();
  const answerFromContext = agent.adapter.answerFromContext.bind(agent.adapter);
  let reply: string;
  try {
    reply = await startRecordedCall(backgroundCallSink(context), {
      projectId: resolved.projectId,
      job: 'git_draft',
      taskId: task?.id ?? null,
      swimlaneId: task?.swimlane_id ?? null,
      agent: agent.agentName,
      requestedModel: agent.model,
      effort: agent.effort,
    }, (onUsage) => withAnswerRunDirectory((runDirectory) => answerFromContext(
      prompt,
      agent.cliPath,
      answerHome,
      agent.model,
      { effort: agent.effort, runDirectory, onUsage },
    ))).done;
  } catch { // report-ok: the agent's CLI failed or timed out; the dialog opens with the stand-in and the user writes it
    return fallback;
  }
  const text = cleanDraft(reply);
  if (!text) return fallback;
  drafts.delete(cacheKey);
  drafts.set(cacheKey, { hash, text });
  if (drafts.size > MAX_CACHED_DRAFTS) {
    const oldest = drafts.keys().next();
    if (!oldest.done) drafts.delete(oldest.value);
  }
  return { text, drafted: true };
}

/** For tests: forget kept drafts. */
export function resetGitDraftsForTests(): void {
  drafts.clear();
}
