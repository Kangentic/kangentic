import type { Task } from '../../../shared/types';
import { sanitizeForPty } from '../../../shared/paths';
import { TASK_TEMPLATE_VAR_NAMES, type TaskTemplateVarName } from '../../../shared/task-template-vars';
import { buildTaskXml } from './prompt-xml';

/**
 * Everything a task-template resolver needs. `defaultBaseBranch` is the
 * caller-resolved effective default (board config -> project/global config ->
 * 'main'; see resolveDefaultBaseBranch in
 * src/main/ipc/handlers/git-stats-capture.ts), never re-derived here so every
 * call site resolves {{baseBranch}} identically. `attachmentPaths` is the
 * task's attachment file paths, already resolved by the caller.
 *
 * `devPort` is the task's leased dev-server port, likewise READ by the caller
 * (devPortRepository.getByTaskId / getDevPortForTask). It is passed in rather
 * than looked up here for two reasons: resolvers stay pure functions of their
 * context, so the parity test can exercise them with plain objects and no
 * database; and, more importantly, allocation must never happen here.
 * `executeAction` builds one vars object that feeds send_command / run_script /
 * webhook as well, and transition-engine.ts builds it at two call sites, so a
 * resolver that allocated lazily would be a side effect fanning out across all
 * of them with a real double-allocation risk. Nothing here allocates: a task
 * has a port only once its agent asked for one via kangentic_reserve_dev_ports,
 * so `devPort` is null for most tasks and that is the normal state.
 * See .claude/rules/task-template-vars-parity.md clause 7.
 */
export interface TaskTemplateContext {
  task: Task;
  defaultBaseBranch: string;
  attachmentPaths: string[];
  devPort: number | null;
}

type TaskTemplateResolver = (ctx: TaskTemplateContext) => string;

/**
 * One resolver per keyword in TASK_TEMPLATE_VAR_NAMES. The Record<keyof>
 * shape makes an unresolved keyword a compile error, not a silent gap.
 */
export const TASK_TEMPLATE_RESOLVERS: Record<TaskTemplateVarName, TaskTemplateResolver> = {
  // Raw description (not sanitizeForPty'd) so multi-line markdown content
  // survives end to end - quoteArg's `multiline: true` opt-in keeps newlines
  // through shell delivery. The legacy {{description}} prose var stays
  // sanitized so user-customized single-line templates don't break.
  task_xml: ({ task }) => buildTaskXml({ title: sanitizeForPty(task.title), description: task.description }),
  title: ({ task }) => sanitizeForPty(task.title),
  description: ({ task }) => {
    const clean = sanitizeForPty(task.description);
    return clean ? `: ${clean}` : '';
  },
  taskId: ({ task }) => task.id,
  // Raw reads: empty is correct for a task with no worktree/branch, and must
  // not fall back to a project-level default the way {{baseBranch}} does.
  worktreePath: ({ task }) => task.worktree_path || '',
  branchName: ({ task }) => task.branch_name || '',
  // The fix: an unset per-task override falls through to the effective
  // project default instead of resolving empty.
  baseBranch: ({ task, defaultBaseBranch }) => task.base_branch || defaultBaseBranch || 'main',
  prUrl: ({ task }) => task.pr_url || '',
  prNumber: ({ task }) => (task.pr_number ? String(task.pr_number) : ''),
  attachments: ({ attachmentPaths }) => (attachmentPaths.length > 0 ? `\n${attachmentPaths.join('\n')}` : ''),
  // The task's lowest RESERVED port, or empty when it has reserved none -
  // which is the normal state, since nothing is reserved until something asks
  // (see kangentic_reserve_dev_ports). A raw read, like {{worktreePath}} and
  // {{branchName}}: it never falls back to a project-level value, because
  // inheriting another task's port is the collision this exists to prevent.
  //
  // Know what empty MEANS for a flag-shaped template, because it is not a
  // graceful fallback: drop-and-collapse turns `--port {{port}}` into a bare
  // `--port` with no value, which most CLIs reject. Prefer letting the agent
  // reserve and use a port itself over templating one in, unless the task is
  // known to hold a reservation.
  port: ({ devPort }) => (devPort != null ? String(devPort) : ''),
};

/** Resolve every task template variable for the given context. */
export function resolveTaskTemplateVars(ctx: TaskTemplateContext): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of TASK_TEMPLATE_VAR_NAMES) {
    vars[name] = TASK_TEMPLATE_RESOLVERS[name](ctx);
  }
  return vars;
}
