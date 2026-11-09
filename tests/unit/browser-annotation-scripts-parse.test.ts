/**
 * The scripts the Browser pane injects into its guest page with
 * `executeJavaScript`. They are text, so a syntax slip compiles fine in
 * TypeScript and only fails inside the guest, where the pane swallows the
 * rejection: annotations would silently never draw. Parsing each one here
 * (without running it, since the unit tier has no DOM) catches that.
 */
import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_LAYER_AFTER_PAINT_SCRIPT,
  ANNOTATION_LAYER_CANCEL_BADGE_WAIT_SCRIPT,
  ANNOTATION_LAYER_CLEAR_SCRIPT,
  ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT,
  ANNOTATION_LAYER_SCROLL_SCRIPT,
  ANNOTATION_LAYER_HOST_ATTRIBUTE,
  hoverAnnotationLayerScript,
  renderAnnotationLayerScript,
} from '../../src/renderer/components/browser/annotations/annotationLayerScript';
import { INSPECT_SCRIPT } from '../../src/renderer/components/browser/inspectScript';

const parses = (source: string): void => {
  // Constructing a Function parses its body and throws a SyntaxError on a slip.
  expect(() => new Function(source)).not.toThrow();
};

describe('Browser pane guest scripts', () => {
  it('every annotation layer call parses', () => {
    parses(ANNOTATION_LAYER_SCROLL_SCRIPT);
    parses(hoverAnnotationLayerScript({ hoveredNumber: 2, hoveredItemId: null }));
    parses(ANNOTATION_LAYER_CLEAR_SCRIPT);
    parses(ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT);
    parses(ANNOTATION_LAYER_CANCEL_BADGE_WAIT_SCRIPT);
    parses(ANNOTATION_LAYER_AFTER_PAINT_SCRIPT);
    parses(renderAnnotationLayerScript({
      hidden: false,
      barRect: { x: 1, y: 2, width: 3, height: 4 },
      hoveredNumber: null,
      hoveredItemId: null,
      annotations: [{
        number: 1,
        emphasis: 'strong',
        items: [
          { id: 'e', kind: 'element', selector: 'button[data-testid="it\'s"]', tag: 'button', name: 'Save "now"' },
          { id: 'd', kind: 'drawing', strokes: [[{ x: 1, y: 2 }]] },
        ],
      }],
    }));
  });

  it('the layer embeds its layout and its host attribute, not their placeholders', () => {
    expect(ANNOTATION_LAYER_SCROLL_SCRIPT).toContain('function kngPlaceBadges');
    expect(ANNOTATION_LAYER_SCROLL_SCRIPT).toContain(`'${ANNOTATION_LAYER_HOST_ATTRIBUTE}'`);
    expect(ANNOTATION_LAYER_SCROLL_SCRIPT).not.toContain('${');
  });

  it('the Select element script parses, and skips the layer host when it hit-tests', () => {
    parses(INSPECT_SCRIPT);
    expect(INSPECT_SCRIPT).toContain(ANNOTATION_LAYER_HOST_ATTRIBUTE);
  });
});
