/**
 * The Vite dev server's address, for the few UI specs that need the dev server itself.
 *
 * On CI the UI tier loads the app from a static bundle (scripts/build-ui-bundle.mjs), served on
 * PLAYWRIGHT_VITE_PORT, because the dev server's one request per source module was most of what a
 * test cost. A bundle has no source-path URLs and no HMR client, so a spec that does one of these
 * takes its URL from here instead of from PLAYWRIGHT_VITE_PORT:
 *
 * - stalls or fails a module by its source path (`page.route('**' + '/ChangesPanel.tsx*')`),
 * - imports a module by its source path in the page (`import('/src/renderer/...')`),
 * - drives the dev server's own client (the dev restart notice).
 *
 * In bundle mode playwright.config.ts starts the dev server on a second port. Without the flag
 * there is one server and the two ports are the same, so a spec here behaves as it always has.
 * tests/unit/ui-bundle.test.ts fails a spec that does one of the above from anywhere else, since
 * it would pass locally and fail on CI.
 *
 * Reach a module's exports through `window.__kangenticTestModules` or `window.__zustandStores`
 * (src/renderer/App.tsx) where one of them holds it. That works in both modes and keeps the spec
 * on the bundle.
 */
export const DEV_SERVER_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_DEV_PORT || process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
