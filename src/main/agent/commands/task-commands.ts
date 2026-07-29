import fs from 'node:fs';
import { TaskRepository } from '../../db/repositories/task-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { readFileAsAttachment } from '../../db/repositories/attachment-utils';
import { resolveColumn } from './column-resolver';
import { resolveTask } from './task-resolver';
import { handleCreateBacklogTask, BACKLOG_DESCRIPTION_MAX_LENGTH } from './backlog-commands';
import { resolveProfileSelector } from './profile-commands';
import { linkPRForTask } from '../../pr/pr-linking';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { TaskUpdateInput, PermissionMode, TaskRunMode } from '../../../shared/types';

export const TASK_DESCRIPTION_MAX_LENGTH = 50_000;

export interface DescriptionEdit {
  find: string;
  replace: string;
}

export type DescriptionEditResult =
  | { success: true; text: string }
  | { success: false; error: string };

/**
 * Render a `find` value for an error message without echoing a huge string
 * back to the caller (which would defeat the token-saving point of the edit
 * modes). Long values are truncated with their full length reported.
 */
function describeFindValue(find: string): string {
  const maxEchoLength = 200;
  if (find.length <= maxEchoLength) return JSON.stringify(find);
  return `${JSON.stringify(find.slice(0, maxEchoLength))} (truncated, ${find.length} chars total)`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Apply Edit-tool-style exact-string replacements to a description, then an
 * optional append, mirroring the file Edit tool's failure semantics: a `find`
 * that is absent or not unique fails the whole call rather than a silent
 * no-op or partial write. Edits apply sequentially against the evolving text.
 */
export function computeUpdatedDescription(
  current: string,
  options: { edits?: DescriptionEdit[] | null; append?: string | null },
): DescriptionEditResult {
  let text = current;
  const edits = options.edits ?? [];
  for (let index = 0; index < edits.length; index += 1) {
    const { find, replace } = edits[index];
    const occurrences = countOccurrences(text, find);
    if (occurrences === 0) {
      return { success: false, error: `descriptionEdits[${index}]: text to find was not present in the description: ${describeFindValue(find)}` };
    }
    if (occurrences > 1) {
      return { success: false, error: `descriptionEdits[${index}]: text to find appears ${occurrences} times in the description; it must be unique: ${describeFindValue(find)}` };
    }
    text = text.split(find).join(replace);
  }
  if (options.append) {
    text = text + options.append;
  }
  if (text.length > TASK_DESCRIPTION_MAX_LENGTH) {
    return { success: false, error: `Resulting description would be ${text.length} characters, over the ${TASK_DESCRIPTION_MAX_LENGTH} character limit.` };
  }
  return { success: true, text };
}

/**
 * The PR number a PR URL names, or null when the URL carries none.
 *
 * `pr_url` and `pr_number` must always name the SAME PR: the linker writes the
 * three PR columns atomically, and Tier 1 of the confidence ladder treats
 * `pr_number` as authoritative. A caller naturally passes `prUrl` alone (the URL
 * already encodes the number), which would otherwise leave the OLD number in the
 * row - the next non-force resolve then resolves that stale number and silently
 * overwrites the URL back to the previous PR. Deriving it here keeps the two in
 * agreement, and mirrors `buildPrFields` in the task-detail edit form, which has
 * always derived the number from the URL the same way.
 */
function prNumberFromUrl(prUrl: string): number | null {
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  return prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;
}

export const handleCreateTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
) => {
  const title = String(params.title ?? '').slice(0, 200);
  const description = String(params.description ?? '').slice(0, TASK_DESCRIPTION_MAX_LENGTH);
  const columnName = params.column as string | null;
  const branchName = params.branchName as string | null;
  const baseBranch = params.baseBranch as string | null;
  const useWorktree = params.useWorktree as boolean | null;
  const attachments = params.attachments as Array<{ filePath: string; filename?: string }> | null;
  const priority = params.priority as number | null;
  const rawLabels = params.labels as Array<string | { name: string; color?: string }> | null;
  const agentOverride = params.agentOverride as string | null;
  const modelOverride = params.modelOverride as string | null;
  const effortOverride = params.effortOverride as string | null;
  const permissionMode = params.permissionMode as PermissionMode | null;
  const autoCommand = params.autoCommand as string | null;
  const profileSelector = params.profile as string | null;
  const runMode = params.runMode as TaskRunMode | null;
  // Normalized to null so an omitted key reads the same as the explicit `null`
  // the MCP tool layer forwards - a direct handler call passes neither.
  const prUrl = (params.prUrl as string | null | undefined) ?? null;
  const prNumber = (params.prNumber as number | null | undefined) ?? null;

  // Observability for the "labels dropped on a large description" bug
  // (task #229). Logs what `labels` actually reached the handler. If it is
  // null/absent here while the description is large, the drop is upstream of
  // Kangentic (the MCP client never sent it). The decisive raw-byte capture
  // lives in mcp-http-server.ts.
  console.log('[create_task] received args:', {
    descriptionLength: description.length,
    labels: rawLabels,
  });

  if (!title.trim()) {
    return { success: false, error: 'Task title is required' };
  }

  // Backlog routing: column="Backlog" (case-insensitive) creates a backlog
  // item instead of a board task. The default (no column) always goes to the
  // To Do column on the active board, never the backlog.
  if (columnName && columnName.trim().toLowerCase() === 'backlog') {
    // The create_task Zod cap (TASK_DESCRIPTION_MAX_LENGTH) covers board tasks;
    // backlog items keep the lower BACKLOG_DESCRIPTION_MAX_LENGTH. Enforce it
    // here so an over-cap backlog description fails loudly rather than being
    // silently truncated by handleCreateBacklogTask's slice.
    const backlogDescriptionLength = String(params.description ?? '').length;
    if (backlogDescriptionLength > BACKLOG_DESCRIPTION_MAX_LENGTH) {
      return {
        success: false,
        error: `Backlog item description is ${backlogDescriptionLength} characters, over the ${BACKLOG_DESCRIPTION_MAX_LENGTH} character limit for backlog items (board tasks allow up to ${TASK_DESCRIPTION_MAX_LENGTH}).`,
      };
    }
    return handleCreateBacklogTask({ ...params, priority: priority ?? 0 }, context);
  }

  // Normalize labels: extract names for DB storage and colors for config
  const labelNames: string[] = [];
  const labelColorMap: Record<string, string> = {};
  if (rawLabels) {
    for (const entry of rawLabels) {
      if (typeof entry === 'string') {
        labelNames.push(entry);
      } else if (entry && typeof entry === 'object' && entry.name) {
        labelNames.push(entry.name);
        if (entry.color) {
          labelColorMap[entry.name] = entry.color;
        }
      }
    }
  }

  if (priority !== null && priority !== undefined && (priority < 0 || priority > 4)) {
    return { success: false, error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)' };
  }

  // Resolved BEFORE the row is written: a typoed profile name must fail the
  // create outright rather than leave a task silently running Default.
  let profileId: string | null = null;
  if (profileSelector) {
    const resolvedProfile = resolveProfileSelector(context, profileSelector);
    if (!resolvedProfile.ok) return { success: false, error: resolvedProfile.error };
    profileId = resolvedProfile.profileId;
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);

  const resolution = resolveColumn(db, columnName);
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

  const task = taskRepo.create({
    title,
    description,
    swimlane_id: targetSwimlane.id,
    ...(baseBranch ? { baseBranch } : {}),
    ...(useWorktree !== null ? { useWorktree } : {}),
    ...(branchName ? { customBranchName: branchName } : {}),
    ...(labelNames.length > 0 ? { labels: labelNames } : {}),
    ...(priority !== null && priority !== undefined ? { priority } : {}),
    ...(agentOverride ? { agent_override: agentOverride } : {}),
    ...(modelOverride ? { model_override: modelOverride } : {}),
    ...(effortOverride ? { effort_override: effortOverride } : {}),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(autoCommand ? { auto_command: autoCommand } : {}),
    ...(profileId ? { profile_id: profileId } : {}),
    ...(runMode ? { run_mode: runMode } : {}),
  });

  // A review task names the PR it is about up front, so the linker's pr_number
  // tier resolves it (a PR URL in the DESCRIPTION is deliberately not an anchor -
  // see the ladder comment in pr-linking.ts). Applied as a follow-up update
  // rather than through TaskCreateInput on purpose: `TaskRepository.create`
  // always writes the three PR columns null, and keeping that invariant means
  // the create path has exactly one shape. pr_state stays null and the next
  // resolve fills it in.
  let createdTask = task;
  if (prUrl !== null || prNumber !== null) {
    // An explicit prNumber wins; otherwise derive it from the URL, so a caller
    // passing prUrl alone still lands on Tier 1 instead of producing a row that
    // shows a PR badge but has no anchor to ever resolve it.
    const linkedPrNumber = prNumber !== null ? Number(prNumber) : prNumberFromUrl(String(prUrl));
    createdTask = taskRepo.update({
      id: task.id,
      ...(prUrl !== null ? { pr_url: String(prUrl) } : {}),
      ...(linkedPrNumber !== null ? { pr_number: linkedPrNumber } : {}),
    });
  }

  // Persist label colors to config if any were provided
  if (Object.keys(labelColorMap).length > 0) {
    context.onLabelColorsChanged(labelColorMap);
  }

  // Process file attachments if provided
  if (attachments && attachments.length > 0) {
    const attachmentRepo = new AttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of attachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        attachmentRepo.add(projectPath, task.id, fileData.filename, fileData.base64Data, fileData.mediaType);
      } catch (error) {
        console.error(`[create_task] Failed to attach file "${entry.filePath}":`, error);
      }
    }
  }

  context.onTaskCreated(createdTask, targetSwimlane.name, targetSwimlane.id);

  return {
    success: true,
    data: { taskId: createdTask.id, displayId: createdTask.display_id, title: createdTask.title, column: targetSwimlane.name },
    message: `Created task "${createdTask.title}" in ${targetSwimlane.name} column (#${createdTask.display_id}, id: ${createdTask.id})`,
  };
};

export const handleUpdateTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;
  const newTitle = params.title as string | null;
  const newDescription = params.description as string | null;
  const newDescriptionEdits = (params.descriptionEdits ?? null) as DescriptionEdit[] | null;
  const newAppendDescription = (params.appendDescription ?? null) as string | null;
  const newPrUrl = params.prUrl as string | null;
  const newPrNumber = params.prNumber as number | null;
  const newAgent = params.agent as string | null;
  const newPriority = params.priority as number | null;
  const newLabels = params.labels as string[] | null;
  const newBaseBranch = params.baseBranch as string | null;
  const newUseWorktree = params.useWorktree as boolean | null;
  const newModel = params.model as string | null | undefined;
  const newEffort = params.effort as string | null | undefined;
  const newPermissionMode = params.permissionMode as PermissionMode | null | undefined;
  const newProfileSelector = params.profile as string | null | undefined;
  const newRunMode = params.runMode as TaskRunMode | undefined;
  const newAttachments = params.attachments as Array<{ filePath: string; filename?: string }> | null;

  // Observability for the "labels dropped on a large description" bug
  // (task #229). See the matching note in handleCreateTask.
  console.log('[update_task] received args:', {
    descriptionLength: typeof newDescription === 'string' ? newDescription.length : null,
    descriptionEditsCount: newDescriptionEdits?.length ?? null,
    appendLength: typeof newAppendDescription === 'string' ? newAppendDescription.length : null,
    labels: newLabels,
  });

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const updates: Record<string, unknown> = { id: task.id };
  if (newTitle !== null) updates.title = String(newTitle).slice(0, 200);

  // `description` (full replace) is mutually exclusive with `descriptionEdits`
  // / `appendDescription`; the tool layer (task-tools.ts) rejects the two
  // together, so this if/else never sees both from the MCP path.
  let descriptionChanged = false;
  if (newDescription !== null) {
    updates.description = String(newDescription).slice(0, TASK_DESCRIPTION_MAX_LENGTH);
    descriptionChanged = true;
  } else if (newDescriptionEdits !== null || newAppendDescription !== null) {
    const editResult = computeUpdatedDescription(task.description, {
      edits: newDescriptionEdits,
      append: newAppendDescription,
    });
    if (!editResult.success) {
      return { success: false, error: editResult.error };
    }
    // Only treat this as a change when the text actually moved. An empty
    // `appendDescription` or a no-op edit (e.g. find === replace) otherwise
    // triggers a spurious DB write, an updated_at bump, and a misleading
    // "description" in changedFields.
    if (editResult.text !== task.description) {
      updates.description = editResult.text;
      descriptionChanged = true;
    }
  }

  if (newPrUrl !== null) updates.pr_url = String(newPrUrl);
  // An explicit prNumber wins; otherwise derive it from the URL. Writing the URL
  // alone would leave the OLD number behind, and the next resolve would take that
  // stale number as authoritative and revert the URL to the previous PR.
  if (newPrNumber !== null) updates.pr_number = Number(newPrNumber);
  else if (newPrUrl !== null) updates.pr_number = prNumberFromUrl(String(newPrUrl));
  // Re-pointing the link invalidates any state carried over from the old PR. The
  // three fields must always agree (the linker writes them atomically), and a
  // stale terminal `merged`/`closed` would otherwise short-circuit every
  // non-force resolve, freezing the task on a PR it no longer points at. The
  // next resolve refills it.
  if (newPrUrl !== null || newPrNumber !== null) updates.pr_state = null;
  if (newAgent !== null) updates.agent = newAgent;
  if (newPriority !== null) updates.priority = Number(newPriority);
  if (newLabels !== null) updates.labels = newLabels;
  if (newBaseBranch !== null) updates.base_branch = newBaseBranch;
  if (newUseWorktree !== null) updates.use_worktree = newUseWorktree ? 1 : 0;
  // model/effort/permissionMode distinguish "not provided" (undefined - leave
  // untouched) from "explicitly cleared" (null, from an empty-string param at
  // the tool layer) from "set" (a concrete value) - unlike the sibling fields
  // above, which collapse "omitted" and "clear" onto the same null sentinel.
  if (newModel !== undefined) updates.model_override = newModel;
  if (newEffort !== undefined) updates.effort_override = newEffort;
  if (newPermissionMode !== undefined) updates.permission_mode = newPermissionMode;
  // Same tri-state, plus a name-to-id resolution. An unknown name fails the
  // whole update rather than clearing the task's profile, which is what `null`
  // would otherwise mean here.
  if (newProfileSelector !== undefined) {
    if (newProfileSelector === null) {
      updates.profile_id = null;
    } else {
      const resolvedProfile = resolveProfileSelector(context, newProfileSelector);
      if (!resolvedProfile.ok) return { success: false, error: resolvedProfile.error };
      updates.profile_id = resolvedProfile.profileId;
    }
  }
  // No "clear" state: the mode is one of two values, so omitted simply means
  // "leave it alone". A pin or profile in this same write still implies a mode
  // via applyProfileExclusivity.
  if (newRunMode !== undefined) updates.run_mode = newRunMode;

  const hasScalarChange = Object.keys(updates).length > 1;
  let updated = hasScalarChange ? taskRepo.update(updates as unknown as TaskUpdateInput) : task;

  // Attach files if provided (additive - existing attachments are untouched).
  let attachmentsAdded = 0;
  if (newAttachments && newAttachments.length > 0) {
    const attachmentRepo = new AttachmentRepository(db);
    const projectPath = context.getProjectPath();
    for (const entry of newAttachments) {
      try {
        const fileData = readFileAsAttachment(entry.filePath, entry.filename);
        attachmentRepo.add(projectPath, task.id, fileData.filename, fileData.base64Data, fileData.mediaType);
        attachmentsAdded += 1;
      } catch (error) {
        console.error(`[update_task] Failed to attach file "${entry.filePath}":`, error);
      }
    }
    // Re-fetch so the response and onTaskUpdated carry the fresh derived attachment_count.
    updated = taskRepo.getById(task.id) ?? updated;
  }

  // If nothing actually changed (no scalar field set, and every requested
  // attachment failed to read), surface a structured failure instead of a
  // misleading success with an empty "Updated  for ..." message. Mirrors the
  // equivalent guard in handleUpdateBacklogItem. Reachable only via attachments,
  // since the tool layer forwards attachments past its "at least one field"
  // gate while attachments contribute to changedFields only when one succeeds.
  if (!hasScalarChange && attachmentsAdded === 0) {
    const attachmentsRequested = newAttachments?.length ?? 0;
    return attachmentsRequested > 0
      ? { success: false, error: `Failed to attach any of the ${attachmentsRequested} requested file(s); no other fields were updated.` }
      : { success: false, error: 'No fields provided to update' };
  }

  context.onTaskUpdated(updated);

  const changedFields: string[] = [];
  if (newTitle !== null) changedFields.push('title');
  if (descriptionChanged) changedFields.push('description');
  if (newPrUrl !== null) changedFields.push('prUrl');
  if (newPrNumber !== null) changedFields.push('prNumber');
  if (newAgent !== null) changedFields.push('agent');
  if (newPriority !== null) changedFields.push('priority');
  if (newLabels !== null) changedFields.push('labels');
  if (newBaseBranch !== null) changedFields.push('baseBranch');
  if (newUseWorktree !== null) changedFields.push('useWorktree');
  if (newModel !== undefined) changedFields.push('model');
  if (newEffort !== undefined) changedFields.push('effort');
  if (newPermissionMode !== undefined) changedFields.push('permissionMode');
  if (newProfileSelector !== undefined) changedFields.push('profile');
  if (newRunMode !== undefined) changedFields.push('runMode');
  if (attachmentsAdded > 0) changedFields.push('attachments');

  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for "${updated.title}".`,
    data: {
      id: updated.id,
      displayId: updated.display_id,
      title: updated.title,
      description: updated.description,
      prUrl: updated.pr_url,
      prNumber: updated.pr_number,
      agent: updated.agent,
      priority: updated.priority,
      labels: updated.labels,
      baseBranch: updated.base_branch,
      useWorktree: updated.use_worktree,
      modelOverride: updated.model_override,
      effortOverride: updated.effort_override,
      permissionMode: updated.permission_mode,
      profileId: updated.profile_id,
      // Reported like its exclusivity siblings above: a pin or a profile in
      // this write can flip the mode without the caller naming it, so the
      // resulting mode has to be visible in the response.
      runMode: updated.run_mode,
      ...(newAttachments !== null ? { attachmentCount: updated.attachment_count, attachmentsAdded } : {}),
    },
  };
};

/**
 * Authoritatively resolve and link the PR for a task via the confidence ladder
 * (PR number -> worktree branch -> commit SHA -> stored slug). Works without a
 * live session, picks up human/web-UI-created PRs the scraper misses, and
 * refreshes the linked PR's state (open/draft/merged/closed) on re-run.
 */
export const handleLinkPr: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  const taskId = params.taskId as string;
  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  let result;
  try {
    result = await linkPRForTask(task.id, {
      tasks: taskRepo,
      projectPath: context.getProjectPath(),
      force: true,
      onLinked: (linked) => context.onTaskUpdated(linked),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `PR resolution failed: ${message}` };
  }

  const linkedTask = result.task;
  switch (result.status) {
    case 'linked':
    case 'unchanged':
      return {
        success: true,
        message: `PR #${linkedTask?.pr_number} (${linkedTask?.pr_state ?? 'open'}) linked to "${task.title}".`,
        data: {
          id: linkedTask?.id,
          displayId: linkedTask?.display_id,
          prUrl: linkedTask?.pr_url,
          prNumber: linkedTask?.pr_number,
          prState: linkedTask?.pr_state,
        },
      };
    case 'resolver-unavailable':
      return { success: false, error: result.message ?? 'GitHub CLI not available. Install gh and run: gh auth login' };
    case 'transient-error':
      return { success: false, error: result.message ?? 'Temporary GitHub error while resolving the PR - try again.' };
    case 'no-anchor':
      return {
        success: true,
        message: `"${task.title}" has no branch, worktree, or PR number to resolve a PR from.`,
        data: { id: task.id, linked: false },
      };
    case 'not-found':
    default:
      return {
        success: true,
        message: `No PR found for "${task.title}".`,
        data: { id: task.id, linked: false },
      };
  }
};

export const handleMoveTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskIdParam = params.taskId as string | null;
  const columnName = params.column as string | null;

  if (!taskIdParam) {
    return { success: false, error: 'taskId is required' };
  }
  if (!columnName) {
    return { success: false, error: 'column is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskIdParam);
  if (!task) {
    return { success: false, error: `Task "${taskIdParam}" not found` };
  }

  const resolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

  if (task.swimlane_id === targetSwimlane.id) {
    return {
      success: true,
      message: `Task "${task.title}" is already in ${targetSwimlane.name}.`,
      data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name },
    };
  }

  // Position at end of target column
  const targetTasks = taskRepo.list(targetSwimlane.id);
  const targetPosition = targetTasks.length;

  // Fire-and-forget the async move (transition engine, agent spawn/suspend, worktree management).
  // The MCP response confirms intent; the LLM should re-query to verify state if needed.
  void context.onTaskMove({
    taskId: task.id,
    targetSwimlaneId: targetSwimlane.id,
    targetPosition,
  }).catch((error) => {
    console.error(`[move_task] Failed for task ${task.id.slice(0, 8)}:`, error);
  });

  return {
    success: true,
    message: `Moving "${task.title}" (#${task.display_id}) to ${targetSwimlane.name}.`,
    data: { id: task.id, displayId: task.display_id, column: targetSwimlane.name },
  };
};

/**
 * Relocate a To Do task to a different project's board: creates an equivalent
 * task in the target project's DB (preserving title, description, labels,
 * priority, creation time, and attachments) then deletes the original from
 * the source project's DB. Takes two `CommandContext`s (source and target)
 * because it operates on two separate per-project SQLite databases at once -
 * unlike every other command handler, which is dispatched through the
 * single-context `commandHandlers` registry. Not registered there; called
 * directly by the `kangentic_move_task_to_project` tool.
 *
 * Scoped to To Do because entering a `role: 'todo'` column already resets a
 * task's live state (session killed, worktree removed, branch deleted - see
 * handleTaskMove's Priority 1 branch), so a To Do task is a pure metadata +
 * attachment relocation with no live git/PTY state that would need to cross
 * the project boundary. A task outside To Do may still hold a live session or
 * worktree that cannot be moved, so the move is rejected.
 */
export function handleMoveTaskToProject(
  params: { taskId: string; column?: string | null },
  source: CommandContext,
  target: CommandContext,
): CommandResponse {
  const taskId = params.taskId;
  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const sourceDb = source.getProjectDb();
  const sourceTaskRepo = new TaskRepository(sourceDb);
  const task = resolveTask(sourceTaskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const sourceSwimlane = new SwimlaneRepository(sourceDb).getById(task.swimlane_id);
  if (!sourceSwimlane || sourceSwimlane.role !== 'todo') {
    return {
      success: false,
      error: `Only tasks in a To Do column can be moved to another project. Task #${task.display_id} is in "${sourceSwimlane?.name ?? 'an unknown column'}". Move it to To Do first.`,
    };
  }
  if (task.session_id) {
    return { success: false, error: `Task #${task.display_id} has an active session and cannot be moved to another project.` };
  }
  if (task.worktree_path && fs.existsSync(task.worktree_path)) {
    return { success: false, error: `Task #${task.display_id} still has a worktree on disk and cannot be moved to another project.` };
  }

  const targetDb = target.getProjectDb();
  const resolution = resolveColumn(targetDb, params.column ?? null, 'todo');
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

  const targetTaskRepo = new TaskRepository(targetDb);
  const newTask = targetTaskRepo.create({
    title: task.title,
    description: task.description,
    swimlane_id: targetSwimlane.id,
    labels: task.labels,
    priority: task.priority,
    createdAt: task.created_at,
  });

  const sourceAttachmentRepo = new AttachmentRepository(sourceDb);
  const targetAttachmentRepo = new AttachmentRepository(targetDb);
  const targetProjectPath = target.getProjectPath();
  const failedAttachments: string[] = [];
  for (const attachment of sourceAttachmentRepo.list(task.id)) {
    try {
      const base64Data = fs.readFileSync(attachment.file_path).toString('base64');
      targetAttachmentRepo.add(targetProjectPath, newTask.id, attachment.filename, base64Data, attachment.media_type);
    } catch (error) {
      console.error(`[move_task_to_project] Failed to copy attachment "${attachment.filename}":`, error);
      failedAttachments.push(attachment.filename);
    }
  }

  // If any attachment failed to copy, roll back the just-created target task
  // (and its copied attachments) and leave the source untouched. Without this,
  // the unconditional source delete below would destroy the attachments that
  // never reached the target - silent, unrecoverable data loss.
  if (failedAttachments.length > 0) {
    targetAttachmentRepo.deleteByTaskId(newTask.id);
    targetTaskRepo.delete(newTask.id);
    return {
      success: false,
      error: `Failed to copy ${failedAttachments.length} attachment(s) (${failedAttachments.join(', ')}) to the target project. Move aborted; task #${task.display_id} stays in the source project.`,
    };
  }

  // Delete the source task in FK-safe order (attachments, sessions, then the
  // task row), mirroring handleDeleteTask.
  sourceAttachmentRepo.deleteByTaskId(task.id);
  new SessionRepository(sourceDb).deleteByTaskId(task.id);
  source.onTaskDeleted(task);
  sourceTaskRepo.delete(task.id);

  target.onTaskCreated(newTask, targetSwimlane.name, targetSwimlane.id);

  return {
    success: true,
    message: `Moved "${task.title}" (was #${task.display_id}) to the ${targetSwimlane.name} column (now #${newTask.display_id}, id: ${newTask.id}).`,
    data: {
      sourceTaskId: task.id,
      sourceDisplayId: task.display_id,
      newTaskId: newTask.id,
      newDisplayId: newTask.display_id,
      title: newTask.title,
      column: targetSwimlane.name,
    },
  };
}

export const handleDeleteTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;

  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const attachmentRepo = new AttachmentRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Delete attachments and session records before task (FK constraints)
  attachmentRepo.deleteByTaskId(task.id);
  sessionRepo.deleteByTaskId(task.id);

  // Fire-and-forget async cleanup (PTY kill, worktree removal, renderer notification)
  context.onTaskDeleted(task);

  // Delete the task from DB
  taskRepo.delete(task.id);

  return {
    success: true,
    message: `Deleted task "${task.title}" (#${task.display_id}).`,
    data: { id: task.id, displayId: task.display_id, title: task.title },
  };
};

/**
 * Remove a single attachment by ID from either surface. Tries the board
 * `task_attachments` table first, then falls back to backlog
 * `backlog_attachments` - the attachment UUID alone determines which surface
 * owns it, so there is no separate board/backlog parameter to get wrong.
 */
export const handleRemoveAttachment: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const attachmentId = params.attachmentId as string;

  if (!attachmentId) {
    return { success: false, error: 'attachmentId is required' };
  }

  const db = context.getProjectDb();

  const attachmentRepo = new AttachmentRepository(db);
  const boardAttachment = attachmentRepo.getById(attachmentId);
  if (boardAttachment) {
    attachmentRepo.remove(attachmentId);
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.getById(boardAttachment.task_id);
    if (task) {
      context.onTaskUpdated(task);
    }
    return {
      success: true,
      message: `Removed attachment "${boardAttachment.filename}" from task ${task ? `"${task.title}" (#${task.display_id})` : boardAttachment.task_id}.`,
      data: { attachmentId, taskId: boardAttachment.task_id, filename: boardAttachment.filename },
    };
  }

  const backlogAttachmentRepo = new BacklogAttachmentRepository(db);
  const backlogAttachment = backlogAttachmentRepo.getById(attachmentId);
  if (backlogAttachment) {
    backlogAttachmentRepo.remove(attachmentId);
    context.onBacklogChanged();
    return {
      success: true,
      message: `Removed attachment "${backlogAttachment.filename}" from backlog item ${backlogAttachment.backlog_task_id}.`,
      data: { attachmentId, backlogItemId: backlogAttachment.backlog_task_id, filename: backlogAttachment.filename },
    };
  }

  return { success: false, error: `Attachment "${attachmentId}" not found` };
};
