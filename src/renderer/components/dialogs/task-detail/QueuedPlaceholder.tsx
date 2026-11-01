import type { ReactNode } from 'react';
import { ChevronRight, Clock } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useBoardStore } from '../../../stores/board-store';
import { useConfigStore } from '../../../stores/config-store';
import { useSessionStore } from '../../../stores/session-store';
import { useQueuePlace } from '../../../hooks/useQueuePlace';
import { openTaskFromNotification } from '../../../utils/open-task-from-notification';
import { agentActivityMark } from '../../board/agent-wait';
import { ActivityMark } from '../../ActivityMark';
import { IconSlot } from '../../IconSlot';
import { isActive } from '../../../../shared/activity-state';
import type { QueueTask } from '../../../../shared/types';

const ROW_FRAME = 'flex flex-shrink-0 items-center gap-1.5 border rounded-md p-2.5 w-full text-left';
const RAISED_ROW = `${ROW_FRAME} bg-surface-raised border-edge hover:border-edge-input transition-colors`;

/** A waiting task's place in line. */
function PlaceNumber({ value }: { value: number }) {
  return <span className="w-4 text-center text-xs font-semibold text-fg-muted tabular-nums shrink-0">{value}</span>;
}

/**
 * The running task's live mark, the one its card wears. Through a slot because
 * it sits inside a row that opens the task, and a mark can change shape as the
 * agent goes from working to waiting. A restart keeping its slot has no session
 * for a moment and nothing to ask, so it reads as working.
 */
function HolderMark({ sessionId }: { sessionId: string | null }) {
  const { t } = useLingui();
  const activity = useSessionStore((state) => (sessionId ? state.sessionActivity[sessionId] : undefined));
  const reason = useSessionStore((state) => (sessionId ? state.sessionActivityReason[sessionId] : undefined));
  const working = sessionId === null || isActive(activity);
  return (
    <IconSlot size={16} className="shrink-0">
      <ActivityMark
        mark={sessionId === null ? 'agent-working' : agentActivityMark(activity, reason)}
        size={16}
        className={working ? 'text-active' : 'text-attention'}
        aria-label={working ? t({ message: 'Working', context: 'Agent status' }) : t`Needs you`}
      />
    </IconSlot>
  );
}

/** One task in the line. A row opens its task, and this task's own row is dashed and opens nothing. */
function QueueRow({ lead, task, self, showProject }: { lead: ReactNode; task: QueueTask; self: boolean; showProject: boolean }) {
  const { t } = useLingui();
  // A rename does not change the line, so main sends no new snapshot for it. The
  // board has the live title for this project's tasks.
  const liveTitle = useBoardStore((state) => state.tasks.find((candidate) => candidate.id === task.taskId)?.title);
  const name = (
    <>
      {lead}
      <span className={`text-sm font-medium truncate flex-1 min-w-0 ${self ? 'text-fg-muted' : 'text-fg'}`}>
        {liveTitle ?? task.title ?? t`Command Terminal`}
      </span>
      {showProject && <span className="shrink-0 text-xs text-fg-muted">{task.projectName}</span>}
      {task.displayId !== null && <span className="shrink-0 font-mono text-xs text-fg-muted">#{task.displayId}</span>}
    </>
  );
  if (self) {
    return <div className={`${ROW_FRAME} border-dashed border-edge-input`} data-testid="queue-row-self">{name}</div>;
  }
  if (task.title === null) {
    return <div className={`${ROW_FRAME} bg-surface-raised border-edge`} data-testid="queue-row">{name}</div>;
  }
  return (
    <button
      type="button"
      className={`${RAISED_ROW} cursor-pointer`}
      data-testid="queue-row"
      onClick={() => openTaskFromNotification(task.projectId, task.taskId)}
    >
      {name}
    </button>
  );
}

/** The head of the Max concurrent sessions line: what holds the slots, and the way to change the limit. */
function AgentsRunningRow() {
  const maxConcurrent = useConfigStore((state) => state.config.agent.maxConcurrentSessions);
  const runningCount = useSessionStore((state) => state.getRunningCount());
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);
  return (
    <button
      type="button"
      className={`${RAISED_ROW} cursor-pointer`}
      data-testid="queue-agents-running"
      onClick={() => setSettingsOpen(true)}
    >
      <IconSlot size={16} className="shrink-0">
        <ActivityMark mark="agent-working" size={16} className="text-active" />
      </IconSlot>
      <span className="text-sm font-medium text-fg flex-1 min-w-0 truncate">
        <Trans>
          {runningCount} of <Plural value={maxConcurrent} one="# agent running" other="# agents running" />
        </Trans>
      </span>
      <ChevronRight size={14} className="shrink-0 text-fg-muted" />
    </button>
  );
}

/**
 * A queued task's window: the card's clock and count as the title, over the line
 * of tasks. One shape for both limits, and the top row is always what holds the
 * slot: the column's running agent, or the agents filling Max concurrent sessions.
 *
 * The title sits at a fixed share of the window's height and the list grows below
 * it, because the line changes under the reader as tasks leave it, and a centred
 * block would move each time. The list scrolls, and its scrollbar sits outside the
 * rows so they stay as wide as the separator.
 */
export function QueuedPlaceholder({ sessionId }: { sessionId: string | null }) {
  const place = useQueuePlace(sessionId);
  const position = place?.position;
  const total = place?.total;
  const snapshotLine = useSessionStore((state) => state.queueSnapshot.global);
  const ownProjectId = snapshotLine.find((task) => task.sessionId === sessionId)?.projectId ?? null;
  const rowFor = (task: QueueTask, lead: ReactNode): ReactNode => (
    <QueueRow
      key={task.sessionId ?? task.taskId}
      lead={lead}
      task={task}
      self={task.sessionId === sessionId}
      showProject={task.projectId !== ownProjectId}
    />
  );

  return (
    <div className="flex-1 flex flex-col items-center min-h-0 bg-surface/50 px-4 pb-7" data-testid="queued-placeholder">
      <div className="basis-[18%] shrink" />
      <div className="flex flex-col min-h-0 w-full max-w-[460px]">
        <div className="flex items-center justify-center gap-2 pb-3.5 border-b border-edge text-xl font-semibold text-fg tabular-nums shrink-0">
          <Clock size={20} />
          <span data-testid="queued-title">
            {place ? <Trans>Queued {position}/{total}</Trans> : <Trans>Queued</Trans>}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 mt-3.5 min-h-0 overflow-y-auto -mr-2 pr-2" data-testid="queue-line">
          {place?.kind === 'column' && (
            <>
              {place.line.holders.map((task) => rowFor(task, <HolderMark sessionId={task.sessionId} />))}
              {place.line.waiting.map((task, index) => rowFor(task, <PlaceNumber value={place.line.holders.length + index + 1} />))}
            </>
          )}
          {place?.kind === 'global' && (
            <>
              <AgentsRunningRow />
              {snapshotLine.map((task, index) => rowFor(task, <PlaceNumber value={index + 1} />))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
