import { identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * The Antigravity CLI's own words, read out of the 1.4.12 binary, for a print run.
 * Its welcome banner is not here: it shows in a healthy TUI.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Error: authentication required\. Run '.+' to log in(?:, then retry)?\.$/,
  /^Print mode: not logged in and no controlling terminal; cannot complete interactive login$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyAntigravityUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
}
