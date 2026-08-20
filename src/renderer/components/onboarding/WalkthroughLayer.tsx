import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useOnboardingProgress } from '../../hooks/useOnboardingProgress';
import { WALKTHROUGH_STEPS, resolveNextStep } from './walkthrough-steps';
import { useWalkthroughActivation } from './useWalkthroughActivation';

/** Gap between the target and the cutout edge. driver.js's `stagePadding` default, matched
 *  so the spotlight reads the way users expect from other products. */
const STAGE_PADDING = 10;
/** Gap between the cutout and the callout. driver.js's `popoverOffset` default. */
const CALLOUT_OFFSET = 10;
const CALLOUT_WIDTH = 300;
/** Keep the callout off the very edge of the window when a target sits near a corner. */
const VIEWPORT_MARGIN = 12;
/**
 * Assumed callout height, used only to keep it on screen and to centre it beside a target.
 * Sized for a two-to-three line body at text-sm; being a little generous biases placement
 * slightly upward, which is harmless.
 *
 * Both placement functions share it deliberately: tuning the assumption in one and not the
 * other would place the anchored and unanchored callouts by different rules.
 */
const ESTIMATED_CALLOUT_HEIGHT = 150;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Also the scrim's test id. Named so `openDialogRects` can exclude this overlay's own bands. */
const WALKTHROUGH_LAYER_TEST_ID = 'walkthrough-layer';

/** Smallest rect containing all of the given rects. */
function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** Laid-out rects for a selector. Zero-size boxes are dropped: an element can be present
 *  but unlaid-out (a collapsed parent, `display: contents`), which is not something to ring. */
function measureAll(selector: string): Rect[] {
  return Array.from(document.querySelectorAll(selector))
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({ left: box.left, top: box.top, width: box.width, height: box.height }));
}

function sameRect(first: Rect | null, second: Rect | null): boolean {
  if (first === null || second === null) return first === second;
  return first.left === second.left
    && first.top === second.top
    && first.width === second.width
    && first.height === second.height;
}

/**
 * Track a selector's live viewport rect.
 *
 * Re-measures every animation frame and only sets state when the rect actually changes,
 * mirroring the dictation chip position hook. A polling loop rather than a ResizeObserver because
 * the target moves for reasons the observer never sees: horizontal board scroll, a column
 * drag, a sibling panel resizing. The loop only runs while a step is active.
 */
function useTargetRect(selector: string | null): { rect: Rect | null; everFound: boolean; measured: boolean } {
  const [rect, setRect] = useState<Rect | null>(null);
  const [everFound, setEverFound] = useState(false);
  // Distinguishes "not looked yet" from "looked and there is nothing there". Without it the
  // caller cannot tell the two apart on the first frame, and has to choose between flashing
  // an unanchored callout before the target resolves or rendering nothing at all when the
  // target never existed (step 5 on a board with no task).
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      setEverFound(false);
      setMeasured(true);
      return;
    }
    setEverFound(false);
    setMeasured(false);
    let frameId: number | undefined;
    let currentRect: Rect | null = null;

    const measure = () => {
      // A step may name several elements (the four project-default controls are one
      // region, not one field); the cutout is their union.
      //
      // An open Combobox dropdown used to be folded into this union. What that
      // bought was a bigger RING, not readability: the blur bands sit at z-[46]
      // (see the scrim comment below), already BELOW the z-50 panels and dialogs
      // these controls live in, and the z-[70] layer above carries only the ring
      // outline and the callout, neither of which blurs anything. The dropdowns now
      // portal to document.body at z-[2147483646], so they clear every layer here
      // outright, and because they portal through OverlayPopover they carry
      // `data-dismissable-layer` - which is what `openDialogRects` already keys on
      // to route the callout around them. Folding them into the cutout would now
      // only over-expand the spotlight into empty space.
      const targetRects = measureAll(selector);
      const nextRect = targetRects.length > 0 ? unionRects(targetRects) : null;
      if (!sameRect(currentRect, nextRect)) {
        currentRect = nextRect;
        setRect(nextRect);
        if (nextRect) setEverFound(true);
      }
      setMeasured(true);
      frameId = requestAnimationFrame(measure);
    };

    frameId = requestAnimationFrame(measure);
    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [selector]);

  return { rect, everFound, measured };
}

function sameRects(first: Rect[], second: Rect[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((rect, index) => sameRect(rect, second[index]));
}

/**
 * Track the dialogs the callout has to stay clear of, on the same per-frame cadence as the
 * target itself.
 *
 * Measuring them during render instead made placement depend on WHEN the component happened
 * to render. A dialog that is on its way out still occupies its box for the length of its
 * exit animation, so a step armed in the same tick that closed the checklist placed itself
 * around a dialog that was already gone a frame later - and never re-placed, because nothing
 * re-rendered afterwards.
 */
function useDialogRects(active: boolean): Rect[] {
  const [rects, setRects] = useState<Rect[]>([]);

  useEffect(() => {
    if (!active) {
      setRects([]);
      return;
    }
    let frameId: number | undefined;
    let committedRects: Rect[] = [];
    let previousRects: Rect[] | null = null;

    const measure = () => {
      const nextRects = openDialogRects();
      // Commit only once a measurement REPEATS. A dialog's entrance animation scales its box
      // on every frame, so placing against the first box that appears makes the callout drift
      // into position over the length of that animation. Waiting for two identical frames
      // means it is placed once, where it belongs.
      if (
        previousRects !== null
        && sameRects(previousRects, nextRects)
        && !sameRects(committedRects, nextRects)
      ) {
        committedRects = nextRects;
        setRects(nextRects);
      }
      previousRects = nextRects;
      frameId = requestAnimationFrame(measure);
    };

    frameId = requestAnimationFrame(measure);
    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [active]);

  return rects;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top;
}

/**
 * Rects of the surfaces currently on screen that the callout has to stay clear of.
 *
 * A step often opens one AND rings something behind it; the callout is the one part of this
 * overlay with pointer-events, so covering it makes it unusable.
 *
 * Two selectors, because Settings is not a dialog. It is a docked panel with its own shell,
 * so it carries no `data-dismissable-layer` - the reason step 1's callout used to sit
 * viewport-centred and only looked right by accident, the panel happening to fill the half of
 * the screen it was not on.
 *
 * The walkthrough's OWN scrim is excluded. It carries `data-dismissable-layer` (so a click
 * through it is not read as "dismiss the task-detail window") and its four bands cover the
 * entire viewport, so counting it made every candidate position look blocked - and, because
 * the scrim is absent on the frame a target first resolves and present on every frame after,
 * the callout landed somewhere different depending on when it happened to be measured.
 */
function openDialogRects(): Rect[] {
  return [
    ...measureSettled(`[data-dismissable-layer]:not([data-testid="${WALKTHROUGH_LAYER_TEST_ID}"]) > *`),
    ...measureSettled('[data-testid="settings-panel"]'),
  ];
}

/**
 * Like `measureAll`, but skips anything still animating.
 *
 * Every dialog and panel here enters on a scale keyframe, so a box measured mid-entrance is
 * both smaller and differently centred than the one it settles into - and placement computed
 * against it puts the callout somewhere it then has to leave. Waiting for two identical frames
 * was not enough: an entrance can hold the same pose across consecutive frames (a delay, or an
 * easing plateau), which reads as settled and commits the wrong box.
 *
 * `getAnimations()` is the direct question, and it does not need a subtree walk: the keyframe
 * lives on the dialog root itself, while children (the mascot's blink loop, a spinner) animate
 * forever and would make the answer permanently "no".
 */
function measureSettled(selector: string): Rect[] {
  return Array.from(document.querySelectorAll(selector))
    .filter((element) => element.getAnimations().every((animation) => animation.playState !== 'running'))
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({ left: box.left, top: box.top, width: box.width, height: box.height }));
}

/**
 * Place the callout so it neither covers the thing it is describing nor any dialog the
 * step just opened.
 *
 * Four candidates are scored in order - above, left, right, below - and the first that
 * clears every open dialog wins. Order matters: a spotlit control usually sits in a
 * vertical stack (a board column, a settings field with siblings under it), so "below"
 * is the likeliest to bury what the copy is talking about and goes last. Overlap is not
 * cosmetic here: the callout is the only part of this overlay with `pointer-events: auto`,
 * so whatever it covers becomes unclickable - which is exactly how it landed on top of the
 * New Task dialog it had just opened.
 *
 * If every candidate is blocked, the least-bad one still beats rendering nothing, so the
 * first is used.
 */
function placeCallout(cutout: Rect, dialogs: Rect[]): { left: number; top: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const clamp = (value: number, max: number) => Math.min(Math.max(VIEWPORT_MARGIN, value), Math.max(VIEWPORT_MARGIN, max));

  const horizontallyCentered = clamp(
    cutout.left + cutout.width / 2 - CALLOUT_WIDTH / 2,
    viewportWidth - CALLOUT_WIDTH - VIEWPORT_MARGIN,
  );
  const verticallyCentered = clamp(
    cutout.top + cutout.height / 2 - ESTIMATED_CALLOUT_HEIGHT / 2,
    viewportHeight - ESTIMATED_CALLOUT_HEIGHT - VIEWPORT_MARGIN,
  );

  // Left and right are ordered by how much room each side actually has, not by a fixed
  // preference. A wide cutout hugging one edge of the window (step 4 lights two whole board
  // columns) leaves a sliver on one side and half the screen on the other; taking "left"
  // just because it came first jammed the callout against the window edge.
  const beside = [
    { left: cutout.left - CALLOUT_OFFSET - CALLOUT_WIDTH, top: verticallyCentered, room: cutout.left },
    {
      left: cutout.left + cutout.width + CALLOUT_OFFSET,
      top: verticallyCentered,
      room: viewportWidth - (cutout.left + cutout.width),
    },
  ].sort((first, second) => second.room - first.room)
    .map(({ left, top }) => ({ left, top }));

  const candidates: Array<{ left: number; top: number }> = [
    { left: horizontallyCentered, top: cutout.top - CALLOUT_OFFSET - ESTIMATED_CALLOUT_HEIGHT },
    ...beside,
    { left: horizontallyCentered, top: cutout.top + cutout.height + CALLOUT_OFFSET },
  ];

  const onScreen = (candidate: { left: number; top: number }) => (
    candidate.left >= VIEWPORT_MARGIN
    && candidate.top >= VIEWPORT_MARGIN
    && candidate.left + CALLOUT_WIDTH <= viewportWidth - VIEWPORT_MARGIN
    && candidate.top + ESTIMATED_CALLOUT_HEIGHT <= viewportHeight - VIEWPORT_MARGIN
  );
  const clearsDialogs = (candidate: { left: number; top: number }) => {
    const box: Rect = { left: candidate.left, top: candidate.top, width: CALLOUT_WIDTH, height: ESTIMATED_CALLOUT_HEIGHT };
    return !dialogs.some((dialog) => overlaps(box, dialog));
  };

  // Two passes, so a cramped layout degrades to "overlaps something" rather than to "half
  // off the top of the window", which is what a single pass falling back to candidates[0]
  // produced. Staying on screen is the harder requirement of the two.
  const best = candidates.find((candidate) => onScreen(candidate) && clearsDialogs(candidate))
    ?? candidates.find(onScreen);
  if (best) return best;
  return {
    left: clamp(candidates[0].left, viewportWidth - CALLOUT_WIDTH - VIEWPORT_MARGIN),
    top: clamp(candidates[0].top, viewportHeight - ESTIMATED_CALLOUT_HEIGHT - VIEWPORT_MARGIN),
  };
}

/**
 * Where the callout goes when the step has nothing to ring.
 *
 * A redirect-only step (Settings, Board manager) still needs its guidance on screen - the
 * surface it opened is the answer to "where", but not to "why am I here". So the callout
 * sits beside that surface: the union of every open dialog is measured, and the callout
 * takes whichever side has more room. With Settings docked right that puts it out over the
 * board on the left; with a centred dialog like Board manager it lands alongside.
 *
 * Vertically centred rather than top-aligned, so it reads as a companion to the dialog
 * rather than a toast.
 */
function placeUnanchoredCallout(dialogs: Rect[]): { left: number; top: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const dialogUnion = unionRects(dialogs);
  if (!dialogUnion) {
    return {
      left: Math.max(VIEWPORT_MARGIN, viewportWidth / 2 - CALLOUT_WIDTH / 2),
      top: Math.max(VIEWPORT_MARGIN, viewportHeight / 2 - ESTIMATED_CALLOUT_HEIGHT / 2),
    };
  }
  // Centred on the DIALOG, not the viewport, so it lines up with whatever it accompanies.
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, dialogUnion.top + dialogUnion.height / 2 - ESTIMATED_CALLOUT_HEIGHT / 2),
    Math.max(VIEWPORT_MARGIN, viewportHeight - ESTIMATED_CALLOUT_HEIGHT - VIEWPORT_MARGIN),
  );
  const roomOnLeft = dialogUnion.left;
  const roomOnRight = viewportWidth - (dialogUnion.left + dialogUnion.width);
  if (roomOnLeft >= roomOnRight) {
    return { left: Math.max(VIEWPORT_MARGIN, dialogUnion.left - CALLOUT_OFFSET - CALLOUT_WIDTH), top };
  }
  return {
    left: Math.min(
      dialogUnion.left + dialogUnion.width + CALLOUT_OFFSET,
      Math.max(VIEWPORT_MARGIN, viewportWidth - CALLOUT_WIDTH - VIEWPORT_MARGIN),
    ),
    top,
  };
}

/**
 * Coach-mark overlay for a single onboarding step.
 *
 * Activated only by the user clicking a checklist item - it never appears unprompted and
 * never auto-advances to a next step. It clears itself when the step completes, when the
 * spotlighted element disappears (the dialog it lived in was closed), on Escape, and on a
 * project switch.
 *
 * EVERY layer here is `pointer-events: none`. That is the load-bearing property: a
 * `backdrop-blur` div is a real painted, hit-testable element, so without it the scrim
 * would swallow every click outside the cutout. With it, nothing on screen is ever
 * blocked - which is how "the user is never at the mercy of the tutorial" is actually
 * implemented, rather than merely promised by a Skip button.
 */
export function WalkthroughLayer() {
  const walkthroughStep = useConfigStore((state) => state.walkthroughStep);
  const setWalkthroughStep = useConfigStore((state) => state.setWalkthroughStep);
  const checklistOpen = useConfigStore((state) => state.onboardingChecklistOpen);
  const settingsOpen = useConfigStore((state) => state.settingsOpen);
  const boardManagerOpen = useBoardStore((state) => state.boardManagerOpen);
  const markOnboardingStepCompleted = useConfigStore((state) => state.markOnboardingStepCompleted);
  const { startStep, closeStepSurfaces } = useWalkthroughActivation();
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const progress = useOnboardingProgress();

  const step = WALKTHROUGH_STEPS.find((candidate) => candidate.key === walkthroughStep) ?? null;
  const selector = step ? step.resolveTargetSelector(swimlanes) : null;
  const { rect, everFound, measured } = useTargetRect(selector);
  const dialogRects = useDialogRects(step !== null);

  // Escape ends the walkthrough. Deliberately BUBBLE phase, not capture: BaseDialog's own
  // Escape listener is registered first and therefore wins, so with Settings or Board
  // manager open, Escape closes that dialog (what the user expects) rather than silently
  // dismissing a coach mark behind it. The step then clears via the disappearance check
  // below, because its target went with the dialog.
  // Gated on `opensDialog`, not on `rect`: any step that opened a dialog hands Escape to that
  // dialog entirely. `!rect` looked equivalent - the redirect-only steps have no target - but
  // `taskCreated` both opens the New Task dialog AND rings the real Add task button, so it
  // resolves a rect and used to attach this listener alongside BaseDialog's. Neither stops
  // propagation, so one Escape closed the dialog and cleared the step, and AppLayout's
  // ref-reset ran first and wiped the step id it needs to bring the checklist back: backing
  // out of "Create a task" silently ended onboarding instead of returning to the list.
  // Testing the flag rather than special-casing that one step keeps a future
  // dialog-plus-spotlight step from reintroducing it.
  useEffect(() => {
    if (!step || step.opensDialog || !rect) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWalkthroughStep(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [step, rect, setWalkthroughStep]);

  // Deliberately NOT cleared here when the step completes. AppLayout owns that: it clears
  // the step and brings the checklist back, so finishing a step leads somewhere instead of
  // just making the guidance vanish. Clearing here would race it and strand the user.
  const stepDone = step ? progress[step.key] : false;

  // The target was found and then vanished: the surface hosting it closed. End the step
  // rather than dimming the whole app around nothing.
  useEffect(() => {
    if (step && everFound && rect === null) setWalkthroughStep(null);
  }, [step, everFound, rect, setWalkthroughStep]);

  // The moment the user picks a card up, the explanation has done its job - and a dimmed,
  // blurred board is the last thing you want while aiming a drop. dnd-kit mounts a
  // `.drag-overlay` for the duration of a drag, so its presence is the signal. Polled on a
  // frame rather than wired into the board's drag hook, which keeps board code untouched.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!step) return;
    let frameId: number | undefined;
    const checkForDrag = () => {
      setDragging(!!document.querySelector('.drag-overlay'));
      frameId = requestAnimationFrame(checkForDrag);
    };
    frameId = requestAnimationFrame(checkForDrag);
    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [step]);

  // A project switch reconstructs the board underneath us; carrying a spotlight across it
  // would point at the previous project's column.
  const previousProjectIdRef = useRef(currentProjectId);
  useEffect(() => {
    if (previousProjectIdRef.current !== currentProjectId) {
      previousProjectIdRef.current = currentProjectId;
      setWalkthroughStep(null);
    }
  }, [currentProjectId, setWalkthroughStep]);

  if (!step) return null;
  // The checklist and a coach mark are two answers to the same question, and seeing both at
  // once is disorienting - a modal explaining the flow, plus a floating card explaining one
  // step of it. Not every path that opens the checklist clears the step - AppLayout's
  // install-scoped auto-open effect sets `onboardingChecklistOpen` without touching
  // `walkthroughStep` - so this guard is load-bearing rather than belt-and-braces, and it
  // also rules the state out no matter which order two competing writes land in.
  if (checklistOpen) return null;

  // The way onward. On every step, and it ticks the step off by itself.
  //
  // The checklist is a demonstration of how the app works, not a gate: someone who would
  // rather read than do can press Next straight through and be done, and that is their call.
  // Doing the real thing still ticks the step on its own, so the two routes never fight.
  //
  // It goes STRAIGHT to the next step rather than back to the checklist. Returning to the
  // list every time made a five-step flow cost ten clicks and two modal transitions per step,
  // and asked the user to re-find their place in a list they had just left. The rows are
  // still there for anyone who wants to jump around; this is the path for anyone who does not.
  const closablePanelOpen = settingsOpen || boardManagerOpen;
  const nextStep = resolveNextStep({ ...progress, [step.key]: true }, step.key);
  const goToNextStep = () => {
    if (currentProjectId) markOnboardingStepCompleted(currentProjectId, step.key);
    if (nextStep) {
      startStep(nextStep);
      return;
    }
    // Last one, and Finish means finished: clear the surfaces and get out of the way. Putting
    // the checklist back up to be dismissed again makes the final click of a five-step flow
    // buy the user one more modal. Completing every step retires onboarding for this project
    // on its own (AppLayout marks it onboarded), so there is nothing left to confirm.
    closeStepSurfaces();
    setWalkthroughStep(null);
  };

  // While a card is being dragged the overlay steps aside entirely: a dimmed, blurred board
  // is the last thing anyone wants while aiming a drop. The STEP stays armed through the
  // drag, so completing it still returns to the checklist.
  if (dragging) return null;
  // Done: get out of the way, EXCEPT while a panel this step opened is still up. The user
  // may still be changing things in there, the checklist deliberately does not jump in front
  // of it, and yanking the guidance away the instant one setting changed left the panel with
  // nothing on screen explaining why they were in it.
  if (stepDone && !closablePanelOpen) return null;
  // Nothing paints until its final position is known. Two things can move it after the fact,
  // and both used to show as a flash on every step: the target's first measurement (one
  // frame), and a dialog that has not finished mounting and animating in yet - placement is
  // computed around dialogs, so appearing before one lands means appearing in the wrong place
  // and then jumping. `dialogRects` only commits once a measurement repeats, so a non-empty
  // value here means the dialog has settled, not merely mounted.
  //
  // Once measured, a MISSING target is not a reason to render nothing: the copy and the Next
  // button still have to be reachable (step 5 on a board with no task has nothing to ring,
  // and gating on that would strand anyone walking the flow with Next).
  if (!measured) return null;
  if (step.opensDialog && dialogRects.length === 0) return null;

  const cutout: Rect | null = stepDone ? null : rect && {
    left: rect.left - STAGE_PADDING,
    top: rect.top - STAGE_PADDING,
    width: rect.width + STAGE_PADDING * 2,
    height: rect.height + STAGE_PADDING * 2,
  };
  // A dialog on screen wins placement, even when the step also rings something behind it.
  // Step 3 rings the Add task button in the bottom-left corner while the New Task dialog it
  // opened sits centre-screen: hugging the ring wedged the callout into the corner right on
  // top of the button it was pointing at. Beside the dialog, vertically centred, is both
  // clear of everything and the same position the redirect steps use, so the callout does
  // not appear to jump around the screen from one step to the next.
  const callout = cutout && dialogRects.length === 0
    ? placeCallout(cutout, dialogRects)
    : placeUnanchoredCallout(dialogRects);
  const stepNumber = WALKTHROUGH_STEPS.findIndex((candidate) => candidate.key === step.key) + 1;

  const scrimClass = 'fixed bg-surface/40 backdrop-blur-xs pointer-events-none';
  const calloutBody = (
    <div
      className="fixed rounded-lg bg-surface-raised ring-1 ring-edge shadow-lg p-3 pointer-events-auto"
      style={{ left: callout.left, top: callout.top, width: CALLOUT_WIDTH }}
      role="dialog"
      aria-label={step.calloutTitle(swimlanes)}
      data-testid="walkthrough-callout"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
            {stepDone && <Check size={14} className="flex-shrink-0 text-accent" />}
            {step.calloutTitle(swimlanes)}
          </p>

          {/* Fixed for the life of the step. Swapping in a confirmation once it ticked
              rewrote the instructions out from under a user still working in the panel; the
              check beside the title says everything the swap was saying. */}
          <p className="text-sm text-fg-muted mt-1 leading-relaxed">
            {step.calloutBody(swimlanes)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWalkthroughStep(null)}
          className="flex-shrink-0 p-1 rounded text-fg-faint hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          aria-label="Stop showing me this step"
          data-testid="walkthrough-skip"
        >
          <X size={14} />
        </button>
      </div>

      {/* A ruled footer, not a third line of body text: progress on the left and the action
          on the right, the same shape as the checklist's own footer so the two surfaces read
          as one flow. driver.js's `{{current}} of {{total}}` convention for the label. */}
      <div className="flex items-center justify-between gap-2 mt-3 pt-2.5 border-t border-edge/50">
        <span className="text-xs text-fg-faint">
          Step {stepNumber} of {WALKTHROUGH_STEPS.length}
        </span>
        <button
          type="button"
          onClick={goToNextStep}
          className="px-3 py-1 text-xs font-medium rounded bg-accent-emphasis hover:bg-accent text-accent-on cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          data-testid="walkthrough-next-step"
        >
          {nextStep ? 'Next step' : 'Finish'}
        </button>
      </div>
    </div>
  );

  // Redirect-only step: the surface it opened IS the guidance, so there is nothing to ring
  // and nothing to dim. The callout still rides along beside that surface, because opening
  // a settings panel with no explanation leaves the user knowing where they are but not why.
  if (!cutout) {
    return <div className="fixed inset-0 z-[70] pointer-events-none">{calloutBody}</div>;
  }

  const cutoutRight = cutout.left + cutout.width;
  const cutoutBottom = cutout.top + cutout.height;

  return (
    <>
      {/*
        The scrim dims the APP, not the surface a step just opened.

        It sits at z-[46]: above the board (z-40) and the command terminal (z-[45]), but
        BELOW dialogs and panels (z-50). So Settings, Board manager, and the New Task
        dialog - and any dropdown inside them - render on top of it at full clarity, while
        the board behind stays dimmed. Without that ordering a step would blur the very
        surface it told the user to go and use: unreadable dropdown options, an invisible
        Save button, a form the user cannot read while filling it in. The cutout then only
        has to handle targets on the board itself.
      */}
      <div
        className="fixed inset-0 z-[46] pointer-events-none"
        data-testid={WALKTHROUGH_LAYER_TEST_ID}
        data-dismissable-layer
      >
        {/* Four bands around the cutout rather than one masked div: simpler, and it renders
            identically everywhere. The cutout itself is left uncovered, so the spotlighted
            control keeps its own appearance. */}
        <div className={scrimClass} style={{ left: 0, top: 0, width: '100vw', height: Math.max(0, cutout.top) }} />
        <div className={scrimClass} style={{ left: 0, top: cutoutBottom, width: '100vw', bottom: 0 }} />
        <div className={scrimClass} style={{ left: 0, top: cutout.top, width: Math.max(0, cutout.left), height: cutout.height }} />
        <div className={scrimClass} style={{ left: cutoutRight, top: cutout.top, right: 0, height: cutout.height }} />
      </div>

      {/* Ring and callout ride ABOVE everything (including the dialogs the scrim passes
          under), so the highlight still reads on a control inside an open panel. */}
      <div className="fixed inset-0 z-[70] pointer-events-none">
      {/* `outline` rather than `border` or `box-shadow`, matching `.drop-highlight`: it
          follows the target's own rounded corners and adds no layout. */}
      <div
        className="fixed rounded-lg outline-2 outline-accent pointer-events-none"
        style={{ left: cutout.left, top: cutout.top, width: cutout.width, height: cutout.height }}
        data-testid="walkthrough-ring"
      />

      {calloutBody}
      </div>
    </>
  );
}
