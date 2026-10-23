import { CSS } from '@dnd-kit/utilities';

/**
 * A resting card's transform, spelled exactly as dnd-kit spells its own zero
 * transform. When a drag starts, dnd-kit gives every card in the dragged
 * card's column that zero transform and sets the sortable `transition` in the
 * same commit. The old resting value, `translate3d(0, 0, 0)`, is the same
 * matrix but a different value to the browser, so each of those cards started
 * a 200ms transition from identity to identity: at 90 workflow cards in To Do,
 * a 3ms style pass and about 5ms of paint and layerize on the frame that first
 * draws the overlay (`scripts/drag-perf-rig.mjs`, W100). Matching strings start
 * none. See docs/audits/board-drag-perf-audit.md.
 *
 * A module of its own, not an export of `TaskCard.tsx`: a component module
 * that also exports a value is no Fast Refresh boundary, so every edit to the
 * card would reload the whole app in dev.
 */
export const RESTING_TRANSFORM = CSS.Transform.toString({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
