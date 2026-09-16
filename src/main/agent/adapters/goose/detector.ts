import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Goose CLI detector.
 *
 * Version banner: `goose --version` prints `goose 1.10.0`.
 *
 * COLLISION HAZARD - read before touching `binaryName` or `parseVersion`:
 * `goose` is also the binary name of pressly/goose, a widely installed Go
 * database-migration tool (`go install github.com/pressly/goose/v3/cmd/goose`,
 * landing in `~/go/bin/goose`). Its banner is `goose version: v3.24.1`, so a
 * scan-anywhere `\d+\.\d+\.\d+` match extracts `3.24.1` from it and reports
 * the migration tool as Block's agent CLI. `parseVersion` therefore REQUIRES
 * the `goose ` product prefix followed immediately by a digit, which the
 * migration tool's `version:` token fails. This mirrors `GrokDetector`, where
 * the same anchoring keeps xAI's and Cursor's shared `agent` shim apart.
 *
 * Rejecting a foreign banner is not the end of detection: `AgentDetector`
 * walks EVERY `which` match in order, so a machine carrying both binaries
 * skips the migration tool and keeps looking for the real Goose.
 *
 * Install locations: the official installer puts the binary in `~/.local/bin`
 * on macOS/Linux (covered by `standardUnixFallbackPaths`) and in
 * `%USERPROFILE%\.local\bin` on Windows, where it is added to PATH and found
 * by `which` - `standardUnixFallbackPaths` returns [] on win32 by design.
 */
export class GooseDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'goose',
      fallbackPaths: standardUnixFallbackPaths('goose'),
      parseVersion: parseGooseVersion,
    });
  }
}

/**
 * Extract the version from `goose --version` output, or null when the banner
 * is not Block Goose's. `goose 1.10.0` -> `1.10.0`;
 * `goose version: v3.24.1` (pressly/goose) -> null.
 */
export function parseGooseVersion(raw: string): string | null {
  const match = raw.trim().match(/^goose\s+(\d[\w.+-]*)/i);
  return match ? match[1] : null;
}
