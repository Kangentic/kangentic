import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
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
  const { t } = useLingui();
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
      const projectName = result.project.name;
      const projectPath = result.project.path;
      useToastStore.getState().addToast({
        title: t`Project moved`,
        message: t`"${projectName}" is now at ${projectPath}.`,
        variant: 'success',
      });
      if (result.warnings.includes('source-delete-failed')) {
        const originalPath = project.path;
        useToastStore.getState().addToast({
          title: t`Old folder not removed`,
          message: t`The original copy remains at ${originalPath}.`,
          variant: 'warning',
        });
      }
      onRelocated?.(result.project);
    } catch (err) {
      useToastStore.getState().addToast({
        title: t`Couldn't move project`,
        message: asSentence(describeIpcError(err)),
        variant: 'error',
      });
    } finally {
      unsubscribe();
      setIsMoving(false);
      setMoveProgress(null);
    }
  }, [pendingMove, relocateProject, onRelocated, t]);

  const activeSessions = pendingMove
    ? sessions.filter(
        (session) =>
          session.projectId === pendingMove.project.id &&
          (session.status === 'running' || session.status === 'queued'),
      )
    : [];

  const sessionLabel = useCallback(
    (session: (typeof sessions)[number]): string => {
      if (session.workflowId) return t`Workflow agent`;
      if (session.transient) return t`Command terminal`;
      const task = tasks.find((candidate) => candidate.id === session.taskId);
      return task ? task.title : session.taskId.slice(0, 8);
    },
    [tasks, t],
  );

  const copiedEntries = moveProgress?.copiedEntries ?? 0;
  const totalEntries = moveProgress?.totalEntries ?? 0;
  const progressCard = isMoving ? (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-surface border border-edge rounded-lg shadow-lg"
      data-testid="project-move-progress"
    >
      <Loader2 size={16} className="animate-spin text-fg-muted" />
      <span className="text-sm text-fg">
        {moveProgress && moveProgress.phase === 'copying' ? (
          <Trans>
            Copying <span className="tabular-nums">{copiedEntries}</span> of{' '}
            <span className="tabular-nums">{totalEntries}</span>...
          </Trans>
        ) : (
          <Trans>Moving project folder...</Trans>
        )}
      </span>
    </div>
  ) : null;

  const pendingProjectName = pendingMove?.project.name ?? '';
  const relocationDialog = (
    <>
      {pendingMove ? (
        <ConfirmDialog
          title={t`Move Project Folder`}
          variant="warning"
          message={
            <div className="space-y-2" data-testid="project-move-dialog">
              <p>
                <Trans>Move <strong>&quot;{pendingProjectName}&quot;</strong> to a new folder?</Trans>
              </p>
              <p className="text-xs break-all">
                <span className="text-fg-faint"><Trans>From:</Trans>{' '}</span>
                {pendingMove.project.path}
              </p>
              <p className="text-xs break-all">
                <span className="text-fg-faint"><Trans>To:</Trans>{' '}</span>
                {pendingMove.newPath}
              </p>
              <p>
                <Trans>
                  Kangentic will move the folder on disk. All tasks, history, and worktrees move
                  with it.
                </Trans>
              </p>
              {activeSessions.length > 0 ? (
                <div className="space-y-1">
                  <p><Trans>These active agent sessions will be stopped and resumed automatically at the new location:</Trans></p>
                  <ul className="list-disc list-inside text-xs text-fg-muted" data-testid="project-move-active-sessions">
                    {activeSessions.map((session) => (
                      <li key={session.id} className="break-all">
                        {sessionLabel(session)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-fg-muted"><Trans>No active agent sessions.</Trans></p>
              )}
            </div>
          }
          confirmLabel={t`Move Folder`}
          onConfirm={handleConfirm}
          onCancel={() => setPendingMove(null)}
        />
      ) : null}
      {progressCard}
    </>
  );

  return { requestMove, relocationDialog };
}
