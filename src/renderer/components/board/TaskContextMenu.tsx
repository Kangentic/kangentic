import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2, Inbox, Pencil, Archive, Copy, GitCompare, Workflow as WorkflowIcon, Ban, Columns3Cog, CirclePause, CirclePlay } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useToastStore } from '../../stores/toast-store';
import type { Task, Swimlane } from '../../../shared/types';
import type { SessionToggleRow } from '../../utils/session-toggle';
import { placeContextMenu, type MenuPlacement } from './context-menu-placement';
import { Tooltip } from '../Tooltip';

/**
 * Inline context menu shown on right-click of a task card. Offers copy-id,
 * then the top group (edit, show changes if a worktree exists, the session's
 * Pause or Resume, the column automations switch, and the row that takes you
 * to the task elsewhere or starts a workflow from it), move-to (for every
 * non-archived non-ghost target lane), and the bottom group: send-to-backlog,
 * archive, and delete.
 *
 * How a row picks its group: the bottom group holds only the larger,
 * destructive actions that take a task off the active board, ordered from
 * easiest to undo to permanent, Delete last. Everything else that acts on the
 * task, and leaves it on the board, goes in the top group.
 *
 * Positions itself at the click coordinates, then measures its rendered size
 * before paint and moves inside the window, 8px from each edge: a workflow
 * task's menu (its workflow rows plus every Move to row) is taller than any
 * fixed guess. A menu taller than the window scrolls. Closes on outside click
 * or Escape. The parent owns the `position` prop and the `onClose` callback.
 *
 * A row the task cannot take (a workflow's lock, a Resume main refuses in
 * Done or on an archived task) stays in place, disabled, with the reason as
 * its tooltip: controls never come and go with state. The whole row dims, its
 * text, icon and dot together, as one unavailable item. A row that does not
 * apply to this kind of task at all (the automations switch on a workflow
 * task, the session row on a task with no session) is not passed by its host.
 */

const ROW_CLASS = 'w-full px-3 py-1.5 text-sm text-left flex items-center gap-2 text-fg-secondary';
const LIVE_ROW_CLASS = `${ROW_CLASS} hover:bg-surface-hover/40`;
const DISABLED_ROW_CLASS = `${ROW_CLASS} opacity-40 cursor-not-allowed`;

export function TaskContextMenu({
  position,
  task,
  swimlanes,
  onEdit,
  onShowChanges,
  onMoveTo,
  onSendToBacklog,
  onArchive,
  onDelete,
  onClose,
  navigationItem,
  moveRefusal,
  sendAwayRefusal,
  onNewWorkflow,
  onToggleAutomations,
  sessionToggle,
  testId = 'task-context-menu',
}: {
  /** Root `data-testid`, so each host can address its own instance. */
  testId?: string;
  /** The row that takes the user to this task somewhere else, in the top group
   *  after the automations row and before New workflow: Open workflow on a
   *  board card, Open on board in the Agent Monitor and on the Workflows canvas.
   *  Lets those hosts reuse this whole menu rather than maintaining a second,
   *  thinner one that drifts from the board's. */
  navigationItem?: React.ReactNode;
  position: { x: number; y: number };
  task: Task;
  swimlanes: Swimlane[];
  onEdit: () => void;
  onShowChanges: () => void;
  onMoveTo: (targetSwimlaneId: string) => void;
  onSendToBacklog: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Why a Move to row is refused (a workflow's lock); null leaves it live. */
  moveRefusal?: (targetSwimlaneId: string) => string | null;
  /** Why Backlog and Archive are refused: each would take the task out of its workflow. */
  sendAwayRefusal?: string | null;
  /** New workflow from this task, offered on a To Do card that is in no workflow. */
  onNewWorkflow?: () => void;
  /**
   * Flip the task's column automations switch. Passed for every task outside a
   * workflow (`automationsSwitchRefusal` is null), whatever column or state it
   * is in; a workflow task's host leaves it out, since its Pause holds it.
   */
  onToggleAutomations?: () => void;
  /**
   * The session's Pause or Resume (`sessionToggleRowFor`), with the host's
   * handler. One object rather than a bare callback: the label depends on
   * session state `task` does not carry. A host leaves it out where the rule
   * offers no row (To Do, or no session lifecycle).
   */
  sessionToggle?: SessionToggleRow & { onToggle: () => void };
}) {
  const { t } = useLingui();
  const menuRef = useRef<HTMLDivElement>(null);
  const displayId = task.display_id;

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose]);

  const moveTargets = swimlanes.filter(
    (lane) => lane.id !== task.swimlane_id && !lane.is_archived && !lane.is_ghost,
  );

  // The press point by value: `position` is a new object on each render of the host.
  const { x: pointerX, y: pointerY } = position;
  const [placement, setPlacement] = useState<MenuPlacement>({ left: pointerX, top: pointerY, maxHeight: undefined });
  // Measured before paint, so the menu never shows at the press point first.
  // `offset*` sizes, not the bounding rect: the entrance animation scales the
  // menu, and a rect read on mount would be the scaled-down size.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const borderHeight = menu.offsetHeight - menu.clientHeight;
    setPlacement(placeContextMenu(
      { x: pointerX, y: pointerY },
      { width: menu.offsetWidth, height: menu.scrollHeight + borderHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [pointerX, pointerY]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[180px] overlay-popover-in"
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        overflowY: placement.maxHeight === undefined ? undefined : 'auto',
        transformOrigin: 'top left',
      }}
      data-dismissable-layer
      data-testid={testId}
    >
      <button
        type="button"
        onClick={() => {
          // The copied text stays English: it is pasted as an identifier (into an
          // agent prompt, a commit, a chat), not read as UI.
          navigator.clipboard.writeText(`Task #${task.display_id}`);
          useToastStore.getState().addToast({ title: t`Task ID copied`, message: `#${task.display_id}`, variant: 'info' });
          onClose();
        }}
        className="w-full px-3 py-1.5 text-sm font-mono text-fg-faint hover:text-fg-secondary transition-colors flex items-center gap-2 cursor-pointer"
        data-testid="context-copy-task-id"
      >
        <Copy size={14} />
        <Trans>Task #{displayId}</Trans>
      </button>
      <div className="border-t border-edge my-1" />
      <button
        type="button"
        onClick={() => { onEdit(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="context-edit-task"
      >
        <Pencil size={14} className="text-fg-faint" />
        <Trans>Edit</Trans>
      </button>

      {task.worktree_path && (
        <button
          type="button"
          onClick={() => { onShowChanges(); onClose(); }}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
          data-testid="context-show-changes"
        >
          <GitCompare size={14} className="text-fg-faint" />
          <Trans>Show changes</Trans>
        </button>
      )}

      {sessionToggle && (
        <Tooltip label={sessionToggle.refusal ?? ''}>
          <button
            type="button"
            onClick={() => { if (sessionToggle.refusal) return; sessionToggle.onToggle(); onClose(); }}
            aria-disabled={sessionToggle.refusal ? true : undefined}
            className={sessionToggle.refusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
            data-testid="context-toggle-session"
            data-session-state={sessionToggle.sessionState}
          >
            {sessionToggle.direction === 'pause'
              ? <CirclePause size={14} className="text-fg-faint" />
              : <CirclePlay size={14} className="text-fg-faint" />}
            {sessionToggle.direction === 'pause' ? <Trans>Pause session</Trans> : <Trans>Resume session</Trans>}
          </button>
        </Tooltip>
      )}

      {onToggleAutomations && (
        <button
          type="button"
          onClick={() => { onToggleAutomations(); onClose(); }}
          className={LIVE_ROW_CLASS}
          data-testid="context-toggle-automations"
          data-automations-disabled={task.automations_disabled ? 'true' : 'false'}
        >
          {task.automations_disabled
            ? <Columns3Cog size={14} className="text-fg-faint" />
            : <Ban size={14} className="text-fg-faint" />}
          {task.automations_disabled ? <Trans>Enable automations</Trans> : <Trans>Disable automations</Trans>}
        </button>
      )}

      {navigationItem}

      {onNewWorkflow && (
        <button
          type="button"
          onClick={() => { onNewWorkflow(); onClose(); }}
          className={LIVE_ROW_CLASS}
          data-testid="context-new-workflow"
        >
          <WorkflowIcon size={14} className="text-fg-faint" />
          <Trans>New workflow</Trans>
        </button>
      )}

      {moveTargets.length > 0 && (
        <>
          <div className="border-t border-edge my-1" />
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            <Trans>Move to</Trans>
          </div>
          {moveTargets.map((lane) => {
            const refusal = moveRefusal?.(lane.id) ?? null;
            return (
              <Tooltip key={lane.id} label={refusal ?? ''}>
                <button
                  type="button"
                  onClick={() => { if (refusal) return; onMoveTo(lane.id); onClose(); }}
                  aria-disabled={refusal ? true : undefined}
                  className={refusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
                  data-testid="context-move-to"
                >
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: lane.color }}
                  />
                  {lane.name}
                </button>
              </Tooltip>
            );
          })}
        </>
      )}

      <div className="border-t border-edge my-1" />

      <Tooltip label={sendAwayRefusal ?? ''}>
        <button
          type="button"
          onClick={() => { if (sendAwayRefusal) return; onSendToBacklog(); }}
          aria-disabled={sendAwayRefusal ? true : undefined}
          className={sendAwayRefusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
          data-testid="context-send-to-backlog"
        >
          <Inbox size={14} className="text-fg-faint" />
          <Trans context="Action">Backlog</Trans>
        </button>
      </Tooltip>
      <Tooltip label={sendAwayRefusal ?? ''}>
        <button
          type="button"
          onClick={() => { if (sendAwayRefusal) return; onArchive(); onClose(); }}
          aria-disabled={sendAwayRefusal ? true : undefined}
          className={sendAwayRefusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
          data-testid="context-archive-task"
        >
          <Archive size={14} className="text-fg-faint" />
          <Trans>Archive</Trans>
        </button>
      </Tooltip>

      <button
        type="button"
        onClick={() => { onDelete(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-red-400 text-left hover:bg-red-400/10 flex items-center gap-2"
        data-testid="context-delete-task"
      >
        <Trash2 size={14} />
        <Trans>Delete</Trans>
      </button>
    </div>
  );
}
