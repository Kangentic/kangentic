import { useEffect, type RefObject } from 'react';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { BoardWorkflow } from '../../utils/board-workflow';

/**
 * A board card shows its workflow links while the pointer rests on it (#732
 * board 8c): after `LINKS_PREVIEW_DWELL_MS` on any part of the card the links
 * fade in, and leaving the card fades them out. This is the board's one way to
 * a card's links; a refused move also shows them, and keeps them until Escape
 * or a click on empty board. Every link is also on the Workflows canvas and in
 * task detail's workflow panel. The overlay itself is `WorkflowLinksOverlay`.
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

/** How long after the button comes up a drop has landed: dnd-kit's drop animation and the column's settle. */
const DROP_LANDING_MS = 300;

/**
 * Preview the links of the card that holds `anchorRef`. Mouse only (touch has
 * no hover), never starting with a button held, and nothing for a card with no
 * links. Kept links (a refused move's) win over a preview, which the store
 * decides.
 *
 * A press on the card holds the preview until the button comes up, wherever
 * the pointer goes meanwhile, so a dragged card keeps its lines all the way
 * through the drag (the overlay follows it). The card tracks its own press
 * rather than trusting a leave event's `buttons`, which is not reliable during
 * a drag. When the button comes up, the preview stays while the pointer is on
 * the card where it landed, and ends when the pointer moves off it.
 */
export function useCardLinksPreview(anchorRef: RefObject<HTMLElement | null>, taskId: string, workflow: BoardWorkflow | null, enabled: boolean): void {
  const hasLinks = workflow?.hasLinks ?? false;
  const homeProjectId = workflow?.homeProjectId ?? null;
  const workflowId = workflow?.workflowId ?? null;

  useEffect(() => {
    const card = anchorRef.current?.closest<HTMLElement>('[data-task-id]');
    if (!enabled || !card || !hasLinks || !homeProjectId || !workflowId) return undefined;
    let timer: number | null = null;
    let landing: number | null = null;
    let hovering = false;
    let pressed = false;
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
    // The button came up. Where the pointer is is read once the drop has
    // landed: a reordered card moves under a pointer that has not moved, which
    // the hover state does not report until the pointer moves again.
    const onUp = (event: PointerEvent) => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      pressed = false;
      if (!hovering) return;
      const { clientX, clientY } = event;
      landing = window.setTimeout(() => {
        landing = null;
        const under = document.elementFromPoint(clientX, clientY);
        if (!card.isConnected || !under || !card.contains(under)) end();
      }, DROP_LANDING_MS);
    };
    const onDown = (event: PointerEvent) => {
      cancelTimer();
      if (event.button !== 0) return;
      pressed = true;
      // Capture, on the window: the drag's own listeners must not keep it from us.
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    };
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || pressed || event.buttons !== 0) return;
      hovering = true;
      cancelTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void useWorkflowStore.getState().previewLinks(taskId, homeProjectId, workflowId);
      }, LINKS_PREVIEW_DWELL_MS);
    };
    const onLeave = () => {
      cancelTimer();
      if (!hovering || pressed) return;
      end();
    };
    card.addEventListener('pointerenter', onEnter);
    card.addEventListener('pointerleave', onLeave);
    card.addEventListener('pointerdown', onDown);
    // A card that moves lanes on its own re-mounts with no pointerleave, so its
    // pending preview and any preview it showed end with it.
    return () => {
      card.removeEventListener('pointerenter', onEnter);
      card.removeEventListener('pointerleave', onLeave);
      card.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      cancelTimer();
      if (landing !== null) window.clearTimeout(landing);
      end();
    };
  }, [anchorRef, taskId, enabled, hasLinks, homeProjectId, workflowId]);
}
