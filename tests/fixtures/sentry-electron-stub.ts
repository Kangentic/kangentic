/**
 * Unit-tier stand-in for `@sentry/electron/main` and `@sentry/electron/renderer`,
 * wired via the aliases in vitest.config.ts for the same reason as the
 * Aptabase stub beside it: the real package's ESM build named-imports from
 * 'electron', which Node's ESM linker rejects against the CJS electron stub
 * under plain-node vitest. Suites that assert on error-reporting behavior
 * keep their own `vi.mock('@sentry/electron/main', ...)`, which overrides
 * this alias; this stub only keeps the import graph loadable for everyone
 * else. Every export is a no-op mirroring the calls the app makes.
 */
type ScopeLike = { setTag: (key: string, value: string) => void };

export function init(): void {}

export function captureException(): string {
  return '';
}

export function setUser(): void {}

export function withScope(callback: (scope: ScopeLike) => void): void {
  callback({ setTag: () => {} });
}
