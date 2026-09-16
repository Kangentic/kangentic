import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Shown when a registered project's folder no longer exists on disk (moved
 * or renamed outside Kangentic). Driven by `missingPathProject` in the
 * project store, which is set on a failed open and by the startup
 * PROJECT_PATH_MISSING push. "Locate Folder..." re-points the project so
 * all tasks and history (keyed by project id) are preserved.
 *
 * Mounted in AppLayout so it appears regardless of sidebar state.
 */
export function ProjectPathMissingDialog() {
  const missingPathProject = useProjectStore((state) => state.missingPathProject);
  const setMissingPathProject = useProjectStore((state) => state.setMissingPathProject);
  const relocateProject = useProjectStore((state) => state.relocateProject);
  const openProject = useProjectStore((state) => state.openProject);

  if (!missingPathProject) return null;
  const project = missingPathProject;

  const handleLocate = async () => {
    const selectedPath = await window.electronAPI.dialog.selectFolder();
    if (!selectedPath) return; // picker cancelled: keep the dialog open
    try {
      // Repoint mode (the default): the folder was moved outside Kangentic and
      // the user is pointing us at where it now lives.
      const { project: updated } = await relocateProject(project.id, selectedPath);
      // relocateProject only re-opens the current project; at startup (or
      // when the failed open never completed) nothing is current yet.
      let reopened = true;
      if (useProjectStore.getState().currentProject?.id !== updated.id) {
        reopened = (await openProject(updated.id)) === 'opened';
      }
      // A failed re-open has already reported itself (a toast, or
      // `missingPathProject` armed again); a success toast here would lie
      // about a switch that did not happen.
      if (reopened) {
        useToastStore.getState().addToast({
          message: `Project "${updated.name}" now points at ${updated.path}`,
          variant: 'success',
        });
      }
    } catch (err) {
      useToastStore.getState().addToast({
        message: err instanceof Error ? err.message : 'Failed to relocate project',
        variant: 'error',
      });
    }
  };

  return (
    <ConfirmDialog
      title="Project Folder Not Found"
      variant="warning"
      message={
        <div className="space-y-2" data-testid="project-path-missing-dialog">
          <p>
            The folder for <strong>&quot;{project.name}&quot;</strong> no longer exists:
          </p>
          <p className="text-xs break-all">{project.path}</p>
          <p>
            If it was moved or renamed, locate the new folder to keep all
            tasks and board history.
          </p>
        </div>
      }
      confirmLabel="Locate Folder..."
      onConfirm={handleLocate}
      onCancel={() => setMissingPathProject(null)}
    />
  );
}
