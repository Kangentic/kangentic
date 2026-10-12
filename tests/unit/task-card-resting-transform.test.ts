/**
 * A board card's resting transform (`RESTING_TRANSFORM`, from
 * `resting-transform.ts`, which TaskCard.tsx reads).
 *
 * When a drag starts, dnd-kit gives every card in the dragged card's column its
 * own zero transform and sets the sortable `transition` in the same commit. A
 * resting card written as `translate3d(0, 0, 0)` is the same matrix but a
 * different STRING to the browser, so each of those cards started a 200ms
 * transition from identity to identity (about 5ms of paint and layerize on the
 * frame that first draws the overlay at 90 workflow cards in To Do). Spelling
 * the resting value exactly as dnd-kit spells its zero starts none.
 *
 * Nothing here renders a card: the claim is that two strings are equal, and that
 * is a unit-sized fact. The second oracle is the library's own sortable strategy,
 * so the pin follows dnd-kit if it ever changes how it writes a zero.
 */
import { describe, it, expect } from 'vitest';
import { CSS } from '@dnd-kit/utilities';
import { verticalListSortingStrategy } from '@dnd-kit/sortable';
import fs from 'node:fs';
import path from 'node:path';
import { RESTING_TRANSFORM } from '../../src/renderer/components/board/resting-transform';

function rect(top: number): { top: number; left: number; bottom: number; right: number; width: number; height: number } {
  return { top, left: 0, bottom: top + 80, right: 300, width: 300, height: 80 };
}

describe('RESTING_TRANSFORM', () => {
  it('is the string dnd-kit writes for its own zero transform', () => {
    expect(RESTING_TRANSFORM).toBe(CSS.Transform.toString({ x: 0, y: 0, scaleX: 1, scaleY: 1 }));
  });

  it('is what dnd-kit hands a card its list strategy does not displace', () => {
    const rects = [rect(0), rect(90), rect(180)];
    // Card 0 is lifted and hovers over itself, so the card at index 2 neither
    // shifts up nor down: the strategy answers with its zero transform.
    const bystander = verticalListSortingStrategy({
      activeIndex: 0,
      activeNodeRect: rects[0],
      index: 2,
      overIndex: 0,
      rects,
    });

    expect(bystander).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    expect(RESTING_TRANSFORM).toBe(CSS.Transform.toString(bystander));
  });

  it('is what the board card falls back to at rest', () => {
    // Read as text: TaskCard is a component module, kept free of value exports
    // so it stays a Fast Refresh boundary.
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/components/board/TaskCard.tsx'), 'utf8');
    expect(source).toContain('CSS.Transform.toString(transform) ?? RESTING_TRANSFORM');
    expect(source).not.toMatch(/translate3d\(0,\s*0,\s*0\)/);
  });
});
