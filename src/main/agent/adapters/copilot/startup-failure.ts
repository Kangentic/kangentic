import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Copilot CLI's own words, read out of the 1.0.105 bundle, printed before an exit
 * with code 1. `Authentication token found but could not be validated.` is not
 * here: the CLI itself says it may be the network.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Error: No authentication information found\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyCopilotUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
