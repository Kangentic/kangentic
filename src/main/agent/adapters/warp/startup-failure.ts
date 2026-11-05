import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/** The Oz CLI's own words, read out of the Warp v0.2026.04.08 binary. */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Your API key is invalid\. Please provide a valid key via '--api-key' or the WARP_API_KEY environment variable\.$/,
  /^Failed to authenticate with server - please log in via 'oz login', provide an API key via '--api-key <key>', or set the WARP_API_KEY environment variable$/,
  /^You are not logged in - please log in with `.+ login` to continue\.$/,
  /^Your credentials are invalid\. Please log in again with `.+ login`\.$/,
  /^Authentication required\. Log in via '.+ login', provide an API key via '--api-key', or set the WARP_API_KEY environment variable\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyWarpUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
