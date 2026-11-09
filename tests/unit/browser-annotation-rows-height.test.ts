/**
 * How tall the Browser pane's annotation list may grow (`annotationRowsMaxHeight`).
 * At the 900x600 window floor the pane is about 275px, where four rows left
 * the page under 80px: the list has to give way before the page does.
 */
import { describe, it, expect } from 'vitest';
import { ROWS_MAX_HEIGHT, annotationRowsMaxHeight } from '../../src/renderer/components/browser/annotations/AnnotationComposer';

describe('annotationRowsMaxHeight', () => {
  it('shows four rows when the pane has room for them and the page', () => {
    expect(annotationRowsMaxHeight(900)).toBe(ROWS_MAX_HEIGHT);
  });

  it('gives way first, keeping the page 120px or 40% of the pane', () => {
    const paneHeight = 400;
    const rows = annotationRowsMaxHeight(paneHeight);
    expect(rows).toBeLessThan(ROWS_MAX_HEIGHT);
    expect(paneHeight - 122 - rows).toBeGreaterThanOrEqual(Math.max(120, paneHeight * 0.4) - 1);
  });

  it('never goes below one row, so the active note is always in reach', () => {
    expect(annotationRowsMaxHeight(275)).toBe(42);
    expect(annotationRowsMaxHeight(150)).toBe(42);
  });

  it('keeps the full height until the pane has been measured', () => {
    expect(annotationRowsMaxHeight(0)).toBe(ROWS_MAX_HEIGHT);
  });
});
