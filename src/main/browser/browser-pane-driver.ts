import { BrowserWindow, type WebContents } from 'electron';
import { browserPaneRegistry, type ResolveTargetSelector } from './browser-pane-registry';
import { attachDebugger, ensureFocusEmulation, isDebuggerAttached } from './cdp/cdp';
import { beginAgentInput, endAgentInput } from './agent-input-signal';
import type { ResolvedBrowserAutomationConfig } from './browser-automation-config';
import { withGuestDriveLock, GuestBusyError } from './guest-drive-queue';

/**
 * The single chokepoint every `kangentic_browser_*` MCP tool routes through to
 * drive the embedded Browser pane. It (1) gates the call against the global
 * automation policy, (2) resolves the target pane to a live guest webContents,
 * (3) lazily attaches the CDP debugger, (4) announces the drive to the pane's
 * renderer so no agent action can take the user's keyboard focus, then (5) runs
 * the operation and wraps the outcome in a structured
 * `{ ok, data } | { ok: false, error }` envelope.
 *
 * Centralizing attach + gating + focus signalling + error shaping here keeps the
 * tools thin and guarantees no tool can bypass capability checks, the attach
 * lifecycle, or the focus guarantee. Step 4 is why a new CDP primitive must be
 * reachable only from inside a `withGuest` body - see
 * `.claude/rules/agent-driven-focus.md`.
 */

export type BrowserCapability = 'observe' | 'interact' | 'navigate' | 'eval';

export interface DriverError {
  kind: string;
  detail: string;
}

export type DriverResult<T> = { ok: true; data: T } | { ok: false; error: DriverError };

const SETTINGS_HINT = 'Settings -> Agent Browser';

/**
 * The automation policy check, exported so a tool whose side effects happen
 * BEFORE it can reach `withGuest` can apply the same gate up front rather than
 * duplicating the policy. `browser-pane-opener.ts` is the one such caller: it
 * opens a window and seeds a URL before any guest exists to resolve, so gating
 * only inside `withGuest` would let a disabled capability still change what is
 * on the user's screen. Keep this the single source of the tier rules.
 */
export function capabilityGate(
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

  // Tell the guest it BEHAVES as focused, so a page that hides UI or pauses on
  // blur works normally under automation and keeps its own focused element after
  // the renderer hands the user's focus back. It does NOT affect input routing -
  // see the measurement in `ensureFocusEmulation`. Armed on every call, not just
  // the attaching one: idempotent per CDP session, so this is one no-op call on
  // the hot path. See `.claude/rules/agent-driven-focus.md`.
  ensureFocusEmulation(webContents);

  // Serialize from here down, so only ONE drive touches this guest at a time.
  // Taken AFTER resolution and the compositing precondition, so a call refused
  // by the gate or by target resolution never queues for a pane it never
  // touches. Refusal rather than an unbounded wait: see
  // GUEST_DRIVE_WAIT_TIMEOUT_MS.
  //
  // Inside the lock, `beginAgentInput` announces the drive so the pane can put
  // the user's keyboard focus back if Chromium moved it (see
  // `.claude/rules/agent-driven-focus.md`). Deliberately fired for EVERY
  // capability tier, not just `interact` and `eval`: `observe` dispatches no
  // input today, but a tier list here would go stale the first time a new
  // primitive lands, and the cost is one IPC push per tool call.
  //
  // The announcement is INSIDE the lock, not around it: a call that is still
  // queued has not begun driving, so announcing it would light the pane up and
  // hand the user's focus around for a drive that has not started. The 400ms
  // burst-quiet window in `agent-input-signal.ts` means a queued call arriving
  // shortly after its predecessor still continues the same burst rather than
  // flapping the guard open and shut between them.
  try {
    return await withGuestDriveLock(webContents.id, async () => {
      beginAgentInput(webContents);
      try {
        // NOT DONE HERE: taking the guest's keyboard focus.
        //
        // Chromium delivers a dispatched keystroke to whichever widget genuinely
        // holds focus, and a `<webview>` guest is out-of-process, so acquiring its
        // focus is asynchronous and never atomic. An attempt to hold that focus
        // ACROSS tool calls was built and measured against a live guest: it put the
        // agent's own text into the user's terminal, at 28, then 95, then 207
        // characters as each mitigation was added. Every version of it is a race
        // with the user, who can take focus back mid-dispatch.
        //
        // What works, and has in every measurement, is a click and its keystrokes
        // inside ONE call: the click focuses the guest as a direct side effect of
        // the same input pipeline, and the characters follow with nothing held
        // across a boundary. So the selector forms are the supported path, and the
        // limits of the selector-less ones are documented rather than papered over
        // with focus management. See `docs/embedded-browser.md`.
        const data = await fn(webContents);
        return { ok: true, data } as DriverResult<T>;
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: 'driver-error',
            detail: error instanceof Error ? error.message : String(error),
          },
        } as DriverResult<T>;
      } finally {
        // `finally`, so a throwing tool still ends the guard. A guard that never ends
        // would keep restoring focus out of the pane for the rest of the session.
        endAgentInput(webContents);
      }
    });
  } catch (error) {
    // Only a failure to ACQUIRE lands here - the body above never rethrows.
    // `pane-busy` is its own kind rather than a `driver-error` so the agent can
    // tell "someone else holds this pane" from "the page misbehaved", which are
    // different problems with different fixes.
    if (error instanceof GuestBusyError) {
      return { ok: false, error: { kind: 'pane-busy', detail: error.message } };
    }
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
 * How long a navigation may hold the guest.
 *
 * `webContents.loadURL` resolves on load and rejects on failure, but a dev
 * server that accepts the connection and then never responds leaves it pending
 * indefinitely - which was survivable while drives interleaved, and is not once
 * they are serialized: one hung navigation would hold the guest's queue against
 * every later caller. The bound converts that into a normal tool error.
 */
export const NAVIGATE_TIMEOUT_MS = 20_000;

/**
 * Load a URL into a guest, bounded.
 *
 * Shared by `kangentic_browser_navigate` and the opener's navigate-a-live-pane
 * path so both carry the same bound - the opener runs inside its own
 * `withGuest`, so an unbounded load there holds the guest exactly as long.
 *
 * Like the screenshot bound, the race ABANDONS rather than cancels: Electron
 * exposes no way to cancel an in-flight `loadURL`, so the page may still land
 * afterwards. The caller gets a clean error and the guest's queue is released,
 * which is the property that matters here.
 */
export async function navigateGuest(webContents: WebContents, url: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bounded = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Navigation to ${url} did not complete within ${NAVIGATE_TIMEOUT_MS / 1000}s. The dev server may be starting, unreachable, or hung.`)),
      NAVIGATE_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([webContents.loadURL(url), bounded]);
  } finally {
    if (timer) clearTimeout(timer);
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
