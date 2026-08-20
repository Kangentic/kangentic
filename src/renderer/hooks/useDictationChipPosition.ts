import { useLayoutEffect, useState, type RefObject } from 'react';
import { useDictationStore } from '../stores/dictation-store';
import {
  placeDictationChip,
  resolveDictationAnchor,
  type ChipPlacement,
  type DictationAnchorTarget,
} from '../utils/dictation-anchor';

/**
 * Space between the anchor and the chip.
 *
 * Generous on purpose. The anchor is the FIELD, but a field usually sits inside
 * chrome the chip must also clear, and there is no generic way to measure that:
 * the Browser pane's note input is inset from its toolbar by exactly 7px (a 1px
 * top border plus 6px of padding), so an 8px gap put the chip's bottom edge
 * flush on the toolbar's border line - touching it rather than sitting above it.
 * 16 leaves visible daylight there and still reads as attached everywhere else.
 */
const ANCHOR_GAP_PX = 16;

/**
 * Live viewport position for the dictation chip, or null when nothing on screen
 * can be anchored to (no target, or its pane closed mid-utterance) - the caller
 * then falls back to a fixed corner.
 *
 * Re-measures every animation frame rather than subscribing to anything, because
 * every input is external to React: the user can drag, resize, or re-tile the
 * window mid-sentence, and a growing note field pushes its own top edge up. The
 * loop only runs while a chip is mounted, which is the few seconds a dictation
 * lasts. State updates only on an actual change, so a still target costs one
 * `getBoundingClientRect` per frame and no renders - and a terminal target IS
 * still by construction, since its anchor comes from the pane rather than from
 * anything the streaming transcript touches.
 *
 * The chip's own size is read from `chipRef` rather than assumed: the placement
 * needs it to flip above and to clamp inside the pane, and the chip's width
 * changes with its label ("Listening" vs "Preparing model... 41%").
 */
export function useDictationChipPosition(
  chipRef: RefObject<HTMLElement | null>,
): ChipPlacement | null {
  const targetKind = useDictationStore((state) => state.targetKind);
  const targetSessionId = useDictationStore((state) => state.targetSessionId);
  const targetElement = useDictationStore((state) => state.targetElement);
  const contentEditableElement = useDictationStore((state) => state.contentEditableElement);
  const guestAnchor = useDictationStore((state) => state.guestAnchor);
  const [placement, setPlacement] = useState<ChipPlacement | null>(null);

  // Layout effect, not a plain effect, so the FIRST measurement lands before the
  // browser paints. The chip mounts at its fallback corner; measuring in a plain
  // effect (or in the rAF below) would let that corner paint once and then jump
  // to the anchor, which the entrance animation makes very visible.
  useLayoutEffect(() => {
    // Rebuilt here rather than stored, so this hook never holds a target across
    // a change: the store's three fields are the source of truth.
    // A guest field reports `targetKind: 'input'` (it IS one, as far as every
    // consumer but this hook cares), and is told apart here by carrying a
    // `guestAnchor` instead of a host element.
    const target: DictationAnchorTarget | null = guestAnchor
      ? { kind: 'guest', webview: guestAnchor.webview, rect: guestAnchor.rect }
      : targetKind === 'input' && (targetElement ?? contentEditableElement)
        // Both anchor by their own rect; the anchor layer never needs to know
        // which write mechanism the sink will use.
        ? { kind: 'input', element: (targetElement ?? contentEditableElement) as Element }
        : targetKind === 'terminal' && targetSessionId
          ? { kind: 'terminal', sessionId: targetSessionId }
          : null;

    const measure = (): void => {
      const chip = chipRef.current;
      const anchor = resolveDictationAnchor(target);
      if (!chip || !anchor) {
        setPlacement((previous) => (previous === null ? previous : null));
        return;
      }
      const chipRect = chip.getBoundingClientRect();
      // Zero-sized before layout. Keep the previous answer rather than placing
      // against nothing.
      if (chipRect.width === 0 || chipRect.height === 0) return;
      const next = placeDictationChip({
        anchor,
        chipWidth: chipRect.width,
        chipHeight: chipRect.height,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap: ANCHOR_GAP_PX,
      });
      setPlacement((previous) => (
        previous
          && previous.left === next.left
          && previous.top === next.top
          && previous.placement === next.placement
          ? previous
          : next
      ));
    };

    measure();
    let frame = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      measure();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [chipRef, targetKind, targetSessionId, targetElement, contentEditableElement, guestAnchor]);

  return placement;
}
