import path from 'node:path';
import { identifyLoginFailure } from '../../shared/user-setup-failure';
import { identifyRejectedHomeSettings } from '../gemini/startup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';
import { qwenHomeDir } from './qwen-home';

/** Qwen Code's own words, read out of the 0.26.5 bundle. */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^No auth type is selected\. Please configure an auth type \(e\.g\. via settings or `--auth-type`\) before running in non-interactive mode\.$/,
  /^Missing API key for OpenAI-compatible auth\. Set the \S+ environment variable\.$/,
  /^Qwen OAuth credentials expired\. Please use \/auth to re-authenticate with qwen-oauth\.$/,
  /^Refresh token expired or invalid\. Please use '\/auth' to re-authenticate\.$/,
];

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyQwenUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES)
    // The home Qwen reads, `QWEN_HOME` included: a user who moved it has their settings there.
    ?? identifyRejectedHomeSettings(finalOutput, path.join(qwenHomeDir(), 'settings.json'));
}
