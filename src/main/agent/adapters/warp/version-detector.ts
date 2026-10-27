import { AgentDetector } from '../../shared/agent-detector';

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

/**
 * Oz CLI detector: the shared pipeline with Oz's own version command, so it
 * caches per CLI path (two projects can name two installs), skips a dead npm
 * shim, and probes an `oz` installed in a WSL distro inside that distro.
 */
export class WarpDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'oz',
      versionArgs: ['dump-debug-info'],
      parseVersion: parseWarpVersion,
      // A `\\wsl.localhost\<distro>\...` path is probed inside the distro.
      supportsWslCli: true,
    });
  }
}
