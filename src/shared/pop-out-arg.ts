/**
 * The additionalArguments flag carrying the base64-encoded pop-out descriptor
 * JSON. Its own module because the sandboxed preload reads it: `pop-out.ts`
 * holds `msg` titles, and the runtime macro behind them hashes message ids
 * with `node:crypto`, which a sandboxed preload cannot load. Nothing the
 * preload imports may reach `@lingui` (`tests/unit/i18n-boundaries.test.ts`).
 */
export const POPOUT_ARG_PREFIX = '--kangentic-popout=';
