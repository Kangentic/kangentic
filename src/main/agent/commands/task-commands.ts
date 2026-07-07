import { TaskRepository } from '../../db/repositories/task-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { readFileAsAttachment } from '../../db/repositories/attachment-utils';
import { resolveColumn } from './column-resolver';
import { resolveTask } from './task-resolver';
import { handleCreateBacklogTask, BACKLOG_DESCRIPTION_MAX_LENGTH } from './backlog-commands';
import { linkPRForTask } from '../../pr/pr-linking';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { TaskUpdateInput } from '../../../shared/types';

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
  });

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

  context.onTaskCreated(task, targetSwimlane.name, targetSwimlane.id);

  return {
    success: true,
    data: { taskId: task.id, displayId: task.display_id, title: task.title, column: targetSwimlane.name },
    message: `Created task "${task.title}" in ${targetSwimlane.name} column (#${task.display_id}, id: ${task.id})`,
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
  if (newPrNumber !== null) updates.pr_number = Number(newPrNumber);
  if (newAgent !== null) updates.agent = newAgent;
  if (newPriority !== null) updates.priority = Number(newPriority);
  if (newLabels !== null) updates.labels = newLabels;
  if (newBaseBranch !== null) updates.base_branch = newBaseBranch;
  if (newUseWorktree !== null) updates.use_worktree = newUseWorktree ? 1 : 0;

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

  const resolution = resolveColumn(db, columnName);
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
