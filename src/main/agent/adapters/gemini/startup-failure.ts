import os from 'node:os';
import path from 'node:path';
import { finalLinesOf, identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Gemini CLI's own words, read out of the 0.66.0 bundle, each printed before an
 * exit. `Invalid configuration in <path>:` is not here: it is a warning, and the
 * run goes on.
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Please set an Auth method in your .+ or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA$/,
  /^When using Gemini API, you must specify the GEMINI_API_KEY environment variable\.$/,
  /^Authentication consent could not be obtained\.$/,
  /^Manual authorization is required but the current session is non-interactive\. Please run the Gemini CLI in an interactive terminal to log in, provide a GEMINI_API_KEY, or ensure Application Default Credentials are configured\.$/,
];

const ERROR_LINE_LEAD = 'Error in ';
const FIX_LINE = 'Please fix the configuration file(s) and try again.';

function comparablePath(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase().replaceAll('/', '\\') : filePath;
}

/**
 * The shape Gemini CLI and its fork Qwen Code share when a settings file will not
 * load: `Error in <path>: <why>`, then a fix line, then an exit (0.66.0 and 0.26.5).
 * Only for the user's own file in their home folder: Kangentic writes hooks into
 * the project-level one, so a CLI refusing that may be ours. `homeSettingsPath` is
 * this machine's home, so a CLI in a WSL distro, which prints its own home, does
 * not match and its failure is reported.
 */
export function identifyRejectedHomeSettings(finalOutput: string, homeSettingsPath: string): UserSetupMatch | null {
  const lines = finalLinesOf(finalOutput);
  const fixLine = lines.findIndex((line) => line === FIX_LINE);
  if (fixLine < 0) return null;
  const errorLine = lines[fixLine + 1];
  if (!errorLine?.startsWith(ERROR_LINE_LEAD)) return null;
  const refusedFile = comparablePath(errorLine.slice(ERROR_LINE_LEAD.length));
  return refusedFile.startsWith(`${comparablePath(path.normalize(homeSettingsPath))}:`) ? { failure: 'bad_configuration', line: errorLine } : null;
}

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyGeminiUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  return identifyLoginFailure(finalOutput, LOGIN_SENTENCES)
    ?? identifyRejectedHomeSettings(finalOutput, path.join(os.homedir(), '.gemini', 'settings.json'));
}
