import { useMemo } from 'react';
import { useConfigStore } from '../stores/config-store';
import { useBoardStore } from '../stores/board-store';
import { useProjectStore } from '../stores/project-store';
import type { OnboardingBaseline, OnboardingStepKey, PermissionMode, Swimlane, Task } from '../../shared/types';

export type { OnboardingStepKey } from '../../shared/types';

export interface OnboardingProgress {
  defaultsChosen: boolean;
  boardShaped: boolean;
  taskCreated: boolean;
  draggedToAutoSpawnLane: boolean;
  taskDetailOpened: boolean;
  doneCount: number;
  complete: boolean;
}

/** The live values step 1 watches. Flattened from two stores - three are columns on the
 *  project row, `permissionMode` is global config. */
export interface OnboardingDefaults {
  defaultAgent: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  permissionMode: PermissionMode;
}

export const ONBOARDING_STEP_COUNT = 5;

/**
 * Stable description of the board's shape, used to tell "the user shaped their board"
 * from "the board is still the seed".
 *
 * Lanes are read in position order and their IDS are emitted, but the numeric `position`
 * deliberately is NOT: positions get renumbered by board writes that collapse gaps, which
 * would flip the signature with no user edit behind it. The id sequence captures reordering
 * exactly, and a reorder the user undoes restores the original sequence.
 *
 * Ghost and archived lanes are excluded - neither is something the user shaped.
 *
 * Fields and lanes are joined with the ASCII unit/record separators rather than nothing,
 * so adjacent values cannot run together and forge a match (a lane named "Ab" with color
 * "c" would otherwise hash the same as one named "A" with color "bc"). They are control
 * characters no column name can contain.
 */
const FIELD_SEPARATOR = String.fromCharCode(0x1f);
const LANE_SEPARATOR = String.fromCharCode(0x1e);

export function buildSwimlaneSignature(swimlanes: Swimlane[]): string {
  return swimlanes
    .filter((lane) => !lane.is_ghost && !lane.is_archived)
    .slice()
    .sort((first, second) => first.position - second.position)
    .map((lane) => [
      lane.id,
      lane.name,
      lane.color,
      lane.icon ?? '',
      lane.description ?? '',
      lane.auto_spawn ? '1' : '0',
      lane.auto_command ?? '',
      lane.permission_mode ?? '',
      lane.agent_override ?? '',
      lane.model_override ?? '',
      lane.effort_override ?? '',
    ].join(FIELD_SEPARATOR))
    .join(LANE_SEPARATOR);
}

/**
 * The lane step 4 asks the user to drag into, and whose live name the copy renders.
 *
 * Resolved from behavior, never from the literal name "Planning". The seeded Planning
 * column carries `role: null` and is renameable in Board manager - which step 2 actively
 * invites - so a name lookup would break for exactly the users who followed our own
 * instructions. Prefers the plan-mode lane (the seeded Planning) and falls back to the
 * first lane that starts an agent at all.
 */
export function resolveAutoSpawnLane(swimlanes: Swimlane[]): Swimlane | null {
  const candidates = swimlanes
    .filter((lane) => lane.auto_spawn && !lane.is_ghost && !lane.is_archived)
    .slice()
    .sort((first, second) => first.position - second.position);
  return candidates.find((lane) => lane.permission_mode === 'plan') ?? candidates[0] ?? null;
}

/**
 * Pure derivation of the five-step onboarding checklist. No timers, and no "you opened
 * the screen" signals: steps 1 and 2 compare live state against the baseline captured
 * when the project was added, so closing a settings screen unchanged ticks nothing.
 *
 * Exported (not hook-private) so it can be unit-tested without rendering React or a store.
 *
 * A missing baseline reads as "not yet configured" (both false) rather than complete.
 * The caller captures one on first checklist open, so this state is transient - but it
 * must not present as finished work the user never did.
 *
 * `completedSteps` is the second source every step accepts, OR-ed with the derived signal.
 * It carries the things the board and settings cannot evidence: a task detail the user
 * opened and then closed, and any step ticked off with the walkthrough's "Next step". The
 * checklist is a demonstration of how the app works, not a gate, so a user who would rather
 * read than do can walk it end to end. Passing it in keeps this function pure and testable.
 */
export function deriveOnboardingProgress(
  tasks: Task[],
  swimlanes: Swimlane[],
  baseline: OnboardingBaseline | undefined,
  currentDefaults: OnboardingDefaults | null,
  completedSteps: ReadonlySet<OnboardingStepKey> = new Set(),
): OnboardingProgress {
  const defaultsChosen = completedSteps.has('defaultsChosen') || (
    baseline !== undefined && currentDefaults !== null && (
      currentDefaults.defaultAgent !== baseline.defaultAgent
      || currentDefaults.defaultModel !== baseline.defaultModel
      || currentDefaults.defaultEffort !== baseline.defaultEffort
      || currentDefaults.permissionMode !== baseline.permissionMode
    )
  );

  const boardShaped = completedSteps.has('boardShaped') || (
    baseline !== undefined
    && swimlanes.length > 0
    && buildSwimlaneSignature(swimlanes) !== baseline.swimlaneSignature
  );

  const taskCreated = completedSteps.has('taskCreated') || tasks.length > 0;

  const autoSpawnLaneIds = new Set(
    swimlanes.filter((lane) => lane.auto_spawn).map((lane) => lane.id),
  );
  const draggedToAutoSpawnLane = completedSteps.has('draggedToAutoSpawnLane')
    || tasks.some((task) => autoSpawnLaneIds.has(task.swimlane_id));

  // No derived counterpart: an open window is a live signal, so the record IS the signal.
  const taskDetailOpened = completedSteps.has('taskDetailOpened');

  const doneCount = [defaultsChosen, boardShaped, taskCreated, draggedToAutoSpawnLane, taskDetailOpened]
    .filter(Boolean).length;

  return {
    defaultsChosen,
    boardShaped,
    taskCreated,
    draggedToAutoSpawnLane,
    taskDetailOpened,
    doneCount,
    complete: doneCount === ONBOARDING_STEP_COUNT,
  };
}

/** Board state is already scoped to the current project, so no project id is needed for
 *  steps 3 to 5. Steps 1 and 2 read the current project's row plus global config. */
export function useOnboardingProgress(): OnboardingProgress {
  const tasks = useBoardStore((state) => state.tasks);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const currentProject = useProjectStore((state) => state.currentProject);
  const permissionMode = useConfigStore((state) => state.config.agent.permissionMode);
  const baselines = useConfigStore((state) => state.config.onboardingBaseline);
  // Steps recorded rather than derived: AppLayout stamps `taskDetailOpened` when a task
  // detail window appears (reading that live would un-tick the step the moment the user
  // closed the window), and the walkthrough stamps whichever step "Next step" was pressed on.
  const stepsCompletedByProject = useConfigStore((state) => state.onboardingStepsCompleted);
  const completedSteps = useMemo(
    () => new Set(currentProject ? stepsCompletedByProject[currentProject.id] ?? [] : []),
    [stepsCompletedByProject, currentProject],
  );

  // Memoized, and returning a stable object identity: `WalkthroughLayer` is mounted for the
  // whole session and subscribes to `tasks` and `swimlanes`, so without this the derivation
  // (which sorts and string-joins every lane via buildSwimlaneSignature) re-ran on every board
  // tick. A fresh object each render also kept AppLayout's return-to-checklist effect, which
  // lists this value as a dependency, from ever settling.
  return useMemo(() => {
    const currentDefaults: OnboardingDefaults | null = currentProject
      ? {
          defaultAgent: currentProject.default_agent,
          defaultModel: currentProject.default_model,
          defaultEffort: currentProject.default_effort,
          permissionMode,
        }
      : null;

    return deriveOnboardingProgress(
      tasks,
      swimlanes,
      currentProject ? baselines?.[currentProject.id] : undefined,
      currentDefaults,
      completedSteps,
    );
  }, [tasks, swimlanes, currentProject, permissionMode, baselines, completedSteps]);
}
