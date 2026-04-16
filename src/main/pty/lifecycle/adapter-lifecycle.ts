import type { AgentParser, SessionAttachment, SessionContext } from '../../../shared/types';

/**
 * Minimal session shape required by the adapter lifecycle helpers. The
 * full ManagedSession type is private to session-manager; this interface
 * declares only the fields these helpers touch.
 */
export interface AdapterAttachable {
  cwd: string;
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
 * Ask the adapter to strip its hooks from the project's settings file.
 *
 * Gemini and Codex write hooks to a shared project-level file
 * (`<cwd>/.gemini/settings.json` or equivalent) rather than a
 * session-specific override, so each session must clean up its own
 * hooks on exit. Without this they accumulate and the agent executes
 * N copies per event.
 *
 * Adapters key on `taskId`, which means this can be called safely from
 * both suspend() and the PTY exit handler for the same task - the
 * second call is a no-op for shared-file adapters and a no-op via the
 * optional chain for adapters that don't implement removeHooks.
 */
export function removeAdapterHooks(session: AdapterAttachable): void {
  session.agentParser?.removeHooks?.(session.cwd, session.taskId);
}
