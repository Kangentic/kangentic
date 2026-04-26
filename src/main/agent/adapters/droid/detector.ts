import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Factory Droid CLI detector.
 *
 * Strips an optional `droid` product prefix from the raw `--version`
 * output. Empirically the Factory CLI prints either `droid 1.2.3`
 * (matches `factory-cli`-style format) or just the bare version
 * `1.2.3`; both forms map to the trimmed version string.
 */
export class DroidDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'droid',
      fallbackPaths: standardUnixFallbackPaths('droid'),
      parseVersion: (raw) => {
        const stripped = raw.replace(/^droid\s+/i, '').trim();
        return stripped.length > 0 ? stripped : null;
      },
    });
  }
}
