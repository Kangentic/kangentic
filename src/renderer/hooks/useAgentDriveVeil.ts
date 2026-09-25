import { useEffect, useRef, useState } from 'react';
import { useAgentDriveStore, useIsAgentDrivingSession } from '../stores/agent-drive-store';
import { useSessionStore } from '../stores/session-store';
import { requiresUserInteraction } from '../../shared/activity-state';

/**
 * The agent-drive signal, shaped for the eye instead of for the input router.
 *
 * ## The measurement this is built on
 *
 * Taken from a real 27-call agent verification against a live pane, reading the
 * agent's own transcript timestamps:
 *
 *   how long one call holds the guest   min 253ms   median 272ms   max 929ms
 *   gap between consecutive calls       min 1060ms  median 1665ms  max 4428ms
 *
 * Both halves are load-bearing, and the second is the surprising one.
 *
 * A call holds the guest for about a quarter of a second, and the router keeps
 * the signal up for `DRIVE_BURST_QUIET_MS` (400ms) past it, so ONE call is a
 * signal roughly 670ms long. The gap between calls is never under a second,
 * because it is the model thinking rather than the tool running, so the 400ms
 * quiet window never bridges it and EVERY call is its own burst. A run of ten
 * calls an agent issues "back to back" arrives as ten separate bursts about
 * 1.1s apart.
 *
 * So a per-burst envelope has no good setting. Paint each burst and a routine
 * verification flashes 27 times; suppress short bursts and nothing ever paints,
 * because every burst is short. The first attempt used a 700ms grace, which sat
 * just above the single-call band and so suppressed the entire workload: 26 of
 * 27 calls fell under it and the user saw nothing at all.
 *
 * ## The four things this has to do at once
 *
 * Stated by the user, and worth keeping because every earlier cut satisfied
 * three of them and traded the fourth:
 *
 *   1. Show the agent is working as soon as possible.
 *   2. Block the user's input as soon as possible.
 *   3. Release both as soon as the agent is no longer using the pane.
 *   4. Never flash or flicker.
 *
 * The tension is only between 1 and 4, and only if you read 4 as "never
 * appear briefly". It is not: what was reported was ONE cue strobing 27 times
 * across a single piece of work. So the cure is holding across the gaps, not
 * delaying the start - and once that is right, 1 costs 4 nothing.
 *
 * ## The shape that satisfies all four
 *
 * The veil OPENS on the first burst, immediately (1). It HOLDS while bursts
 * keep arriving within `LINK_MS` of each other, which at 5000ms covers every
 * gap measured above, so a whole verification is one fade in and one fade out
 * with nothing in between (4). It CLOSES on the earliest honest signal: the
 * agent going idle, the user's Ctrl+C, or `LINK_MS` of silence (3).
 *
 * The POINTER BLOCK is deliberately not on this envelope at all - see
 * `blocking` below. It follows the raw signal so it engages on the very first
 * call (2) and lets go the moment the agent does, which is tighter than the
 * announcement can safely be.
 *
 * ## Why not just ease the transition
 *
 * A fade on a cue that should never have appeared is a slower flash, and a
 * slower flash occupies more time on screen, not less. The fade OUT is longer
 * than the fade in, and that asymmetry is semantic rather than decorative: by
 * the time it runs the router has long since released the guest, so a veil at
 * full strength would be asserting something false while one at half strength
 * and falling reads as an ending.
 *
 * ## One envelope, every consumer
 *
 * The pane's veil and the split row's accent border both read this. Shaping
 * only the veil would leave the border flipping at the raw cadence underneath
 * a veil that no longer does, which is the same flicker wearing a different
 * element.
 */

/**
 * How far apart two bursts may be and still count as one run.
 *
 * Above the widest gap measured between consecutive agent calls (4428ms),
 * because a run that breaks mid-verification produces exactly the flicker this
 * exists to remove.
 */
export const AGENT_DRIVE_VEIL_LINK_MS = 5000;

/**
 * There is deliberately no threshold before the veil opens.
 *
 * An earlier cut waited for the SECOND burst of a run, so the first call was
 * never marked and the announcement trailed the agent by a whole inter-call
 * gap. That was solving the wrong problem. The flicker originally reported
 * was ONE cue strobing 27 times across a single piece of work, not a cue
 * appearing once - so the cure is to hold across the gaps, which `LINK_MS`
 * already does, not to delay the start.
 *
 * Opening on the first burst also keeps the two halves honest with each
 * other: the pointer block engages on that call whatever the veil does, and a
 * page that stops accepting clicks with nothing on screen to explain it is
 * worse than a brief mark.
 */

export interface AgentDriveVeilState {
  /** Veil the pane, breathe the ring, show the label. The SHAPED signal. */
  visible: boolean;
  /**
   * Take the pointer. The RAW signal, deliberately not the shaped one.
   *
   * The SAME envelope as `visible`, and that is a correction. It followed the
   * raw signal for one iteration, on the reasoning that blocking should be
   * exact while the mark could linger. That reasoning ignored the measured
   * cadence: a call holds the guest ~300ms out of every ~2s, so the raw
   * signal is DOWN for roughly 85% of a run. Reported immediately - "when the
   * agent is driving I can still click past the veil and interact with the
   * page" - because the veil was up through the gaps while the pointer was
   * live through them too.
   *
   * The gaps are the agent thinking about the page it is working on, not the
   * agent finishing with it, so a click there races the next call just as
   * much as one during a call. The run is the honest unit for both.
   *
   * It stays a separate field, and the pane a separate layer, for the
   * TRANSITION rather than the timing: pointer-events must flip instantly at
   * both edges, while the mark fades. A faded-out veil that still swallowed
   * clicks would be the same bug wearing the other face.
   *
   * It closes on the same instant signals `visible` does - a stop, or the
   * user's Ctrl+C - so the pane is never left dead after the user has asked
   * for it back. Opens with the raw signal, closes with the shaped one.
   */
  blocking: boolean;
  /**
   * The run ended because the agent STOPPED, rather than because the link
   * window expired with nothing following.
   *
   * The consumer uses this to pick its exit: those two look identical in the
   * store and are nothing alike to the person watching. A run winding down on
   * its own wants a slow fade, which reads as an ending rather than as an
   * assertion that is suddenly gone. A stop wants a fast one - the user
   * pressed the key, so they already know it ended and what they are waiting
   * for is confirmation that their input landed. Reported as "it still feels
   * like it releases slowly", against a release whose state and pointer were
   * already instant: only the 500ms fade was left, and for that half second
   * the veil said "do not touch" over a page that was fully clickable again.
   */
  stopped: boolean;
}

export function useAgentDriveVeil(sessionId: string | null | undefined): AgentDriveVeilState {
  const driving = useIsAgentDrivingSession(sessionId);
  const [visible, setVisible] = useState(false);

  /**
   * The agent has stopped and the pane is the user's again, right now.
   *
   * The link window bridges the model THINKING between two calls, and an
   * interrupted or finished agent is not thinking - so waiting it out is
   * always wrong, and since the veil swallows the pointer it means the user
   * is locked out of their own browser for seconds after they pressed stop.
   * Reported from live use: "I cancelled while it was driving and it held
   * longer than it should have; if a user stops the agent the stopping has to
   * be responsive."
   *
   * `requiresUserInteraction` rather than `!isActive`, because it is true only
   * for a DEFINITE idle or permission state. An unknown or not-yet-loaded
   * activity returns false and so can never tear the veil down underneath a
   * live drive, which is the direction that fails safe.
   */
  const agentReleased = useSessionStore((state) => {
    if (!sessionId) return false;
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (session && session.status !== 'running') return true;
    return requiresUserInteraction(state.sessionActivity[sessionId]);
  });

  /**
   * The user pressed Ctrl+C in this session's terminal, counted as an event.
   *
   * The engine's own answer arrives, measured end to end on a live agent,
   * 3067ms after the keypress: `UserInterruptCoordinator` deliberately waits
   * 3000ms to let the agent's `PostToolUseFailure` / `Stop` hooks fire first,
   * so it does not force-idle an agent that is still working. That is the
   * right trade for the ENGINE and the wrong one for this veil, which
   * swallows the pointer: it would leave the user unable to touch their own
   * browser for three seconds after pressing stop.
   *
   * Note which interrupts reach the engine quickly and which do not, because
   * it explains why this felt intermittent. Interrupting DURING a tool call
   * fires `PostToolUseFailure` with `is_interrupt` and idles at once.
   * Interrupting BETWEEN calls - which is most of the time, since a call runs
   * ~300ms out of every ~2s - fires no hook at all and pays the full settle.
   */
  const interruptCount = useAgentDriveStore((state) =>
    (sessionId ? state.userInterrupts[sessionId] : undefined) ?? 0,
  );

  // Run state lives in refs rather than in the effect's closure: a run spans
  // many `driving` transitions, so anything an effect cleanup tore down between
  // them would reset the run on every call and put the per-burst behaviour
  // straight back.
  const previousDrivingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const wasDriving = previousDrivingRef.current;
    previousDrivingRef.current = driving;
    // Also the mount pass, where both are false and there is no edge yet.
    if (driving === wasDriving) return;

    // One timer for both edges: they are mutually exclusive, and a rise must
    // cancel a pending close rather than let it blink the mark off between
    // two calls of the same run. Zero delay on the open rather than a
    // synchronous `setVisible`, which the React Compiler lint refuses inside
    // an effect body; it costs a frame, against a signal whose own debounce
    // is 400ms.
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setVisible(driving);
    }, driving ? 0 : AGENT_DRIVE_VEIL_LINK_MS);
  }, [driving]);

  // A user interrupt closes the run on the spot. Tracked separately from
  // `agentReleased` because it is an EVENT rather than a state: the engine may
  // never follow at all (an interrupt between tool calls fires no hook), so
  // there is nothing to latch on to and nothing to derive from.
  //
  // One shot is enough. Unlike `agentReleased`, which must keep the veil down
  // for as long as the agent stays idle, this only has to end the run once;
  // re-opening then takes a fresh run exactly as it would from rest.
  useEffect(() => {
    if (interruptCount === 0) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setVisible(false);
    }, 0);
  }, [interruptCount]);

  // The stop path, and it deliberately does not consult the run at all: no
  // grace, no link window, no fade budget to wait out. The agent is done, so
  // the pointer goes back on the next frame.
  //
  // A stale close timer set by the burst ending afterwards is harmless: the
  // run is already at zero, and a NEW drive clears that timer before its own
  // first burst is counted.
  useEffect(() => {
    if (!agentReleased) return;
    // Zero delay rather than a synchronous `setVisible`, which the React
    // Compiler lint rightly refuses inside an effect body. It costs nothing:
    // the returned value below already reads false this render, so the pointer
    // is back before this fires. This only tidies the run state so a later
    // resume starts clean.
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setVisible(false);
    }, 0);
  }, [agentReleased]);

  // Unmount, or a session change: drop the run outright. The signal for the old
  // session will never arrive again, so a veil left up here would never come
  // down.
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    previousDrivingRef.current = false;
    setVisible(false);
  }, [sessionId]);

  // Derived, not just stored: this is what makes a stop take effect in the
  // SAME render the session state changes in, with no timer, no fade budget
  // and no frame of the user still being locked out of their own page.
  return {
    visible: visible && !agentReleased,
    blocking: visible && !agentReleased,
    stopped: agentReleased,
  };
}
