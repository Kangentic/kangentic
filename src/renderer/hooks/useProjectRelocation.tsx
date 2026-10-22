import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { useBoardStore } from '../stores/board-store';
import { useToastStore } from '../stores/toast-store';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog';
import type { Project, ProjectMoveProgress } from '../../shared/types';
import { asSentence, describeIpcError } from '../lib/ipc-error';

interface PendingMove {
  project: Project;
  newPath: string;
}

/** Last path segment of `projectPath`, tolerant of either separator. */
function projectFolderName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

/** Join a parent dir and child name using the parent's own separator style. */
function joinWithParentSeparator(parentPath: string, childName: string): string {
  const separator = parentPath.includes('\\') ? '\\' : '/';
  return `${parentPath.replace(/[\\/]+$/, '')}${separator}${childName}`;
}

/**
 * One-step "Move..." flow: pick a destination PARENT folder, confirm (the
 * dialog lists the project's active agent sessions, which are stopped and
 * resumed automatically), then Kangentic moves the folder on disk itself and
 * relocates the project. Cross-volume moves fall back to a recursive copy and
 * surface progress in a floating card. Used by the Project settings General
 * tab. The caller renders `relocationDialog` so the dialog and progress card
 * mount in its own subtree.
 *
 * The "Locate Folder..." missing-path dialog (ProjectPathMissingDialog) covers
 * the separate case where the folder was moved outside Kangentic while it was
 * closed; that path uses the relocate endpoint's default repoint mode.
 */
export function useProjectRelocation(onRelocated?: (project: Project) => void) {
  const relocateProject = useProjectStore((state) => state.relocateProject);
  const sessions = useSessionStore((state) => state.sessions);
  const tasks = useBoardStore((state) => state.tasks);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [moveProgress, setMoveProgress] = useState<ProjectMoveProgress | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  const requestMove = useCallback(async (project: Project) => {
    const selectedParent = await window.electronAPI.dialog.selectFolder();
    if (!selectedParent) return; // picker cancelled
    const newPath = joinWithParentSeparator(selectedParent, projectFolderName(project.path));
    setPendingMove({ project, newPath });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!pendingMove) return;
    const { project, newPath } = pendingMove;
    setPendingMove(null);
    setIsMoving(true);
    setMoveProgress(null);
    const unsubscribe = window.electronAPI.projects.onMoveProgress((progress) => {
      if (progress.projectId === project.id) setMoveProgress(progress);
    });
    try {
      const result = await relocateProject(project.id, newPath, { mode: 'move' });
      useToastStore.getState().addToast({
        title: 'Project moved',
        message: `"${result.project.name}" is now at ${result.project.path}.`,
        variant: 'success',
      });
      if (result.warnings.includes('source-delete-failed')) {
        useToastStore.getState().addToast({
          title: 'Old folder not removed',
          message: `The original copy remains at ${project.path}.`,
          variant: 'warning',
        });
      }
      onRelocated?.(result.project);
    } catch (err) {
      useToastStore.getState().addToast({
        title: "Couldn't move project",
        message: asSentence(describeIpcError(err)),
        variant: 'error',
      });
    } finally {
      unsubscribe();
      setIsMoving(false);
      setMoveProgress(null);
    }
  }, [pendingMove, relocateProject, onRelocated]);

  const activeSessions = pendingMove
    ? sessions.filter(
        (session) =>
          session.projectId === pendingMove.project.id &&
          (session.status === 'running' || session.status === 'queued'),
      )
    : [];

  const sessionLabel = useCallback(
    (session: (typeof sessions)[number]): string => {
      if (session.workflowId) return 'Workflow agent';
      if (session.transient) return 'Command terminal';
      const task = tasks.find((candidate) => candidate.id === session.taskId);
      return task ? task.title : session.taskId.slice(0, 8);
    },
    [tasks],
  );

  const progressCard = isMoving ? (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-surface border border-edge rounded-lg shadow-lg"
      data-testid="project-move-progress"
    >
      <Loader2 size={16} className="animate-spin text-fg-muted" />
      <span className="text-sm text-fg">
        {moveProgress && moveProgress.phase === 'copying' ? (
          <>
            Copying <span className="tabular-nums">{moveProgress.copiedEntries}</span> of{' '}
            <span className="tabular-nums">{moveProgress.totalEntries}</span>...
          </>
        ) : (
          'Moving project folder...'
        )}
      </span>
    </div>
  ) : null;

  const relocationDialog = (
    <>
      {pendingMove ? (
        <ConfirmDialog
          title="Move Project Folder"
          variant="warning"
          message={
            <div className="space-y-2" data-testid="project-move-dialog">
              <p>
                Move <strong>&quot;{pendingMove.project.name}&quot;</strong> to a new folder?
              </p>
              <p className="text-xs break-all">
                <span className="text-fg-faint">From: </span>
                {pendingMove.project.path}
              </p>
              <p className="text-xs break-all">
                <span className="text-fg-faint">To: </span>
                {pendingMove.newPath}
              </p>
              <p>
                Kangentic will move the folder on disk. All tasks, history, and worktrees move
                with it.
              </p>
              {activeSessions.length > 0 ? (
                <div className="space-y-1">
                  <p>These active agent sessions will be stopped and resumed automatically at the new location:</p>
                  <ul className="list-disc list-inside text-xs text-fg-muted" data-testid="project-move-active-sessions">
                    {activeSessions.map((session) => (
                      <li key={session.id} className="break-all">
                        {sessionLabel(session)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-fg-muted">No active agent sessions.</p>
              )}
            </div>
          }
          confirmLabel="Move Folder"
          onConfirm={handleConfirm}
          onCancel={() => setPendingMove(null)}
        />
      ) : null}
      {progressCard}
    </>
  );

  return { requestMove, relocationDialog };
}
