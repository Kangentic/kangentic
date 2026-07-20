/**
 * Sentinel taskId used in notification round-trips for transient (Command Terminal)
 * sessions, which have no associated task. The renderer's click handler routes this
 * value through `setPendingOpenCommandTerminal` instead of opening a task detail dialog.
 * Shared between the main-process desktop notifier (which assembles the click payload)
 * and the renderer's click handler (which routes on it).
 */
export const COMMAND_TERMINAL_NOTIFICATION_TASK_ID = '__command_terminal__';
