import { finalLinesOf, identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Codex CLI's own words for a login it can no longer refresh, read out of the
 * 0.163.0 binary beside `login/src/auth/manager.rs`. Bare `Not logged in` is not
 * here: `codex login status` and `/mcp` print it in a working session. Neither is
 * a 401 on a request (0.171.0 answered the first request after a fresh API key
 * login with one, and the next request worked).
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Your access token could not be refreshed because your refresh token (?:has expired|was already used|was revoked)\. Please log out and sign in again\.$/,
  /^Your access token could not be refreshed\. Please log out and sign in again\.$/,
];

/**
 * Codex refusing a repository's own `.codex/config.toml` and exiting at launch,
 * in the words 0.171.0 printed (a TOML parse error in that file). Kangentic writes
 * nothing in a project's `.codex` folder, so the file is the user's. Not
 * `Error loading config.toml`: Kangentic writes trust tables into the home
 * `config.toml` and passes `-c` overrides, so a refusal of those may be ours.
 */
const PROJECT_CONFIG_REFUSED = /^Error: Error parsing project config file .+[\\/]\.codex[\\/]config\.toml: /;

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyCodexUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  const login = identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
  if (login) return login;
  const refused = finalLinesOf(finalOutput).find((line) => PROJECT_CONFIG_REFUSED.test(line));
  return refused === undefined ? null : { failure: 'bad_configuration', line: refused };
}
