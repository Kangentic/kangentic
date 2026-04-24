import os from 'node:os';
import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/**
 * Claude Code CLI detector.
 *
 * Strips the `(Claude Code)` suffix from the raw version string
 * (e.g. `2.1.90 (Claude Code)` -> `2.1.90`).
 *
 * Includes Unix fallback paths plus `~/.claude/local/claude`, the
 * official Anthropic installer location, for the macOS/Linux GUI
 * launch case where Electron does not inherit the shell PATH.
 */
export class ClaudeDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'claude',
      fallbackPaths: [
        path.join(os.homedir(), '.claude', 'local', 'claude'), // Official Anthropic installer
        ...standardUnixFallbackPaths('claude'),
      ],
      parseVersion: (raw) => raw.replace(/\s*\(Claude Code\)\s*$/i, '').trim() || null,
    });
  }
}
