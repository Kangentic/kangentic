import os from 'node:os';
import path from 'node:path';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * Copilot CLI's config home: `$COPILOT_HOME` when set, else `~/.copilot`.
 *
 * Copilot keeps the signed-in account, settings, MCP servers, command history
 * and its session state there, and `--config-dir` is the same setting on the
 * command line (1.0.97 assigns it to `COPILOT_HOME`). A session's own config
 * home is seeded from this one, so it must be the folder the user's Copilot
 * uses: with `~/.copilot` hard-coded, a user with `COPILOT_HOME` set got every
 * session seeded without their sign-in, settings or MCP servers.
 *
 * Only an absolute value is taken; a relative one would resolve against the
 * CLI's own working directory, which a global reader does not have.
 *
 * A Copilot installed in a WSL distro (`place`) has its home in the distro,
 * under the `COPILOT_HOME` its own shell sets, else the distro's
 * `~/.copilot`, reached through the distro's share. Seeding from it is what
 * keeps the distro's sign-in.
 */
export function copilotHomeDir(place: CliPlace | null = null): string {
  if (place) {
    const distroOverride = place.facts.env.COPILOT_HOME?.trim();
    return distroOverride?.startsWith('/') ? hostPathForTarget(distroOverride, place) : path.join(place.facts.homeUnc, '.copilot');
  }
  const override = process.env.COPILOT_HOME?.trim();
  return override && path.isAbsolute(override) ? override : path.join(os.homedir(), '.copilot');
}
