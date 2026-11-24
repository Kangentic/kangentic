import type { GitDraftKind } from '../../shared/git-work-state';
import { block, cutText } from './prompt-text';

/** The whole prompt's budget, under what every adapter's answer path takes. */
export const DRAFT_PROMPT_MAX_CHARS = 40_000;
const TASK_DESCRIPTION_MAX_CHARS = 4_000;

export interface DraftPromptInput {
  kind: GitDraftKind;
  /** The change being written about, as git prints it. */
  diff: string;
  /** Recent commit subjects in this repository, for its style. */
  recentSubjects: string[];
  /** The commits a pull request carries. */
  commits: string;
  taskTitle: string | null;
  taskDescription: string | null;
}

const INSTRUCTIONS: Record<GitDraftKind, string> = {
  'commit-message': [
    'Write the commit message for the change below.',
    'First line: a summary of at most 72 characters, in the style of the recent commits (including their prefix convention, if they have one).',
    'Then, only if the change needs it, a blank line and a short body that says what changed and why, wrapped at 72 characters.',
    'Reply with the commit message only: no code fence, no quotes, no commentary, no trailers.',
  ].join('\n'),
  'pull-request-description': [
    'Write the description of the pull request below, in Markdown.',
    'Say what it changes and why in one or two short paragraphs or a short list. Do not repeat the title and do not invent test results.',
    'Reply with the description only: no code fence around it, no commentary.',
  ].join('\n'),
};

/** The prompt, with the diff cut to what the budget leaves. */
export function buildDraftPrompt(input: DraftPromptInput): string {
  const parts = [INSTRUCTIONS[input.kind]];
  if (input.taskTitle) parts.push(block('task_title', input.taskTitle));
  if (input.taskDescription) parts.push(block('task_description', cutText(input.taskDescription, TASK_DESCRIPTION_MAX_CHARS)));
  if (input.recentSubjects.length > 0) parts.push(block('recent_commits', input.recentSubjects.join('\n')));
  if (input.commits) parts.push(block('commits', cutText(input.commits, 8_000)));
  const room = Math.max(0, DRAFT_PROMPT_MAX_CHARS - parts.join('\n\n').length - 100);
  const diff = input.diff.length > room ? `${cutText(input.diff, room)}\n[diff cut]` : input.diff;
  parts.push(block('diff', diff));
  return parts.join('\n\n');
}

/** The reply without the code fence or quotes a model may wrap it in. */
export function cleanDraft(reply: string): string {
  let text = reply.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (text.length > 1 && /^(["'`])[\s\S]*\1$/.test(text) && !text.slice(1, -1).includes(text[0])) text = text.slice(1, -1).trim();
  return text;
}
