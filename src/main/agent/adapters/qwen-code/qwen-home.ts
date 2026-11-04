import fs from 'node:fs';
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
  // No cwd: a relative value has nothing to resolve against, so it is skipped.
  const override = resolveRuntimeValue(place ? place.facts.env.QWEN_HOME : process.env.QWEN_HOME, null, place);
  if (override) return override;
  return place ? path.join(place.facts.homeUnc, '.qwen') : path.join(os.homedir(), '.qwen');
}

/**
 * The base directory Qwen writes its per-project runtime output under:
 * `projects/<slug>/chats/` (the chats), `projects/<slug>/subagents/` and
 * `tmp/`. Trust and settings stay in `qwenHomeDir`.
 *
 * Qwen's order (`Storage.getRuntimeBaseDir` in
 * https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/config/storage.ts,
 * and the bundled `stuck` skill that spells it out):
 *   1. `QWEN_RUNTIME_DIR`
 *   2. the `advanced.runtimeOutputDir` setting, resolved against the
 *      workspace (`Storage.setRuntimeBaseDir(settings.advanced?.runtimeOutputDir, cwd)`
 *      in packages/cli/src/config/config.ts)
 *   3. `qwenHomeDir` (`QWEN_HOME`, else `~/.qwen`)
 *
 * The setting is read from the workspace's `.qwen/settings.json` first and
 * then the user's, the order Qwen's merge gives them. A leading `~` is
 * expanded. A relative value resolves against `cwd`; a reader with no `cwd`
 * (the model scan, which is global) skips it, as `qwenHomeDir` skips a
 * relative `QWEN_HOME`. A settings file that is not plain JSON (Qwen accepts
 * comments) is skipped. A Qwen in a WSL distro reads its own environment,
 * settings and home. Built from Qwen's source, not yet checked against a
 * real Qwen with either override set.
 */
export function qwenRuntimeDir(cwd: string | null, place: CliPlace | null = null): string {
  // A Qwen in a WSL distro reads the distro shell's own value
  // (`WSL_ENV_KEYS` in wsl-distro.ts collects it).
  const fromEnvironment = resolveRuntimeValue(
    place ? place.facts.env.QWEN_RUNTIME_DIR : process.env.QWEN_RUNTIME_DIR,
    null,
    place,
  );
  if (fromEnvironment) return fromEnvironment;
  const settingsFiles = [
    ...(cwd ? [path.join(cwd, '.qwen', 'settings.json')] : []),
    path.join(qwenHomeDir(place), 'settings.json'),
  ];
  for (const settingsFile of settingsFiles) {
    const fromSettings = resolveRuntimeValue(readRuntimeOutputDir(settingsFile), cwd, place);
    if (fromSettings) return fromSettings;
  }
  return qwenHomeDir(place);
}

/** `advanced.runtimeOutputDir` from one settings file, or null. */
function readRuntimeOutputDir(settingsFile: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const advanced = (parsed as Record<string, unknown>).advanced;
    if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) return null;
    const value = (advanced as Record<string, unknown>).runtimeOutputDir;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * A directory value (`QWEN_HOME`, `QWEN_RUNTIME_DIR`, the setting) made
 * absolute on this machine, or null when it is empty or relative with no
 * `cwd` to resolve it against.
 */
function resolveRuntimeValue(raw: string | null | undefined, cwd: string | null, place: CliPlace | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (place) {
    const linuxPath = value === '~' || value.startsWith('~/') ? `${place.facts.homeLinux}${value.slice(1)}` : value;
    if (linuxPath.startsWith('/')) return hostPathForTarget(linuxPath, place);
    // Relative: the distro resolves it against the `/mnt` form of the same cwd.
    return cwd ? path.resolve(cwd, linuxPath) : null;
  }
  const expanded = value === '~' || /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
  if (path.isAbsolute(expanded)) return expanded;
  return cwd ? path.resolve(cwd, expanded) : null;
}
