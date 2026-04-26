import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * OpenCode CLI detector.
 *
 * Binary name: `opencode` (with a `.cmd` shim on Windows for npm
 * installs). Distributed via Homebrew, Scoop, Chocolatey, Pacman, the
 * curl|sh installer, and `npm i -g opencode-ai`. All install methods
 * publish the same `opencode` binary name.
 *
 * Version output is the bare version string. If a future release
 * prepends a product name we'll tighten the parser.
 */
export class OpenCodeDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'opencode',
      fallbackPaths: standardUnixFallbackPaths('opencode'),
      parseVersion: (raw) => {
        const trimmed = raw.replace(/^opencode\s+/i, '').trim();
        return trimmed.length > 0 ? trimmed : null;
      },
    });
  }
}
