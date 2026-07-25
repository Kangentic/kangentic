/**
 * Unit tests for createExternalWindowOpenHandler in
 * src/main/window-open-policy.ts.
 *
 * This is the setWindowOpenHandler installed on non-webview WebContents (the
 * main window, and any pop-out window) in src/main/index.ts's
 * `web-contents-created` handler. It is the widest trust boundary added by
 * the terminal-links-open change: a renderer window.open() must never spawn
 * a bare, chrome-less BrowserWindow, an allowed URL must still reach the OS
 * default browser, and a disallowed URL must never reach openExternal.
 *
 * Tier: Unit (vitest, no browser, no Electron - openExternal is injected).
 */
import { describe, it, expect, vi } from 'vitest';
import { createExternalWindowOpenHandler } from '../../src/main/window-open-policy';

// Flushes the setImmediate the handler defers openExternal into.
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createExternalWindowOpenHandler', () => {
  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
    ['mailto', 'mailto:someone@example.com'],
  ])('always returns deny for an allowed %s URL (never spawns the popup)', (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    const result = handler({ url });

    expect(result).toEqual({ action: 'deny' });
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
    ['empty string', ''],
    ['an unparseable string', 'not a url'],
  ])('returns deny for a disallowed %s URL', (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    const result = handler({ url });

    expect(result).toEqual({ action: 'deny' });
  });

  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
    ['mailto', 'mailto:someone@example.com'],
  ])('routes an allowed %s URL out to openExternal, deferred past the synchronous return', async (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url });

    // Must not have been called synchronously - the callback has to return
    // its deny verdict before ShellExecute runs.
    expect(openExternal).not.toHaveBeenCalled();

    await flushImmediate();

    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
    ['empty string', ''],
    ['an unparseable string', 'not a url'],
  ])('never calls openExternal for a disallowed %s URL', async (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url });
    await flushImmediate();

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('warns with the [WINDOW_OPEN] prefix and does not throw when openExternal rejects', async () => {
    const rejection = new Error('no registered handler');
    const openExternal = vi.fn(() => Promise.reject(rejection));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url: 'mailto:someone@example.com' });
    await flushImmediate();
    // Let the rejected promise's .catch handler run.
    await flushImmediate();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WINDOW_OPEN] shell.openExternal failed for mailto:someone@example.com'),
      rejection,
    );

    warnSpy.mockRestore();
  });

  it('warns with the [WINDOW_OPEN] prefix for a denied URL', () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url: 'file:///etc/passwd' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WINDOW_OPEN] Denied window.open for disallowed URL: file:///etc/passwd'),
    );

    warnSpy.mockRestore();
  });
});
