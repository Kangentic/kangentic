import type { AgentParser, SessionAttachment, SessionContext } from '../../../shared/types';
import { forgetPlanApprovalSpawn } from '../../plan-approval/plan-approval-spawns';

/**
 * Minimal session shape required by the adapter lifecycle helpers. The
 * full ManagedSession type is private to session-manager; this interface
 * declares only the fields these helpers touch.
 */
export interface AdapterAttachable {
  id: string;
  cwd: string;
  /** The cwd the agent's command was built for. See ManagedSession.commandCwd. */
  commandCwd?: string;
  taskId: string;
  agentParser?: AgentParser;
  adapterAttachment?: SessionAttachment;
}

/**
 * Generic adapter attach hook. Adapters that need per-session orchestration
 * outside the declarative `runtime` surface (e.g. out-of-band CLI queries,
 * external event subscriptions) implement `attachSession(context)`. The
 * returned `SessionAttachment` is the adapter's private handle - callers
 * never inspect it, they only guarantee `dispose()` is invoked exactly
 * once when the session ends.
 *
 * No-op for adapters that do not implement `attachSession`.
 */
export function attachAdapter(session: AdapterAttachable, context: SessionContext): void {
  // Invoke via method syntax (`parser.attachSession(...)`) rather than via a
  // destructured reference so `this` stays bound to the adapter instance.
  // Cursor's attachSession calls `this.fetchAboutUsage()`; a destructured
  // invocation throws `Cannot read properties of undefined (reading 'fetchAboutUsage')`.
  const parser = session.agentParser;
  if (!parser?.attachSession) return;
  const attachment = parser.attachSession(context);
  if (attachment) session.adapterAttachment = attachment;
}

/**
 * Dispose the adapter attachment if present, then clear the reference.
 * Idempotent - safe to call from both the PTY exit handler and the
 * remove() cleanup path.
 */
export function disposeAdapterAttachment(session: AdapterAttachable): void {
  if (!session.adapterAttachment) return;
  session.adapterAttachment.dispose();
  session.adapterAttachment = undefined;
}

/**
 * End a session's hold on what its adapter wrote for it.
 *
 * Several adapters write their hooks or the Kangentic MCP entry into a file
 * every session in a folder shares (`.gemini/settings.json`,
 * `.cursor/mcp.json`, ...), and strip it once the folder's last session
 * releases (`SharedFolderHolds`). The hold was taken in `buildCommand` under
 * the session's own id (`CommandOptions.ptySessionId`), so the release names
 * that id and the folder the command was built for.
 *
 * Every hold must be released exactly once it can no longer become a
 * running session's: on the PTY's exit and on suspend (a second release of
 * one session is a no-op), and for a built command that never ran (an
 * abandoned or failed spawn, a queued placeholder killed before it started,
 * a caller that gave up between building and spawning). A hold that is
 * never released keeps its folder's file in place for the rest of the run.
 *
 * Never throws. Most calls sit in a catch or a finally, where an adapter's
 * failed strip would replace the error being handled (an abort would read as
 * a spawn failure), and in the PTY exit handler it would skip the cleanup
 * after it.
 */
export function releaseCommandHold(
  agentParser: AgentParser | undefined,
  commandCwd: string,
  sessionId: string,
): void {
  // The plan approval writer's record of the spawn ends with the hold: a
  // chokepoint notes it right after buildCommand, so every path that never
  // spawns the command passes through here.
  forgetPlanApprovalSpawn(sessionId);
  try {
    agentParser?.removeHooks?.(commandCwd, sessionId);
  } catch (error) {
    console.error(`[ADAPTER] Releasing the hold of session ${sessionId.slice(0, 8)} failed:`, error);
  }
}

/**
 * Release the session's hold (see `releaseCommandHold`). Keyed by the
 * session's own id, never its task: a task's sessions overlap (a killed young
 * session's PTY exits up to the grace after the task's next session started),
 * and a task-keyed release let the old exit strip the new session's file.
 */
export function removeAdapterHooks(session: AdapterAttachable): void {
  releaseCommandHold(session.agentParser, session.commandCwd ?? session.cwd, session.id);
}
