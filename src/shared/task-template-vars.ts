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

export const TASK_TEMPLATE_VAR_NAMES = [
  'task_xml',
  'title',
  'description',
  'taskId',
  'worktreePath',
  'branchName',
  'baseBranch',
  'prUrl',
  'prNumber',
  'attachments',
  'port',
] as const;

export type TaskTemplateVarName = (typeof TASK_TEMPLATE_VAR_NAMES)[number];

export interface TaskTemplateVarInfo {
  name: TaskTemplateVarName;
  chip: string;
  description: string;
}

export const TASK_TEMPLATE_VARS: readonly TaskTemplateVarInfo[] = [
  {
    name: 'task_xml',
    chip: '{{task_xml}}',
    description: 'Task title and description wrapped in a <task> XML envelope. Default seeded prompt template is {{task_xml}}{{attachments}}.',
  },
  {
    name: 'title',
    chip: '{{title}}',
    description: 'Task title (PTY-sanitized).',
  },
  {
    name: 'description',
    chip: '{{description}}',
    description: 'Task description with a ": " prefix when non-empty (PTY-sanitized).',
  },
  {
    name: 'taskId',
    chip: '{{taskId}}',
    description: 'Task UUID.',
  },
  {
    name: 'worktreePath',
    chip: '{{worktreePath}}',
    description: 'Worktree directory path (empty if the task has none).',
  },
  {
    name: 'branchName',
    chip: '{{branchName}}',
    description: 'Git branch name (empty if the task has none).',
  },
  {
    name: 'baseBranch',
    chip: '{{baseBranch}}',
    description: "Effective base branch: the task's override, else the project's configured default.",
  },
  {
    name: 'prUrl',
    chip: '{{prUrl}}',
    description: 'Pull request URL (empty if none).',
  },
  {
    name: 'prNumber',
    chip: '{{prNumber}}',
    description: 'Pull request number as a string (empty if none).',
  },
  {
    name: 'attachments',
    chip: '{{attachments}}',
    description: 'Attached file paths, one per line (empty if none).',
  },
  {
    name: 'port',
    chip: '{{port}}',
    description: 'Dev-server port this task reserved. Usually empty - one exists only once an agent asks for it.',
  },
];
