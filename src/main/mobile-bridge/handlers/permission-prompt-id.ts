/**
 * There is no dedicated permission-prompt object or id scheme in the
 * desktop app today - a permission prompt is just the agent's own TUI
 * prompt, and the activity engine tracks only that one is outstanding
 * (`permissionPending`) plus which tool it is for
 * (`permissionAwaitedToolId`, the `tool_use_id`). This synthesizes a
 * stable prompt id from those two pieces of session state, used both to
 * report "what is outstanding" (read-stream's snapshot) and to bind
 * answer-permission-prompt's response to the SPECIFIC prompt it answers,
 * rejecting a stale or replayed answer whose id no longer matches.
 */
export function buildPermissionPromptId(sessionId: string, awaitedToolId: string): string {
  return `${sessionId}:${awaitedToolId}`;
}
