import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleCheckBig, Folder, Layers, Plus, SquareTerminal, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { PlanApproval, Task, WorkflowBoardEnds, WorkflowDetail, WorkflowRouteStep, WorkflowViewTask } from '../../../shared/types';
import { WORKFLOW_REFUSAL_MESSAGES } from '../../../shared/workflow-refusals';
import { translateText } from '../../i18n/translate';
import { agentCannotApprovePlans, normalizeTaskPlanApproval, taskPlanApprovalTip } from '../../../shared/plan-approval';
import { formatDateTime, formatRelativeTime } from '../../lib/datetime';
import { ColumnGlyph } from '../../utils/swimlane-icons';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { ActivityMark } from '../ActivityMark';
import { CountBadge } from '../CountBadge';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { OverlayPopover } from '../OverlayPopover';
import { ToggleSwitch } from '../settings/shared';
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl';
import { useTaskCardViewModel } from '../board/task-card-view';
import {
  addBlockerRefusal,
  blockerCandidates,
  findTask,
  otherBoardDoneColor,
  removeRefusal,
  runOrder,
  stepRefusal,
  toggledRoute,
  unlinkRefusal,
  workflowColor,
} from './workflow-graph';
import { isAtToDo } from './workflow-track';
import { WorkflowStateChip } from './WorkflowPicker';

/**
 * The Workflows inspector, always open so the canvas never shifts. A workflow
 * opens with its first task selected (the view picks it), so the panel usually
 * shows a task: its route as a rail of steps, what it waits for, what waits
 * for it, and its two actions in the footer. With no task selected (Escape, a
 * click on empty canvas, or a workflow with no tasks yet) it shows the run
 * order: every task, grouped by when it can start, each row selecting its
 * card. There is no "Select a task" prompt (Final 4).
 *
 * Every control is always drawn. One that cannot act is disabled with the
 * reason main would refuse it with (`WORKFLOW_REFUSALS`, through
 * `workflow-graph.ts`), so a control never comes and goes with state.
 *
 * Task detail's workflow panel is this same component (`variant:
 * 'taskDetail'`): no task header (the window has one), the workflow's own row
 * on top, and Open workflow where the inspector has Open task.
 */

export const INSPECTOR_WIDTH = 380;

const DONE_COLOR = 'var(--color-active)';
const RAIL_DONE = 'color-mix(in srgb, var(--color-active) 55%, transparent)';
const RAIL_AHEAD = 'var(--color-edge)';

function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/** The card's own Active / Idle mark: a status, not a button. */
function TaskActivityMark({ task, size }: { task: Task; size: number }) {
  const view = useTaskCardViewModel(task);
  if (view.isThinking) {
    return (
      <Tooltip label="Active">
        <span className="inline-flex shrink-0 text-active" role="img" aria-label="Active"><ActivityMark mark="agent-working" size={size} /></span>
      </Tooltip>
    );
  }
  if (view.isIdle) {
    return (
      <Tooltip label="Idle">
        <span className="inline-flex shrink-0 text-attention" role="img" aria-label="Idle"><ActivityMark mark="agent-idle" size={size} /></span>
      </Tooltip>
    );
  }
  return null;
}

function SectionHeading({ children, count, trailing }: { children: React.ReactNode; count?: number; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-faint">
      {children}
      {/* Tinted from the heading's faint tone. `tracking-normal` keeps the
          heading's letter-spacing off the digits. */}
      {count !== undefined && (
        <CountBadge count={count} variant="tinted" size="pill" className="tracking-normal" />
      )}
      {trailing}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

function RailNode({ kind, color }: { kind: 'done' | 'current' | 'ahead' | 'end' | null; color: string }) {
  if (kind === 'done') {
    return (
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-surface" style={{ background: DONE_COLOR }}>
        <Check size={10} strokeWidth={3.5} />
      </span>
    );
  }
  if (kind === 'current') {
    return (
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-surface-raised" style={{ boxShadow: `inset 0 0 0 2px ${color}, 0 0 0 3px ${tint(color, 22)}` }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      </span>
    );
  }
  if (kind === 'ahead') return <span className="w-2.5 h-2.5 rounded-full bg-surface-raised" style={{ boxShadow: 'inset 0 0 0 2px var(--color-edge-input)' }} />;
  if (kind === 'end') return <span className="w-3 h-3 rounded-full bg-surface-raised" style={{ boxShadow: `inset 0 0 0 2px ${color}` }} />;
  return null;
}

function Rail({ above, below, aboveColor, belowColor, node }: { above: boolean; below: boolean; aboveColor: string; belowColor: string; node: React.ReactNode }) {
  return (
    <span className="relative self-stretch w-4 shrink-0 flex items-center justify-center">
      {above && <span className="absolute left-[7px] top-0 h-1/2 w-0.5" style={{ background: aboveColor }} />}
      {below && <span className="absolute left-[7px] top-1/2 bottom-0 w-0.5" style={{ background: belowColor }} />}
      <span className="relative inline-flex">{node}</span>
    </span>
  );
}

/**
 * One end of the rail: the board's To Do column on top, its Done column at the
 * bottom. Locked on, since every route starts and ends there. Current while the
 * task is at that end; otherwise To Do reads as left behind and Done as ahead.
 */
function EndRow({ end, current, color, icon, name }: {
  end: 'todo' | 'done';
  current: boolean;
  color: string;
  icon: string | null;
  name: string;
}) {
  const rail = end === 'todo'
    ? <Rail above={false} below aboveColor={RAIL_AHEAD} belowColor={current ? RAIL_AHEAD : RAIL_DONE} node={<RailNode kind={current ? 'current' : 'done'} color={color} />} />
    : <Rail above below={false} aboveColor={current ? RAIL_DONE : RAIL_AHEAD} belowColor={RAIL_AHEAD} node={<RailNode kind={current ? 'current' : 'end'} color={color} />} />;
  const elsewhereState = end === 'todo' ? 'done' : 'ahead';
  return (
    <div
      className="flex items-center gap-2.5 w-full h-[34px] px-2 rounded-md text-[13px]"
      style={current ? { background: tint(color, 10) } : undefined}
      data-testid={`workflow-route-${end}`}
      data-step-state={current ? 'current' : elsewhereState}
    >
      {rail}
      <ColumnGlyph column={{ icon, role: end }} size={14} color={color} />
      <span className="flex-1 min-w-0 truncate text-fg-secondary">{name}</span>
      <ToggleSwitch
        checked
        onChange={() => undefined}
        disabled
        disabledReason={end === 'todo' ? `Every route starts in ${name}` : `Every route ends in ${name}`}
        ariaLabel={name}
      />
    </div>
  );
}

/**
 * The task's journey as a rail, the same stops its card's track draws
 * (sign-off T2, 2026-10-07): the board's To Do column, one row per route
 * column (a skipped one struck through, with its switch off), the board's Done
 * column. To Do and Done are locked on: every route starts and ends there.
 */
function RouteRows({ task, held, onToggle, doneColumnColor, ends }: {
  task: WorkflowViewTask;
  held: boolean;
  onToggle: (step: WorkflowRouteStep) => void;
  doneColumnColor: string;
  ends: WorkflowBoardEnds | null;
}) {
  const steps = task.steps;
  const firstOn = steps.findIndex((step) => step.state !== 'skipped');
  // The furthest row the task has reached: its current column, every row for a
  // task in Done, none before it starts. The rail is green up to there.
  const reached = task.place === 'done'
    ? steps.length - 1
    : steps.findIndex((step) => step.state === 'current');
  const todo = ends?.todo ?? null;
  // With a To Do row on top the rail runs through every row, the skipped ones
  // before the first column on the route included.
  const railFrom = todo ? 0 : firstOn;
  return (
    <div className="-mx-2">
      {todo && (
        <EndRow end="todo" current={isAtToDo(task.place)} color={todo.color ?? 'var(--color-fg-faint)'} icon={todo.icon} name={todo.name} />
      )}
      {steps.map((step, index) => {
        const on = step.state !== 'skipped';
        const refusal = held ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : stepRefusal(task, index);
        const color = step.color ?? 'var(--color-fg-faint)';
        const kind = !on ? null : step.state === 'done' ? 'done' : step.state === 'current' ? 'current' : 'ahead';
        const interactive = refusal === null;
        const finished = step.state === 'done' && step.finishedAt;
        return (
          // A click anywhere on a live row flips it, as on a settings row; the
          // switch is the keyboard's way to it, so the row is not a second control.
          <div
            key={step.swimlaneId}
            onClick={interactive ? () => onToggle(step) : undefined}
            className={`flex items-center gap-2.5 w-full h-[34px] px-2 rounded-md text-[13px] text-left select-none ${interactive ? 'cursor-pointer hover:bg-surface-hover/40' : ''}`}
            style={step.state === 'current' ? { background: tint(color, 10) } : undefined}
            data-testid="workflow-route-row"
            data-step-state={step.state}
          >
            <Rail
              above={railFrom >= 0 && (index > railFrom || (todo !== null && index === 0))}
              below={railFrom >= 0 && index >= railFrom}
              aboveColor={index <= reached ? RAIL_DONE : RAIL_AHEAD}
              belowColor={index < reached ? RAIL_DONE : RAIL_AHEAD}
              node={<RailNode kind={kind} color={color} />}
            />
            <ColumnGlyph column={{ icon: step.icon, role: null }} size={14} color={on ? color : 'var(--color-fg-disabled)'} />
            <span className={`flex-1 min-w-0 truncate ${on ? 'text-fg-secondary' : 'text-fg-faint line-through decoration-fg-faint decoration-[1.5px]'}`}>{step.name}</span>
            {finished && (
              <Tooltip label={formatDateTime(step.finishedAt!)}>
                <span className="shrink-0 text-xs text-fg-faint whitespace-nowrap">
                  {formatRelativeTime(step.finishedAt!)}
                </span>
              </Tooltip>
            )}
            <span onClick={(event) => event.stopPropagation()}>
              <ToggleSwitch
                checked={on}
                onChange={() => onToggle(step)}
                disabled={!interactive}
                tip={`${on ? 'Skip' : 'Include'} ${step.name}`}
                disabledReason={refusal ?? undefined}
                ariaLabel={`${on ? 'Skip' : 'Include'} ${step.name}`}
                testId={`workflow-route-switch-${step.swimlaneId}`}
              />
            </span>
          </div>
        );
      })}
      <EndRow end="done" current={task.place === 'done'} color={doneColumnColor} icon={ends?.done?.icon ?? null} name={ends?.done?.name ?? 'Done'} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Where a linked task is, as its card strip names it: To Do until it starts, its column while it works. */
function LinkColumn({ task, projectName }: { task: WorkflowViewTask; projectName: string | null }) {
  const current = task.steps.find((step) => step.state === 'current');
  const prefix = projectName ? `${projectName} / ` : '';
  if (task.place === 'working' && current) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <ColumnGlyph column={{ icon: current.icon, role: null }} size={11} color={current.color} />
        {prefix}{current.name}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
      <Layers size={11} strokeWidth={1.75} className="text-fg-faint" />
      {prefix}To Do
    </span>
  );
}

function LinkRow({ linked, projectName, removeRefusal, onSelect, onRemove }: {
  linked: WorkflowViewTask;
  projectName: string | null;
  removeRefusal: string | null;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const number = linked.displayId ? <span className="shrink-0 font-mono text-xs text-fg-muted" data-testid="workflow-link-number">#{linked.displayId}</span> : null;
  return (
    <div className="flex items-stretch min-h-9 border border-edge/60 rounded-md bg-surface/35 overflow-hidden" data-testid="workflow-link-row" data-task-key={linked.key}>
      <button type="button" onClick={onSelect} className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 px-2.5 py-1.5 text-left hover:bg-surface-hover/30 transition-colors">
        {linked.place === 'done' ? (
          <span className="flex items-center gap-2 min-w-0">
            <CircleCheckBig size={14} strokeWidth={1.75} className="shrink-0" style={{ color: DONE_COLOR }} />
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-fg" data-testid="workflow-link-title">{linked.title}</span>
            {number}
          </span>
        ) : (
          <>
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-fg" data-testid="workflow-link-title">{linked.title}</span>
              {number}
            </span>
            <LinkColumn task={linked} projectName={projectName} />
          </>
        )}
      </button>
      <Tooltip label={tipLabel({ disabled: removeRefusal !== null, disabledReason: removeRefusal, tip: 'Remove link' })}>
        <button
          type="button"
          onClick={onRemove}
          disabled={removeRefusal !== null}
          aria-label="Remove link"
          className="w-9 shrink-0 flex items-center justify-center border-l border-edge/60 text-fg-muted enabled:hover:text-fg enabled:hover:bg-surface-hover/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="workflow-unlink"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

/** The dashed Add blocker button and its list of what this task can wait for. */
function AddBlocker({ detail, task, refusal, onAdd, projectNameOf }: {
  detail: WorkflowDetail;
  task: WorkflowViewTask;
  refusal: string | null;
  onAdd: (blockerKey: string) => void;
  projectNameOf: (viewTask: WorkflowViewTask) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => (open ? blockerCandidates(detail, task.key) : []), [open, detail, task.key]);
  const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, { mode: 'dropdown', strategy: 'fixed', matchTriggerWidth: true });

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open]);

  return (
    <>
      <Tooltip label={tipLabel({ disabled: refusal !== null, disabledReason: refusal, tip: 'Make this task wait for another' })} enabled={!open}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((current) => !current)}
          disabled={refusal !== null}
          className="flex items-center justify-center gap-1.5 w-full h-[30px] mt-2 rounded border border-dashed border-edge text-xs text-fg-faint enabled:hover:text-fg-muted enabled:hover:border-edge-input disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
          data-testid="workflow-add-blocker"
        >
          <Plus size={13} />Add blocker
        </button>
      </Tooltip>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        className="fixed z-[2147483646] max-h-72 overflow-y-auto bg-surface-raised border border-edge-input rounded-md shadow-xl p-1"
        data-testid="workflow-add-blocker-menu"
      >
        {candidates.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            onClick={() => {
              setOpen(false);
              onAdd(candidate.key);
            }}
            className="flex flex-col gap-0.5 w-full px-2.5 py-1.5 rounded text-left hover:bg-surface-hover/60"
            data-testid="workflow-add-blocker-option"
            data-task-key={candidate.key}
          >
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="flex-1 min-w-0 truncate text-[13px] text-fg">{candidate.title}</span>
              {candidate.displayId ? <span className="shrink-0 text-xs text-fg-muted">#{candidate.displayId}</span> : null}
            </span>
            <LinkColumn task={candidate} projectName={projectNameOf(candidate)} />
          </button>
        ))}
      </OverlayPopover>
    </>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface WorkflowInspectorProps {
  detail: WorkflowDetail;
  selectedTaskKey: string | null;
  /** The workflow agent's turn is running: what would change its plan waits. */
  planHeld: boolean;
  /**
   * The Done column's color on the workflow's home board, for the rail's last
   * row. A task on another board wears that board's (`otherBoardDoneColor`).
   */
  doneColumnColor: string;
  /** Tasks the board's search and filter leave showing; null shows all. */
  visibleKeys: ReadonlySet<string> | null;
  variant?: 'canvas' | 'taskDetail';
  onSelectTask: (key: string | null) => void;
  onOpenTask: (key: string) => void;
  onRequestRemove: (key: string) => void;
  onSetRoute: (key: string, columns: string[]) => void;
  onSetLink: (blockerKey: string, blockedKey: string, linked: boolean) => void;
  onRefuse: (message: string) => void;
  /** taskDetail only: the footer's Open workflow. */
  onOpenWorkflow?: () => void;
  /** Who approves one task's plans; null follows its plan columns. The control is read-only without it. */
  onSetTaskPlanApproval?: (key: string, planApproval: PlanApproval | null) => void;
}

export function WorkflowInspector(props: WorkflowInspectorProps) {
  const { detail, selectedTaskKey, variant = 'canvas' } = props;
  const task = selectedTaskKey ? findTask(detail, selectedTaskKey) : null;
  const frame = variant === 'canvas'
    ? 'shrink-0 border-l border-edge bg-surface-raised'
    : 'flex-1 min-h-0 bg-surface-raised';
  return (
    <aside
      className={`${frame} flex flex-col overflow-hidden`}
      style={variant === 'canvas' ? { width: INSPECTOR_WIDTH } : undefined}
      data-testid="workflow-inspector"
    >
      {task ? <TaskPanel {...props} task={task} /> : <RunOrderPanel {...props} />}
    </aside>
  );
}

function RunOrderRowMark({ task }: { task: Task }) {
  const view = useTaskCardViewModel(task);
  if (!view.isIdle) return null;
  return (
    <Tooltip label="Waiting for you">
      <span className="inline-flex shrink-0 text-attention" role="img" aria-label="Waiting for you"><ActivityMark mark="agent-idle" size={14} /></span>
    </Tooltip>
  );
}

const AUTOMATIC_TIP = 'Approve this task\'s plans for you. Questions the agent asks still wait.';
const MANUAL_TIP = 'You approve this task\'s plans.';

/**
 * A task's own plan approval, above its route. What is lit is what happens:
 * left alone, the value the plan columns on its route give
 * (`TaskPlanApproval.columnValue`); picking the other option sets it on the
 * task, and picking the columns' value again goes back to following them. The
 * lit option's tip says which, so the section carries no line of its own.
 *
 * Shown only while it can decide something: the route has a plan column and the
 * task has not passed it. Automatic is off where no plan column's agent can
 * approve plans, and the whole control waits while the workflow agent works.
 */
function TaskPlanApprovalSection({ task, held, onSetTaskPlanApproval }: {
  task: WorkflowViewTask;
  held: boolean;
  onSetTaskPlanApproval?: (key: string, planApproval: PlanApproval | null) => void;
}) {
  const view = task.planApproval;
  // Memoized: SegmentedControl keys its measuring effect on the options array.
  const options = useMemo((): SegmentedControlOption<PlanApproval>[] => {
    if (!view) return [];
    const litTip = translateText(taskPlanApprovalTip(view));
    const heldReason = held ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : undefined;
    const automaticOff = !view.canApprove && view.agentName ? translateText(agentCannotApprovePlans(view.agentName)) : undefined;
    return [
      {
        value: 'automatic',
        label: 'Automatic',
        tip: view.value === 'automatic' ? litTip : AUTOMATIC_TIP,
        testId: 'workflow-task-plan-approval-automatic',
        disabled: held || !view.canApprove,
        disabledReason: heldReason ?? automaticOff,
      },
      {
        value: 'manual',
        label: 'Manual',
        tip: view.value === 'manual' ? litTip : MANUAL_TIP,
        testId: 'workflow-task-plan-approval-manual',
        disabled: held,
        disabledReason: heldReason,
      },
    ];
  }, [view, held]);
  if (!view || view.passed) return null;
  return (
    <section
      className="px-4 py-3.5 border-b border-edge/60"
      data-testid="workflow-task-plan-approval-section"
      data-set={view.set ?? 'columns'}
    >
      <SectionHeading>Plan approval</SectionHeading>
      <SegmentedControl
        options={options}
        value={view.value}
        onChange={(next) => {
          // Against what is stored, not what is lit: a task set to Automatic on
          // an agent that cannot approve plans reads Manual, and picking Manual
          // must still clear it. Main normalizes too; this only skips a no-op call.
          const stored = normalizeTaskPlanApproval(next, view.columnValue);
          if (stored === view.set) return;
          onSetTaskPlanApproval?.(task.key, stored);
        }}
        disabled={held || !onSetTaskPlanApproval}
        fullWidth
        quiet
        ariaLabel="Plan approval"
        testId="workflow-task-plan-approval"
      />
    </section>
  );
}

function RunOrderPanel({ detail, visibleKeys, onSelectTask }: WorkflowInspectorProps) {
  const groups = useMemo(() => runOrder(detail)
    .map((group) => group.filter((task) => !visibleKeys || visibleKeys.has(task.key)))
    .filter((group) => group.length > 0), [detail, visibleKeys]);
  return (
    <>
      <div className="shrink-0 px-4 pt-3.5 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-faint">Run order</div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3" data-testid="workflow-run-order">
        {groups.length === 0 && (
          <div className="px-2 py-1.5 text-sm text-fg-faint">{detail.tasks.length === 0 ? 'No tasks yet.' : 'No task matches the search.'}</div>
        )}
        {groups.map((group, index) => (
          <div key={group[0].key} className="relative flex gap-2 pb-3">
            {index < groups.length - 1 && <span className="absolute left-[9px] top-5 -bottom-3 w-0.5 bg-edge" aria-hidden="true" />}
            <div className="shrink-0 pt-[5px]">
              <span
                className={`relative z-[1] inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-raised text-[11px] font-semibold ${index === 0 ? 'text-accent-fg' : 'text-fg-muted'}`}
                style={{ boxShadow: `inset 0 0 0 1.5px ${index === 0 ? 'var(--color-accent)' : 'var(--color-edge-input)'}` }}
              >
                {index + 1}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              {group.map((task) => (
                <Tooltip key={task.key} label="Select this task">
                  <button
                    type="button"
                    onClick={() => onSelectTask(task.key)}
                    className="flex items-center gap-2.5 w-full h-[30px] px-2 rounded-md text-left hover:bg-surface-hover/50 transition-colors"
                    data-testid="workflow-run-order-row"
                    data-task-key={task.key}
                  >
                    <span className="flex-1 min-w-0 truncate text-[13px] text-fg-secondary">{task.title}</span>
                    {task.task && <RunOrderRowMark task={task.task} />}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function TaskPanel({
  detail,
  task,
  planHeld,
  doneColumnColor,
  variant = 'canvas',
  onSelectTask,
  onOpenTask,
  onRequestRemove,
  onSetRoute,
  onSetLink,
  onRefuse,
  onOpenWorkflow,
  onSetTaskPlanApproval,
}: WorkflowInspectorProps & { task: WorkflowViewTask }) {
  const acrossBoards = detail.tasks.some((other) => other.projectId !== detail.homeProjectId);
  const projectNameOf = (viewTask: WorkflowViewTask): string | null => (acrossBoards ? detail.projectNames[viewTask.projectId] ?? null : null);
  const blockedBy = detail.links.filter((link) => link.blockedKey === task.key).map((link) => findTask(detail, link.blockerKey)).filter((linked): linked is WorkflowViewTask => linked !== null);
  const blocking = detail.links.filter((link) => link.blockerKey === task.key).map((link) => findTask(detail, link.blockedKey)).filter((linked): linked is WorkflowViewTask => linked !== null);
  const held = planHeld;
  // Memoized: with no other guard in the way it walks every task's links.
  const addRefusal = useMemo(() => (held ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : addBlockerRefusal(detail, task)), [held, detail, task]);
  const removeReason = held ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : removeRefusal(task);
  const onAnotherBoard = task.projectId !== detail.homeProjectId;
  const openLabel = variant === 'taskDetail' ? 'Open workflow' : onAnotherBoard ? `Open on ${detail.projectNames[task.projectId] ?? 'its board'}` : 'Open task';
  // A finished workflow has left the picker, so there is nothing to open; the
  // panel stays as the task's history, its controls disabled by their guards.
  const openRefusal = variant !== 'taskDetail'
    ? null
    : detail.workflow.state === 'done'
      ? `${detail.workflow.title} is complete.`
      : onOpenWorkflow ? null : 'Open the main window to see the workflow.';

  const toggleStep = (step: WorkflowRouteStep) => {
    const next = toggledRoute(task.steps, step.swimlaneId);
    if ('refusal' in next) onRefuse(next.refusal);
    else onSetRoute(task.key, next.columns);
  };

  return (
    <>
      {variant === 'canvas' && (
        <div className="flex items-center gap-2.5 h-[54px] shrink-0 px-4 border-b border-edge/60" data-testid="workflow-inspector-title">
          {task.task && <TaskActivityMark task={task.task} size={16} />}
          <Tooltip label={task.title}>
            <span className="flex-1 min-w-0 truncate text-base font-semibold text-fg">{task.title}</span>
          </Tooltip>
          {task.displayId ? <span className="shrink-0 text-[13px] text-fg-muted tabular-nums">#{task.displayId}</span> : null}
        </div>
      )}
      {variant === 'taskDetail' && (
        <div className="flex items-center gap-2 h-11 shrink-0 px-4 border-b border-edge/60" data-testid="workflow-panel-workflow">
          <WorkflowIcon size={16} className="shrink-0" style={{ color: workflowColor(detail.workflow.color_slot) }} />
          <Tooltip label={detail.workflow.title}>
            <span className="flex-1 min-w-0 truncate text-sm font-semibold text-fg">{detail.workflow.title}</span>
          </Tooltip>
          <WorkflowStateChip state={detail.workflow.state} />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <TaskPlanApprovalSection task={task} held={held} onSetTaskPlanApproval={onSetTaskPlanApproval} />
        <section className="px-4 py-3.5 border-b border-edge/60">
          <SectionHeading
            trailing={acrossBoards ? (
              <Tooltip label={detail.projectNames[task.projectId] ? `Columns on the ${detail.projectNames[task.projectId]} board` : 'Columns on its board'}>
                <span
                  className="ml-auto inline-flex items-center gap-1 text-xs font-medium normal-case tracking-normal text-fg-muted"
                  data-testid="workflow-route-board"
                >
                  <Folder size={12} />{detail.projectNames[task.projectId] ?? ''}
                </span>
              </Tooltip>
            ) : undefined}
          >
            Route
          </SectionHeading>
          <RouteRows task={task} held={held} onToggle={toggleStep} doneColumnColor={otherBoardDoneColor(detail, task) ?? doneColumnColor} ends={detail.boardEnds[task.projectId] ?? null} />
        </section>
        <section className={`px-4 py-3.5 ${blocking.length > 0 ? 'border-b border-edge/60' : ''}`}>
          <SectionHeading count={blockedBy.length}>Blocked by</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {blockedBy.map((linked) => (
              <LinkRow
                key={linked.key}
                linked={linked}
                projectName={projectNameOf(linked)}
                removeRefusal={held ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : unlinkRefusal(detail, linked.key, task.key)}
                onSelect={() => onSelectTask(linked.key)}
                onRemove={() => onSetLink(linked.key, task.key, false)}
              />
            ))}
          </div>
          {/* Keyed on its refusal, so a list that empties (or a guard that
              lands) while the menu is open closes it rather than leaving an
              empty menu on screen. */}
          <AddBlocker key={addRefusal ?? 'live'} detail={detail} task={task} refusal={addRefusal} onAdd={(blockerKey) => onSetLink(blockerKey, task.key, true)} projectNameOf={projectNameOf} />
        </section>
        {blocking.length > 0 && (
          <section className="px-4 py-3.5">
            <SectionHeading count={blocking.length}>Blocking</SectionHeading>
            <div className="flex flex-col gap-1.5">
              {blocking.map((linked) => (
                <LinkRow
                  key={linked.key}
                  linked={linked}
                  projectName={projectNameOf(linked)}
                  removeRefusal={held ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : unlinkRefusal(detail, task.key, linked.key)}
                  onSelect={() => onSelectTask(linked.key)}
                  onRemove={() => onSetLink(task.key, linked.key, false)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 shrink-0 px-4 py-3.5 whitespace-nowrap" data-testid="workflow-inspector-footer">
        <Tooltip label={tipLabel({ disabled: removeReason !== null, disabledReason: removeReason, tip: 'Take this task out of the workflow' })}>
          <button
            type="button"
            onClick={() => onRequestRemove(task.key)}
            disabled={removeReason !== null}
            className="inline-flex items-center justify-center gap-1.5 py-2 rounded border border-edge-input text-[13px] text-fg-secondary enabled:hover:bg-surface-hover/40 disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
            data-testid="workflow-remove-task"
          >
            <X size={14} />Remove
          </button>
        </Tooltip>
        {/* The tip is the full label, which the button can cut short, or the
            reason it is off. Only the reason is read, since the label is
            already the button's name. */}
        <Tooltip label={tipLabel({ disabled: openRefusal !== null, disabledReason: openRefusal, tip: openLabel })} describe={openRefusal !== null}>
          <button
            type="button"
            onClick={() => (variant === 'taskDetail' ? onOpenWorkflow?.() : onOpenTask(task.key))}
            disabled={openRefusal !== null}
            // The panel's main action wears the accent tint (as Add task does on
            // the canvas), not a fill: the view's one filled button is Start or Resume.
            className="inline-flex items-center justify-center gap-1.5 min-w-0 py-2 rounded border border-accent/40 bg-accent/20 enabled:hover:bg-accent/30 text-accent-fg text-[13px] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
            data-testid="workflow-open-task"
          >
            {variant === 'taskDetail' ? <WorkflowIcon size={14} className="shrink-0" /> : <SquareTerminal size={14} className="shrink-0" />}
            <span className="truncate">{openLabel}</span>
          </button>
        </Tooltip>
      </div>
    </>
  );
}
