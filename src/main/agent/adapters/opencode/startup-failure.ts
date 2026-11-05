import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * OpenCode's own words, read out of the 1.18.31 binary. Its config errors are not
 * here: Kangentic hands it a plugin, so a config error may be ours.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Authentication is missing or has expired \(the endpoint is likely behind an SSO or identity-aware proxy\)\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyOpenCodeUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
