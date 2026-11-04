/**
 * Who a Browser surface belongs to: a board task, or a Command Terminal.
 *
 * Every Browser surface is keyed by ONE string everywhere it is tracked: the
 * main-process pane registry and lane manager, the `browser-urls.json` sidecar,
 * the open/close pushes, the pop-out window key, and the renderer's
 * `browserOpenTasks` / `browserHeldTasks` / `browserGuestTasks` /
 * `dividerRatio` sets. For a task that string is the task id. For a Command
 * Terminal it is an owner key built here, so the whole task-keyed pipeline
 * carries a Command Terminal's pane without a second set of fields. The fields
 * keep their `taskId` names; each declaration says it holds an owner key.
 *
 * The key names the PROJECT as well as the slot. Command Terminal slots are
 * per project (`slot-1` exists in every project), and the renderer's Browser
 * sets are flat and survive a project switch, because the pane itself does. A
 * slot-only key would let slot-1 of two projects share an open flag, a guest
 * id and a hold.
 *
 * It starts with `command-terminal::`, the prefix the Changes panel's per-window
 * ids use, so the session store's detail-view save skips it the same way: a
 * Command Terminal has no `tasks` row to write a layout into.
 */

const COMMAND_TERMINAL_OWNER_PREFIX = 'command-terminal::';

/** Kinds of Browser surface owner. */
export type BrowserOwnerKind = 'task' | 'command-terminal';

/** A Command Terminal's Browser owner key: `command-terminal::<projectId>::<slot>`. */
export function commandTerminalBrowserOwner(projectId: string, slot: string): string {
  return `${COMMAND_TERMINAL_OWNER_PREFIX}${projectId}::${slot}`;
}

/** Whether a surface owner key names a Command Terminal rather than a task. */
export function isCommandTerminalBrowserOwner(ownerKey: string): boolean {
  return ownerKey.startsWith(COMMAND_TERMINAL_OWNER_PREFIX);
}

/** The project and slot a Command Terminal owner key names, or null for a task id. */
export function parseCommandTerminalBrowserOwner(ownerKey: string): { projectId: string; slot: string } | null {
  if (!isCommandTerminalBrowserOwner(ownerKey)) return null;
  const rest = ownerKey.slice(COMMAND_TERMINAL_OWNER_PREFIX.length);
  const separator = rest.lastIndexOf('::');
  if (separator <= 0 || rest.endsWith('::')) return null;
  return { projectId: rest.slice(0, separator), slot: rest.slice(separator + 2) };
}

/** The kind of owner a surface key names. */
export function browserOwnerKind(ownerKey: string): BrowserOwnerKind {
  return isCommandTerminalBrowserOwner(ownerKey) ? 'command-terminal' : 'task';
}
