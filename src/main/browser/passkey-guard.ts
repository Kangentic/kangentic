import { session as electronSession, type Session, type WebContents } from 'electron';
import { attachDebugger, ensureVirtualAuthenticator, isDebuggerAttached, removeVirtualAuthenticator } from './cdp/cdp';
import { isAgentDriving } from './agent-input-signal';
import { browserPartitionForOwner } from '../../shared/browser-partition';
import { createChokepointReporter } from '../analytics/handled-report';

/**
 * Keeps OS passkey dialogs off a Browser surface an agent controls.
 *
 * A sign-in page that asks for a passkey on load opens Windows' "Choose a
 * passkey" dialog at once in Electron, and on an agent's surface nobody is there
 * to answer it. While an agent controls a surface, its passkey requests go to a
 * virtual authenticator instead (`ensureVirtualAuthenticator` in `cdp/cdp.ts`).
 * The person's own passkey sign-ins must keep reaching Windows Hello and the
 * phone, so the authenticator comes off the moment the person takes the surface
 * back. See `docs/architecture/embedded-browser/decision-log.md`, decision 47.
 *
 * WHEN it goes on is the whole design, because the request that opens the
 * dialog runs on the page's FIRST load, and a request already handed to the OS
 * does not move to an authenticator added later:
 *
 * - An offscreen lane is armed before its first `loadURL` (`openLane`). A person
 *   never drives a lane.
 * - Every `withGuest` call marks its owner and arms the guest before the tool
 *   body runs, so a `navigate` never loads unarmed.
 * - A guest created for an owner that is marked is armed at construction
 *   (`web-contents-created` in `src/main/index.ts`), before `did-attach` loads
 *   its `src`. That covers a pane `open_pane` mounts, a pop-out or dock that
 *   re-creates the guest, and a pane that reclaims a lane.
 *
 * The mark is keyed by PARTITION, because a partition is the one fact main can
 * read from a guest before it loads: `session.fromPartition(name)` is the same
 * object as the new guest's `session`. A task's surfaces all share its jar, so
 * the mark follows the task from lane to pane to pop-out.
 *
 * It ends on the person's first trusted mouse press or key on the guest outside
 * a drive (`releaseAgentControl`), never on a timer: a page that redirects to
 * sign-in between two agent calls must still be covered.
 */

/**
 * Marked partitions, each with its `Session` once one was looked up. Cached so a
 * person's press, which reads this on every mouse press and key in any guest,
 * never calls `session.fromPartition` again for a partition it already matched.
 * Pruned by `forgetAgentControl` when a task's work ends, so a deleted task's
 * jar is never looked up (and so rebuilt) again.
 */
const agentControlledPartitions = new Map<string, Session | null>();

/** Where an arm was asked for. Fixed values, sent as a report tag. */
export type PasskeyGuardSurface = 'lane' | 'drive' | 'created';

const passkeyGuardReporter = createChokepointReporter('browser_passkey_guard');

/** A fixed error for an install the guest refused, which the CDP helper reports as `false`. */
function installFailure(): Error {
  const error = new Error('The virtual passkey authenticator could not be installed');
  error.name = 'VirtualAuthenticatorInstallFailed';
  return error;
}

/**
 * An agent is driving or opening this owner's surface. The mark lasts until the
 * person's first press on one of its guests (`releaseAgentControl`) or, for a
 * task, until its work ends (`forgetAgentControl`). A Command Terminal's shared
 * jar has no such end, so its mark waits for the press.
 */
export function markAgentControl(projectId: string | null, ownerKey: string | null): void {
  if (!projectId || !ownerKey) return;
  const partition = browserPartitionForOwner(projectId, ownerKey);
  if (!agentControlledPartitions.has(partition)) agentControlledPartitions.set(partition, null);
}

/**
 * A task's work ended (Done, a reset, a delete): drop its mark, so a guest
 * built for it later starts as a person's pane. Called from `closeTaskWindows`.
 * A Command Terminal's shared jar is not a task's, so it is never dropped here.
 */
export function forgetAgentControl(projectId: string | null | undefined, taskId: string): void {
  if (!projectId) return;
  agentControlledPartitions.delete(browserPartitionForOwner(projectId, taskId));
}

/** The marked partition a guest's session belongs to, or null. */
function markedPartitionFor(guestSession: Session): string | null {
  for (const [partition, cachedSession] of agentControlledPartitions) {
    const markedSession = cachedSession ?? electronSession.fromPartition(partition);
    if (!cachedSession) agentControlledPartitions.set(partition, markedSession);
    if (markedSession === guestSession) return partition;
  }
  return null;
}

/** Whether a new guest on this session belongs to a surface an agent controls. */
export function isUnderAgentControl(guestSession: Session): boolean {
  if (agentControlledPartitions.size === 0) return false;
  return markedPartitionFor(guestSession) !== null;
}

/**
 * Attach CDP if needed and route this guest's passkey requests to the virtual
 * authenticator. Never throws: a guest that cannot be armed still loads, and
 * the failure is reported.
 */
export async function armGuest(guest: WebContents, surface: PasskeyGuardSurface): Promise<boolean> {
  if (guest.isDestroyed()) return false;
  if (!isDebuggerAttached(guest) && !attachDebugger(guest)) return false;
  return armAttachedGuest(guest, surface);
}

/** `armGuest` for a caller that has just attached the debugger itself (`withGuest`). */
export async function armAttachedGuest(guest: WebContents, surface: PasskeyGuardSurface): Promise<boolean> {
  const installed = await ensureVirtualAuthenticator(guest);
  if (!installed && !guest.isDestroyed()) {
    passkeyGuardReporter.report(installFailure(), { tags: { surface } });
  }
  return installed;
}

/**
 * The person pressed a mouse button or a key on this guest: they are taking the
 * surface back, so their passkey requests go to the OS again. Ignored during a
 * drive, where an input event is the agent's own or one the veil already
 * swallows. The agent's next drive marks and arms it again.
 */
export function releaseAgentControl(guest: WebContents): void {
  if (guest.isDestroyed() || isAgentDriving(guest.id)) return;
  // The disable goes first, in the same tick as the press: the click that
  // follows the press is what asks for a passkey. See `removeVirtualAuthenticator`.
  void removeVirtualAuthenticator(guest);
  if (agentControlledPartitions.size === 0) return;
  const partition = markedPartitionFor(guest.session);
  if (partition) agentControlledPartitions.delete(partition);
}

export function resetPasskeyGuardForTests(): void {
  agentControlledPartitions.clear();
}
