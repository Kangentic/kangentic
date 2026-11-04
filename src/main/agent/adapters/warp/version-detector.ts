import fs from 'node:fs';
import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import type { VersionLaunch } from '../../shared/exec-version';

/**
 * Extract the Warp version from `oz dump-debug-info` output.
 *
 * The oz CLI does not support `--version`. Instead, `dump-debug-info`
 * prints lines like:
 *   Warp version: Some("v0.2026.04.08.08.36.stable_02")
 *
 * We extract the version string from the `Some("...")` wrapper.
 */
export function parseWarpVersion(output: string): string | null {
  const match = output.match(/Warp version:\s*Some\("([^"]+)"\)/);
  return match ? match[1] : null;
}

/** A launcher script is a few lines; anything larger is not Warp's shim. */
const MAX_SHIM_BYTES = 64 * 1024;

/**
 * Read Warp's Windows launcher, `oz.cmd`, into the program it runs and the
 * variables it sets. Warp v0.2026.04.08.08.36.stable_02 installs:
 *
 *   @echo off
 *   set "WARP_CLI_MODE=1"
 *   "<install>\warp.exe" %*
 *
 * `%~dp0` (the script's own folder, with its trailing separator) is resolved
 * against `shimDirectory`, and a `%NAME%` reference against the shim's own
 * `set` variables, then `environment`, ignoring case as cmd does. `set` is
 * read in its quoted and bare forms. Null when no line runs an `.exe` with
 * `%*`, or when the program it names is still not an absolute path, since
 * execFile expands nothing. The shim only exists on Windows, so its paths are
 * read as Windows paths (`path.win32`) on every platform.
 */
export function parseWarpCliShim(
  text: string,
  shimDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): VersionLaunch | null {
  const env: Record<string, string> = {};
  let file: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const setMatch = line.match(/^\s*set\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"|([A-Za-z_][A-Za-z0-9_]*)=([^"]*?))\s*$/i);
    if (setMatch) {
      env[setMatch[1] ?? setMatch[3]] = setMatch[2] ?? setMatch[4];
      continue;
    }
    const runMatch = line.match(/^\s*"([^"]+\.exe)"\s+%\*\s*$/i);
    if (runMatch && !file) {
      const folder = /[\\/]$/.test(shimDirectory) ? shimDirectory : shimDirectory + path.win32.sep;
      file = runMatch[1]
        .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (reference, name: string) => lookupVariable(name, env, environment) ?? reference)
        .replace(/%~dp0/gi, () => folder);
    }
  }
  if (!file) return null;
  const resolved = path.win32.normalize(file);
  if (resolved.includes('%') || !path.win32.isAbsolute(resolved)) return null;
  return { file: resolved, env };
}

/** A cmd variable's value, matched without regard to case, from the first source that sets it. */
function lookupVariable(name: string, ...sources: ReadonlyArray<Readonly<Record<string, string | undefined>>>): string | undefined {
  const wanted = name.toLowerCase();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && key.toLowerCase() === wanted) return value;
    }
  }
  return undefined;
}

/**
 * The program the version probe starts directly on Windows, or null to probe
 * the path as found.
 *
 * Run through cmd, as every Windows version probe runs, Warp's CLI prints
 * nothing: `oz.cmd` runs `warp.exe`, a GUI-subsystem program, and cmd loses
 * its output on the way to the pipe. Measured on this install: `oz.cmd` and
 * `warp.exe` through cmd both returned empty, `warp.exe` started directly
 * returned the `dump-debug-info` text, and `oz.cmd` inside a pseudo-terminal
 * printed it too, so only the probe needs this, not the session's spawn.
 * Before it, the detector logged "exited without printing anything" and never
 * found Oz on Windows.
 *
 * A configured `warp.exe` is started directly with `WARP_CLI_MODE=1`, the
 * variable the shim sets. A shim whose program is missing is probed as found,
 * so the report names the shim's own failure.
 */
export function warpVersionLaunch(candidatePath: string, platform: NodeJS.Platform = process.platform): VersionLaunch | null {
  if (platform !== 'win32') return null;
  const extension = path.win32.extname(candidatePath).toLowerCase();
  if (extension === '.exe') return { file: candidatePath, env: { WARP_CLI_MODE: '1' } };
  if (extension !== '.cmd' && extension !== '.bat') return null;
  try {
    if (fs.statSync(candidatePath).size > MAX_SHIM_BYTES) return null;
    const launch = parseWarpCliShim(fs.readFileSync(candidatePath, 'utf-8'), path.win32.dirname(candidatePath));
    return launch && fs.existsSync(launch.file) ? launch : null;
  } catch {
    // Unreadable shim: probe it through cmd as before, and let that report.
    return null;
  }
}

/**
 * Oz CLI detector: the shared pipeline with Oz's own version command, so it
 * caches per CLI path (two projects can name two installs), skips a dead npm
 * shim, and probes an `oz` installed in a WSL distro inside that distro. On
 * Windows the probe starts the `warp.exe` that `oz.cmd` names, directly
 * (`warpVersionLaunch`).
 */
export class WarpDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'oz',
      versionArgs: ['dump-debug-info'],
      parseVersion: parseWarpVersion,
      versionLaunch: (candidatePath) => warpVersionLaunch(candidatePath),
      // A `\\wsl.localhost\<distro>\...` path is probed inside the distro.
      supportsWslCli: true,
    });
  }
}
