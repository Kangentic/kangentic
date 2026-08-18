/**
 * Puts the user's keyboard focus back when an agent-driven CDP input dispatch
 * pulls it into a Browser pane's `<webview>` guest.
 *
 * THE MECHANISM. `Input.dispatchMouseEvent` lands a real synthesized mousedown in
 * the guest. Blink answers by focusing the guest frame, and the browser process
 * propagates that up until the embedder's `<webview>` element is
 * `document.activeElement` - so the terminal the user was mid-sentence in is
 * blurred and the rest of the keystrokes go into the page.
 *
 * TRIGGERED BY THE SIGNAL, NOT BY A FOCUS EVENT. Main pushes an explicit "an
 * agent is driving guest N" interval (`browser:agentInput`), and that is what
 * arms and disarms this guard. The embedder does receive a trusted `focusout` on
 * the victim when the steal happens (measured), but it is deliberately NOT used
 * as a trigger - see the next paragraph, which is the whole reason this file is
 * shaped the way it is.
 *
 * THE RESTORE HAPPENS ONLY AFTER THE DRIVE ENDS, NEVER DURING IT. Measured on
 * Electron 41 against a live guest: taking focus back mid-drive silently BREAKS
 * the tool that is running. `kangentic_browser_type` is a click followed by
 * `Input.dispatchKeyEvent` char events, and once focus is pulled out of the guest
 * the guest's own focused element loses it too, so every character lands nowhere.
 * The measurement was unambiguous - the same type call produced an empty input
 * after a restore and the full text without one. So an "early fire" on `focusout`
 * would trade a focus bug for a silent input-dropping bug in the same feature.
 *
 * The user's focus is therefore held for the length of ONE tool call, which is
 * tens of milliseconds for the tools that dispatch input at all. The long-running
 * observe tools (`wait`) never steal focus in the first place, because they
 * dispatch no input.
 *
 * Two reasons the signal is also better than any DOM heuristic:
 *
 *  1. Clicking into a guest routes input to the guest widget and produces NO
 *     mousedown on the host document, so "was there a trusted user gesture on the
 *     pane" cannot distinguish an agent click from a real one.
 *  2. Main is the only caller of `Input.*`, so it knows the exact interval.
 *
 * Nothing runs, and no listener is installed, while no agent is driving.
 *
 * See `.claude/rules/agent-driven-focus.md`.
 */

import { useEffect } from 'react';
import { getLastFocusedTerminalSessionId, isRunningSession } from './dictation-target';

/**
 * How long after a drive ends to keep watching for the focus move.
 *
 * The guest focus change crosses a process boundary, so it can land after the
 * tool call has already returned. Checking only once, at the instant the drive
 * ends, misses exactly that case.
 */
export const AGENT_INPUT_GUARD_TAIL_MS = 150;

/**
 * The three decisions this guard makes, as PURE functions over primitives.
 *
 * Split out for the same reason `resolveArrivalFocus` is split out of
 * `mayTakeArrivalFocus`: the unit tier has no DOM, and each of these encodes a
 * distinction that is easy to get subtly wrong and impossible to see going wrong
 * at runtime. They take booleans rather than elements so they are testable
 * without jsdom.
 */

/** Whether an arriving drive has anything worth guarding. */
export function shouldArmFocusGuard(input: {
  hasActiveElement: boolean;
  activeIsBody: boolean;
  /** The user was ALREADY working inside this pane, so a move within it is
   *  their own business rather than a steal. */
  activeInsidePane: boolean;
}): boolean {
  if (!input.hasActiveElement || input.activeIsBody) return false;
  return !input.activeInsidePane;
}

/**
 * Whether a trusted user gesture means the user has chosen a DIFFERENT target
 * and the guard should stand down.
 *
 * The distinction this encodes is the one that matters most. The reported bug is
 * "type in the terminal while an agent drives", and a drive is short enough that
 * someone actively typing lands a keystroke inside it. That keystroke is a
 * trusted `keydown` on the very element being guarded - the user CONTINUING to
 * do the thing this guard protects. Treating it as "the user went somewhere
 * else" makes the fix fail in exactly its own repro, intermittently, which
 * presents identically to the original bug.
 */
export function isGestureAwayFromGuardedElement(input: {
  gestureIsGuardedElement: boolean;
  gestureInsideGuardedElement: boolean;
}): boolean {
  return !input.gestureIsGuardedElement && !input.gestureInsideGuardedElement;
}

/** Whether focus ended up in the pane and should be handed back. */
export function shouldRestoreStolenFocus(input: {
  /** False once the element has left the document (a re-render, a closed
   *  window): focusing a detached node silently does nothing. */
  restoreTargetConnected: boolean;
  activeIsRestoreTarget: boolean;
  /** The guest surfaces on the host as the `<webview>` element itself. */
  activeIsGuest: boolean;
  activeInsidePane: boolean;
}): boolean {
  if (!input.restoreTargetConnected) return false;
  if (input.activeIsRestoreTarget) return false;
  return input.activeIsGuest || input.activeInsidePane;
}

/** True when the element is (or is inside) the pane, including its guest. */
function isInsidePane(element: Element | null, pane: HTMLElement | null): boolean {
  if (!element || !pane) return false;
  return pane.contains(element);
}

export interface AgentInputFocusGuardRefs {
  /** The pane root, used to tell an intra-pane focus move from a steal. */
  paneRef: { current: HTMLElement | null };
  /** This pane's registered guest webContents id, or null before `dom-ready`. */
  guestWebContentsIdRef: { current: number | null };
}

export function useAgentInputFocusGuard({
  paneRef,
  guestWebContentsIdRef,
}: AgentInputFocusGuardRefs): void {
  // Empty deps on purpose: both ids are read from refs at EVENT time, so the
  // subscription never churns as the pane re-renders or re-registers its guest.
  useEffect(() => {
    const browser = window.electronAPI?.browser;
    if (!browser?.onAgentInput) return;

    // The element the user was in when the drive started. Null whenever there is
    // nothing worth restoring, which is also what disarms the guard.
    let restoreTarget: HTMLElement | null = null;
    // The session behind `restoreTarget`, snapshotted at ARM time.
    //
    // Captured rather than resolved at delivery, because by delivery time the
    // ambient answer is WRONG in exactly the case this feature creates: an
    // agent's `open_pane` makes its window `focusedWindowId` WITHOUT taking DOM
    // focus (that is what the `openedByAgent` stamp is for), so a focused-window
    // lookup names the agent's session while the user is still typing in theirs.
    // Routing there would put the user's characters, and an Enter, into another
    // agent's live shell. See `.claude/rules/agent-driven-focus.md`.
    let armedSessionId: string | null = null;
    let pendingChecks: ReturnType<typeof setTimeout>[] = [];

    const clearPendingChecks = () => {
      for (const timer of pendingChecks) clearTimeout(timer);
      pendingChecks = [];
    };

    const disarm = () => {
      clearPendingChecks();
      restoreTarget = null;
      armedSessionId = null;
    };

    const restoreIfStolen = () => {
      const target = restoreTarget;
      if (!target) return;
      // Gone from the document (a re-render, a closed window): there is nothing
      // to restore to, and focusing a detached node would silently do nothing.
      const active = document.activeElement;
      const shouldRestore = shouldRestoreStolenFocus({
        restoreTargetConnected: document.contains(target),
        activeIsRestoreTarget: active === target,
        activeIsGuest: active?.tagName === 'WEBVIEW',
        activeInsidePane: isInsidePane(active, paneRef.current),
      });
      if (!shouldRestore) return;
      // Cleared BEFORE the focus call so the tail check cannot fire a second
      // restore and fight a click the user made in between.
      restoreTarget = null;
      // `.focus()` alone is enough, measured: it takes REAL focus back off the
      // guest, not just `document.activeElement`. `document.hasFocus()` returns
      // to true asynchronously (within ~400ms), so do not add a `<webview>`
      // `.blur()` on the strength of an immediate read looking wrong.
      target.focus();
    };

    const unsubscribe = browser.onAgentInput((webContentsId, active) => {
      // Another pane in this same window. One window can host several.
      if (webContentsId !== guestWebContentsIdRef.current) return;

      if (active) {
        clearPendingChecks();
        const activeElement = document.activeElement;
        const arm = activeElement instanceof HTMLElement && shouldArmFocusGuard({
          hasActiveElement: true,
          activeIsBody: activeElement === document.body,
          activeInsidePane: isInsidePane(activeElement, paneRef.current),
        });
        if (!arm || !(activeElement instanceof HTMLElement)) {
          disarm();
          return;
        }
        restoreTarget = activeElement;
        // Snapshot the target's session NOW, while the user's terminal still
        // holds focus, so delivery never has to guess. `noteTerminalFocus` is
        // wired to every xterm textarea's focus event, so when `restoreTarget`
        // is a terminal this is that terminal's session.
        armedSessionId = getLastFocusedTerminalSessionId();
        // Note what is NOT done here: no `focusout` listener, and no restore
        // while the drive is in flight. The steal DOES surface as a trusted
        // `focusout` on this element, so an early fire is tempting and was the
        // original design - but restoring mid-drive breaks the very tool that is
        // running (see the file header). The drive is short; waiting is correct.
        return;
      }

      // The drive ended. Check now for the focus move that already landed, and
      // again after the tail for the one still crossing the process boundary.
      pendingChecks.push(setTimeout(restoreIfStolen, 0));
      pendingChecks.push(setTimeout(() => {
        restoreIfStolen();
        disarm();
      }, AGENT_INPUT_GUARD_TAIL_MS));
    });

    // The user typed into the guest while the agent held focus there. Main
    // already stopped the keystroke reaching the page and encoded it as terminal
    // bytes; this puts it where the user meant it to go.
    //
    // The target is CAPTURED ON ARM, not resolved at delivery. Reusing
    // `resolveDictationTarget` here was wrong: its tier 1 is the focused WINDOW,
    // and an agent's `open_pane` deliberately makes its window the focused one
    // without taking DOM focus, so the ambient answer names the agent's session
    // precisely when the user is typing in a different one.
    const unsubscribeUserKey = window.electronAPI?.browser?.onUserKeyDuringDrive?.(
      (webContentsId, data) => {
        if (webContentsId !== guestWebContentsIdRef.current) return;
        // Route ONLY when the drive interrupted someone typing in a TERMINAL.
        //
        // `restoreTarget` is what the user was actually in when the drive armed,
        // and it is the only honest basis for this. Resolving the target
        // ambiently instead would misroute the one case that is easy to hit: a
        // user typing in the pane's own note input gets their focus stolen the
        // same way, and their words would be delivered to a shell as if they had
        // been commands.
        //
        // Anything other than a terminal is dropped rather than guessed at. The
        // keystroke is already safely out of the page, which was the point;
        // landing a note-input keystroke back in the note input needs a
        // different mechanism (writing into a controlled input, not PTY bytes)
        // and is tracked separately.
        if (!restoreTarget?.classList.contains('xterm-helper-textarea')) return;
        // Still in the document. A detached node keeps its class, so the check
        // above cannot tell a live terminal from one whose window closed or
        // whose session suspend-killed mid-drive. `restoreIfStolen` already
        // makes this distinction; the delivery path must make it too, or a
        // keystroke aimed at a torn-down terminal gets written somewhere else.
        if (!document.contains(restoreTarget)) return;
        // Only the session we armed on, and only while it is still running.
        // Both checks fail CLOSED to a dropped keystroke, which this feature
        // already accepts: a lost character beats a misdirected one.
        if (!isRunningSession(armedSessionId)) return;
        void window.electronAPI.sessions.write(armedSessionId, data).catch(() => {});
      },
    );

    // A real user gesture disarms the guard, but ONLY when it names a different
    // target than the one being guarded.
    //
    // The distinction is the whole point. The reported bug is "type in the
    // terminal while an agent drives", and a drive is short enough that someone
    // actively typing lands a keystroke inside it. That keystroke is a trusted
    // `keydown` on the guarded element - the user CONTINUING to do the thing
    // this guard protects, not choosing somewhere else. Disarming on it would
    // make the fix fail in exactly its own repro, intermittently, which presents
    // identically to the original bug.
    //
    // A gesture aimed elsewhere is different: the user has moved on, and
    // restoring focus would yank them back.
    //
    // This deliberately does NOT cover a click into the guest itself, which
    // produces no host event at all - that residual is stated in the rule rather
    // than papered over here.
    const userGestureListener = (event: Event) => {
      if (!event.isTrusted || !restoreTarget) return;
      const target = event.target;
      const movedOn = isGestureAwayFromGuardedElement({
        gestureIsGuardedElement: target === restoreTarget,
        gestureInsideGuardedElement: target instanceof Node && restoreTarget.contains(target),
      });
      if (movedOn) disarm();
    };
    document.addEventListener('pointerdown', userGestureListener, true);
    document.addEventListener('keydown', userGestureListener, true);

    return () => {
      unsubscribe();
      unsubscribeUserKey?.();
      document.removeEventListener('pointerdown', userGestureListener, true);
      document.removeEventListener('keydown', userGestureListener, true);
      disarm();
    };
  }, [paneRef, guestWebContentsIdRef]);
}
