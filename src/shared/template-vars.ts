import { stripShellMetacharacters } from './template-escape';

export interface ShortcutContext {
  cwd: string;
  branchName: string;
  taskTitle: string;
  projectPath: string;
}

/**
 * Replace template variables in a shortcut command string.
 * Supported variables: {{cwd}}, {{branchName}}, {{taskTitle}}, {{projectPath}}
 *
 * The paths (cwd, projectPath) are substituted literally, since they come from
 * controlled sources and a real path may hold `&` or `(`. The task title and the
 * branch name are stripped of shell metacharacters: a title can be a stranger's
 * (an imported issue), and git allows `;`, `$`, `&` and backticks in a ref
 * name, so a branch a cloned repo carries could chain a second command.
 */
export function resolveShortcutCommand(template: string, context: ShortcutContext): string {
  return template
    .replace(/\{\{cwd\}\}/g, context.cwd)
    .replace(/\{\{branchName\}\}/g, stripShellMetacharacters(context.branchName))
    .replace(/\{\{taskTitle\}\}/g, stripShellMetacharacters(context.taskTitle))
    .replace(/\{\{projectPath\}\}/g, context.projectPath);
}
