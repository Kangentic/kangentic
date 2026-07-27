import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { OverseerMascot } from './OverseerMascot';
import type { OnboardingStepKey } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import {
  buildSwimlaneSignature,
  useOnboardingProgress,
  ONBOARDING_STEP_COUNT,
} from '../../hooks/useOnboardingProgress';
import { WALKTHROUGH_STEPS, resolveNextStep, resolveStepLabel } from './walkthrough-steps';
import { useWalkthroughActivation } from './useWalkthroughActivation';

/**
 * The onboarding checklist: five steps, each opening the surface where it happens.
 *
 * Centered on the BOARD region rather than the viewport (`backdropPositionClass` matches
 * the window layer's `top-10 bottom-9`), so the title bar and status bar stay live behind
 * it. Guided, not automated: a row takes the user to the right screen and rings the right
 * control, but never fills anything in.
 */
export function WelcomeChecklistDialog() {
  const currentProject = useProjectStore((state) => state.currentProject);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const setOnboardingChecklistOpen = useConfigStore((state) => state.setOnboardingChecklistOpen);
  const setWalkthroughStep = useConfigStore((state) => state.setWalkthroughStep);
  const markProjectOnboarded = useConfigStore((state) => state.markProjectOnboarded);
  const captureOnboardingBaseline = useConfigStore((state) => state.captureOnboardingBaseline);
  const permissionMode = useConfigStore((state) => state.config.agent.permissionMode);
  const progress = useOnboardingProgress();
  const { startStep } = useWalkthroughActivation();

  const closeRef = useRef<(() => void) | null>(null);
  // Distinguishes "the user is done with onboarding" (Skip / X / Escape, which persists a
  // dismissal) from "the user clicked a step and we are getting out of the way" (which
  // must not). Both routes end at BaseDialog's single onClose.
  const dismissOnCloseRef = useRef(true);

  const projectId = currentProject?.id ?? null;
  const defaultAgent = currentProject?.default_agent ?? null;
  const defaultModel = currentProject?.default_model ?? null;
  const defaultEffort = currentProject?.default_effort ?? null;

  // Projects that predate this feature have no baseline, and the title-bar button can open
  // the checklist on any of them. Capture one on first open so steps 1 and 2 start honest
  // and tick on the next real change. captureOnboardingBaseline is first-write-wins, so
  // reopening never re-baselines away progress the user already made.
  useEffect(() => {
    if (!projectId || defaultAgent === null || swimlanes.length === 0) return;
    captureOnboardingBaseline(projectId, {
      defaultAgent,
      defaultModel,
      defaultEffort,
      permissionMode,
      swimlaneSignature: buildSwimlaneSignature(swimlanes),
    });
  }, [projectId, defaultAgent, defaultModel, defaultEffort, permissionMode, swimlanes, captureOnboardingBaseline]);

  if (!currentProject || !projectId) return null;

  // Typed on OnboardingStepKey, not `string`: adding a step to the union then fails the
  // build here instead of silently rendering a checkbox that can never tick.
  const stepDone: Record<OnboardingStepKey, boolean> = {
    defaultsChosen: progress.defaultsChosen,
    boardShaped: progress.boardShaped,
    taskCreated: progress.taskCreated,
    draggedToAutoSpawnLane: progress.draggedToAutoSpawnLane,
    taskDetailOpened: progress.taskDetailOpened,
  };

  const handleClose = () => {
    if (dismissOnCloseRef.current) {
      // A real dismissal (Skip / X / Escape / backdrop). Any spotlight still on screen was
      // started from this list, so it goes too. A step click takes the other branch and
      // leaves its spotlight running on the surface it just opened.
      markProjectOnboarded(projectId);
      setWalkthroughStep(null);
    }
    setOnboardingChecklistOpen(false);
  };

  const handleStepClick = (stepKey: string) => {
    const step = WALKTHROUGH_STEPS.find((candidate) => candidate.key === stepKey);
    if (!step) return;
    // `startStep` records WHICH STEP THE USER IS ON, not "a spotlight is showing" - the layer
    // decides that for itself by whether a target resolves. It is also what AppLayout keys
    // the return-to-checklist on, so tying it to the spotlight meant the redirect-only steps
    // (Settings, Board manager) never came back.
    startStep(step);
    // Step through, not away: getting out of the checklist's own way is not a dismissal.
    dismissOnCloseRef.current = false;
    closeRef.current?.();
  };

  // Three states, because one label cannot honestly cover them. "Next step" on a list where
  // nothing has been done yet names a place the user has not been.
  const primaryLabel = progress.complete
    ? 'Done'
    : progress.doneCount === 0 ? 'Start' : 'Next step';

  const handlePrimaryClick = () => {
    const next = resolveNextStep(stepDone, null);
    // Nothing left: the list is the celebration, and closing it is a real dismissal so the
    // project is marked onboarded and it stops coming back.
    if (!next) {
      closeRef.current?.();
      return;
    }
    handleStepClick(next.key);
  };

  return (
    <BaseDialog
      onClose={handleClose}
      closeRef={closeRef}
      className="w-[420px]"
      backdropPositionClass="left-0 right-0 top-10 bottom-9"
      testId="onboarding-checklist"
      trapFocus
      header={null}
      rawBody
    >
      <div className="px-5 pt-5 pb-4">
        {/* Centered by a flex wrapper, not `mx-auto`: the branding package styles
            `.overseer` as `display: inline-block`, and auto margins do nothing on an
            inline-level box. (WelcomeScreen gets away with mx-auto only because an
            ancestor sets text-center.) */}
        <div className="flex justify-center mb-4">
          <OverseerMascot scale={5} intro="wave-once" sequence="blink-loop" />
        </div>
        <div className="text-center mb-5">
          <h2 className="text-base font-medium text-fg">Welcome to Kangentic</h2>
          <p className="text-sm text-fg-muted mt-1">
            Five steps to your first agent run. Take them in any order.
          </p>
        </div>

        <ul className="space-y-1">
          {WALKTHROUGH_STEPS.map((step, index) => {
            const done = stepDone[step.key];
            return (
              <li key={step.key}>
                <button
                  type="button"
                  onClick={() => handleStepClick(step.key)}
                  // Explicit focus ring. Chromium's default `outline: auto` takes its colour
                  // from the OS accent, which on an orange-accented Windows reads as a
                  // warning badge sitting on the row the user just completed. Same treatment
                  // as the welcome screen's project rows.
                  className="w-full flex items-start gap-3 px-2 py-2 rounded-lg text-left hover:bg-surface-hover cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  data-testid={`onboarding-step-${step.key}`}
                  // Per-row done state, separate from the "N of 5" total: the counter comes
                  // straight from the derivation, so it would read correct even if a row
                  // were wired to the wrong field or to nothing at all.
                  data-done={done}
                >
                  {/* Accent, not `active`. The green `--kng-active` means "an agent is
                      working" everywhere else in the app; reusing it for a ticked checkbox
                      conflates two states. Accent is the theme's own colour, so a user who
                      switches theme mid-walkthrough sees the ticks follow. */}
                  <span
                    className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center mt-0.5 ${
                      done ? 'bg-accent/15 text-accent' : 'bg-surface-hover text-fg-faint'
                    }`}
                    aria-hidden="true"
                  >
                    {done ? <Check size={12} /> : <span className="text-[11px] font-medium">{index + 1}</span>}
                  </span>
                  <span className="flex-1 min-w-0">
                    {/* No per-step glyph. The numbered badge already carries the visual, and a
                        second icon beside every label was decoration that made five short rows
                        read as a denser list than they are. */}
                    <span className={`block text-sm font-medium ${done ? 'text-fg-muted' : 'text-fg'}`}>
                      {resolveStepLabel(step, swimlanes)}
                    </span>
                    {/* text-sm, not text-xs: ui-conventions.md puts descriptions and hints at
                        14px or larger, and this is the first copy a brand-new user reads. */}
                    <span className="block text-sm text-fg-muted mt-0.5 leading-relaxed">
                      {step.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-3 mt-5 pt-4 border-t border-edge/50">
          <span className="text-xs text-fg-faint" data-testid="onboarding-progress">
            {progress.doneCount} of {ONBOARDING_STEP_COUNT} done
          </span>
          {/* A primary action, so the way forward is never something to hunt for in the list.
              It starts the next unfinished step directly; the rows stay clickable for anyone
              who wants to jump around. Once everything is done there is nothing to go to, so
              the pair collapses to a single Done. */}
          <div className="flex items-center gap-2">
            {!progress.complete && (
              <button
                type="button"
                onClick={() => closeRef.current?.()}
                className="px-3 py-1.5 text-sm font-medium rounded text-fg-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                data-testid="onboarding-skip"
              >
                Skip for now
              </button>
            )}
            <button
              type="button"
              onClick={handlePrimaryClick}
              className="px-3 py-1.5 text-sm font-medium rounded bg-accent-emphasis hover:bg-accent text-accent-on cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              data-testid="onboarding-primary"
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </BaseDialog>
  );
}
