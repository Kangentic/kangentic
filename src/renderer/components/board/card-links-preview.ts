import { useEffect, type RefObject } from 'react';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { BoardWorkflow } from '../../utils/board-workflow';

/**
 * A board card shows its workflow links while the pointer rests on it (#732
 * board 8c): after `LINKS_PREVIEW_DWELL_MS` on any part of the card the links
 * fade in, and leaving the card fades them out. Show workflow links in the
 * card's menu keeps them on screen, for following a line while scrolling, or
 * without a pointer. The overlay itself is `WorkflowLinksOverlay`.
 *
 * The listeners go on the card's root (the element carrying `data-task-id`)
 * as native events, attached from the workflow card's own body, so an
 * ordinary card carries none of this.
 */

/**
 * How long the pointer rests on a card before its links show. A pointer
 * crossing the board passes a card in about 50ms, so it sets nothing off; one
 * that stops on a card is looking at it.
 */
export const LINKS_PREVIEW_DWELL_MS = 400;

/**
 * Preview the links of the card that holds `anchorRef`. Mouse only (touch has
 * no hover), never starting with a button held, and nothing for a card with no
 * links. Kept links (the menu, a refused move) win over a preview, which the
 * store decides.
 *
 * A press that slides off the card is a drag starting, or a click wandering:
 * the preview holds until the button comes up, so a dragged card keeps its
 * lines (the overlay follows it), and ends then unless the pointer is back on
 * the card.
 */
export function useCardLinksPreview(anchorRef: RefObject<HTMLElement | null>, taskId: string, workflow: BoardWorkflow | null, enabled: boolean): void {
  const hasLinks = workflow?.hasLinks ?? false;
  const homeProjectId = workflow?.homeProjectId ?? null;
  const workflowId = workflow?.workflowId ?? null;

  useEffect(() => {
    const card = anchorRef.current?.closest<HTMLElement>('[data-task-id]');
    if (!enabled || !card || !hasLinks || !homeProjectId || !workflowId) return undefined;
    let timer: number | null = null;
    let hovering = false;
    const cancelTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const end = () => {
      if (!hovering) return;
      hovering = false;
      useWorkflowStore.getState().endPreview(taskId);
    };
    // After the button comes up, a tick later so the hover state is current.
    const release = () => {
      window.setTimeout(() => {
        if (!card.isConnected || !card.matches(':hover')) end();
      }, 0);
    };
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
      hovering = true;
      cancelTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void useWorkflowStore.getState().previewLinks(taskId, homeProjectId, workflowId);
      }, LINKS_PREVIEW_DWELL_MS);
    };
    const onLeave = (event: PointerEvent) => {
      cancelTimer();
      if (!hovering) return;
      if (event.buttons !== 0) {
        document.addEventListener('pointerup', release, { once: true });
        return;
      }
      end();
    };
    card.addEventListener('pointerenter', onEnter);
    card.addEventListener('pointerleave', onLeave);
    card.addEventListener('pointerdown', cancelTimer);
    // A card that moves lanes on its own re-mounts with no pointerleave, so its
    // pending preview and any preview it showed end with it.
    return () => {
      card.removeEventListener('pointerenter', onEnter);
      card.removeEventListener('pointerleave', onLeave);
      card.removeEventListener('pointerdown', cancelTimer);
      document.removeEventListener('pointerup', release);
      cancelTimer();
      end();
    };
  }, [anchorRef, taskId, enabled, hasLinks, homeProjectId, workflowId]);
}
