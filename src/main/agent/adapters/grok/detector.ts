import os from 'node:os';
import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Grok Build CLI detector.
 *
 * Version banner (verified against grok 1.0.0 on Windows):
 *   `grok 1.0.0 (3cd0d0cbce) [stable]`
 *
 * COLLISION HAZARD - read before touching `binaryName` or `parseVersion`:
 * xAI's installer publishes BOTH `grok` and a generic `agent` shim, and
 * Cursor also publishes `agent` (with `cursor-agent`). On Windows, Grok's
 * `agent.exe` beats Cursor's `agent.cmd` in PATHEXT order, which once made
 * Cursor undetectable on any machine with Grok installed (see
 * `tests/unit/cursor-grok-binary-collision.test.ts`). Two invariants keep
 * both directions safe:
 *
 *   1. This detector probes ONLY `grok` - never the shared `agent` shim.
 *   2. `parseVersion` REQUIRES the `grok ` product prefix, so if a foreign
 *      binary ever answers (Cursor's `Cursor Agent 1.0.0` / bare
 *      `2026.04.29-c83a488`, Codex's `codex-cli 0.128.0`), it is rejected
 *      and detection keeps looking instead of mis-identifying it.
 *
 * The official installer puts the binary at `~/.grok/bin/grok` (grok.exe on
 * Windows) and adds it to PATH. The explicit home fallback covers the macOS
 * Finder/Dock launch case (no login-shell PATH) and any Windows session
 * where the PATH edit has not propagated; note `standardUnixFallbackPaths`
 * returns [] on win32, so the Windows install path must be listed here.
 */
export class GrokDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'grok',
      fallbackPaths: [
        ...standardUnixFallbackPaths('grok'),
        path.join(os.homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'),
      ],
      parseVersion: parseGrokVersion,
    });
  }
}

/**
 * Extract the version from `grok --version` output, or null when the banner
 * is not Grok's. `grok 1.0.0 (3cd0d0cbce) [stable]` -> `1.0.0`.
 */
export function parseGrokVersion(raw: string): string | null {
  const match = raw.trim().match(/^grok\s+(\d[\w.+-]*)/i);
  return match ? match[1] : null;
}
