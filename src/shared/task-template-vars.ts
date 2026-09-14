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
 */

/**
 * The prompt template a fresh spawn uses when no `spawn_agent` action supplies
 * one, and the one the seeded "Start Planning Agent" action carries. ONE
 * declaration, so the engine's implicit default and the seed cannot drift. The
 * legacy-rewrite migration keeps its own frozen literal on purpose: a migration
 * must not retroactively rewrite old rows if this default ever changes.
 */
export const DEFAULT_SPAWN_PROMPT_TEMPLATE = '{{task_xml}}{{attachments}}';

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
 */
export type TaskTemplateContextName = 'automation' | 'spawn';

/** Available everywhere, which is most of the catalog. */
const EVERYWHERE: readonly TaskTemplateContextName[] = ['automation', 'spawn'];

/** The move knows these; a spawn prompt does not. */
const MOVE_ONLY: readonly TaskTemplateContextName[] = ['automation'];

export interface TaskTemplateVarInfo {
  name: TaskTemplateVarName;
  chip: string;
  description: string;
  contexts: readonly TaskTemplateContextName[];
  /**
   * Shown by the picker under a value that is USUALLY empty, so nobody reaches
   * for one expecting a value and gets a silent blank. Present only where empty
   * is the normal state, not merely a possible one.
   */
  availability?: string;
}

export const TASK_TEMPLATE_VARS: readonly TaskTemplateVarInfo[] = [
  {
    name: 'task_xml',
    chip: '{{task_xml}}',
    description: 'Task title and description wrapped in a <task> XML envelope. Default seeded prompt template is {{task_xml}}{{attachments}}.',
    contexts: EVERYWHERE,
  },
  {
    name: 'title',
    chip: '{{title}}',
    description: 'Task title (PTY-sanitized).',
    contexts: EVERYWHERE,
  },
  {
    name: 'description',
    chip: '{{description}}',
    description: 'Task description with a ": " prefix when non-empty (PTY-sanitized).',
    contexts: EVERYWHERE,
  },
  {
    name: 'taskId',
    chip: '{{taskId}}',
    description: 'Task UUID.',
    contexts: EVERYWHERE,
  },
  {
    name: 'taskNumber',
    chip: '{{taskNumber}}',
    description: 'The task\'s #N, the number people say out loud.',
    contexts: EVERYWHERE,
  },
  {
    name: 'projectPath',
    chip: '{{projectPath}}',
    description: 'Main project checkout path. Always the base repo, even when the task has a worktree.',
    contexts: EVERYWHERE,
  },
  {
    name: 'projectName',
    chip: '{{projectName}}',
    description: 'The project\'s name as it reads in the sidebar.',
    contexts: EVERYWHERE,
  },
  {
    name: 'worktreePath',
    chip: '{{worktreePath}}',
    description: 'Worktree directory path (empty if the task has none).',
    contexts: EVERYWHERE,
    availability: 'Empty until the task has a worktree.',
  },
  {
    name: 'branchName',
    chip: '{{branchName}}',
    description: 'Git branch name (empty if the task has none).',
    contexts: EVERYWHERE,
    availability: 'Empty until the task has a branch.',
  },
  {
    name: 'baseBranch',
    chip: '{{baseBranch}}',
    description: "Effective base branch: the task's override, else the project's configured default.",
    contexts: EVERYWHERE,
  },
  {
    name: 'prUrl',
    chip: '{{prUrl}}',
    description: 'Pull request URL (empty if none).',
    contexts: EVERYWHERE,
    availability: 'Empty until a PR is linked.',
  },
  {
    name: 'prNumber',
    chip: '{{prNumber}}',
    description: 'Pull request number as a string (empty if none).',
    contexts: EVERYWHERE,
    availability: 'Empty until a PR is linked.',
  },
  {
    name: 'prState',
    chip: '{{prState}}',
    description: 'Pull request state: open, merged, closed or draft.',
    contexts: EVERYWHERE,
    availability: 'Empty until a PR is linked.',
  },
  {
    name: 'issueKey',
    chip: '{{issueKey}}',
    description: 'The linked tracker issue\'s key, such as a Jira key or a GitHub issue number.',
    contexts: EVERYWHERE,
    availability: 'Empty until the task is linked to a tracker issue.',
  },
  {
    name: 'issueUrl',
    chip: '{{issueUrl}}',
    description: 'The linked tracker issue\'s URL.',
    contexts: EVERYWHERE,
    availability: 'Empty until the task is linked to a tracker issue.',
  },
  {
    name: 'labels',
    chip: '{{labels}}',
    description: 'The task\'s labels, comma-separated.',
    contexts: EVERYWHERE,
  },
  {
    name: 'attachments',
    chip: '{{attachments}}',
    description: 'Attached file paths, one per line (empty if none).',
    contexts: EVERYWHERE,
  },
  {
    name: 'port',
    chip: '{{port}}',
    description: 'Dev-server port this task reserved. Usually empty - one exists only once an agent asks for it.',
    contexts: EVERYWHERE,
    availability: 'Empty until an agent reserves a port.',
  },
  // The move. These are why `contexts` exists: a spawn prompt is not a move, so
  // offering them there would be offering a permanent empty string.
  {
    name: 'column',
    chip: '{{column}}',
    description: 'The column this automation belongs to.',
    contexts: MOVE_ONLY,
  },
  {
    name: 'fromColumn',
    chip: '{{fromColumn}}',
    description: 'The column the task moved out of.',
    contexts: MOVE_ONLY,
  },
  {
    name: 'toColumn',
    chip: '{{toColumn}}',
    description: 'The column the task moved into.',
    contexts: MOVE_ONLY,
  },
  {
    name: 'trigger',
    chip: '{{trigger}}',
    description: 'Which end of the move this is: enter or exit.',
    contexts: MOVE_ONLY,
  },
];

/** The catalog filtered to one context, which is what a picker should offer. */
export function templateVarsFor(context: TaskTemplateContextName): readonly TaskTemplateVarInfo[] {
  return TASK_TEMPLATE_VARS.filter((info) => info.contexts.includes(context));
}
