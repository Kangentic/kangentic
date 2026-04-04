import fs from 'node:fs';
import which from 'which';
import { execVersion } from '../../shared/exec-version';
import type { AgentInfo } from '../../agent-adapter';

export class CodexDetector {
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
    try {
      const codexPath = overridePath || await which('codex');
      const version = await this.extractVersion(codexPath);
      this.cached = { found: true, path: codexPath, version };
      return this.cached;
    } catch { /* not on PATH */ }

    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  /** Run --version and return the version string, or null on failure. */
  private async extractVersion(candidatePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const { stdout, stderr } = await execVersion(candidatePath);
      const raw = stdout.trim() || stderr.trim() || null;
      // `codex --version` outputs e.g. "codex-cli 0.118.0" - strip the product name prefix
      return raw?.replace(/^codex-cli\s+/i, '') ?? null;
    } catch {
      return null;
    }
  }

  invalidateCache(): void {
    this.cached = null;
    this.inflight = null;
  }
}
