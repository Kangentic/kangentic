import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Droid's own words, read out of the 0.218.0 binary. Its settings errors are not
 * here: Kangentic writes the session's settings file, so one may be ours.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Not authenticated\. Please log in using \/login or set a valid FACTORY_API_KEY environment variable\.$/,
  /^Authentication failed\. FACTORY_API_KEY is set but appears to be invalid\. Unset it or replace it with a valid key\.$/,
  /^Authentication failed\. Your login session may have expired\. Please log in again using \/login\.$/,
  /^Authentication failed\. Please log in using \/login or set a valid FACTORY_API_KEY environment variable\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyDroidUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
