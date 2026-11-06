import type { ReactNode } from 'react';
import { Gauge } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useTaskDetailHost } from './task-detail-host';
import { useConfigStore } from '../../../stores/config-store';
import { useSessionStore } from '../../../stores/session-store';
import { useQueuePlace } from '../../../hooks/useQueuePlace';
import { openTaskFromNotification } from '../../../utils/open-task-from-notification';
import { SwimlaneIcon } from '../../../utils/swimlane-icons';
import { agentActivityMark } from '../../board/agent-wait';
import { ActivityMark } from '../../ActivityMark';
import { IconSlot } from '../../IconSlot';
import { Pill, TINTED_PILL_EDGE, TINTED_PILL_FILL } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { isActive } from '../../../../shared/activity-state';
import type { QueuePlace } from '../../../../shared/queue-place';
import type { QueueTask } from '../../../../shared/types';

const ROW_FRAME = 'flex flex-1 min-w-0 items-center gap-2 border rounded-lg px-3.5 py-3 text-left';
const NODE_FRAME = 'flex h-7 w-7 shrink-0 items-center justify-center';
const REASON_FRAME = 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-fg-muted';

/** A waiting task's stop on the track. The task this window belongs to is lit. */
function PlaceNode({ value, self }: { value: number; self: boolean }) {
  const tone = self ? 'border-accent bg-accent text-accent-on' : 'border-edge bg-surface-raised text-fg-muted';
  return <span className={`${NODE_FRAME} rounded-full border text-xs font-semibold tabular-nums ${tone}`}>{value}</span>;
}

/** One task in the line. A row opens its task, and this task's own row is lit and opens nothing. */
function QueueRow({ lead, task, self, showProject, frame }: {
  lead?: ReactNode;
  task: QueueTask;
  self: boolean;
  showProject: boolean;
  frame: string;
}) {
  const { t } = useLingui();
  // A rename does not change the line, so main sends no new snapshot for it. The
  // host has the live title for tasks on its board.
  const host = useTaskDetailHost();
  const liveTitle = host.useLiveTaskTitle(task.taskId);
  const name = (
    <>
      {lead}
      <span className="text-sm font-medium truncate flex-1 min-w-0">
        {liveTitle ?? task.title ?? t`Command Terminal`}
      </span>
      {showProject && <span className="shrink-0 text-xs text-fg-muted">{task.projectName}</span>}
      {task.displayId !== null && <span className="shrink-0 font-mono text-xs text-fg-muted">#{task.displayId}</span>}
    </>
  );
  if (self) {
    return <div className={`${ROW_FRAME} ${frame}`} data-testid="queue-row-self">{name}</div>;
  }
  if (task.title === null) {
    return <div className={`${ROW_FRAME} ${frame}`} data-testid="queue-row">{name}</div>;
  }
  return (
    <button
      type="button"
      className={`${ROW_FRAME} ${frame} hover:border-edge-input transition-colors cursor-pointer`}
      data-testid="queue-row"
      onClick={() => openTaskFromNotification(task.projectId, task.taskId)}
    >
      {name}
    </button>
  );
}

/**
 * The running task at the head of the line, with the live mark its card wears.
 * Through a slot because it sits inside a row that opens the task, and a mark can
 * change shape as the agent goes from working to waiting. An agent waiting on the
 * user stalls everything behind it, so its row turns amber. A restart keeping its
 * slot has no session for a moment and nothing to ask, so it reads as working.
 */
function HolderItem({ task }: { task: QueueTask }) {
  const { t } = useLingui();
  const { sessionId } = task;
  const activity = useSessionStore((state) => (sessionId ? state.sessionActivity[sessionId] : undefined));
  const reason = useSessionStore((state) => (sessionId ? state.sessionActivityReason[sessionId] : undefined));
  const working = sessionId === null || isActive(activity);
  return (
    <div className="relative flex items-center gap-3 min-w-0">
      <span className={NODE_FRAME}>
        <span className={`h-2.5 w-2.5 rounded-full ${working ? 'bg-fg-faint' : 'bg-attention'}`} />
      </span>
      <QueueRow
        lead={(
          <IconSlot size={16} className="shrink-0">
            <ActivityMark
              mark={sessionId === null ? 'agent-working' : agentActivityMark(activity, reason)}
              size={16}
              className={working ? 'text-active' : 'text-attention'}
              aria-label={working ? t({ message: 'Working', context: 'Agent status' }) : t`Needs you`}
            />
          </IconSlot>
        )}
        task={task}
        self={false}
        showProject={false}
        frame={`bg-surface-raised text-fg ${working ? 'border-edge' : 'border-attention'}`}
      />
    </div>
  );
}

/** A task waiting its turn: its place on the track and its row. */
function WaitingItem({ task, place, self, showProject }: { task: QueueTask; place: number; self: boolean; showProject: boolean }) {
  return (
    <div className="relative flex items-center gap-3 min-w-0">
      <PlaceNode value={place} self={self} />
      <QueueRow
        task={task}
        self={self}
        showProject={showProject}
        frame={self ? 'border-accent bg-accent/10 text-fg' : 'border-edge bg-surface-raised text-fg-muted'}
      />
    </div>
  );
}

/**
 * Why the task waits, and the way to the setting that says so. The Column Manager
 * opens on the board layer for the open board's project, so a host that cannot
 * show it keeps the reason and says where the setting is.
 */
function QueueReason({ place }: { place: QueuePlace }) {
  const { t } = useLingui();
  const host = useTaskDetailHost();
  const maxConcurrent = useConfigStore((state) => state.config.agent.maxConcurrentSessions);
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);
  const linkClass = `${REASON_FRAME} cursor-pointer hover:text-fg hover:underline`;

  if (place.kind === 'global') {
    return (
      <button type="button" className={linkClass} data-testid="queue-reason" onClick={() => setSettingsOpen(true)}>
        <Gauge size={16} className="shrink-0" />
        <span>
          <Trans>Up to <Plural value={maxConcurrent} one="# agent runs" other="# agents run" /> at a time</Trans>
        </span>
      </button>
    );
  }

  const { columnName, maxAgents, swimlaneId } = place.line;
  const lane = host.swimlanes.find((candidate) => candidate.id === swimlaneId);
  const content = (
    <>
      {lane && <SwimlaneIcon swimlane={lane} size={16} dotClassName="w-2.5 h-2.5 rounded-full flex-shrink-0" />}
      <span>
        <Trans>{columnName} runs <Plural value={maxAgents} one="one agent" other="# agents" /> at a time</Trans>
      </span>
    </>
  );
  const { openColumnManager } = host;
  if (!openColumnManager) {
    return (
      <Tooltip label={t`Open the board to change this`}>
        <span className={REASON_FRAME} data-testid="queue-reason">{content}</span>
      </Tooltip>
    );
  }
  return (
    <button type="button" className={linkClass} data-testid="queue-reason" onClick={() => openColumnManager(swimlaneId)}>
      {content}
    </button>
  );
}

/** "Next in line" or how many go first, since a task's place is what the window is for. */
function QueueHeading({ place }: { place: QueuePlace | null }) {
  if (!place) return <Trans>Queued</Trans>;
  const ahead = place.position - 1;
  if (ahead === 0) return <Trans>Next in line</Trans>;
  return <Plural value={ahead} one="# task ahead" other="# tasks ahead" />;
}

/** The count of waiting tasks beside the heading, which shows a long line's size without a scroll. */
function QueueCount({ position, total }: { position: number; total: number }) {
  return (
    <Pill
      size="xs"
      className="border font-semibold text-fg-muted tabular-nums"
      style={{ backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
      data-testid="queued-count"
    >
      <Trans>{position} of {total}</Trans>
    </Pill>
  );
}

/**
 * A queued task's window: its place in words, what holds it, and the line as one
 * connected track. One shape for both limits. A column's track starts at the
 * agents holding its slot. Max concurrent sessions can be any number of agents
 * across every project, so that track starts at the first waiting task.
 *
 * The title sits at a fixed share of the window's height and the track grows below
 * it, because the line changes under the reader as tasks leave it, and a centred
 * block would move each time. The track scrolls, and its scrollbar sits outside the
 * rows so they keep their width.
 */
export function QueuedPlaceholder({ sessionId }: { sessionId: string | null }) {
  const place = useQueuePlace(sessionId);
  const holders = place?.kind === 'column' ? place.line.holders : [];
  const waiting = place?.kind === 'column' ? place.line.waiting : place?.tasks ?? [];
  const ownProjectId = waiting.find((task) => task.sessionId === sessionId)?.projectId ?? null;
  const rowCount = holders.length + waiting.length;

  return (
    <div className="flex-1 flex flex-col items-center min-w-0 min-h-0 bg-surface/50 px-4 pb-7" data-testid="queued-placeholder">
      <div className="basis-[14%] shrink" />
      <div className="flex flex-col min-h-0 w-full max-w-[560px]">
        <div className="flex flex-col items-center gap-2 mb-7 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-3xl font-semibold text-fg" data-testid="queued-title">
              <QueueHeading place={place} />
            </span>
            {place && <QueueCount position={place.position} total={place.total} />}
          </div>
          {place && <QueueReason place={place} />}
        </div>
        <div className="min-h-0 overflow-y-auto -mr-2 pr-2" data-testid="queue-line">
          <div className="relative flex flex-col gap-2.5">
            {rowCount > 1 && <div className="absolute left-[13px] top-6 bottom-6 w-0.5 bg-edge" aria-hidden="true" />}
            {holders.map((task) => <HolderItem key={task.sessionId ?? task.taskId} task={task} />)}
            {waiting.map((task, index) => (
              <WaitingItem
                key={task.sessionId ?? task.taskId}
                task={task}
                place={index + 1}
                self={task.sessionId === sessionId}
                showProject={task.projectId !== ownProjectId}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
