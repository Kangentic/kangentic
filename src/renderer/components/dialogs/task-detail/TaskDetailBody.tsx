import { Suspense, lazy, useRef } from 'react';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import { TerminalTab } from '../../terminal/TerminalTab';
import { ContextBar } from '../../terminal/ContextBar';
import { PreSpawnContextBar } from '../../terminal/PreSpawnContextBar';
import { LaunchOverlay } from '../../LaunchOverlay';
import { SessionSummaryPanel } from '../SessionSummaryPanel';
import { BrowserPane } from '../../browser/BrowserPane';
import { PriorityBadge } from '../../backlog/PriorityBadge';
import { LabelPills } from '../../Pill';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import { QueuedPlaceholder } from './QueuedPlaceholder';
import { AttachmentThumbnails } from './AttachmentThumbnails';
import type { AttachmentWithPreview } from './useAttachments';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { Task, SessionDisplayState } from '../../../../shared/types';
import { useSessionStore } from '../../../stores/session-store';
import { useTaskSplitResize } from '../../../hooks/useTaskSplitResize';
import { PanelErrorBoundary } from '../../PanelErrorBoundary';

const ChangesPanel = lazy(() => import('./changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

interface TaskDetailBodyProps {
  task: Task;
  /** Whether this task window is the focused one (gates Changes keyboard nav). */
  isFocused: boolean;
  isArchived: boolean;
  isInTodo: boolean;
  hasSessionContext: boolean;
  sessionId: string | null;
  displayKind: SessionDisplayState['kind'];
  isSuspended: boolean;
  toggling: boolean;
  pendingAction: null | 'pausing' | 'resuming';
  pendingCommandLabel: string | null;
  savedAttachments: AttachmentWithPreview[];
  handlePreview: (attachment: AttachmentWithPreview) => void;
  handleOpenExternal: (attachment: AttachmentWithPreview) => void;
  removeAttachment: (id: string) => void;
  handleToggle: () => void;
  changesOpen: boolean;
  projectPath: string;
  resumeFailed?: boolean;
  resumeError?: string;
  onResetSession?: () => void;
  browserOpen: boolean;
}

export function TaskDetailBody({
  task,
  isFocused,
  isArchived,
  isInTodo,
  hasSessionContext,
  sessionId,
  displayKind,
  isSuspended,
  toggling,
  pendingAction,
  pendingCommandLabel,
  savedAttachments,
  handlePreview,
  handleOpenExternal,
  removeAttachment,
  handleToggle,
  changesOpen,
  projectPath,
  resumeFailed,
  resumeError,
  onResetSession,
  browserOpen,
}: TaskDetailBodyProps) {
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  // Default-agent tasks leave `task.agent` null; fall back to the project's
  // default agent so the ContextBar picker can resolve capabilities (mirrors
  // CommandBarOverlay). Non-null `task.agent` wins inside ContextBar.
  const projectDefaultAgent = useProjectStore((state) => state.currentProject?.default_agent ?? null);
  const changesViewMode = useSessionStore((state) => state.changesViewMode[task.id] ?? 'split');
  const setChangesViewMode = useSessionStore((state) => state.setChangesViewMode);
  // Spawn-progress label ("Creating worktree...", etc.) for the pre-session
  // launch overlay. Present whenever displayKind is 'preparing'.
  const spawnLabel = useSessionStore((state) => state.spawnProgress[task.id] ?? null);
  // Draggable terminal / right-panel split. One shared ratio per task across
  // both the Browser and Changes views, so switching tabs never moves it.
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const { ratio: splitRatio, isResizing: isSplitResizing, onResizeStart: onSplitResizeStart } =
    useTaskSplitResize(task.id, splitContainerRef);
  // The right panel (Changes diff / Browser) opens and closes instantly, like a
  // split pane in VS Code / JetBrains. Opening it reflows the split - the
  // terminal resizes and re-fits its canvas - and an entrance animation only
  // drew the eye to that unavoidable repaint (it read as a "flash"), so there is
  // none. The two panels are mutually exclusive: this is just which one (if any)
  // is showing.
  const rightPanelPresent = changesOpen || browserOpen;
  const showBrowser = browserOpen;
  const changesPresent = rightPanelPresent && !showBrowser;
  const changesExpanded = changesPresent && changesViewMode === 'expanded';
  const handleChangesExpand = () => setChangesViewMode(task.id, 'expanded');
  const handleChangesCollapse = () => setChangesViewMode(task.id, 'split');
  const taskLabels = task.labels ?? [];
  const taskPriority = task.priority ?? 0;
  const hasLabelsOrPriority = taskPriority > 0 || taskLabels.length > 0;

  const labelsAndPriorityRow = hasLabelsOrPriority && (
    <div className="flex flex-wrap items-center gap-1.5">
      <PriorityBadge priority={taskPriority} />
      <LabelPills labels={taskLabels} labelColors={labelColors} />
    </div>
  );

  const thumbnailStrip = (
    <AttachmentThumbnails
      attachments={savedAttachments}
      isEditing={false}
      onPreview={handlePreview}
      onOpenExternal={handleOpenExternal}
      onRemove={removeAttachment}
    />
  );

  // Description view mode with attachment thumbnails (non-archived, non-session)
  const descriptionBar = !isArchived && (task.description || savedAttachments.length > 0 || hasLabelsOrPriority) && !hasSessionContext && (
    <div className="px-4 py-3 border-b border-edge flex-shrink-0 space-y-2">
      {task.description && (
        <MarkdownRenderer content={task.description} />
      )}
      {labelsAndPriorityRow}
      {thumbnailStrip}
    </div>
  );

  // Archived task: description + attachments as scrollable body, summary bar as footer
  if (isArchived) {
    return (
      <>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {(task.description || savedAttachments.length > 0 || hasLabelsOrPriority) ? (
            <div className="px-4 py-4 space-y-3 max-h-[40vh] overflow-y-auto">
              {task.description && (
                <MarkdownRenderer content={task.description} />
              )}
              {labelsAndPriorityRow}
              {thumbnailStrip}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm p-8 h-full">
              No description
            </div>
          )}
          <SessionSummaryPanel taskId={task.id} />
        </div>
      </>
    );
  }

  const changesContent = (
    <PanelErrorBoundary label="Changes panel">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        }
      >
        <ChangesPanel
          entityId={task.id}
          isFocused={isFocused}
          scrollKey={task.id}
          projectPath={projectPath}
          worktreePath={task.worktree_path ?? undefined}
          baseBranch={task.base_branch || defaultBaseBranch || 'main'}
          panelMode={changesViewMode}
          onExpand={handleChangesExpand}
          onCollapse={handleChangesCollapse}
        />
      </Suspense>
    </PanelErrorBoundary>
  );

  // The diff panel for the suspended / changes-only layouts (never the Browser
  // pane, which needs an active session). Shown instantly with no reveal
  // animation; the parent's overflow-hidden keeps it within the dialog edge.
  const changesPanelElement = changesPresent && (
    <div className={`flex-1 min-h-0 min-w-0 overflow-hidden ${changesExpanded ? '' : 'border-l border-edge'}`}>
      <div className="h-full">
        {changesContent}
      </div>
    </div>
  );

  // Active terminal session
  if (sessionId && displayKind !== 'queued' && displayKind !== 'suspended') {
    // Browser pane and changes panel are mutually exclusive; when either shares
    // the row with the terminal, a draggable divider sets the per-task split.
    const showDivider = rightPanelPresent && !changesExpanded;
    // Browser pane (active-session only) or the diff panel - mutually exclusive,
    // shown instantly with no reveal animation.
    const rightPanelElement = rightPanelPresent && (
      <div className={`flex-1 min-h-0 min-w-0 overflow-hidden ${changesExpanded ? '' : 'border-l border-edge'}`}>
        <div className="h-full">
          {showBrowser ? (
            <BrowserPane
              sessionId={sessionId}
              taskId={task.id}
              cwd={task.worktree_path ?? projectPath}
            />
          ) : (
            changesContent
          )}
        </div>
      </div>
    );

    return (
      <>
        {descriptionBar}
        <div ref={splitContainerRef} className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div
              className={`${rightPanelPresent ? 'flex-shrink-0 flex-grow-0' : 'flex-1'} min-h-0 relative overflow-hidden`}
              style={rightPanelPresent ? { flexBasis: `${splitRatio * 100}%` } : undefined}
            >
              <div className="absolute inset-0">
                <TerminalTab
                  key={sessionId}
                  sessionId={sessionId}
                  taskId={task.id}
                  active={true}
                  releaseEscapeWhenPointerOutside={true}
                  // The task-detail surface is window-hosted: refit immediately on
                  // the window's resize/snap/maximize/divider dispatch (no 50ms lag).
                  immediatePanelResize={true}
                />
              </div>
            </div>
          )}
          {showDivider && (
            <div
              onMouseDown={onSplitResizeStart}
              data-testid="task-detail-split-divider"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              className="group relative z-10 w-1 -mx-0.5 flex-shrink-0 cursor-col-resize"
            >
              {/* Widened invisible hit zone for easier grabbing. */}
              <span className="absolute inset-y-0 -inset-x-1" />
              {/* Resting seam is the panel's border-edge. Highlight on hover, and
                  hold the highlight through the whole drag so the target split
                  stays visible while the panes resize underneath. */}
              <span
                className={`absolute inset-0 transition-colors ${
                  isSplitResizing ? 'bg-accent/60' : 'group-hover:bg-accent/40'
                }`}
              />
            </div>
          )}
          {rightPanelElement}
          {/* While dragging, an overlay keeps mouse events flowing over the
              Electron <webview> (Browser pane) and the xterm canvas. */}
          {isSplitResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
        </div>
        <ContextBar sessionId={sessionId} agentFallback={projectDefaultAgent} />
      </>
    );
  }

  // Queued
  if (displayKind === 'queued') {
    return <QueuedPlaceholder sessionId={sessionId} />;
  }

  // Launching (preparing): worktree creation / CLI boot before the session
  // exists. The terminal area is otherwise blank here, so mirror the board
  // card's launch treatment - a centered muted spinner + the spawn status
  // label - and keep PreSpawnContextBar pinned at the bottom.
  if (displayKind === 'preparing') {
    return (
      <>
        {descriptionBar}
        <div className="flex-1 min-h-0 relative">
          <LaunchOverlay label={spawnLabel ?? 'Starting agent...'} />
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Suspended or toggling
  if ((isSuspended || toggling) && !isArchived && !isInTodo) {
    if (pendingCommandLabel) {
      return (
        <>
          <div className="flex-1 min-h-0 flex">
            {!changesExpanded && (
              <div className={`${changesPresent ? 'w-1/2' : 'flex-1'} min-h-0 relative`}>
                <LaunchOverlay label={pendingCommandLabel} />
              </div>
            )}
            {changesPanelElement}
          </div>
          <PreSpawnContextBar taskId={task.id} />
        </>
      );
    }
    // When not toggling, we're in this branch only because isSuspended is true,
    // so the resting state is always "Resume session" with a Play icon. While
    // toggling, the direction depends on the current session status.
    const toggleIcon = toggling
      ? <Loader2 size={16} className="animate-spin" />
      : <Play size={16} />;
    const toggleLabel = !toggling
      ? 'Resume session'
      : pendingAction === 'pausing'
        ? 'Pausing agent...'
        : 'Resuming agent...';
    return (
      <>
        <div className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div className={`${changesPresent ? 'w-1/2' : 'flex-1'} flex flex-col items-center justify-center gap-3 bg-surface/50`}>
              <button
                onClick={handleToggle}
                disabled={toggling}
                className="flex items-center gap-2.5 px-6 py-3 rounded-lg bg-accent/20 border border-accent/40 text-base text-accent-fg hover:bg-accent/30 transition-colors disabled:opacity-50"
              >
                {toggleIcon}
                {toggleLabel}
              </button>
              {resumeFailed && onResetSession && (
                <div className="flex flex-col items-center gap-2 mt-1">
                  <p className="text-xs text-fg-muted text-center max-w-sm">
                    {resumeError || 'Session could not be resumed.'}
                  </p>
                  <button
                    onClick={onResetSession}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-surface-hover border border-edge-input transition-colors"
                  >
                    <RotateCcw size={14} />
                    Reset session
                  </button>
                </div>
              )}
            </div>
          )}
          {changesPanelElement}
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Changes-only view (no session but changes panel open). Uses changesPresent
  // (not changesOpen) for parity with the active-session branches above; the
  // panel shows and hides instantly, with no exit animation (see top of render).
  if (changesPresent) {
    return (
      <>
        <div className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div className="w-1/2 min-h-0 overflow-y-auto">
              {task.description ? (
                <div className="px-4 py-4 space-y-2">
                  <MarkdownRenderer content={task.description} />
                  {labelsAndPriorityRow}
                  {thumbnailStrip}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-fg-disabled text-sm p-8">
                  No active session
                </div>
              )}
            </div>
          )}
          {changesPanelElement}
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Empty state
  if (!task.description && savedAttachments.length === 0) {
    return (
      <>
        <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm p-8">
          No active session. Drag this task to a column with a transition to start one.
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Description-only view (no session) and the transient pre-spawn window
  // where hasSessionContext is true but session.id has not arrived yet.
  // The flex-1 spacer keeps PreSpawnContextBar pinned to the bottom in both
  // cases so it never flashes at the top of the dialog while spawning.
  return (
    <>
      {descriptionBar}
      <div className="flex-1" />
      <PreSpawnContextBar taskId={task.id} />
    </>
  );
}
