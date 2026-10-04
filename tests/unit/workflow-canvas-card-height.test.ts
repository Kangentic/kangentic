/**
 * The height a workflow task's card is laid out at on the canvas
 * (`canvasCardHeight`, #732 board 17).
 *
 * The canvas gives every card a fixed height per density so the layout never
 * jumps when a card's content changes. Once any task of a workflow is on another
 * board, every card also carries a row naming its project, above the strip. That
 * row is 24px, and the layout has to reserve it or the cards on the next row
 * would be drawn over the one above. On one board there is no row and the
 * heights are what they were before it existed.
 */
import { describe, it, expect } from 'vitest';
import {
  CANVAS_CARD_HEIGHT,
  CANVAS_DONE_CARD_HEIGHT,
  canvasCardHeight,
} from '../../src/renderer/components/workflows/WorkflowCanvasCard';
import { PROJECT_ROW_HEIGHT } from '../../src/renderer/components/workflows/workflow-layout';

const DENSITIES = ['compact', 'default', 'comfortable'] as const;

describe('canvasCardHeight', () => {
  it('on one board is the density\'s fixed height, and the Done strip\'s for a done task', () => {
    for (const density of DENSITIES) {
      expect(canvasCardHeight({ place: 'todo' }, density)).toBe(CANVAS_CARD_HEIGHT[density]);
      expect(canvasCardHeight({ place: 'working' }, density, false)).toBe(CANVAS_CARD_HEIGHT[density]);
      expect(canvasCardHeight({ place: 'done' }, density, false)).toBe(CANVAS_DONE_CARD_HEIGHT);
    }
  });

  it('across boards is 24px taller, for every density and for a done task', () => {
    expect(PROJECT_ROW_HEIGHT).toBe(24);
    for (const density of DENSITIES) {
      expect(canvasCardHeight({ place: 'todo' }, density, true)).toBe(CANVAS_CARD_HEIGHT[density] + 24);
      expect(canvasCardHeight({ place: 'planned' }, density, true)).toBe(CANVAS_CARD_HEIGHT[density] + 24);
      expect(canvasCardHeight({ place: 'done' }, density, true)).toBe(CANVAS_DONE_CARD_HEIGHT + 24);
    }
  });

  it('is the one-board height when the project row is left out', () => {
    for (const density of DENSITIES) {
      expect(canvasCardHeight({ place: 'working' }, density)).toBe(canvasCardHeight({ place: 'working' }, density, false));
    }
  });
});
