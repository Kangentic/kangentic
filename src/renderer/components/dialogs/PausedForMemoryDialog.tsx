import { useState } from 'react';
import { LoaderCircle, MemoryStick, Play } from 'lucide-react';
import type { HostMemoryAgentPausedEvent } from '../../../shared/types';
import { isLiveSessionStatus } from '../../../shared/session-liveness';
import { BaseDialog } from './BaseDialog';
import { ActivityMark } from '../ActivityMark';
import { Tooltip } from '../Tooltip';
import { useHostMemoryStore } from '../../stores/host-memory-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useNow } from '../../hooks/useNow';
import { formatDateTime, formatTimeAgo } from '../../lib/datetime';
import { orderPausedAgents, pausedRowDetail } from '../../lib/paused-for-memory';

/** How often the header's age re-reads the clock; it shows whole minutes. */
const AGE_TICK_MS = 30_000;

/**
 * The list the paused toast's Review button opens: every agent low memory
 * paused since the toast was raised, oldest wait first, each with a Resume
 * button. Resume is the task's own Resume path, in place, from any project,
 * without opening the task. Once the agent is back the row reads Running,
 * and so does a row whose task was resumed some other way (its card, its
 * window, a move). There is no Resume all: bringing every agent back at once
 * would refill the memory that was just freed.
 */
export function PausedForMemoryDialog() {
  const open = useHostMemoryStore((state) => state.reviewOpen);
  const entries = useHostMemoryStore((state) => state.pausedAgents);
  const closeReview = useHostMemoryStore((state) => state.closeReview);
  if (!open || entries.length === 0) return null;
  return <PausedForMemoryDialogBody entries={entries} onClose={closeReview} />;
}

function PausedForMemoryDialogBody({ entries, onClose }: { entries: HostMemoryAgentPausedEvent[]; onClose: () => void }) {
  const now = useNow(AGE_TICK_MS);
  const ordered = orderPausedAgents(entries);
  const latestPausedAt = entries.reduce((latest, entry) => (entry.pausedAt > latest ? entry.pausedAt : latest), entries[0].pausedAt);
  const spansProjects = new Set(entries.map((entry) => entry.projectId)).size > 1;
  const single = entries.length === 1;
  return (
    <BaseDialog
      onClose={onClose}
      title={single ? 'Agent paused to free memory' : `${entries.length} agents paused to free memory`}
      subtitle={(
        <Tooltip label={formatDateTime(latestPausedAt)}>
          <span data-testid="paused-for-memory-age">{formatTimeAgo(latestPausedAt, now)}</span>
        </Tooltip>
      )}
      icon={<MemoryStick size={16} className="text-accent-fg" />}
      className="w-[560px] max-w-[calc(100vw-2rem)]"
      bodyClassName="max-h-[60vh] overflow-y-auto"
      testId="paused-for-memory-dialog"
      trapFocus
      footer={(
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            data-testid="paused-for-memory-close"
            className="px-6 py-1.5 min-w-[96px] text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
          >
            Close
          </button>
        </div>
      )}
    >
      <div className="flex flex-col gap-1.5">
        <p className="mb-2 text-sm text-fg-muted">
          {single ? 'It stays paused until you resume it.' : 'They stay paused until you resume them.'}
        </p>
        {ordered.map((entry) => (
          <PausedAgentRow key={entry.taskId} entry={entry} showProject={spansProjects} />
        ))}
      </div>
    </BaseDialog>
  );
}

type RowState = 'paused' | 'resuming' | 'running';

function PausedAgentRow({ entry, showProject }: { entry: HostMemoryAgentPausedEvent; showProject: boolean }) {
  const [resuming, setResuming] = useState(false);
  const [resumed, setResumed] = useState(false);
  // Running however it came back: this Resume, its card, its window, a move.
  const liveElsewhere = useSessionStore((state) => state.sessions.some(
    (session) => session.taskId === entry.taskId && isLiveSessionStatus(session.status),
  ));
  const state: RowState = resumed || liveElsewhere ? 'running' : resuming ? 'resuming' : 'paused';

  const resume = async (): Promise<void> => {
    setResuming(true);
    try {
      const session = await window.electronAPI.sessions.resume(entry.taskId, undefined, entry.projectId);
      if (session) setResumed(true);
    } catch (error) {
      useToastStore.getState().addToast({
        title: 'Couldn\'t resume session',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    } finally {
      setResuming(false);
    }
  };

  const detail = pausedRowDetail(entry, showProject);
  const title = entry.taskTitle ?? 'Untitled task';
  return (
    <div
      className="flex items-center gap-3 rounded-md bg-surface-hover/40 px-3 py-2"
      data-testid="paused-for-memory-row"
      data-task-id={entry.taskId}
      data-state={state}
    >
      <div className="min-w-0 flex-1">
        <Tooltip label={title}>
          <div className="truncate text-sm text-fg">{title}</div>
        </Tooltip>
        <div className="truncate text-xs text-fg-tertiary">{detail}</div>
      </div>
      <RowAction state={state} taskTitle={title} onResume={() => { void resume(); }} />
    </div>
  );
}

const ACTION_BASE_CLASS = 'flex h-7 w-[104px] flex-shrink-0 items-center justify-center gap-1.5 rounded-md border text-xs';

function RowAction({ state, taskTitle, onResume }: { state: RowState; taskTitle: string; onResume: () => void }) {
  if (state === 'running') {
    return (
      <span
        className={`${ACTION_BASE_CLASS} border-edge bg-surface-hover/40 text-fg-muted`}
        data-testid="paused-for-memory-running"
      >
        <ActivityMark mark="agent-working" size={16} className="text-fg-muted" aria-hidden="true" />
        Running
      </span>
    );
  }
  if (state === 'resuming') {
    return (
      <button type="button" disabled className={`${ACTION_BASE_CLASS} border-accent/40 bg-accent/20 text-accent-fg opacity-80`} data-testid="paused-for-memory-resume">
        <LoaderCircle size={12} strokeWidth={2.5} className="animate-spin" aria-hidden="true" />
        Resuming
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onResume}
      aria-label={`Resume ${taskTitle}`}
      data-testid="paused-for-memory-resume"
      className={`${ACTION_BASE_CLASS} border-accent/40 bg-accent/20 text-accent-fg transition-colors hover:bg-accent/30`}
    >
      <Play size={12} aria-hidden="true" />
      Resume
    </button>
  );
}
