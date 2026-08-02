/**
 * The restore contract behind fit-to-phone terminal resizing: while a phone
 * holds a session's grid (interactive-terminal `resize`), a guard entry in
 * the device's SubscriptionRegistry owns giving it back. Registering the
 * restore AS a subscription teardown means every release path the bridge
 * already has - explicit `release-size`, device transport drop, roster
 * revoke, bridge shutdown - restores the desktop's dimensions with no new
 * lifecycle plumbing.
 *
 * The guard disarms WITHOUT restoring when the session exits: a respawn
 * gets a new session id and spawns at desktop dims anyway, and resizing a
 * dead registry entry would just stash a stale pendingResize.
 */
import type { IpcContext } from '../../ipc/ipc-context';
import type { SubscriptionRegistry } from '../session/subscription-registry';

export function sizeGuardKeyFor(sessionId: string): string {
  return `terminal-size:${sessionId}`;
}

export function armTerminalSizeGuard(
  sessionId: string,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
): void {
  // Already armed: keep the existing guard. SubscriptionRegistry.set RUNS
  // the prior teardown under the same key, so re-arming on every repeat
  // resize would restore desktop dims mid-hold - exactly the flap the
  // guard exists to prevent.
  if (subscriptions.has(sizeGuardKeyFor(sessionId))) return;

  let disarmed = false;
  const onExit = (exitedSessionId: string): void => {
    if (exitedSessionId !== sessionId) return;
    disarmed = true;
    subscriptions.remove(sizeGuardKeyFor(sessionId));
  };
  context.sessionManager.on('exit', onExit);

  subscriptions.set(sizeGuardKeyFor(sessionId), () => {
    context.sessionManager.off('exit', onExit);
    if (disarmed) return;
    const desktopDims = context.sessionManager.getLastDesktopDimensions(sessionId);
    if (desktopDims) {
      context.sessionManager.resize(sessionId, desktopDims.cols, desktopDims.rows, 'desktop');
    }
    // The phone let go: an unheld session should return to the resting grid
    // after the usual debounce, so the next phone visit finds park dims (its
    // cue to request a fit-to-phone grid) rather than this restored desktop
    // grid frozen with nobody watching.
    context.sessionManager.reconsiderRestingGridAfterMobileRelease(sessionId);
  });
}

/** Runs the guard's teardown (restoring desktop dims) if one is armed. */
export function releaseTerminalSizeGuard(sessionId: string, subscriptions: SubscriptionRegistry): void {
  subscriptions.remove(sizeGuardKeyFor(sessionId));
}
