import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Well-known install locations for the `agy` binary.
 *
 * The official installer places it at `%LOCALAPPDATA%\agy\bin\agy.exe` on
 * Windows (verified against a real 1.1.x install; NOT `%LOCALAPPDATA%\
 * Antigravity\`, which is a different product's staging dir) and
 * `~/.local/bin/agy` on macOS/Linux (already covered by
 * `standardUnixFallbackPaths`). The installer normally also adds the bin dir
 * to PATH, so these fallbacks only matter for the GUI-launch minimal-PATH
 * case the shared detector documents.
 */
function antigravityFallbackPaths(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? [path.join(localAppData, 'agy', 'bin', 'agy.exe')] : [];
  }
  return standardUnixFallbackPaths('agy');
}

/**
 * Detector for Google's Antigravity CLI. `agy --version` prints a bare
 * version (`1.1.13`), so parseVersion is near-identity; requiring a leading
 * digit rejects a foreign tool answering on the same binary name (the
 * Cursor/Grok shared-shim lesson).
 */
export class AntigravityDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'agy',
      fallbackPaths: antigravityFallbackPaths(),
      parseVersion: (raw) => {
        const trimmed = raw.trim();
        return /^\d/.test(trimmed) ? trimmed : null;
      },
    });
  }
}
