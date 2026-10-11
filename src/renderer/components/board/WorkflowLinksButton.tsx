import React, { useCallback, useEffect, useRef } from 'react';
import { Link2 } from 'lucide-react';
import { WORKFLOW_REFUSALS } from '../../../shared/workflow-refusals';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { BoardWorkflow } from '../../utils/board-workflow';

/**
 * A board card's way to its workflow links without a right-click (#732 board
 * 8c, option C). Resting the pointer on the card's strip previews them until
 * the pointer leaves the strip; the links button at the strip's right end
 * keeps them on screen while the user scrolls to follow a line, and a second
 * click hides them. The overlay itself is `WorkflowLinksOverlay`.
 *
 * The button's icon is the accent whenever this card's links are on screen,
 * previewed or kept, so a preview says where it came from; kept, it is also
 * outlined and tinted, the app's pressed look (Resume session's tint). Its
 * shape never changes: the border is there, transparent, at rest.
 */

/**
 * How long the pointer rests on a strip before its links show. A pointer
 * crossing the board passes a strip in about 50ms, so it sets nothing off; one
 * that stops on a strip is asking.
 */
export const LINKS_PREVIEW_DWELL_MS = 400;

type LinksState = 'off' | 'shown' | 'kept';

function useLinksState(taskId: string): LinksState {
  return useWorkflowStore((state) => {
    if (state.linkFocus?.taskId !== taskId) return 'off';
    return state.linkFocus.kept ? 'kept' : 'shown';
  });
}

interface StripHoverHandlers {
  onPointerEnter?: (event: React.PointerEvent) => void;
  onPointerLeave?: () => void;
  onPointerDown?: () => void;
}

/**
 * The strip's hover preview. Mouse only (touch has no hover), never with a
 * button held (a press is a click or a card drag starting, and a drag clears
 * the links), and nothing for a card with no links. Kept links win over a
 * preview, which the store decides.
 */
export function useLinksPreview(taskId: string, workflow: BoardWorkflow | null, enabled: boolean): StripHoverHandlers {
  const timer = useRef<number | null>(null);
  const hovering = useRef(false);
  const cancelTimer = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // A card that moves lanes on its own re-mounts with no pointerleave, so its
  // pending preview and any preview it showed end with it.
  useEffect(() => () => {
    cancelTimer();
    if (!hovering.current) return;
    hovering.current = false;
    useWorkflowStore.getState().endPreview(taskId);
  }, [taskId, cancelTimer]);

  if (!enabled || !workflow?.hasLinks) return {};
  const { homeProjectId, workflowId } = workflow;
  return {
    onPointerEnter: (event) => {
      if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
      hovering.current = true;
      cancelTimer();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void useWorkflowStore.getState().previewLinks(taskId, homeProjectId, workflowId);
      }, LINKS_PREVIEW_DWELL_MS);
    },
    onPointerLeave: () => {
      cancelTimer();
      if (!hovering.current) return;
      hovering.current = false;
      useWorkflowStore.getState().endPreview(taskId);
    },
    onPointerDown: cancelTimer,
  };
}

const BUTTON_CLASS = 'inline-flex items-center justify-center w-5 h-5 rounded-[5px] border transition-colors';
const STATE_CLASS: Record<LinksState, string> = {
  off: 'border-transparent text-fg-faint hover:text-accent-fg',
  shown: 'border-transparent text-accent-fg',
  kept: 'border-accent/40 bg-accent/20 text-accent-fg',
};
const DISABLED_CLASS = 'border-transparent text-fg-faint opacity-40 cursor-not-allowed';

/** The links button at the right end of a board card's strip. */
export function WorkflowLinksButton({ taskId, displayId, workflow, interactive }: {
  taskId: string;
  displayId: number;
  workflow: BoardWorkflow;
  /** False on the drag overlay's and the flying card's copies: drawn, inert. */
  interactive: boolean;
}) {
  const state = useLinksState(taskId);
  const refusal = workflow.hasLinks ? null : WORKFLOW_REFUSALS.noLinks(`#${displayId}`);
  const onClick = (event: React.MouseEvent) => {
    // A click on the card opens its task; this one is the button's own.
    event.stopPropagation();
    if (!interactive || refusal) return;
    void useWorkflowStore.getState().toggleKeptLinks(taskId, workflow.homeProjectId, workflow.workflowId);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show workflow links"
      aria-pressed={state === 'kept'}
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? 'Show workflow links'}
      className={`${BUTTON_CLASS} ${refusal ? DISABLED_CLASS : STATE_CLASS[state]}`}
      data-testid="workflow-links-button"
      data-links-state={refusal ? 'none' : state}
    >
      <Link2 size={12} />
    </button>
  );
}
