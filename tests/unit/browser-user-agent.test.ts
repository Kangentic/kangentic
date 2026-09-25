import { describe, it, expect, vi } from 'vitest';
import { applyBrowserUserAgent, stripElectronToken } from '../../src/main/browser/browser-user-agent';

/**
 * The Browser pane's user agent (decision 41 in docs/embedded-browser.md).
 *
 * The `Electron/` token is what some web application firewalls reject: measured
 * with curl against such a host, a user agent carrying it got an HTML block page
 * and the same one without it got the CSS. These pin the string the pane sends
 * and that both halves of a guest are given it.
 */

// The pane's default user agent as reported from a live Windows build.
const PANE_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Kangentic/0.43.0 Chrome/146.0.7680.216 Electron/41.10.7 Safari/537.36';

describe('stripElectronToken', () => {
  it('removes the Electron token and keeps every other token', () => {
    expect(stripElectronToken(PANE_DEFAULT_USER_AGENT)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Kangentic/0.43.0 Chrome/146.0.7680.216 Safari/537.36',
    );
  });

  it('is idempotent, because every pane on a shared jar re-applies it', () => {
    const once = stripElectronToken(PANE_DEFAULT_USER_AGENT);
    expect(stripElectronToken(once)).toBe(once);
  });

  it('leaves a user agent with no Electron token unchanged', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
    expect(stripElectronToken(chrome)).toBe(chrome);
  });
});

describe('applyBrowserUserAgent', () => {
  function fakeGuest(sessionUserAgent: string) {
    return {
      session: {
        getUserAgent: vi.fn(() => sessionUserAgent),
        setUserAgent: vi.fn(),
      },
      setUserAgent: vi.fn(),
    };
  }

  it('gives the Session and the guest the same stripped user agent', () => {
    const guest = fakeGuest(PANE_DEFAULT_USER_AGENT);
    applyBrowserUserAgent(guest as never);

    const expected = stripElectronToken(PANE_DEFAULT_USER_AGENT);
    // The Session alone does not reach a WebContents that already exists, and
    // the guest alone does not reach the popups opened from it. Dropping either
    // call leaves one of the two presenting the token.
    expect(guest.session.setUserAgent).toHaveBeenCalledWith(expected);
    expect(guest.setUserAgent).toHaveBeenCalledWith(expected);
  });

  it('never passes an accept-language argument, so the Session keeps its own', () => {
    const guest = fakeGuest(PANE_DEFAULT_USER_AGENT);
    applyBrowserUserAgent(guest as never);
    expect(guest.session.setUserAgent.mock.calls[0]).toHaveLength(1);
  });
});
