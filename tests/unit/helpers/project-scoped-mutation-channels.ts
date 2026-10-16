/**
 * The renderer-driven mutation channels of `.claude/rules/project-scoped-ipc.md`: each one
 * forwards an explicit projectId, captured at interaction time, as its trailing IPC argument.
 *
 * Shared because two tests read it and must not drift apart:
 * - `project-scoped-ipc.test.ts` holds each one to forwarding the projectId in preload;
 * - `other-window-task-writes.test.ts` holds each task-row write to announcing itself to the
 *   main window when it comes from another window.
 *
 * Keep in sync with the prose list in the rule when the set grows.
 */
export const PROJECT_SCOPED_MUTATION_CHANNELS: ReadonlySet<string> = new Set([
  'TASK_CREATE',
  'TASK_UPDATE',
  'TASK_DELETE',
  'TASK_MOVE',
  'TASK_UNARCHIVE',
  'TASK_BULK_DELETE',
  'TASK_BULK_UNARCHIVE',
  'TASK_SWITCH_BRANCH',
  'TASK_UPDATE_FROM_BASE',
  'TASK_SET_RUNTIME_OVERRIDE',
  'TASK_RESOLVE_PR',
  'TASK_SET_DETAIL_VIEW_STATE',
  // Deletes a board task as it creates the backlog item, and the Agent Monitor
  // demotes a task of a project the board is not on.
  'BACKLOG_DEMOTE',
  'SESSION_SPAWN',
  'SESSION_SUSPEND',
  'SESSION_RESUME',
  'SESSION_RESET',
  'SESSION_RECONCILE',
]);
