/**
 * An agent CLI's version as a report tag. Its own module with no imports, so a
 * reporter that needs only this (the account report) does not load the launch
 * report's graph, which reaches `electron`.
 */

/** Starts with a digit, one token, no slash, backslash or space, so a path or a banner fails it. */
const CLI_VERSION = /^v?\d[0-9A-Za-z._+-]{0,47}$/;

/**
 * The CLI's version as a tag, or `unknown`. Detection keeps what the CLI printed,
 * and some parsers only trim it, so a banner or a path can sit in that string.
 */
export function cliVersionTag(version: string | null | undefined): string {
  const firstToken = version?.trim().split(/\s+/)[0] ?? '';
  return CLI_VERSION.test(firstToken) ? firstToken : 'unknown';
}
