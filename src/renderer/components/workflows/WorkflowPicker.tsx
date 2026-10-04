import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CircleDashed, ListTree, Pause } from 'lucide-react';
import type { WorkflowSummary } from '../../../shared/types';
import { OverlayPopover } from '../OverlayPopover';
import { ActivityMark } from '../ActivityMark';
import { Pill, TINTED_PILL_EDGE, TINTED_PILL_FILL } from '../Pill';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { workflowColor } from './workflow-graph';

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

function tasksText(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}`;
}

function StateChip({ summary }: { summary: WorkflowSummary }) {
  const state = summary.workflow.state;
  const shape = 'inline-flex items-center gap-1 h-5 px-1.5 rounded text-[11px] font-medium whitespace-nowrap shrink-0';
  if (state === 'running') {
    return (
      <span className={`${shape} text-active bg-active/10 ring-1 ring-inset ring-active/25`}>
        <ActivityMark mark="agent-working" size={12} />Running
      </span>
    );
  }
  if (state === 'paused') {
    return <span className={`${shape} text-fg-muted bg-surface-hover/60`}><Pause size={11} />Paused</span>;
  }
  return <span className={`${shape} text-fg-muted bg-surface-hover/60`}><CircleDashed size={11} />Not started</span>;
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

  const name = selected?.workflow.title ?? 'Workflows';
  const count = selected?.taskCount ?? 0;
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        title={`${name}, ${tasksText(count)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="workflow-picker"
        className={`flex items-center gap-2 h-[34px] shrink-0 px-3 rounded border bg-surface-control text-sm text-fg-tertiary transition-colors ${
          open ? 'border-accent' : 'border-edge-input hover:border-fg-faint/60'
        } ${controlClassName}`}
      >
        <ListTree size={14} className="shrink-0" style={{ color: selected ? workflowColor(selected.workflow.color_slot) : undefined }} />
        <span className="min-w-0 truncate text-left">{name}</span>
        <Pill
          size="sm"
          className={`shrink-0 border font-medium tabular-nums ${pillClassName}`}
          style={{ backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
        >
          {tasksText(count)}
        </Pill>
        <span className="flex-1" />
        <Chevron size={14} className="shrink-0 text-fg-muted" />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom left' : 'top left'}
        className="fixed z-[2147483646] w-[360px] max-h-[420px] overflow-y-auto bg-surface-raised border border-edge-input rounded-md shadow-xl py-1"
        data-testid="workflow-picker-menu"
      >
        <div role="listbox" aria-label="Workflows">
          {summaries.map((summary) => {
            const isSelected = summary.workflow.id === selected?.workflow.id;
            const started = summary.workflow.state !== 'draft';
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
                className={`flex w-full items-center gap-2.5 h-[44px] px-3 text-left transition-colors ${isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover/60'}`}
                data-testid="workflow-picker-option"
                data-workflow-id={summary.workflow.id}
              >
                <ListTree size={15} className="shrink-0" style={{ color: workflowColor(summary.workflow.color_slot) }} />
                <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-fg" title={summary.workflow.title}>{summary.workflow.title}</span>
                <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                  {started ? `${summary.doneCount} of ${summary.taskCount}` : tasksText(summary.taskCount)}
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
