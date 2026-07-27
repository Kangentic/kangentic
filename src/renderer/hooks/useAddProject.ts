import { useCallback } from 'react';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';

/**
 * Pick a folder and open it as a project, in one step.
 *
 * There is deliberately no confirmation dialog between the folder picker and the board.
 * Everything it used to ask has a better answer than asking:
 *
 * - Git is set up rather than offered. Kangentic runs every task on its own branch in its
 *   own worktree, so a project without git is a broken project; `git init` creates `.git`
 *   and touches nothing else. A folder already covered by a repo (its own or a parent's)
 *   is left alone - see ensureGitRepo, which will not nest a repo inside someone else's.
 * - The name is the folder's own name, and the sidebar renames it in place any time.
 * - The default agent is step 1 of the onboarding walkthrough, which opens on the board
 *   immediately after this. Asking here would ask the same question twice.
 *
 * Re-picking a folder that is already a project just opens it - that is what someone
 * choosing it again is asking for.
 *
 * Failing to set git up never blocks the open. Being unable to run `git init` is a reason
 * to warn, not a reason to lock someone out of their own folder, so the board loads and a
 * toast explains what it costs.
 */
export function useAddProject() {
  const probePath = useProjectStore((state) => state.probePath);
  const ensureGit = useProjectStore((state) => state.ensureGit);
  const openProject = useProjectStore((state) => state.openProject);
  const openProjectByPath = useProjectStore((state) => state.openProjectByPath);

  const startAddProject = useCallback(async () => {
    const selectedPath = await window.electronAPI.dialog.selectFolder({
      title: 'Choose a project folder',
      buttonLabel: 'Choose folder',
      message: 'Pick the folder that holds your code.',
    });
    if (!selectedPath) return;

    // Every await below reports failure with a toast. This runs straight off a click handler,
    // so an unguarded rejection is not merely unlogged - it leaves the button looking broken:
    // nothing opens and nothing explains why.
    let probe;
    try {
      probe = await probePath(selectedPath);
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Could not read that folder. ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
      return;
    }

    if (probe.alreadyRegisteredProjectId) {
      try {
        await openProject(probe.alreadyRegisteredProjectId);
      } catch (error) {
        useToastStore.getState().addToast({
          message: `Could not open that project. ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'error',
        });
      }
      return;
    }

    if (!probe.exists || !probe.isDirectory) {
      useToastStore.getState().addToast({
        message: 'That folder could not be opened. It may have been moved or renamed.',
        variant: 'error',
      });
      return;
    }

    // A rejection here reads the same as a refusal: git could not be set up, which warns but
    // never blocks the open.
    let git;
    try {
      git = await ensureGit(selectedPath);
    } catch {
      git = { ok: false, created: false, error: 'Unknown error' };
    }

    try {
      await openProjectByPath(selectedPath, { name: probe.suggestedName });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Could not add that project. ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
      return;
    }

    // Raised after the open, so it lands on the board the user is now looking at rather
    // than over the folder picker they have already moved on from.
    if (!git.ok) {
      useToastStore.getState().addToast({
        message: 'Could not set up git here. Tasks will share one working tree, and Kangentic cannot keep its own files out of your commits.',
        variant: 'warning',
      });
      return;
    }
    // A repo we just made has no commits, and a worktree needs something to branch from. Say
    // so once, here, rather than letting the first task move be where they find out.
    if (git.created) {
      useToastStore.getState().addToast({
        message: 'Started a git repo in this folder. Make a first commit to give each task its own worktree; until then they share this one.',
        variant: 'info',
      });
    }
  }, [probePath, ensureGit, openProject, openProjectByPath]);

  return { startAddProject };
}
