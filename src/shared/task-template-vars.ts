/**
 * Single declaration of the task template-variable keyword set, shared by
 * auto_command and spawn_agent promptTemplate interpolation. Renderer-safe
 * (metadata only - no resolution logic, which lives in
 * src/main/agent/shared/task-template-resolvers.ts since it needs
 * sanitizeForPty/buildTaskXml). Drives the UI chip list
 * (BoardManagerDialog.tsx) and the docs-parity test, so adding or removing a
 * keyword here is the only edit needed to keep every consumer in sync.
 *
 * This is a distinct system from src/shared/template-vars.ts, which resolves
 * Shortcut command variables ({{cwd}}, {{branchName}}, {{taskTitle}},
 * {{projectPath}}) and is unrelated to task template interpolation.
 *
 * A `description` is user-facing copy, translated through Lingui's runtime macro
 * (main bundles this module with plain esbuild). Literal `{{keyword}}` text in one
 * is ICU syntax, so it is quoted: `'{{task_xml}}'` renders `{{task_xml}}`.
 * Keyword names and chips stay English: they are template syntax.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';

/**
 * The prompt template a fresh spawn uses when no `spawn_agent` action supplies
 * one, and the one the seeded "Start Planning Agent" action carries. ONE
 * declaration, so the engine's implicit default and the seed cannot drift. The
 * legacy-rewrite migration keeps its own frozen literal on purpose: a migration
 * must not retroactively rewrite old rows if this default ever changes.
 *
 * `{{workflow_xml}}` resolves empty for a task outside a workflow, and
 * drop-and-collapse removes it, so an ordinary task's prompt is unchanged.
 */
export const DEFAULT_SPAWN_PROMPT_TEMPLATE = '{{task_xml}}{{workflow_xml}}{{attachments}}';

/**
 * The ONE definition of what a template variable looks like in text.
 *
 * It was written out three times before this: `interpolateTemplate` built
 * `new RegExp(key)` per variable, and `interpolateTaskTemplate` restated the
 * syntax twice more (`/(\{\{\w+\}\})/g` to tokenize, `/^\{\{(\w+)\}\}$/` to
 * match). Three definitions that can disagree is what the `\w+` parity
 * assertion exists to catch, so leaving them restated would make the test guard
 * a rule the code still broke in two places. The pill highlighter reads it too,
 * so what paints as a variable and what substitutes as one cannot diverge.
 *
 * Global and stateful: `lastIndex` persists between calls, so reset it or use
 * it only with `String.replace`/`matchAll`, which reset it themselves.
 */
export const TEMPLATE_VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

export const TASK_TEMPLATE_VAR_NAMES = [
  'task_xml',
  'workflow_xml',
  'title',
  'description',
  'taskId',
  'taskNumber',
  'projectPath',
  'projectName',
  'worktreePath',
  'branchName',
  'baseBranch',
  'prUrl',
  'prNumber',
  'prState',
  'issueKey',
  'issueUrl',
  'labels',
  'attachments',
  'port',
  'column',
  'fromColumn',
  'toColumn',
  'trigger',
  'agentReply',
  'columns',
  'brief_xml',
] as const;

export type TaskTemplateVarName = (typeof TASK_TEMPLATE_VAR_NAMES)[number];

/**
 * Where a variable is available. A flat global list starts lying the moment one
 * entry cannot resolve everywhere: `{{fromColumn}}` has no meaning in a spawn
 * prompt, which is not a move, so offering it there would be offering a value
 * that is always empty.
 *
 *   - `'automation'` - a column automation, which runs on a move and therefore
 *     knows its column, both ends of the move, and the trigger.
 *   - `'spawn'` - a `spawn_agent` prompt template, which knows the task and the
 *     project and nothing about a move.
 *   - `'workflow'` - a workflow agent's first message (Settings > Workflows),
 *     written before any of its tasks exist: it knows the project, the board's
 *     columns and the workflow's brief, and no task.
 */
export type TaskTemplateContextName = 'automation' | 'spawn' | 'workflow';

/** Available wherever there is a task, which is most of the catalog. */
const EVERYWHERE: readonly TaskTemplateContextName[] = ['automation', 'spawn'];

/** The project's own facts, which a workflow agent's first message knows too. */
const PROJECT_LEVEL: readonly TaskTemplateContextName[] = ['automation', 'spawn', 'workflow'];

/** The move knows these; a spawn prompt does not. */
const MOVE_ONLY: readonly TaskTemplateContextName[] = ['automation'];

/** Only a workflow agent's first message has a brief and a plan to make. */
const WORKFLOW_AGENT_ONLY: readonly TaskTemplateContextName[] = ['workflow'];

export interface TaskTemplateVarInfo {
  name: TaskTemplateVarName;
  chip: string;
  /** Resolve it where it renders (`translateText`). */
  description: MessageDescriptor;
  contexts: readonly TaskTemplateContextName[];
  /**
   * Shown by the picker under a value that is USUALLY empty, so nobody reaches
   * for one expecting a value and gets a silent blank. Present only where empty
   * is the normal state, not merely a possible one. Resolve it where it renders.
   */
  availability?: MessageDescriptor;
}

export const TASK_TEMPLATE_VARS: readonly TaskTemplateVarInfo[] = [
  {
    name: 'task_xml',
    chip: '{{task_xml}}',
    description: msg`Task title and description wrapped in a <task> XML envelope. Default seeded prompt template is '{{task_xml}}{{workflow_xml}}{{attachments}}'.`,
    contexts: EVERYWHERE,
  },
  {
    name: 'workflow_xml',
    chip: '{{workflow_xml}}',
    description: msg`A workflow task's <workflow> block: its route, its neighbours, and how its turns are judged.`,
    contexts: EVERYWHERE,
    availability: msg`Empty for a task outside a workflow.`,
  },
  {
    name: 'title',
    chip: '{{title}}',
    description: msg`Task title (PTY-sanitized).`,
    contexts: EVERYWHERE,
  },
  {
    name: 'description',
    chip: '{{description}}',
    description: msg`Task description with a ": " prefix when non-empty (PTY-sanitized).`,
    contexts: EVERYWHERE,
  },
  {
    name: 'taskId',
    chip: '{{taskId}}',
    description: msg`Task UUID.`,
    contexts: EVERYWHERE,
  },
  {
    name: 'taskNumber',
    chip: '{{taskNumber}}',
    description: msg`The task's #N, the number people say out loud.`,
    contexts: EVERYWHERE,
  },
  {
    name: 'projectPath',
    chip: '{{projectPath}}',
    description: msg`Main project checkout path. Always the base repo, even when the task has a worktree.`,
    contexts: PROJECT_LEVEL,
  },
  {
    name: 'projectName',
    chip: '{{projectName}}',
    description: msg`The project's name as it reads in the sidebar.`,
    contexts: PROJECT_LEVEL,
  },
  {
    name: 'worktreePath',
    chip: '{{worktreePath}}',
    description: msg`Worktree directory path (empty if the task has none).`,
    contexts: EVERYWHERE,
    availability: msg`Empty until the task has a worktree.`,
  },
  {
    name: 'branchName',
    chip: '{{branchName}}',
    description: msg`Git branch name (empty if the task has none).`,
    contexts: EVERYWHERE,
    availability: msg`Empty until the task has a branch.`,
  },
  {
    name: 'baseBranch',
    chip: '{{baseBranch}}',
    description: msg`Effective base branch: the task's override, else the project's configured default.`,
    contexts: PROJECT_LEVEL,
  },
  {
    name: 'prUrl',
    chip: '{{prUrl}}',
    description: msg`Pull request URL (empty if none).`,
    contexts: EVERYWHERE,
    availability: msg`Empty until a PR is linked.`,
  },
  {
    name: 'prNumber',
    chip: '{{prNumber}}',
    description: msg`Pull request number as a string (empty if none).`,
    contexts: EVERYWHERE,
    availability: msg`Empty until a PR is linked.`,
  },
  {
    name: 'prState',
    chip: '{{prState}}',
    description: msg`Pull request state: open, merged, closed or draft.`,
    contexts: EVERYWHERE,
    availability: msg`Empty until a PR is linked.`,
  },
  {
    name: 'issueKey',
    chip: '{{issueKey}}',
    description: msg`The linked tracker issue's key, such as a Jira key or a GitHub issue number.`,
    contexts: EVERYWHERE,
    availability: msg`Empty until the task is linked to a tracker issue.`,
  },
  {
    name: 'issueUrl',
    chip: '{{issueUrl}}',
    description: msg`The linked tracker issue's URL.`,
    contexts: EVERYWHERE,
    availability: msg`Empty until the task is linked to a tracker issue.`,
  },
  {
    name: 'labels',
    chip: '{{labels}}',
    description: msg`The task's labels, comma-separated.`,
    contexts: EVERYWHERE,
  },
  {
    name: 'attachments',
    chip: '{{attachments}}',
    description: msg`Attached file paths, one per line (empty if none).`,
    contexts: EVERYWHERE,
  },
  {
    name: 'port',
    chip: '{{port}}',
    description: msg`Dev-server port this task reserved. Usually empty - one exists only once an agent asks for it.`,
    contexts: EVERYWHERE,
    availability: msg`Empty until an agent reserves a port.`,
  },
  // The move. These are why `contexts` exists: a spawn prompt is not a move, so
  // offering them there would be offering a permanent empty string.
  {
    name: 'column',
    chip: '{{column}}',
    description: msg`The column this automation belongs to.`,
    contexts: MOVE_ONLY,
  },
  {
    name: 'fromColumn',
    chip: '{{fromColumn}}',
    description: msg`The column the task moved out of.`,
    contexts: MOVE_ONLY,
  },
  {
    name: 'toColumn',
    chip: '{{toColumn}}',
    description: msg`The column the task moved into.`,
    contexts: MOVE_ONLY,
  },
  {
    name: 'trigger',
    chip: '{{trigger}}',
    description: msg`When this automation runs: enter, turn_end or exit.`,
    contexts: MOVE_ONLY,
  },
  // The agent's final message of the turn that just ended, so a review's
  // findings can ride along with a move back to Executing. Full text, newlines
  // kept. Read from the session whose turn ended (for an isolated column, that
  // column's own session), never "the task's latest session".
  {
    name: 'agentReply',
    chip: '{{agentReply}}',
    description: msg`The agent's reply at the end of its last turn in this column.`,
    contexts: MOVE_ONLY,
    availability: msg`Empty on task enter, and for an agent whose transcript Kangentic cannot read.`,
  },
  // A workflow agent's first message. Written before any task exists, so these
  // describe the board and the brief, and are offered nowhere else.
  {
    name: 'columns',
    chip: '{{columns}}',
    description: msg`One line per column between To Do and Done: what it runs, and how recent tasks went through it.`,
    contexts: WORKFLOW_AGENT_ONLY,
  },
  {
    name: 'brief_xml',
    chip: '{{brief_xml}}',
    description: msg`What the workflow was made from, in a <brief> block with the source task's number.`,
    contexts: WORKFLOW_AGENT_ONLY,
    availability: msg`Empty for a workflow made from nothing.`,
  },
];

/** The catalog filtered to one context, which is what a picker should offer. */
export function templateVarsFor(context: TaskTemplateContextName): readonly TaskTemplateVarInfo[] {
  return TASK_TEMPLATE_VARS.filter((info) => info.contexts.includes(context));
}
