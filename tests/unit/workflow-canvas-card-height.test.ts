/**
 * The height a workflow task's card is laid out at on the canvas
 * (`canvasCardHeight`, #732 board 17).
 *
 * The canvas gives every card a fixed height per density so the layout never
 * jumps when a card's content changes. Once any task of a workflow is on another
 * board, every card names its project, and it names it in the strip's left side
 * (where the phone puts it), not on a row of its own, so naming it costs no
 * height: the layout reserves the same height on one board or several.
 */
import { describe, it, expect } from 'vitest';
import {
  CANVAS_CARD_HEIGHT,
  CANVAS_DONE_CARD_HEIGHT,
  canvasCardHeight,
} from '../../src/renderer/components/workflows/WorkflowCanvasCard';
import * as workflowLayout from '../../src/renderer/components/workflows/workflow-layout';

const DENSITIES = ['compact', 'default', 'comfortable'] as const;

describe('canvasCardHeight', () => {
  it('is the density\'s fixed height, and the Done card\'s for a done task', () => {
    for (const density of DENSITIES) {
      expect(canvasCardHeight({ place: 'todo' }, density)).toBe(CANVAS_CARD_HEIGHT[density]);
      expect(canvasCardHeight({ place: 'planned' }, density)).toBe(CANVAS_CARD_HEIGHT[density]);
      expect(canvasCardHeight({ place: 'working' }, density)).toBe(CANVAS_CARD_HEIGHT[density]);
      expect(canvasCardHeight({ place: 'done' }, density)).toBe(CANVAS_DONE_CARD_HEIGHT);
    }
  });

  it('takes no project argument: a card that names its project is no taller', () => {
    // The project rides in the strip, so the height cannot depend on it.
    expect(canvasCardHeight.length).toBe(2);
    expect(Object.keys(workflowLayout)).not.toContain('PROJECT_ROW_HEIGHT');
  });
});
