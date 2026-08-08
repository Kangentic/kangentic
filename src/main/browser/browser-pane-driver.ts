import { BrowserWindow, type WebContents } from 'electron';
import { browserPaneRegistry, type ResolveTargetSelector } from './browser-pane-registry';
import { attachDebugger, isDebuggerAttached } from './cdp/cdp';
import type { ResolvedBrowserAutomationConfig } from './browser-automation-config';

/**
 * The single chokepoint every `kangentic_browser_*` MCP tool routes through to
 * drive the embedded Browser pane. It (1) gates the call against the global
 * automation policy, (2) resolves the target pane to a live guest webContents,
 * (3) lazily attaches the CDP debugger, then (4) runs the operation and wraps
 * the outcome in a structured `{ ok, data } | { ok: false, error }` envelope.
 *
 * Centralizing attach + gating + error shaping here keeps the tools thin and
 * guarantees no tool can bypass capability checks or the attach lifecycle.
 */

export type BrowserCapability = 'observe' | 'interact' | 'navigate' | 'eval';

export interface DriverError {
  kind: string;
  detail: string;
}

export type DriverResult<T> = { ok: true; data: T } | { ok: false; error: DriverError };

const SETTINGS_HINT = 'Settings -> Agent Browser';

function capabilityGate(
  capability: BrowserCapability,
  config: ResolvedBrowserAutomationConfig,
): DriverError | null {
  if (!config.enabled) {
    return {
      kind: 'automation-disabled',
      detail: `Agent browser automation is turned off. Enable it in ${SETTINGS_HINT}.`,
    };
  }
  if (capability === 'interact' && !config.allowInteraction) {
    return {
      kind: 'interaction-disabled',
      detail: `Interaction (click / type / keypress / drag) is turned off (observe-only mode). Enable "Allow interaction" in ${SETTINGS_HINT}.`,
    };
  }
  if (capability === 'navigate' && !config.allowNavigation) {
    return {
      kind: 'navigation-disabled',
      detail: `Navigation is turned off. Enable "Allow navigation" in ${SETTINGS_HINT}.`,
    };
  }
  if (capability === 'eval' && !config.allowEval) {
    return {
      kind: 'eval-disabled',
      detail: `Eval (arbitrary JavaScript) is turned off. Enable "Allow eval" in ${SETTINGS_HINT}.`,
    };
  }
  return null;
}

export interface WithGuestOptions {
  selector: ResolveTargetSelector;
  capability: BrowserCapability;
  config: ResolvedBrowserAutomationConfig;
}

/**
 * Resolve, gate, attach, and run. The body receives the live guest webContents.
 * Any throw inside the body becomes a `driver-error` envelope rather than
 * rejecting, so tool handlers never have to try/catch.
 *
 * Resolution is CALLER-SCOPED: `options.selector.projectId` is required, and
 * `resolveTarget` refuses any pane outside it with the `foreign-project` kind.
 * The refusal happens before the liveness check and before any CDP attach, so a
 * call from another project can neither touch a foreign guest nor evict its
 * registry entry. `projectId: null` is the deliberate unscoped path and belongs
 * only to main-process internal callers and tests.
 */
export async function withGuest<T>(
  options: WithGuestOptions,
  fn: (webContents: WebContents) => Promise<T>,
): Promise<DriverResult<T>> {
  const gate = capabilityGate(options.capability, options.config);
  if (gate) return { ok: false, error: gate };

  const target = browserPaneRegistry.resolveTarget(options.selector);
  if (!target.ok) {
    return { ok: false, error: { kind: target.kind, detail: target.detail } };
  }

  const live = browserPaneRegistry.resolveLiveGuest(target.entry);
  if (!live.ok) {
    return { ok: false, error: { kind: live.kind, detail: live.detail } };
  }

  const { webContents } = live;

  // A window that is not being composited has no frame for CDP to hand back, so
  // `Page.captureScreenshot` NEVER RESOLVES and every later command for that
  // guest queues behind it, wedging the pane permanently.
  //
  // This check is a fast, clear refusal for the ONE case main can actually
  // observe. It is not the guarantee: a window that is merely hidden or fully
  // occluded stops compositing too, and Electron exposes no way to detect that
  // from the main process (`isVisible()` stays true, and Chromium's occlusion
  // state is not surfaced). Measured on Electron 41 against a real backgrounded
  // window, where this check did NOT fire and the capture hung anyway. The
  // bounded capture in `cdp.ts` is what actually stops the hang; see
  // SCREENSHOT_TIMEOUT_MS there. Covers both a popped-out pane (its own OS
  // window) and a docked pane (the main window).
  const hostWindow = BrowserWindow.fromWebContents(webContents.hostWebContents ?? webContents);
  if (hostWindow?.isMinimized()) {
    return {
      ok: false,
      error: {
        kind: 'pane-not-rendering',
        detail:
          "The window holding this Browser pane is minimized, so it renders no frames and cannot be driven. Ask the user to restore the window, then retry.",
      },
    };
  }

  if (!isDebuggerAttached(webContents)) {
    // The pane exposes no DevTools, so a re-attach can never steal a
    // connection from the user; attaching is always safe here.
    if (!attachDebugger(webContents)) {
      return {
        ok: false,
        error: {
          kind: 'cdp-attach-failed',
          detail: 'Could not attach the Chrome DevTools Protocol debugger to the Browser pane.',
        },
      };
    }
  }

  try {
    const data = await fn(webContents);
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'driver-error',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Validate a navigation target against the http(s)-only rule and the optional
 * localhost-restriction policy. Returns the normalized URL or a structured
 * error the navigate tool surfaces verbatim.
 */
export function validateNavigationUrl(
  rawUrl: string,
  config: ResolvedBrowserAutomationConfig,
): { ok: true; url: string } | { ok: false; error: DriverError } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: { kind: 'invalid-url', detail: `Not a valid URL: ${rawUrl}.` } };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: { kind: 'invalid-url', detail: `Only http(s) URLs are allowed (got ${parsed.protocol}).` },
    };
  }
  if (config.restrictNavigationToLocalhost && !isLoopbackOrPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      error: {
        kind: 'navigation-host-blocked',
        detail: `Navigation is restricted to localhost / private hosts; "${parsed.hostname}" is blocked. Turn off "Restrict navigation to localhost" in ${SETTINGS_HINT} to allow public origins.`,
      },
    };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * True for loopback, RFC-1918 / link-local private ranges, `.local` / `.localhost`
 * mDNS names, and single-label intranet hostnames (no dot). Everything with a
 * public-looking FQDN is treated as non-private.
 */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  // IPv4 private / loopback / link-local ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 127 || first === 10) return true;
    if (first === 192 && second === 168) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 169 && second === 254) return true;
    return false;
  }
  // IPv6 unique-local (fc00::/7) covers fc.. and fd.. prefixes.
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  // Any other colon-bearing host is a public IPv6 address (loopback ::1 and
  // unique-local fc../fd.. are already matched above). Reject before the
  // single-label check below, which would otherwise treat a dotless IPv6
  // literal as a private intranet name and wrongly allow it.
  if (host.includes(':')) return false;
  // Single-label hostname (no dot) - an intranet / dev box name.
  if (!host.includes('.')) return true;
  return false;
}
