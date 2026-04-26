import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Qwen Code CLI detector.
 *
 * Qwen Code is a soft fork of Google's gemini-cli, so the version-print
 * path is inherited unchanged: `qwen --version` emits the raw version
 * string with no product-name prefix or suffix (e.g. `0.0.14`). parseVersion
 * is therefore identity, matching GeminiDetector.
 */
export class QwenDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'qwen',
      fallbackPaths: standardUnixFallbackPaths('qwen'),
      parseVersion: (raw) => raw.trim() || null,
    });
  }
}
