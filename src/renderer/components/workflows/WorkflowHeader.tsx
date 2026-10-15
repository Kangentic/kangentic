import React, { useMemo } from 'react';
import { CirclePlay, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { WorkflowDetail, WorkflowSummary } from '../../../shared/types';
import { WORKFLOW_REFUSALS } from '../../../shared/workflow-refusals';
import { ActivityMark } from '../ActivityMark';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { WorkflowPicker } from './WorkflowPicker';

/**
 * The Workflows view header, the same controls in the same places in every
 * state (a control that cannot act shows disabled, with its reason, and
 * nothing shifts by a pixel):
 *
 *   picker, Rename | Start / Running / Resume | Delete | progress     New workflow
 *
 * Rename, the lifecycle button and Delete share one width, so they read as one
 * kind of control and a state change moves nothing. The lifecycle button is
 * task detail's own Pause / Resume toggle with a word: Running shows the state
 * in the working mark's green and pauses on a click ("Pause workflow"); a
 * paused workflow shows Resume, primary; one not started shows Start, primary.
 * Progress exists only once started, after every control, where it pushes
 * nothing. New workflow acts on no workflow, so it stands alone at the right.
 *
 * At narrower widths (a container query on this row, so a wider sidebar
 * collapses it sooner, as the board toolbar's ladder does) nothing is hidden
 * and nothing moves; what gives way keeps its place and turns its text into a
 * tooltip. Text that is not a control goes first; the lifecycle word goes
 * last. The width sweep in `tests/ui/workflows-view.spec.ts` holds it.
 *
 * A tip cannot follow a container query, so Rename, Delete and the Running
 * button carry the floor's tips ("Rename", "Delete", "Running. Pause
 * workflow") at every width.
 */
const LADDER = {
  /** The counts line folds into the bar's tooltip. */
  counts: 'hidden @[1235px]:inline',
  /** Rename, Delete and New workflow go icon-only. */
  actionButton: 'w-9 @[1040px]:w-24',
  actionLabel: 'hidden @[1040px]:inline',
  newButton: 'w-9 px-0 @[1040px]:w-auto @[1040px]:px-3',
  /** "2 of 9 done" folds into the bar's tooltip, and the bar narrows. */
  progressText: 'hidden @[830px]:inline',
  bar: 'w-12 @[710px]:w-[72px] @[830px]:w-[120px]',
  /**
   * The lifecycle word goes last; the row tightens to a 6px gap and 12px
   * padding; each divider becomes a 4px space; the picker narrows and its
   * count moves to its tooltip.
   */
  row: 'gap-1.5 px-3 @[710px]:gap-3 @[710px]:px-4',
  lifecycleButton: 'w-9 @[710px]:w-24',
  lifecycleLabel: 'hidden @[710px]:inline',
  divider: 'w-0 mx-0.5 @[710px]:w-px @[710px]:mx-0',
  picker: 'w-[176px] @[710px]:w-[260px]',
  pickerPill: 'hidden @[710px]:inline-flex',
} as const;

const BUTTON = 'inline-flex items-center justify-center gap-1.5 h-[34px] shrink-0 rounded border text-[13px] whitespace-nowrap transition-colors disabled:opacity-45 disabled:cursor-not-allowed';
const NEUTRAL = 'border-edge-input text-fg-secondary hover:bg-surface-hover/40 enabled:hover:text-fg';
const PRIMARY = 'border-accent-emphasis bg-accent-emphasis text-accent-on enabled:hover:bg-accent enabled:hover:border-accent';

function Divider() {
  return <span className={`block h-5 shrink-0 bg-edge ${LADDER.divider}`} aria-hidden="true" data-testid="workflow-header-divider" />;
}

interface ProgressSegment {
  key: string;
  color: string;
  /** How many of the workflow's tasks it stands for. */
  tasks: number;
  kind: 'done' | 'working';
}

/**
 * The bar's segments: one for every task in Done, in the Done column's color,
 * then one per working task in its column's color, furthest along first.
 */
function progressSegments(detail: WorkflowDetail | null, doneColumnColor: string): ProgressSegment[] {
  if (!detail) return [];
  const doneTasks = detail.tasks.filter((task) => task.place === 'done').length;
  const done: ProgressSegment[] = doneTasks > 0 ? [{ key: 'done', color: doneColumnColor, tasks: doneTasks, kind: 'done' }] : [];
  const working = detail.tasks
    .filter((task) => task.place === 'working')
    .map((task) => {
      const index = task.steps.findIndex((step) => step.state === 'current');
      return { key: task.key, color: task.steps[index]?.color ?? 'var(--color-fg-faint)', order: index };
    })
    .sort((left, right) => right.order - left.order)
    .map((task): ProgressSegment => ({ key: task.key, color: task.color, tasks: 1, kind: 'working' }));
  return [...done, ...working];
}

function countsLine(summary: WorkflowSummary): string {
  const parts = [
    summary.inProgressCount > 0 ? `${summary.inProgressCount} in progress` : null,
    summary.queuedCount > 0 ? `${summary.queuedCount} queued` : null,
    summary.blockedCount > 0 ? `${summary.blockedCount} blocked` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(', ');
}

interface WorkflowHeaderProps {
  summaries: WorkflowSummary[];
  selected: WorkflowSummary | null;
  detail: WorkflowDetail | null;
  /** The workflow agent's turn is running: what would change its plan waits (Start). */
  planHeld: boolean;
  /** The Done column's color on the board, for the progress bar's done segment. */
  doneColumnColor: string;
  onSelect: (workflowId: string) => void;
  onRename: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onNew: () => void;
}

export function WorkflowHeader({
  summaries,
  selected,
  detail,
  planHeld,
  doneColumnColor,
  onSelect,
  onRename,
  onStart,
  onPause,
  onResume,
  onDelete,
  onNew,
}: WorkflowHeaderProps) {
  const state = selected?.workflow.state ?? null;
  const started = state === 'running' || state === 'paused';
  const segments = useMemo(() => progressSegments(detail, doneColumnColor), [detail, doneColumnColor]);
  const hasWorkflow = selected !== null;

  let lifecycle: React.ReactNode;
  if (state === 'running') {
    lifecycle = (
      <Tooltip label="Running. Pause workflow">
        <button
          type="button"
          onClick={onPause}
          aria-label="Running. Pause workflow"
          className={`${BUTTON} ${LADDER.lifecycleButton} border-active/40 text-active hover:bg-active/10`}
          data-testid="workflow-pause"
        >
          <ActivityMark mark="control-pause-working" size={16} />
          <span className={LADDER.lifecycleLabel}>Running</span>
        </button>
      </Tooltip>
    );
  } else if (state === 'paused') {
    lifecycle = (
      <Tooltip label="Resume workflow">
        <button type="button" onClick={onResume} aria-label="Resume workflow" className={`${BUTTON} ${PRIMARY} ${LADDER.lifecycleButton}`} data-testid="workflow-resume">
          <CirclePlay size={14} className="shrink-0" />
          <span className={LADDER.lifecycleLabel}>Resume</span>
        </button>
      </Tooltip>
    );
  } else {
    const empty = (detail?.tasks.length ?? 0) === 0;
    const reason = !hasWorkflow ? 'No workflow to start' : planHeld ? WORKFLOW_REFUSALS.agentWorking : empty ? 'This workflow has no tasks yet.' : null;
    lifecycle = (
      <Tooltip label={tipLabel({ disabled: reason !== null, disabledReason: reason, tip: 'Start this workflow' })}>
        <button
          type="button"
          onClick={onStart}
          disabled={reason !== null}
          aria-label="Start workflow"
          className={`${BUTTON} ${PRIMARY} ${LADDER.lifecycleButton}`}
          data-testid="workflow-start"
        >
          <Play size={12} className="shrink-0" />
          <span className={LADDER.lifecycleLabel}>Start</span>
        </button>
      </Tooltip>
    );
  }

  const progress = selected && started ? `${selected.doneCount} of ${selected.taskCount} done` : '';
  const counts = selected && started ? countsLine(selected) : '';
  const barTitle = `${[progress, counts].filter(Boolean).join('. ')}.`;

  return (
    <div className="@container shrink-0 border-b border-edge" data-testid="workflow-header">
      <div className={`flex items-center h-14 min-w-0 ${LADDER.row}`}>
        {hasWorkflow && (
          <>
            <WorkflowPicker
              summaries={summaries}
              selected={selected}
              onSelect={onSelect}
              controlClassName={LADDER.picker}
              pillClassName={LADDER.pickerPill}
            />
            <Tooltip label="Rename">
              <button type="button" onClick={onRename} aria-label="Rename" className={`${BUTTON} ${NEUTRAL} ${LADDER.actionButton}`} data-testid="workflow-rename">
                <Pencil size={13} className="shrink-0" />
                <span className={LADDER.actionLabel}>Rename</span>
              </button>
            </Tooltip>
            <Divider />
            {lifecycle}
            <Divider />
            <Tooltip label="Delete">
              <button
                type="button"
                onClick={onDelete}
                aria-label="Delete"
                className={`${BUTTON} ${LADDER.actionButton} border-danger/40 text-danger hover:bg-danger/10 hover:border-danger/60`}
                data-testid="workflow-delete"
              >
                <Trash2 size={13} className="shrink-0" />
                <span className={LADDER.actionLabel}>Delete</span>
              </button>
            </Tooltip>
            {started && selected && (
              <>
                <Divider />
                <span className={`shrink-0 text-[13px] text-fg-tertiary whitespace-nowrap tabular-nums ${LADDER.progressText}`} data-testid="workflow-progress">
                  {progress}
                </span>
                <Tooltip label={barTitle}>
                  <span
                    className={`flex shrink-0 h-1.5 gap-0.5 rounded-full overflow-hidden bg-edge/60 ${LADDER.bar}`}
                    role="img"
                    aria-label={barTitle}
                    data-testid="workflow-progress-bar"
                  >
                    {segments.map((segment) => (
                      <i
                        key={segment.key}
                        className="block h-full"
                        style={{ width: `${(100 * segment.tasks) / Math.max(1, selected.taskCount)}%`, background: segment.color }}
                        data-segment={segment.kind}
                      />
                    ))}
                  </span>
                </Tooltip>
                {counts && (
                  <span className={`min-w-0 truncate text-xs text-fg-faint ${LADDER.counts}`} data-testid="workflow-counts">{counts}</span>
                )}
              </>
            )}
          </>
        )}
        <span className="ml-auto" />
        <Tooltip label="New workflow">
          <button type="button" onClick={onNew} aria-label="New workflow" className={`${BUTTON} ${NEUTRAL} ${LADDER.newButton}`} data-testid="workflow-new">
            <Plus size={13} className="shrink-0" />
            <span className={LADDER.actionLabel}>New workflow</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
