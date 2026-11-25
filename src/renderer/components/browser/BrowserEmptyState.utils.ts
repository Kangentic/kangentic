// Pure URL normalization logic extracted from BrowserEmptyState.tsx
// so it can be unit-tested without React / Electron globals.

/**
 * Normalizes a user-typed URL input:
 * - Trims whitespace.
 * - Bare hostnames (no scheme) are prefixed with `http://`.
 * - Returns the canonical URL string when valid http/https.
 * - Returns null for empty strings, non-http(s) schemes, or unparsable input.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = trimmed.match(/^https?:\/\//i) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    // report-ok: the user typed a URL that does not parse, and null is the documented answer.
    return null;
  }
}
