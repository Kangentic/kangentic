import os from 'node:os';
import path from 'node:path';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * Gemini CLI's user directory: `<GEMINI_CLI_HOME>/.gemini` when that variable
 * is set, else `~/.gemini`.
 *
 * Gemini's configuration docs: `GEMINI_CLI_HOME` "specifies the root directory
 * for Gemini CLI's user-level configuration and storage", by default the home
 * directory, and "the CLI will create a `.gemini` folder inside" it. Trusted
 * folders, the per-project chats and the project registry all live there, so
 * Kangentic must use the same folder: with `~/.gemini` hard-coded, a user with
 * `GEMINI_CLI_HOME` set got trust written where Gemini never looks (and an
 * untrusted folder disables every MCP server, Kangentic's included).
 *
 * Only an absolute value is taken; a relative one would resolve against the
 * CLI's own working directory, which a global reader does not have.
 *
 * A Gemini installed in a WSL distro (`place`) keeps its directory in the
 * distro, under the `GEMINI_CLI_HOME` its own shell sets, else the distro's
 * home, reached through the distro's share.
 *
 * Read per call, so a test or a user that changes the variable is not
 * shadowed by a value captured at import.
 */
export function geminiHomeDir(place: CliPlace | null = null): string {
  if (place) {
    const override = place.facts.env.GEMINI_CLI_HOME?.trim();
    return path.join(override?.startsWith('/') ? hostPathForTarget(override, place) : place.facts.homeUnc, '.gemini');
  }
  const override = process.env.GEMINI_CLI_HOME?.trim();
  return path.join(override && path.isAbsolute(override) ? override : os.homedir(), '.gemini');
}
