import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Codex CLI detector.
 *
 * Strips the `codex-cli ` prefix from the raw version string
 * (e.g. `codex-cli 0.118.0` -> `0.118.0`).
 */
export class CodexDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'codex',
      fallbackPaths: standardUnixFallbackPaths('codex'),
      parseVersion: (raw) => raw.replace(/^codex-cli\s+/i, '').trim() || null,
    });
  }
}
