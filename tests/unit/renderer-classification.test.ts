import { describe, it, expect, afterEach } from 'vitest';
import {
  BROWSER_GUEST_RENDERER_NAME,
  rendererNameForReporting,
  resetRendererClassificationForTests,
  setLaneWebContentsPredicate,
} from '../../src/main/analytics/renderer-classification';

// The Sentry SDK's getRendererName decides which renderer crashes are a Browser pane page (the
// user's page, reduced before upload) and which are Kangentic's own UI (kept whole). A guest
// misread as ours ships the page's URL and stack; one of ours misread as a guest loses its stack.

function contents(id: number, type: string) {
  return { id, getType: () => type };
}

afterEach(() => {
  resetRendererClassificationForTests();
});

describe('rendererNameForReporting', () => {
  it('names a <webview> guest a Browser pane page', () => {
    expect(rendererNameForReporting(contents(7, 'webview'))).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it('names an offscreen lane a Browser pane page once the lane manager vouches for it', () => {
    expect(rendererNameForReporting(contents(12, 'window'))).toBeUndefined();
    setLaneWebContentsPredicate((webContentsId) => webContentsId === 12);
    expect(rendererNameForReporting(contents(12, 'window'))).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it("leaves Kangentic's own windows unnamed, so the SDK keeps calling them 'renderer'", () => {
    setLaneWebContentsPredicate((webContentsId) => webContentsId === 12);
    expect(rendererNameForReporting(contents(1, 'window'))).toBeUndefined();
    expect(rendererNameForReporting(contents(2, 'browserView'))).toBeUndefined();
  });

  it('never throws, even for a WebContents that throws on getType', () => {
    const destroyed = {
      id: 3,
      getType: (): string => {
        throw new Error('Object has been destroyed');
      },
    };
    expect(rendererNameForReporting(destroyed)).toBeUndefined();
  });
});
