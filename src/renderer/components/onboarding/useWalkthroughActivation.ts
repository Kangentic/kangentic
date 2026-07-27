import { useCallback } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import type { WalkthroughStepDefinition } from './walkthrough-steps';

/**
 * Starting a walkthrough step, shared by the checklist and the coach mark.
 *
 * Both need the same two things: leave whatever the previous step put on screen, then open
 * what this one needs. Keeping it in one place is what lets "Next step" go straight from one
 * step to the next instead of bouncing the user back through the checklist to pick manually.
 */
export function useWalkthroughActivation(): {
  startStep: (step: WalkthroughStepDefinition) => void;
  closeStepSurfaces: () => void;
} {
  const setWalkthroughStep = useConfigStore((state) => state.setWalkthroughStep);
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  const openBoardManager = useBoardStore((state) => state.openBoardManager);
  const closeBoardManager = useBoardStore((state) => state.closeBoardManager);
  const requestNewTask = useBoardStore((state) => state.requestNewTask);
  const dismissNewTask = useBoardStore((state) => state.dismissNewTask);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const currentProject = useProjectStore((state) => state.currentProject);

  const projectPath = currentProject?.path ?? null;
  const projectName = currentProject?.name ?? null;

  /** Clear every surface a step can open. Each call is a no-op when nothing is open. */
  const closeStepSurfaces = useCallback(() => {
    setSettingsOpen(false);
    closeBoardManager();
    dismissNewTask();
  }, [setSettingsOpen, closeBoardManager, dismissNewTask]);

  const startStep = useCallback((step: WalkthroughStepDefinition) => {
    closeStepSurfaces();
    setWalkthroughStep(step.key);
    step.activate({
      openBoardManager,
      requestNewTask,
      swimlanes,
      openProjectSettings: (tabId) => {
        if (!projectPath || !projectName) return;
        // Always close-then-reopen on the next frame. SettingsPanel picks its tab in a
        // mount-time initializer and its re-apply effect is keyed on the project path rather
        // than the tab, so asking an ALREADY-OPEN panel for a different tab silently does
        // nothing. Unconditional because `closeStepSurfaces` above has just queued a close:
        // opening again in the same tick would keep the panel mounted and land on the wrong
        // tab, and branching on the pre-close value only moves the race around.
        requestAnimationFrame(() => openProjectSettings(projectPath, projectName, tabId));
      },
    });
  }, [
    closeStepSurfaces, setWalkthroughStep, openBoardManager, requestNewTask, swimlanes,
    openProjectSettings, projectPath, projectName,
  ]);

  return { startStep, closeStepSurfaces };
}
