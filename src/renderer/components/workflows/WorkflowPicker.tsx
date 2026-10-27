import React, { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronUp, CircleCheckBig, CircleDashed, Pause, Workflow as WorkflowIcon } from 'lucide-react';
import type { WorkflowState, WorkflowSummary } from '../../../shared/types';
import { OverlayPopover } from '../OverlayPopover';
import { ActivityMark } from '../ActivityMark';
import { Tooltip } from '../Tooltip';
import { Pill, TINTED_PILL_EDGE, TINTED_PILL_FILL } from '../Pill';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { workflowColor } from './workflow-graph';
import { tasksText } from './workflow-text';
import { useSessionStore } from '../../stores/session-store';
import { requiresUserInteraction } from '../../../shared/activity-state';
import { formatClockTime } from '../../lib/datetime';

/**
 * The workflow picker: which workflow the view shows, among the project's
 * unfinished ones. A fixed width, so the header never shifts when the
 * workflow changes: a long name truncates (its tooltip holds it all) while the
 * icon, the task count and the chevron never shrink. The count is a pill with
 * its noun ("9 tasks"), tinted from the control's own text color the way a
 * label pill is from its label's.
 *
 * The open menu lists every unfinished workflow with its state: Running (the
 * working ring the header's Running button spins, without its pause bars, since
 * a row pauses nothing), Paused, or Not started. A finished workflow leaves the
 * list. The menu portals to the body so no clipping ancestor cuts it
 * (popover-escapes-clipping.md).
 */

/** A workflow's state as a list row or a panel names it (a header says it with its buttons instead). */
export function WorkflowStateChip({ state }: { state: WorkflowState }) {
  const shape = 'inline-flex items-center gap-1 h-5 px-1.5 rounded text-[11px] font-medium whitespace-nowrap shrink-0';
  if (state === 'running') {
    return (
      <span className={`${shape} text-active bg-active/10 ring-1 ring-inset ring-active/25`} data-testid="workflow-state-chip" data-state={state}>
        <ActivityMark mark="agent-working" size={12} /><Trans context="workflow state">Running</Trans>
      </span>
    );
  }
  // Paused and Not started: the Running chip's tint and ring, in grey (board 11).
  const grey = `${shape} text-fg-muted bg-fg-muted/10 ring-1 ring-inset ring-fg-muted/25`;
  if (state === 'paused') {
    return <span className={grey} data-testid="workflow-state-chip" data-state={state}><Pause size={11} /><Trans context="workflow state">Paused</Trans></span>;
  }
  if (state === 'done') {
    return <span className={`${shape} text-fg-muted bg-surface-hover/60`} data-testid="workflow-state-chip" data-state={state}><CircleCheckBig size={11} /><Trans context="workflow state">Complete</Trans></span>;
  }
  return <span className={grey} data-testid="workflow-state-chip" data-state={state}><CircleDashed size={11} /><Trans context="workflow state">Not started</Trans></span>;
}

function StateChip({ summary }: { summary: WorkflowSummary }) {
  return <WorkflowStateChip state={summary.workflow.state} />;
}

/**
 * The line under a row's name (board 11): when a paused workflow paused
 * ("Paused yesterday 18:20"); else what the workflow's own agent is doing
 * ("Agent idle, last message 10:44"), or, with no agent running, how many of a
 * running workflow's tasks wait for the user ("2 idle"). Nothing otherwise.
 */
function useAgentNote(summary: WorkflowSummary): string | null {
  const { t } = useLingui();
  const agent = summary.agent ?? null;
  const running = summary.workflow.state === 'running';
  // A count, so the selector's answer is a primitive and a row re-renders only when it changes.
  const idleTasks = useSessionStore((state) => {
    if (agent || !running) return 0;
    let count = 0;
    for (const session of state.sessions) {
      if (session.status !== 'running' || !(session.taskId in summary.boardTasks)) continue;
      if (requiresUserInteraction(state.sessionActivity[session.id])) count += 1;
    }
    return count;
  });
  // A workflow paused before `paused_at` existed has no time, and falls through to its agent.
  const pausedAt = summary.workflow.state === 'paused' ? summary.workflow.paused_at ?? null : null;
  if (pausedAt) {
    const pausedTime = formatClockTime(pausedAt);
    return t`Paused ${pausedTime}`;
  }
  if (agent?.state === 'active') return t`Agent active`;
  if (agent?.state === 'paused') return t`Agent paused`;
  // activity-state-ok: the workflow agent's own summary state, one label per state, not an idle-vs-active bucket.
  if (agent?.state === 'idle') {
    if (!agent.lastReplyAt) return t`Agent idle`;
    const lastMessageTime = formatClockTime(agent.lastReplyAt);
    return t`Agent idle, last message ${lastMessageTime}`;
  }
  return idleTasks > 0 ? t`${idleTasks} idle` : null;
}

function PickerRowName({ summary }: { summary: WorkflowSummary }) {
  const note = useAgentNote(summary);
  return (
    <span className="flex-1 min-w-0">
      <Tooltip label={summary.workflow.title}>
        <span className="block truncate text-[13px] font-medium text-fg">{summary.workflow.title}</span>
      </Tooltip>
      {note && <span className="block truncate text-[11px] text-fg-faint" data-testid="workflow-picker-note">{note}</span>}
    </span>
  );
}

interface WorkflowPickerProps {
  summaries: WorkflowSummary[];
  selected: WorkflowSummary | null;
  onSelect: (workflowId: string) => void;
  /** Container-query classes for the closed control and its count pill (the header's width ladder). */
  controlClassName: string;
  pillClassName: string;
}

export function WorkflowPicker({ summaries, selected, onSelect, controlClassName, pillClassName }: WorkflowPickerProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'below',
    preferRight: false,
  });

  useEffect(() => {
    if (!open) return;
    // Capture phase, and both refs: the menu is portaled out of the trigger's
    // subtree, so a click inside it would otherwise read as outside.
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Escape closes the menu and nothing else (keybindings-registry.md: an
    // open menu consumes its own Escape).
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open]);

  const name = selected?.workflow.title ?? t`Workflows`;
  const count = selected?.taskCount ?? 0;
  const countText = tasksText(count);
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <>
      <Tooltip label={t`${name}, ${countText}`} enabled={!open}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="workflow-picker"
          className={`flex items-center gap-2 h-[34px] shrink-0 px-3 rounded border bg-surface-control text-sm text-fg-tertiary transition-colors ${
            open ? 'border-accent' : 'border-edge-input hover:border-fg-faint/60'
          } ${controlClassName}`}
        >
          <WorkflowIcon size={14} className="shrink-0" style={{ color: selected ? workflowColor(selected.workflow.color_slot) : undefined }} />
          <span className="min-w-0 truncate text-left">{name}</span>
          <Pill
            size="sm"
            className={`shrink-0 border font-medium tabular-nums ${pillClassName}`}
            style={{ backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
          >
            {countText}
          </Pill>
          <span className="flex-1" />
          <Chevron size={14} className="shrink-0 text-fg-muted" />
        </button>
      </Tooltip>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom left' : 'top left'}
        className="fixed z-[2147483646] w-[360px] max-h-[420px] overflow-y-auto bg-surface-raised border border-edge-input rounded-md shadow-xl py-1"
        data-testid="workflow-picker-menu"
      >
        <div role="listbox" aria-label={t`Workflows`}>
          {summaries.map((summary) => {
            const isSelected = summary.workflow.id === selected?.workflow.id;
            const started = summary.workflow.state !== 'draft';
            // Named locals, so the translator reads {doneCount} and {taskCount}.
            const { doneCount, taskCount } = summary;
            return (
              <button
                key={summary.workflow.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  setOpen(false);
                  onSelect(summary.workflow.id);
                }}
                className={`flex w-full items-center gap-2.5 h-[52px] px-3 text-left transition-colors ${isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover/60'}`}
                data-testid="workflow-picker-option"
                data-workflow-id={summary.workflow.id}
              >
                <WorkflowIcon size={15} className="shrink-0" style={{ color: workflowColor(summary.workflow.color_slot) }} />
                <PickerRowName summary={summary} />
                <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                  {started ? t`${doneCount} of ${taskCount}` : tasksText(taskCount)}
                </span>
                <StateChip summary={summary} />
              </button>
            );
          })}
        </div>
      </OverlayPopover>
    </>
  );
}
