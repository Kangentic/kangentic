import type { BrowserOptions } from '@sentry/electron/renderer';

/**
 * What the Sentry SDK may collect on its own, passed as `dataCollection` by
 * both processes: main in src/main/analytics/error-reporting.ts and the
 * renderer in src/renderer/error-reporting.ts.
 *
 * Sentry 8 (SDK 11) replaced `sendDefaultPii` with this object, and every field
 * left out of it COLLECTS: the user's IP address, cookies, HTTP headers and
 * bodies, query strings, AI and database payloads, and local variables. So
 * every field is spelled out here and turned off, which is what
 * `sendDefaultPii: false` meant for us before, and stricter.
 *
 * Off rather than on with deny lists, because Kangentic reports errors only and
 * the Privacy tab says no task content or personal data is attached. Two fields
 * guard something real in main. The MCP HTTP server runs there, so an error
 * raised while it handles a request would otherwise carry that request's
 * headers (the `x-kangentic-token` bearer) and body (an agent's tool arguments,
 * task text included). And `userInfo` decides whether Sentry infers the
 * sender's IP address, in both processes. `stackFrameVariables` is a guard
 * only: the SDK captures local variables only under `includeLocalVariables`,
 * which is never set. `frameContextLines` keeps its default, since it reads
 * source lines from the app's own bundle.
 *
 * The type import is erased at build, so neither bundle pulls in an SDK through
 * this module; it is here so a misspelled or removed field fails typecheck.
 * docs/analytics.md ("Error Reporting") is the prose.
 */
export const SENTRY_DATA_COLLECTION: NonNullable<BrowserOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};
