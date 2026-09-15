import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Goose CLI detector.
 *
 * Goose supports `goose --version`, whose output contains a semver
 * (e.g. `goose 1.10.0`). We extract the first `MAJOR.MINOR.PATCH` run rather
 * than stripping a fixed prefix, because the surrounding wrapper text varies
 * between builds and packaging.
 */
export class GooseDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'goose',
      fallbackPaths: standardUnixFallbackPaths('goose'),
      parseVersion: (raw) => raw.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
    });
  }
}
