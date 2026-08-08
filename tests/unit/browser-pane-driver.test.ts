/**
 * Unit tests for the browser-pane driver in
 * src/main/browser/browser-pane-driver.ts.
 *
 * Covers the single chokepoint withGuest (capability gating, target
 * resolution, lazy CDP attach, error envelopes) and validateNavigationUrl
 * (http(s)-only + the optional localhost restriction). electron and the CDP
 * helpers are mocked; the real registry singleton is exercised so resolution
 * is end-to-end.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  attachDebugger: vi.fn(() => true),
  isDebuggerAttached: vi.fn(() => false),
  detachDebugger: vi.fn(),
}));

import { webContents, BrowserWindow } from 'electron';
import { attachDebugger, isDebuggerAttached } from '../../src/main/browser/cdp/cdp';
import { withGuest, validateNavigationUrl } from '../../src/main/browser/browser-pane-driver';
import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';

function config(overrides: Partial<ResolvedBrowserAutomationConfig> = {}): ResolvedBrowserAutomationConfig {
  return {
    enabled: true,
    allowInteraction: true,
    allowNavigation: true,
    allowEval: false,
    restrictNavigationToLocalhost: false,
    ...overrides,
  };
}

function seedGuest(id: number, destroyed = false): void {
  vi.mocked(webContents.fromId).mockImplementation((requestedId: number) =>
    requestedId === id ? ({ id, isDestroyed: () => destroyed } as never) : (undefined as never),
  );
}

describe('withGuest - capability gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    browserPaneRegistry.detachAll();
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
  });

  it('blocks all capabilities when automation is disabled', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config({ enabled: false }) }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'automation-disabled' } });
  });

  it('blocks interaction when allowInteraction is off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'interact', config: config({ allowInteraction: false }) }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'interaction-disabled' } });
  });

  it('blocks navigation when allowNavigation is off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'navigate', config: config({ allowNavigation: false }) }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'navigation-disabled' } });
  });

  it('blocks eval when allowEval is off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'eval', config: config() }, async () => 'ran');
    expect(result).toMatchObject({ ok: false, error: { kind: 'eval-disabled' } });
  });

  it('allows observe even when interaction/eval are off', async () => {
    const result = await withGuest({ selector: { projectId: 'p' }, capability: 'observe', config: config() }, async () => 'snapshot');
    expect(result).toEqual({ ok: true, data: 'snapshot' });
  });
});

describe('withGuest - resolution and attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(attachDebugger).mockReturnValue(true);
    vi.mocked(isDebuggerAttached).mockReturnValue(false);
    browserPaneRegistry.detachAll();
  });

  it('attaches lazily then runs the body', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    const result = await withGuest({ selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() }, async (guestWebContents) => (guestWebContents as { id: number }).id);
    expect(result).toEqual({ ok: true, data: 7 });
    expect(vi.mocked(attachDebugger)).toHaveBeenCalledTimes(1);
  });

  it('does not re-attach when the debugger is already attached', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(isDebuggerAttached).mockReturnValue(true);
    await withGuest({ selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
  });

  it('reports pane-destroyed when the guest no longer resolves', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(999); // 7 does not resolve
    const result = await withGuest({ selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(result).toMatchObject({ ok: false, error: { kind: 'pane-destroyed' } });
  });

  it('reports no-pane-open when nothing is registered', async () => {
    const result = await withGuest({ selector: { sessionId: 'missing', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(result).toMatchObject({ ok: false, error: { kind: 'no-pane-open' } });
  });

  it('refuses a foreign-project target without running the body or attaching CDP', async () => {
    browserPaneRegistry.register({ sessionId: 's2', taskId: 't2', projectId: 'proj-2', webContentsId: 8, url: null });
    seedGuest(8);
    const body = vi.fn(async () => 'ran');
    const result = await withGuest(
      { selector: { sessionId: 's2', projectId: 'proj-1' }, capability: 'observe', config: config() },
      body,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'foreign-project' } });
    expect(body).not.toHaveBeenCalled();
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
  });

  // A minimized window composites nothing, so Page.captureScreenshot never
  // resolves and wedges every later command for that guest. Measured on
  // Electron 41; blurred and occluded windows are unaffected. Refusing up front
  // is what keeps a popped-out pane safe to minimize.
  it('refuses when the pane host window is minimized, instead of hanging', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isMinimized: () => true } as never);
    const body = vi.fn(async () => 'ran');
    const result = await withGuest(
      { selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() },
      body,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'pane-not-rendering' } });
    expect(body).not.toHaveBeenCalled();
    expect(vi.mocked(attachDebugger)).not.toHaveBeenCalled();
  });

  it('runs normally when the host window is present and not minimized', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isMinimized: () => false } as never);
    const result = await withGuest(
      { selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() },
      async () => 'ok',
    );
    expect(result).toEqual({ ok: true, data: 'ok' });
  });

  it('refuses a foreign target BEFORE the liveness check, so it cannot evict another project entry', async () => {
    browserPaneRegistry.register({ sessionId: 's2', taskId: 't2', projectId: 'proj-2', webContentsId: 8, url: null });
    seedGuest(999); // 8 does not resolve, so an unscoped path would say pane-destroyed
    const result = await withGuest(
      { selector: { sessionId: 's2', projectId: 'proj-1' }, capability: 'observe', config: config() },
      async () => 'ok',
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'foreign-project' } });
    expect(browserPaneRegistry.get('s2')).toBeDefined();
  });

  it('reports cdp-attach-failed when attach returns false', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    vi.mocked(attachDebugger).mockReturnValue(false);
    const result = await withGuest({ selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() }, async () => 'ok');
    expect(result).toMatchObject({ ok: false, error: { kind: 'cdp-attach-failed' } });
  });

  it('wraps a thrown body error as driver-error', async () => {
    browserPaneRegistry.register({ sessionId: 's', taskId: 't', projectId: 'p', webContentsId: 7, url: null });
    seedGuest(7);
    const result = await withGuest({ selector: { sessionId: 's', projectId: 'p' }, capability: 'observe', config: config() }, async () => {
      throw new Error('boom');
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'driver-error', detail: 'boom' } });
  });
});

describe('validateNavigationUrl', () => {
  it('accepts http and https', () => {
    expect(validateNavigationUrl('http://localhost:4200', config()).ok).toBe(true);
    expect(validateNavigationUrl('https://example.com', config()).ok).toBe(true);
  });

  it('rejects non-http(s) and malformed URLs', () => {
    expect(validateNavigationUrl('ftp://x', config())).toMatchObject({ ok: false, error: { kind: 'invalid-url' } });
    expect(validateNavigationUrl('not a url', config())).toMatchObject({ ok: false, error: { kind: 'invalid-url' } });
  });

  it('with the localhost restriction on, allows local/private hosts and blocks public', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    expect(validateNavigationUrl('http://localhost:4200', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://127.0.0.1:3000', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://192.168.1.10', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://dev-box:8080', restricted).ok).toBe(true);
    expect(validateNavigationUrl('https://github.com', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
  });

  it('with the restriction off, allows public hosts', () => {
    expect(validateNavigationUrl('https://github.com', config()).ok).toBe(true);
  });

  it('private IPv4 ranges (10.x, 172.16-31.x, 169.254.x) are allowed under the restriction', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // RFC-1918 10.0.0.0/8
    expect(validateNavigationUrl('http://10.1.2.3', restricted).ok).toBe(true);
    // RFC-1918 172.16.0.0/12 lower bound
    expect(validateNavigationUrl('http://172.16.0.1', restricted).ok).toBe(true);
    // RFC-1918 172.16.0.0/12 upper bound
    expect(validateNavigationUrl('http://172.31.255.1', restricted).ok).toBe(true);
    // link-local 169.254.0.0/16
    expect(validateNavigationUrl('http://169.254.1.1', restricted).ok).toBe(true);
  });

  it('mDNS (.local) and .localhost subdomains are allowed under the restriction', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    expect(validateNavigationUrl('http://foo.local', restricted).ok).toBe(true);
    expect(validateNavigationUrl('http://app.localhost', restricted).ok).toBe(true);
  });

  it('IPv6 private/loopback addresses are allowed under the restriction', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // ::1 loopback (URL percent-encodes brackets, hostname strips them)
    expect(validateNavigationUrl('http://[::1]/', restricted).ok).toBe(true);
    // fc00::/7 unique-local fc.. prefix
    expect(validateNavigationUrl('http://[fc00::1]/', restricted).ok).toBe(true);
    // fc00::/7 unique-local fd.. prefix
    expect(validateNavigationUrl('http://[fd12:3456::1]/', restricted).ok).toBe(true);
  });

  it('public IPv4 addresses just outside RFC-1918 172.16-31 are blocked', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // 172.15.x.x is public (one below the lower bound of 172.16)
    expect(validateNavigationUrl('http://172.15.0.1', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
    // 172.32.x.x is public (one above the upper bound of 172.31)
    expect(validateNavigationUrl('http://172.32.0.1', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
  });

  // Regression lock: before the `if (host.includes(':')) return false;` guard
  // was added to isLoopbackOrPrivateHost, a dotless IPv6 literal (e.g.
  // '2001:db8::1' after bracket-stripping) fell through to the single-label
  // check (!host.includes('.')) and was WRONGLY classified as a private
  // intranet name, allowing navigation to arbitrary public IPv6 hosts.
  // Removing that one guard line makes this test go red. Keep it to lock
  // the regression.
  it('public IPv6 addresses are blocked under the restriction (IPv6-as-single-label regression)', () => {
    const restricted = config({ restrictNavigationToLocalhost: true });
    // Documentation range - public IPv6
    expect(validateNavigationUrl('http://[2001:db8::1]/', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
    // Global unicast - public IPv6
    expect(validateNavigationUrl('http://[2600:1234::abcd]/', restricted)).toMatchObject({
      ok: false,
      error: { kind: 'navigation-host-blocked' },
    });
  });
});
