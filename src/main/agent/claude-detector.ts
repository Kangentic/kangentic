import fs from 'node:fs';
import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ClaudeInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

export class ClaudeDetector {
  private cached: ClaudeInfo | null = null;
  private inflight: Promise<ClaudeInfo> | null = null;

  async detect(overridePath?: string | null): Promise<ClaudeInfo> {
    if (this.cached) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.performDetection(overridePath);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async performDetection(overridePath?: string | null): Promise<ClaudeInfo> {
    try {
      const claudePath = overridePath || await which('claude');
      const version = await this.extractVersion(claudePath);
      this.cached = { found: true, path: claudePath, version };
      return this.cached;
    } catch { /* not on PATH */ }

    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  /** Run --version and return the version string, or null on failure. */
  private async extractVersion(candidatePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const { stdout, stderr } = await execFileAsync(candidatePath, ['--version'], {
        timeout: 5000,
        shell: process.platform === 'win32',
      });
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
