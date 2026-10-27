import os from 'node:os';
import path from 'node:path';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';

/**
 * Qwen Code's global directory: `$QWEN_HOME` when set, else `~/.qwen`.
 *
 * Qwen's settings docs: `QWEN_HOME` "customizes the global configuration
 * directory (default: `~/.qwen`)", where it keeps credentials, settings,
 * trusted folders and the per-project chats, and an empty value is unset. A
 * leading `~` is expanded. Kangentic must write trust to, and read chats from,
 * the directory Qwen uses: with `~/.qwen` hard-coded, a user with `QWEN_HOME`
 * set got trust written where Qwen never looks, and no model or history.
 *
 * A relative value is resolved by Qwen against its own working directory,
 * which differs per session; the readers here have none to resolve it against
 * (the model scan is global), so they keep the default for it.
 *
 * A Qwen installed in a WSL distro (`place`) keeps its directory in the
 * distro's home, under the `QWEN_HOME` its own shell sets, reached through
 * the distro's share.
 *
 * Read per call, as `codexHomeDir` reads `CODEX_HOME`, so a test or a user
 * that changes the variable is not shadowed by a value captured at import.
 */
export function qwenHomeDir(place: CliPlace | null = null): string {
  if (place) {
    const override = place.facts.env.QWEN_HOME?.trim();
    const linuxPath = override === '~' || override?.startsWith('~/') ? `${place.facts.homeLinux}${override.slice(1)}` : override;
    return linuxPath?.startsWith('/') ? hostPathForTarget(linuxPath, place) : path.join(place.facts.homeUnc, '.qwen');
  }
  const override = process.env.QWEN_HOME?.trim();
  if (override) {
    const expanded = override === '~' || /^~[\\/]/.test(override) ? path.join(os.homedir(), override.slice(1)) : override;
    if (path.isAbsolute(expanded)) return expanded;
  }
  return path.join(os.homedir(), '.qwen');
}
