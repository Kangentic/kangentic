/**
 * The variable that tells a CLI this terminal draws OSC 8 links, which it cannot
 * detect here. Its own module because the agent adapters are in the pty host's
 * bundle and `pty-spawn.ts` is not.
 */
export const HYPERLINK_ENV_KEY = 'FORCE_HYPERLINK';
