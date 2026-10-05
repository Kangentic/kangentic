import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Wrench } from 'lucide-react';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import { ByToolTable } from '../shared/ByToolTable';
import type { PerToolStat } from '../../../shared/types';

/**
 * Live per-tool breakdown popover for the ContextBar's tool-call pill.
 *
 * Mirrors ContextBarPopover's positioning (opens above, since the bar is
 * pinned to the bottom of its container) and dismissal (capture-phase
 * outside-click + Escape with stopPropagation so the parent dialog does not
 * also close), but renders the shared `ByToolTable` fed by two on-demand
 * pulls: `sessions.getToolBreakdown` (the live counts and durations, instant)
 * and `sessions.getToolResultTokens` (per-tool result-token estimates read from
 * the agent's transcript in the retrieval worker, merged on by tool name). Both
 * refetch whenever `refreshSignal` (the live tool-call count) changes, so the
 * table stays current while open; nothing runs while it is closed.
 *
 * The rows arrive after the popover has mounted and been measured in its empty
 * state. `usePopoverPosition` anchors the fixed popover on its trigger-facing
 * edge, so they grow it upward, and the size caps read the room the hook
 * publishes so a short window scrolls inside the popover.
 */
export function ToolBreakdownPopover({
  triggerRef,
  sessionId,
  refreshSignal,
  onClose,
  testId,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  sessionId: string;
  /** Live tool-call count; a change triggers a refetch so the table stays current. */
  refreshSignal: number;
  onClose: () => void;
  testId?: string;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<PerToolStat[]>([]);
  const [resultTokensByTool, setResultTokensByTool] = useState<Record<string, number> | null>(null);
  // Portal + fixed, matching ContextBarPopover. `fixed` alone is not enough
  // here: the ContextBar's own container carries `[transform:translateZ(0)]`,
  // which makes it a containing block for fixed descendants, so the popover has
  // to leave the subtree entirely. `preferVertical: 'above'` stays - the bar is
  // pinned to the bottom of its pane.
  const { style: popoverStyle, placement } = usePopoverPosition(triggerRef, popoverRef, true, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'above',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.sessions.getToolBreakdown(sessionId);
        if (!cancelled) setRows(result);
      } catch {
        // Session may have exited between open and fetch; keep last-known rows.
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, refreshSignal]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.sessions.getToolResultTokens(sessionId);
        // Null means no readable transcript: keep the last-known estimates.
        if (!cancelled && result) setResultTokensByTool(result);
      } catch {
        // Best-effort: the table renders without the Tokens column.
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, refreshSignal]);

  const displayRows = useMemo(() => {
    if (!resultTokensByTool) return rows;
    return rows.map((row) => {
      const resultTokens = resultTokensByTool[row.toolName];
      return resultTokens === undefined ? row : { ...row, resultTokens };
    });
  }, [rows, resultTokensByTool]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [onClose, triggerRef]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  return (
    <OverlayPopover
      open
      popoverRef={popoverRef}
      style={popoverStyle}
      portal
      transformOrigin={`${placement.vertical === 'above' ? 'bottom' : 'top'} ${placement.horizontal}`}
      className="fixed z-[2147483646] bg-surface-raised border border-edge rounded-lg shadow-xl w-max max-w-[min(480px,var(--popover-available-width,480px))] max-h-[min(340px,var(--popover-available-height,340px))] overflow-y-auto"
      data-testid={testId}
    >
      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint flex items-center gap-1.5">
        <Wrench size={11} />
        Tool calls
      </div>
      {displayRows.length > 0 ? (
        <ByToolTable rows={displayRows} />
      ) : (
        <div className="px-3 py-3 text-xs text-fg-disabled whitespace-nowrap">No tool calls yet</div>
      )}
    </OverlayPopover>
  );
}
