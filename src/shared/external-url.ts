/**
 * Scheme allowlist for URLs handed to the OS (shell.openExternal, a denied
 * window.open, a terminal OSC 8 hyperlink). shell.openExternal is
 * ShellExecute on Windows and will launch any registered protocol handler,
 * so every caller of this module is a process trust boundary.
 *
 * Three allowed sets, not one, because the callers have different threat
 * models: terminal OSC 8 sequences are agent-controlled bytes with zero user
 * intent (anything a session prints, cats, or echoes can carry one), while
 * the shell:openExternal IPC channel is invoked only by deliberate UI
 * affordances (markdown links, PR pills, docs pills) that legitimately need
 * mailto:.
 */

export const TERMINAL_LINK_SCHEMES = ['http:', 'https:'] as const;
export const EXTERNAL_OPEN_SCHEMES = ['http:', 'https:', 'mailto:'] as const;
/**
 * Schemes the embedded Browser pane and the popups it opens may LOAD.
 *
 * Web content only. Unlike `EXTERNAL_OPEN_SCHEMES` there is deliberately no
 * `mailto:` escape: a pane popup is untrusted page content that an AGENT can
 * navigate, and handing that to `shell.openExternal` is handing it ShellExecute.
 * The pane's own `will-navigate` guard already refuses every non-http(s) scheme,
 * so this set keeps the popup at parity with the guest that spawned it rather
 * than opening a wider door beside it.
 */
export const EMBEDDED_BROWSER_SCHEMES = ['http:', 'https:'] as const;

export function isAllowedExternalUrl(rawUrl: string, allowedSchemes: readonly string[]): boolean {
  if (!rawUrl) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return allowedSchemes.includes(url.protocol);
}
