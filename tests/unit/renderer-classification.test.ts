import { describe, it, expect, afterEach } from 'vitest';
import {
  BROWSER_GUEST_RENDERER_NAME,
  markBrowserGuestWebContents,
  rendererNameForReporting,
  resetRendererClassificationForTests,
} from '../../src/main/analytics/renderer-classification';

// The Sentry SDK's getRendererName decides which renderer crashes are a Browser pane page (the
// user's page, reduced before upload) and which are Kangentic's own UI (kept whole). A guest
// misread as ours ships the page's URL and stack; one of ours misread as a guest loses its stack.
//
// The SDK asks LATE: its live crash path calls getRendererName only after its minidump loader has
// polled up to 5 s for the dump to stop changing. By then the surface may be closed, and a
// destroyed WebContents throws on getType(). The marks are therefore never removed, and the cases
// below that make getType throw are the ones this design exists for.

function contents(id: number, type: string) {
  return { id, getType: () => type };
}

/** What a destroyed WebContents looks like to the SDK: every getType() call throws. */
function destroyedContents(id: number) {
  return {
    id,
    getType: (): string => {
      throw new Error('Object has been destroyed');
    },
  };
}

afterEach(() => {
  resetRendererClassificationForTests();
});

describe('rendererNameForReporting', () => {
  it('names a <webview> guest a Browser pane page, with no mark needed', () => {
    expect(rendererNameForReporting(contents(7, 'webview'))).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it('leaves an unmarked window unnamed', () => {
    expect(rendererNameForReporting(contents(12, 'window'))).toBeUndefined();
  });

  it('names a window a Browser pane page once its creator marks it (a lane, a pane popup)', () => {
    expect(rendererNameForReporting(contents(12, 'window'))).toBeUndefined();
    markBrowserGuestWebContents(12);
    expect(rendererNameForReporting(contents(12, 'window'))).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it("leaves Kangentic's own windows unnamed, for the SDK's defaults and restoreOwnRendererProcessTag", () => {
    markBrowserGuestWebContents(12);
    expect(rendererNameForReporting(contents(1, 'window'))).toBeUndefined();
    expect(rendererNameForReporting(contents(2, 'browserView'))).toBeUndefined();
  });

  it('still names a marked WebContents whose getType throws, which is a surface closed before the SDK asked', () => {
    markBrowserGuestWebContents(3);
    expect(
      rendererNameForReporting(destroyedContents(3)),
      'a lane, popup or guest closed inside the SDK\'s 5 s minidump poll throws on getType(); answering "ours" there would ship its page URL, stack and minidump',
    ).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it('leaves an unmarked WebContents whose getType throws unnamed, and does not throw', () => {
    expect(() => rendererNameForReporting(destroyedContents(3))).not.toThrow();
    expect(rendererNameForReporting(destroyedContents(3))).toBeUndefined();
  });

  it('keeps a mark for the life of the process, however many other surfaces come and go', () => {
    markBrowserGuestWebContents(40);
    for (let id = 41; id < 141; id++) {
      markBrowserGuestWebContents(id);
      expect(rendererNameForReporting(destroyedContents(id))).toBe(BROWSER_GUEST_RENDERER_NAME);
    }
    expect(rendererNameForReporting(destroyedContents(40))).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it('does not throw when reading the id throws, and leaves that renderer unnamed', () => {
    const unreadableId = {
      get id(): number {
        throw new Error('Object has been destroyed');
      },
      getType: () => 'window',
    };
    expect(() => rendererNameForReporting(unreadableId)).not.toThrow();
    expect(rendererNameForReporting(unreadableId)).toBeUndefined();
  });

  it('still names a <webview> whose id getter throws, since the type alone answers', () => {
    const unreadableGuestId = {
      get id(): number {
        throw new Error('Object has been destroyed');
      },
      getType: () => 'webview',
    };
    expect(rendererNameForReporting(unreadableGuestId)).toBe(BROWSER_GUEST_RENDERER_NAME);
  });

  it('never throws when both getType and the id are unreadable', () => {
    const fullyDestroyed = {
      get id(): number {
        throw new Error('Object has been destroyed');
      },
      getType: (): string => {
        throw new Error('Object has been destroyed');
      },
    };
    expect(() => rendererNameForReporting(fullyDestroyed)).not.toThrow();
    expect(rendererNameForReporting(fullyDestroyed)).toBeUndefined();
  });
});

describe('resetRendererClassificationForTests', () => {
  it('forgets every mark', () => {
    markBrowserGuestWebContents(12);
    markBrowserGuestWebContents(13);
    expect(rendererNameForReporting(contents(12, 'window'))).toBe(BROWSER_GUEST_RENDERER_NAME);

    resetRendererClassificationForTests();

    expect(rendererNameForReporting(contents(12, 'window'))).toBeUndefined();
    expect(rendererNameForReporting(destroyedContents(13))).toBeUndefined();
  });
});
