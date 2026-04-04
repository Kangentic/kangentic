import fs from 'node:fs';
import which from 'which';
import { execVersion } from '../../shared/exec-version';
import type { AgentInfo } from '../../agent-adapter';

// Common install locations that may not be on PATH when Electron launches
// from Finder/Dock (macOS GUI apps don't inherit shell profile PATH).
const FALLBACK_PATHS = [
  '/opt/homebrew/bin/claude',     // Homebrew on Apple Silicon
  '/usr/local/bin/claude',        // Homebrew on Intel Mac / manual installs
  '/home/linuxbrew/.linuxbrew/bin/claude', // Linuxbrew
];

export class ClaudeDetector {
  private cached: AgentInfo | null = null;
  private inflight: Promise<AgentInfo> | null = null;

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    if (this.cached) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.performDetection(overridePath);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async performDetection(overridePath?: string | null): Promise<AgentInfo> {
    // 1. Try the user-configured override path first
    if (overridePath) {
      const version = await this.extractVersion(overridePath);
      if (version !== null) {
        this.cached = { found: true, path: overridePath, version };
        return this.cached;
      }
      // User explicitly configured this path but it failed - report it
      this.cached = { found: false, path: overridePath, version: null };
      return this.cached;
    }

    // 2. Try PATH-based discovery (works when launched from terminal)
    try {
      const whichPath = await which('claude');
      const version = await this.extractVersion(whichPath);
      if (version !== null) {
        this.cached = { found: true, path: whichPath, version };
        return this.cached;
      }
    } catch { /* not on PATH */ }

    // 3. Try well-known fallback locations (Homebrew, etc.)
    for (const fallbackPath of FALLBACK_PATHS) {
      if (!fs.existsSync(fallbackPath)) continue;
      const version = await this.extractVersion(fallbackPath);
      if (version !== null) {
        this.cached = { found: true, path: fallbackPath, version };
        return this.cached;
      }
    }

    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  /** Run --version and return the version string, or null on failure. */
  private async extractVersion(candidatePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const { stdout, stderr } = await execVersion(candidatePath);
      const raw = stdout.trim() || stderr.trim() || null;
      // `claude --version` outputs e.g. "2.1.90 (Claude Code)" - strip the product name suffix
      return raw?.replace(/\s*\(Claude Code\)\s*$/i, '') ?? null;
    } catch {
      return null;
    }
  }

  invalidateCache(): void {
    this.cached = null;
    this.inflight = null;
  }
}
