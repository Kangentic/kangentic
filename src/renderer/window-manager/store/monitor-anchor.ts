/**
 * The Agent Monitor layer's window anchor codec.
 *
 * A window's `anchor` is its durable identity. The board anchors a task-detail
 * window BY taskId, because its windows always belong to the open project. The
 * monitor's windows can belong to ANY project, and the layer needs the project
 * to resolve its per-project bundle, so it anchors by `projectId:taskId`.
 *
 * That difference is invisible to the layer itself but NOT to the renderer-global
 * consumers of window state: `dialogSessionIds` (which session an open detail
 * owns, so the bottom panel drops its xterm) is one set per renderer, shared by
 * every layer. A consumer that compared `session.taskId === window.anchor`
 * silently never matched a monitor window, which left the panel holding a second
 * xterm on the same PTY - two fitters resizing one terminal to two different
 * widths, which reads as a frozen, overflowing terminal.
 *
 * So the codec lives here, beside the engine that declares the instances, rather
 * than in the monitor's components: the engine exposes it as the layer option
 * `anchorToTaskId`, and consumers ask the MANAGER to decode instead of knowing
 * which layer they are looking at.
 */

/** `projectId:taskId`. Both halves are UUIDs, so the first colon is the split. */
export function monitorDetailAnchor(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`;
}

/** Decode a monitor anchor, or null when it is not one. */
export function parseMonitorAnchor(anchor: string): { projectId: string; taskId: string } | null {
  const separator = anchor.indexOf(':');
  if (separator <= 0) return null;
  return { projectId: anchor.slice(0, separator), taskId: anchor.slice(separator + 1) };
}

/** The taskId half alone, falling back to the whole anchor when it is unprefixed
 *  (so a bad value degrades to "no session matched" rather than throwing). */
export function monitorAnchorToTaskId(anchor: string): string {
  return parseMonitorAnchor(anchor)?.taskId ?? anchor;
}
