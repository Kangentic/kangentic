import { Suspense, lazy } from 'react';
import { Loader2, Play } from 'lucide-react';
import { TerminalTab } from '../../terminal/TerminalTab';
import { ContextBar } from '../../terminal/ContextBar';
import { ShimmerOverlay } from '../../ShimmerOverlay';
import { SessionSummaryPanel } from '../SessionSummaryPanel';
import { PriorityBadge } from '../../backlog/PriorityBadge';
import { LabelPills } from '../../Pill';
import { useConfigStore } from '../../../stores/config-store';
import { QueuedPlaceholder } from './QueuedPlaceholder';
import { AttachmentThumbnails } from './AttachmentThumbnails';
import type { AttachmentWithPreview } from './useAttachments';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { Task, SessionDisplayState } from '../../../../shared/types';

const ChangesPanel = lazy(() => import('./changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

interface TaskDetailBodyProps {
  task: Task;
  isArchived: boolean;
  isInTodo: boolean;
  hasSessionContext: boolean;
  sessionId: string | null;
  displayKind: SessionDisplayState['kind'];
  isSuspended: boolean;
  toggling: boolean;
  pendingCommandLabel: string | null;
  savedAttachments: AttachmentWithPreview[];
  handlePreview: (attachment: AttachmentWithPreview) => void;
  handleOpenExternal: (attachment: AttachmentWithPreview) => void;
  removeAttachment: (id: string) => void;
  handleToggle: () => void;
  changesOpen: boolean;
  projectPath: string;
}

export function TaskDetailBody({
  task,
  isArchived,
  isInTodo,
  hasSessionContext,
  sessionId,
  displayKind,
  isSuspended,
  toggling,
  pendingCommandLabel,
  savedAttachments,
  handlePreview,
  handleOpenExternal,
  removeAttachment,
  handleToggle,
  changesOpen,
  projectPath,
}: TaskDetailBodyProps) {
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
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

  const changesPanelElement = changesOpen && (
    <div className="w-1/2 min-h-0 border-l border-edge flex-shrink-0">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        }
      >
        <ChangesPanel task={task} projectPath={projectPath} />
      </Suspense>
    </div>
  );

  // Active terminal session
  if (sessionId && displayKind !== 'queued' && displayKind !== 'suspended') {
    return (
      <>
        {descriptionBar}
        <div className="flex-1 min-h-0 flex">
          <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} min-h-0 relative`}>
            <div className="absolute inset-0">
              <TerminalTab
                key={sessionId}
                sessionId={sessionId}
                taskId={task.id}
                active={true}
              />
            </div>
          </div>
          {changesPanelElement}
        </div>
        <ContextBar sessionId={sessionId} />
      </>
    );
  }

  // Queued
  if (displayKind === 'queued') {
    return <QueuedPlaceholder sessionId={sessionId} />;
  }

  // Suspended or toggling
  if ((isSuspended || toggling) && !isArchived && !isInTodo) {
    if (pendingCommandLabel) {
      return (
        <div className="flex-1 min-h-0 flex">
          <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} min-h-0 relative`}>
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface">
              <ShimmerOverlay label={pendingCommandLabel} />
            </div>
          </div>
          {changesPanelElement}
        </div>
      );
    }
    return (
      <div className="flex-1 min-h-0 flex">
        <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} flex flex-col items-center justify-center gap-3 bg-surface/50`}>
          <button
            onClick={handleToggle}
            disabled={toggling}
            className="flex items-center gap-2.5 px-6 py-3 rounded-lg bg-accent/20 border border-accent/40 text-base text-accent-fg hover:bg-accent/30 transition-colors disabled:opacity-50"
          >
            {toggling ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Play size={16} />
            )}
            {toggling ? 'Resuming agent...' : 'Resume session'}
          </button>
        </div>
        {changesPanelElement}
      </div>
    );
  }

  // Changes-only view (no session but changes panel open)
  if (changesOpen) {
    return (
      <div className="flex-1 min-h-0 flex">
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
        {changesPanelElement}
      </div>
    );
  }

  // Empty state
  if (!task.description && savedAttachments.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm p-8">
        No active session. Drag this task to a column with a transition to start one.
      </div>
    );
  }

  // Description-only view (no session)
  return descriptionBar || null;
}
