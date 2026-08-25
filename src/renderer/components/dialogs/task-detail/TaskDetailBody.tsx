import { Suspense, lazy, useEffect, useRef } from 'react';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import { TerminalTab } from '../../terminal/TerminalTab';
import { ContextBar } from '../../terminal/ContextBar';
import { PreSpawnContextBar } from '../../terminal/PreSpawnContextBar';
import { LaunchOverlay } from '../../LaunchOverlay';
import { SessionSummaryPanel } from '../SessionSummaryPanel';
import { BrowserPane } from '../../browser/BrowserPane';
import { PriorityBadge } from '../../backlog/PriorityBadge';
import { LabelPills } from '../../Pill';
import { useTaskDetailHost } from './task-detail-host';
import { taskDetailSurfaceFor } from '../../../utils/task-progress';
import { QueuedPlaceholder } from './QueuedPlaceholder';
import { taskHasDescriptionContent } from './description-content';
import { AttachmentChipStrip } from '../AttachmentChipStrip';
import { isImageMediaType } from '../attachment-utils';
import type { AttachmentWithPreview } from './useAttachments';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { Task, SessionDisplayState } from '../../../../shared/types';
import { useSessionStore } from '../../../stores/session-store';
import { useIsAgentDrivingSession } from '../../../stores/agent-drive-store';
import { useTaskSplitResize } from '../../../hooks/useTaskSplitResize';
import { PanelErrorBoundary } from '../../PanelErrorBoundary';
import { usePopOut } from '../../../pop-out/usePopOut';
import { onIdle } from '../../../utils/on-idle';

const ChangesPanel = lazy(() => import('./changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

// hmr-safe: reset-on-HMR just re-fires the already-resolved dynamic import below - resolves instantly from the module cache (a no-op unless ChangesPanel's own module graph also changed in the same HMR batch).
let hasWarmedChangesPanel = false;

/** Warm the Changes panel's lazy chunk (and its Monaco module graph) once per
 *  session, off the interaction path, so the first real Changes open never
 *  pays for the synchronous monaco-editor parse/eval on the click. Idle-time
 *  only: never competes with an in-flight task-detail interaction. */
function warmChangesPanelOnIdle(): void {
  if (hasWarmedChangesPanel) return;
  hasWarmedChangesPanel = true;
  onIdle(() => {
    void import('./changes/ChangesPanel');
  });
}

/** Suspense fallback for the lazy ChangesPanel chunk: a two-pane shell
 *  (file rail + diff area) that mirrors the panel's real layout, so a cold
 *  open (chunk not yet warmed) paints instantly instead of a bare spinner
 *  that gives no sense of what's loading. */
function ChangesPanelSkeleton() {
  return (
    <div className="flex h-full" data-testid="changes-panel-skeleton">
      <div className="w-[220px] flex-shrink-0 border-r border-edge p-2 space-y-1.5">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-4 rounded bg-surface-hover animate-pulse" style={{ opacity: 1 - index * 0.1 }} />
        ))}
      </div>
      <div className="flex-1 min-w-0 p-3 space-y-2">
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="h-3.5 rounded bg-surface-hover animate-pulse" style={{ width: `${60 + (index * 13) % 35}%` }} />
        ))}
      </div>
    </div>
  );
}

interface TaskDetailBodyProps {
  task: Task;
  /** Whether this task window is the focused one (gates Changes keyboard nav). */
  isFocused: boolean;
  isArchived: boolean;
  isInTodo: boolean;
  isInDone: boolean;
  hasSessionContext: boolean;
  sessionId: string | null;
  displayKind: SessionDisplayState['kind'];
  isSuspended: boolean;
  toggling: boolean;
  pendingAction: null | 'pausing' | 'resuming';
  pendingCommandLabel: string | null;
  savedAttachments: AttachmentWithPreview[];
  handlePreview: (attachment: AttachmentWithPreview) => void;
  handleOpenExternal: (attachment: AttachmentWithPreview) => Promise<void>;
  handleToggle: () => void;
  changesOpen: boolean;
  projectPath: string;
  resumeFailed?: boolean;
  resumeError?: string;
  onResetSession?: () => void;
  browserOpen: boolean;
  /** Whether the description peek is open (only relevant when hasSessionContext is true). */
  descriptionPeekOpen?: boolean;
  /** The OWNING project's id when this window is retained for a BACKGROUNDED
   *  project: mounted only so its Browser pane's `<webview>` guest survives.
   *  Drops the terminal (an xterm parsing PTY output for a project the user is
   *  not looking at is pure cost) while leaving every surrounding element in
   *  place, and keeps the pane resolving against its OWN project rather than the
   *  open board's, which the host context supplies. */
  retainedProjectId?: string;
}

export function TaskDetailBody({
  task,
  isFocused,
  isArchived,
  isInTodo,
  isInDone,
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
  handleToggle,
  changesOpen,
  projectPath,
  resumeFailed,
  resumeError,
  onResetSession,
  browserOpen,
  descriptionPeekOpen = false,
  retainedProjectId,
}: TaskDetailBodyProps) {
  const retained = retainedProjectId !== undefined;
  // Project-scoped values come from the HOST, never from the open board: this
  // surface can be hosted by the Agent Monitor for a task in another project.
  // Default-agent tasks leave `task.agent` null; falling back to the hosting
  // project's default agent lets the ContextBar picker resolve capabilities
  // (mirrors CommandBarOverlay). Non-null `task.agent` wins inside ContextBar.
  const {
    projectId,
    defaultAgent: projectDefaultAgent,
    config: { labelColors, defaultBaseBranch },
  } = useTaskDetailHost();
  // The pane's project is the TASK's, not the open board's. They differ only for
  // a retained window, whose project is backgrounded while the host context still
  // reports whatever board is now open. Getting this wrong points the task-URL
  // lookup at the wrong project's sidecar, which empties the pane and unmounts
  // the guest retention exists to preserve.
  const paneProjectId = retainedProjectId ?? projectId;
  const browserPopOut = usePopOut('browser', { taskId: task.id, projectId: paneProjectId });
  const changesPopOut = usePopOut('changes', { taskId: task.id, projectId });
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
  // Warm the Changes panel's chunk as soon as a task detail is open, so a later
  // click into Changes resolves the lazy import instantly.
  useEffect(() => {
    warmChangesPanelOnIdle();
  }, []);
  // The right panel (Changes diff / Browser) opens and closes instantly, like a
  // split pane in VS Code / JetBrains. Opening it reflows the split - the
  // terminal resizes and re-fits its canvas - and an entrance animation only
  // drew the eye to that unavoidable repaint (it read as a "flash"), so there is
  // none. The two panels are mutually exclusive: this is just which one (if any)
  // is showing.
  // The right panel is one of three mutually-exclusive views (Browser / Changes
  // / Description peek); opening one closes the others (enforced in the toggle
  // handlers). All three share the same draggable terminal split.
  // Strict mutual exclusivity: while the Browser pane or the Changes view is
  // detached into its own window, the in-app split suppresses that panel (falling
  // back to the other panel or the plain terminal) rather than showing it in two
  // places at once.
  const showBrowser = browserOpen && !browserPopOut.isOpen;
  // Only meaningful while the pane is actually on screen: a drive against a
  // popped-out or closed pane must not dim a terminal the user is working in.
  const agentDrivingBrowser = useIsAgentDrivingSession(sessionId) && showBrowser;
  const showChanges = changesOpen && !showBrowser && !changesPopOut.isOpen;
  const rightPanelPresent = showChanges || showBrowser || descriptionPeekOpen;
  const changesPresent = showChanges;
  const showDescriptionPanel = descriptionPeekOpen && !showBrowser && !showChanges;
  const changesExpanded = changesPresent && changesViewMode === 'expanded';
  const handleChangesExpand = () => setChangesViewMode(task.id, 'expanded');
  const handleChangesCollapse = () => setChangesViewMode(task.id, 'split');
  const taskLabels = task.labels ?? [];
  const taskPriority = task.priority ?? 0;
  const hasLabelsOrPriority = taskPriority > 0 || taskLabels.length > 0;
  // Single source of truth shared with canShowDescription in TaskDetailWindow.
  const hasDescriptionContent = taskHasDescriptionContent(task, savedAttachments.length);

  const labelsAndPriorityRow = hasLabelsOrPriority && (
    <div className="flex flex-wrap items-center gap-1.5">
      <PriorityBadge priority={taskPriority} />
      <LabelPills labels={taskLabels} labelColors={labelColors} />
    </div>
  );

  const attachmentStrip = (
    <AttachmentChipStrip
      attachments={savedAttachments}
      onOpen={(attachment) =>
        isImageMediaType(attachment.media_type) ? handlePreview(attachment) : handleOpenExternal(attachment)
      }
    />
  );

  // The renderable description body shared by the in-body strip, the side-panel
  // peek, and the archived view; only the wrapper chrome differs per site.
  const descriptionContent = (
    <>
      {task.description && (
        <MarkdownRenderer content={task.description} />
      )}
      {labelsAndPriorityRow}
      {attachmentStrip}
    </>
  );

  // Description view mode with the attachment chips - the non-session, in-body
  // view (no terminal to sit beside). During an active session the description
  // instead rides the right-panel split as descriptionPanelContent below.
  const descriptionBar = !isArchived && hasDescriptionContent && !hasSessionContext && (
    <div className="px-4 py-3 border-b border-edge flex-shrink-0 space-y-2">
      {descriptionContent}
    </div>
  );

  // The description peek as a right-panel view (parity with Browser / Changes):
  // a full-height, scrollable sibling of the terminal, resized by the shared
  // split divider. Same content as descriptionBar, without the top-strip chrome.
  const descriptionPanelContent = (
    <div className="h-full overflow-y-auto px-4 py-3 space-y-2" data-testid="task-detail-description-panel">
      {descriptionContent}
    </div>
  );

  // Archived task: description + attachments as scrollable body, summary bar as footer
  if (isArchived) {
    return (
      <>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {hasDescriptionContent ? (
            <div className="px-4 py-4 space-y-3 max-h-[40vh] overflow-y-auto">
              {descriptionContent}
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
      <Suspense fallback={<ChangesPanelSkeleton />}>
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
          task={task}
          popOutParams={projectId ? { taskId: task.id, projectId } : undefined}
          filePopOutParams={projectId ? { taskId: task.id, projectId } : undefined}
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

  // Draggable seam between the main pane (terminal / launch overlay) and the
  // right panel. Shared by the active-terminal and preparing branches.
  const splitDivider = (
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
  );
  // While dragging, an overlay keeps mouse events flowing over the Electron
  // <webview> (Browser pane) and the xterm canvas.
  const resizeCaptureOverlay = isSplitResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />;

  // Active terminal session.
  //
  // Gated on the classifier rather than a chain of `kind !== ...` exclusions: a
  // denylist adopts every kind added later, which is how a restore came to paint
  // the outgoing session's dead terminal once 'preparing' started winning. The
  // table in task-progress.ts is compile-enforced, so a new kind cannot land
  // here by default.
  if (sessionId && taskDetailSurfaceFor(displayKind) === 'terminal') {
    // Browser, Changes, and the Description peek are mutually exclusive; when one
    // shares the row with the terminal, a draggable divider sets the per-task split.
    const showDivider = rightPanelPresent && !changesExpanded;
    // The chosen right panel (Browser / Changes / Description) - shown instantly
    // with no reveal animation.
    const rightPanelElement = rightPanelPresent && (
      <div
        data-testid="task-detail-right-panel"
        className={`flex-1 min-h-0 min-w-0 overflow-hidden transition-colors ${
          changesExpanded ? '' : 'border-l'
        } ${agentDrivingBrowser ? 'border-accent' : 'border-edge'}`}
      >
        <div className="h-full">
          {showBrowser ? (
            <BrowserPane
              sessionId={sessionId}
              taskId={task.id}
              cwd={task.worktree_path ?? projectPath}
              projectId={paneProjectId}
            />
          ) : changesPresent ? (
            changesContent
          ) : (
            descriptionPanelContent
          )}
        </div>
      </div>
    );

    return (
      <>
        <div ref={splitContainerRef} className="flex-1 min-h-0 flex">
          {!changesExpanded && (
            <div
              className={`${rightPanelPresent ? 'flex-shrink-0 flex-grow-0' : 'flex-1'} min-h-0 relative overflow-hidden`}
              style={rightPanelPresent ? { flexBasis: `${splitRatio * 100}%` } : undefined}
            >
              {/* Dimmed while an agent drives the Browser pane.
                  Interacting with a page means clicking it, and a click gives
                  the guest real keyboard focus - so the focus move cannot be
                  designed away, and every attempt to hide it put keystrokes on
                  the wrong side. It is shown instead, so the user can SEE that
                  their typing will not land here. Opacity only: the terminal
                  stays mounted, live, and clickable, and one click takes focus
                  straight back. */}
              <div
                data-testid="task-detail-terminal-dim"
                className={`absolute inset-0 transition-opacity duration-200 ${
                  agentDrivingBrowser ? 'opacity-40' : 'opacity-100'
                }`}
              >
                {/* A retained window is mounted ONLY to keep its Browser pane's
                    <webview> guest alive while its project is backgrounded, so
                    the terminal comes down: an xterm parsing PTY output for a
                    surface nobody can see is pure cost, and it remounts from
                    scrollback on return exactly as the ownership handoff already
                    does. Swapping the child here (rather than dropping the
                    wrapping divs) is deliberate: the sibling slots around
                    `rightPanelElement` must keep their positions, because React
                    matches these fixed children by index and a shifted index
                    would remount BrowserPane and destroy the guest. */}
                {retained ? null : (
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
                )}
              </div>
            </div>
          )}
          {showDivider && splitDivider}
          {rightPanelElement}
          {resizeCaptureOverlay}
        </div>
        <ContextBar sessionId={sessionId} agentFallback={projectDefaultAgent} />
      </>
    );
  }

  // Queued
  if (taskDetailSurfaceFor(displayKind) === 'queued-placeholder') {
    return <QueuedPlaceholder sessionId={sessionId} />;
  }

  // Launching (preparing): worktree creation / CLI boot before the session
  // exists. The terminal area is otherwise blank here, so mirror the board
  // card's launch treatment - a centered muted spinner + the spawn status
  // label - and keep PreSpawnContextBar pinned at the bottom.
  if (taskDetailSurfaceFor(displayKind) === 'launch-overlay') {
    // No session/PTY yet, so the only right panel that applies is the Description
    // peek (Browser needs a live session; Changes is not offered here). It rides
    // the same split so it survives the transition into the running terminal.
    return (
      <>
        <div ref={splitContainerRef} className="flex-1 min-h-0 flex">
          <div
            className={`${showDescriptionPanel ? 'flex-shrink-0 flex-grow-0' : 'flex-1'} min-h-0 relative overflow-hidden`}
            style={showDescriptionPanel ? { flexBasis: `${splitRatio * 100}%` } : undefined}
          >
            <LaunchOverlay label={spawnLabel ?? 'Starting agent...'} />
          </div>
          {showDescriptionPanel && splitDivider}
          {showDescriptionPanel && (
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden border-l border-edge">
              <div className="h-full">{descriptionPanelContent}</div>
            </div>
          )}
          {resizeCaptureOverlay}
        </div>
        <PreSpawnContextBar taskId={task.id} />
      </>
    );
  }

  // Suspended or toggling. The big centered Play button is a resume surface, so
  // it follows the same eligibility as the header toggle: main refuses an
  // in-place resume for To Do, Done, and archived tasks. Done is checked
  // alongside isArchived rather than folded into it, because a task placed
  // directly in a Done-role column was never archived.
  if ((isSuspended || toggling) && !isArchived && !isInTodo && !isInDone) {
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
                  {attachmentStrip}
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
          No active session. Drag this task into a column that starts an agent.
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
