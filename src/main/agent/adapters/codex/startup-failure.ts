import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Codex CLI's own words for a login it can no longer refresh, read out of the
 * 0.163.0 binary beside `login/src/auth/manager.rs`. Bare `Not logged in` is not
 * here: `codex login status` and `/mcp` print it in a working session. Neither is
 * `Error loading config.toml`: Kangentic passes `-c` overrides, so a config error
 * may be ours.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Your access token could not be refreshed because your refresh token (?:has expired|was already used|was revoked)\. Please log out and sign in again\.$/,
  /^Your access token could not be refreshed\. Please log out and sign in again\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyCodexUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
