/**
 * The complete set of capability verbs a paired device may be granted.
 * There is deliberately NO shell, file-read, or arbitrary-command verb --
 * absent from the protocol entirely, not filtered at runtime (the SSH
 * forced-command lesson: Chrome Remote Desktop and VS Code tunnels are the
 * counter-examples, identity-gated but capability-unscoped). Adding a new
 * verb here is a protocol change; it does not, by itself, grant anything --
 * the desktop's capability router (Phase 2) still has to implement and
 * wire a handler, and a device's roster entry still has to include it in
 * its CapabilitySet.
 *
 * Append only. The desktop mirrors this tuple by hand in its import-free
 * types module and pins the two equal INDEX for index, so a verb inserted
 * mid-list fails that parity test even when both lists hold the same names.
 *
 * `start-session` is the second lifecycle verb beside `move-task`: it spawns
 * or resumes a task's session in the column the task is already in, so a
 * phone's "Session ended" state can bring the agent back without moving the
 * task. A live session is an idempotent no-op; nothing is ever stopped.
 */
export const CAPABILITY_VERBS = [
  'read-stream',
  'read-board',
  'read-diff',
  'send-user-message',
  'move-task',
  'answer-permission-prompt',
  'interactive-terminal',
  'board-tool-read',
  'board-tool-write',
  'register-push',
  'start-session',
] as const;

export type CapabilityVerb = (typeof CAPABILITY_VERBS)[number];

export function isCapabilityVerb(value: string): value is CapabilityVerb {
  return (CAPABILITY_VERBS as readonly string[]).includes(value);
}

/** Deny-by-default: a verb absent from the set is not authorized. */
export type CapabilitySet = ReadonlySet<CapabilityVerb>;

export function capabilitySetFromArray(verbs: readonly string[]): CapabilitySet {
  const set = new Set<CapabilityVerb>();
  for (const verb of verbs) {
    if (isCapabilityVerb(verb)) set.add(verb);
  }
  return set;
}

export function capabilitySetToArray(capabilities: CapabilitySet): CapabilityVerb[] {
  return Array.from(capabilities);
}
