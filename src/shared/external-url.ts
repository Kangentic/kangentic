/**
 * Scheme allowlist for URLs handed to the OS (shell.openExternal, a denied
 * window.open, a terminal OSC 8 hyperlink). shell.openExternal is
 * ShellExecute on Windows and will launch any registered protocol handler,
 * so every caller of this module is a process trust boundary.
 *
 * Two allowed sets, not one, because the callers have different threat
 * models: terminal OSC 8 sequences are agent-controlled bytes with zero user
 * intent (anything a session prints, cats, or echoes can carry one), while
 * the shell:openExternal IPC channel is invoked only by deliberate UI
 * affordances (markdown links, PR pills, docs pills) that legitimately need
 * mailto:.
 */

export const TERMINAL_LINK_SCHEMES = ['http:', 'https:'] as const;
export const EXTERNAL_OPEN_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

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
