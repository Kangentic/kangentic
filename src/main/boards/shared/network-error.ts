/**
 * The errno a failed `fetch` carries (`ENOTFOUND`, `ECONNREFUSED`, a TLS code),
 * when it has one. Node's `fetch` puts it on the error's `cause`. A request that
 * ran out of time (`AbortSignal.timeout`, or an abort) reads as `ETIMEDOUT`.
 * Undefined for an error that did not come from the network, so a caller can
 * tell "the server did not answer" from a defect.
 */
export function networkCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return code;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'ETIMEDOUT';
  return undefined;
}
