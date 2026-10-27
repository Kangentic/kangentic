import os from 'node:os';
import path from 'node:path';

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
 * Read per call, so a test or a user that changes the variable is not
 * shadowed by a value captured at import.
 */
export function geminiHomeDir(): string {
  const override = process.env.GEMINI_CLI_HOME?.trim();
  return path.join(override && path.isAbsolute(override) ? override : os.homedir(), '.gemini');
}
