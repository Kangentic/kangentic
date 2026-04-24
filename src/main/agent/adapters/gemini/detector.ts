import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Gemini CLI detector.
 *
 * Gemini's `--version` output is the raw version string with no
 * product-name prefix or suffix (e.g. `0.37.0`), so parseVersion is
 * essentially identity.
 */
export class GeminiDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'gemini',
      fallbackPaths: standardUnixFallbackPaths('gemini'),
      parseVersion: (raw) => raw.trim() || null,
    });
  }
}
