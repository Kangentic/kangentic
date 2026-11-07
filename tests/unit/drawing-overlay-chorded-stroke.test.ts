/**
 * A stroke with push-to-talk held. A left press or release that overlaps another
 * button reports as a `pointermove`, so without this the stroke never starts, or
 * never ends while the other button stays down.
 */
import { describe, it, expect } from 'vitest';
import { chordedStrokeChange } from '../../src/renderer/components/browser/useDrawingOverlay';

const LEFT = 1;
const BACK = 8;

describe('chordedStrokeChange', () => {
  it('starts a stroke on a left press under Back', () => {
    expect(chordedStrokeChange(false, { button: 0, buttons: BACK | LEFT })).toBe('start');
  });

  it('ends a stroke on a left release under Back', () => {
    expect(chordedStrokeChange(true, { button: 0, buttons: BACK })).toBe('end');
  });

  it('keeps a stroke through Back going down and coming up', () => {
    expect(chordedStrokeChange(true, { button: 3, buttons: BACK | LEFT })).toBeNull();
    expect(chordedStrokeChange(true, { button: 3, buttons: LEFT })).toBeNull();
  });

  it('leaves plain movement alone, drawing or not', () => {
    expect(chordedStrokeChange(true, { button: -1, buttons: LEFT })).toBeNull();
    expect(chordedStrokeChange(false, { button: -1, buttons: 0 })).toBeNull();
    expect(chordedStrokeChange(false, { button: -1, buttons: BACK })).toBeNull();
  });

  it('starts nothing from Back alone', () => {
    expect(chordedStrokeChange(false, { button: 3, buttons: BACK })).toBeNull();
  });
});
