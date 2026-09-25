/**
 * Every link from the app into the docs site, built from one base URL.
 *
 * The host is the canonical apex, with no `www`. Both hosts resolve and serve
 * the same pages (neither redirects to the other), so the mixed set the app
 * shipped for a while was never broken. It just meant a docs move had to find
 * five independent copies of the base by grep, and each new link picked
 * whichever host its author had last seen. There is one copy now.
 *
 * The paths below are the set the website treats as contracts and will not
 * move. A page the site is free to reorganize does not belong here: put it at
 * its call site and let the scan in `tests/unit/docs-links.test.ts` fail, which
 * is the moment to decide whether the site owes it a stable URL.
 *
 * `announcements.json` is the one surface that ships a docs link without going
 * through this module, because it is hand-authored data that no import can
 * reach. The same test holds its host.
 */
export const DOCS_BASE_URL = 'https://kangentic.com';

export const DOCS_URLS = {
  gettingStarted: `${DOCS_BASE_URL}/getting-started/`,
  mobile: `${DOCS_BASE_URL}/mobile/`,
  mobilePairing: `${DOCS_BASE_URL}/mobile/pairing/`,
  relay: `${DOCS_BASE_URL}/relay/`,
  mcpServer: `${DOCS_BASE_URL}/mcp-server/`,
} as const;
