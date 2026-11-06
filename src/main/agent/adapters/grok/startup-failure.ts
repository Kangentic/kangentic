import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Grok Build's own words, read out of the 1.0.0 binary. `You are not authenticated.`
 * is not here: it belongs to `grok models`, not to a launch.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Not signed in\. Run `grok login` to authenticate \(or `grok login --device-code` if no browser is available\)\.$/,
  /^Headless mode requires a grok\.com session\. Run `grok login` to sign in, or use `grok agent stdio` for API-key access\.$/,
  /^Your session has expired\. Run `grok login` to sign in again\.$/,
  /^Your auth token is invalid or expired\. Run `grok login` to re-authenticate\.$/,
  /^Your GROK_DEPLOYMENT_KEY is invalid or expired\. Please contact a team admin\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyGrokUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
