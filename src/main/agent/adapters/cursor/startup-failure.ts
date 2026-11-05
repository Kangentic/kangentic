import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Cursor's own words, read out of the 2026.09.26 bundle, each printed before an
 * exit with code 1. Bare `Not logged in` is not here: `about`, `status` and `/usage`
 * print it in a working session.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Error: Authentication required\. Run '.+ login', pass --api-key\/--auth-token, or set CURSOR_API_KEY\/CURSOR_AUTH_TOKEN\.$/,
  /^\S* ?Warning: The provided API key is invalid\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyCursorUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
