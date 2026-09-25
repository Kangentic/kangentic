import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Goose CLI detector.
 *
 * Version banner: `goose --version` prints `goose 1.10.0`.
 *
 * COLLISION HAZARD - read before touching `binaryName` or `parseVersion`:
 * TWO other tools install a binary called `goose`.
 *   - pressly/goose, a widely used Go database-migration tool
 *     (`go install github.com/pressly/goose/v3/cmd/goose` -> `~/go/bin/goose`),
 *     banner `goose version: v3.24.1`.
 *   - the awesome-goose scaffolding framework, banner `goose version 0.0.0`.
 * A scan-anywhere `\d+\.\d+\.\d+` match pulls a version out of both and reports
 * them as Block's agent CLI, after which Kangentic spawns `goose run -t ... -s`
 * against a tool with no such command. `parseVersion` therefore REQUIRES a
 * DIGIT immediately after the product name, which both impostors fail because
 * they put the literal word `version` there. This mirrors `GrokDetector`, where
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
 * is not Block Goose's.
 *
 * The discriminator is the token right after the product name: Block's CLI is
 * clap-generated, so the version follows immediately (`goose 1.10.0`), while
 * both impostors put the literal word `version` there (`goose version: v3.24.1`,
 * `goose version 0.0.0`). Requiring a digit in that slot separates them without
 * needing to pin one exact banner, which matters because Goose's published docs
 * show the `--version` COMMAND everywhere and its stdout nowhere. So the accept
 * side is deliberately a little loose - `goose` or `goose-cli`, an optional `v`,
 * case-insensitive - since a false negative here is a detectable "not found"
 * while a false positive spawns the wrong binary.
 */
export function parseGooseVersion(raw: string): string | null {
  const match = raw.trim().match(/^goose(?:-cli)?\s+v?(\d[\w.+-]*)/i);
  return match ? match[1] : null;
}
