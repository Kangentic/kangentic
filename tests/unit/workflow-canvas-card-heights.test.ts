/**
 * How tall the Workflows canvas lays each card out (canvas-card-heights.ts).
 *
 * A canvas card is as tall as its content, as a board card is: the layout
 * reads the height React Flow measures, and uses an estimate per state only
 * until then. The measured map changes only when a card's whole-pixel height
 * does, so a drag never lays the canvas out again. Whether a card really is
 * as tall as its content, and a grown card re-spaces its column, is a layout
 * question checked in the UI tier (tests/ui/workflows-canvas-card-fit.spec.ts).
 */
import { describe, it, expect } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import {
  NO_MEASURED_HEIGHTS,
  estimatedCardHeight,
  withMeasuredHeights,
} from '../../src/renderer/components/workflows/canvas-card-heights';
import * as workflowLayout from '../../src/renderer/components/workflows/workflow-layout';

const dimensions = (id: string, height: number): NodeChange => ({ id, type: 'dimensions', dimensions: { width: 256, height } });
const position = (id: string): NodeChange => ({ id, type: 'position', position: { x: 10, y: 20 }, dragging: true });

describe('estimatedCardHeight', () => {
  it('guesses one Done card height at every density, since a Done card is the compact card at all of them', () => {
    const done = estimatedCardHeight({ place: 'done' }, 'default');
    for (const density of ['compact', 'default', 'comfortable'] as const) {
      expect(estimatedCardHeight({ place: 'done' }, density)).toBe(done);
      expect(estimatedCardHeight({ place: 'planned' }, density)).toBe(estimatedCardHeight({ place: 'todo' }, density));
    }
    expect(done).toBeLessThan(estimatedCardHeight({ place: 'working' }, 'default'));
  });

  it('grows with the density, as a board card does', () => {
    expect(estimatedCardHeight({ place: 'todo' }, 'compact')).toBeLessThan(estimatedCardHeight({ place: 'todo' }, 'default'));
    expect(estimatedCardHeight({ place: 'todo' }, 'default')).toBeLessThan(estimatedCardHeight({ place: 'todo' }, 'comfortable'));
  });

  it('leaves no fixed card height in the layout', () => {
    // The layout takes a height per card; nothing pins one any more.
    expect(Object.keys(workflowLayout).filter((name) => /CARD_HEIGHT/.test(name))).toEqual([]);
  });
});

describe('withMeasuredHeights', () => {
  it('records each card\'s measured height in whole pixels', () => {
    const next = withMeasuredHeights(NO_MEASURED_HEIGHTS, [dimensions('a', 131.6), dimensions('b', 178)]);
    expect([...next]).toEqual([['a', 132], ['b', 178]]);
  });

  it('returns the same map for a drag, so the canvas is not laid out again', () => {
    const current = withMeasuredHeights(NO_MEASURED_HEIGHTS, [dimensions('a', 132)]);
    expect(withMeasuredHeights(current, [position('a'), position('b')])).toBe(current);
  });

  it('returns the same map when no card changed height, and a new one when one grew', () => {
    const current = withMeasuredHeights(NO_MEASURED_HEIGHTS, [dimensions('a', 132)]);
    expect(withMeasuredHeights(current, [dimensions('a', 132.2)])).toBe(current);
    const grown = withMeasuredHeights(current, [dimensions('a', 178)]);
    expect(grown).not.toBe(current);
    expect(grown.get('a')).toBe(178);
    // The map it started from is left as it was.
    expect(current.get('a')).toBe(132);
  });

  it('ignores a change with no size and a zero height, which a hidden card reports', () => {
    const current = withMeasuredHeights(NO_MEASURED_HEIGHTS, [dimensions('a', 132)]);
    expect(withMeasuredHeights(current, [{ id: 'a', type: 'dimensions' }, dimensions('a', 0)])).toBe(current);
  });
});
