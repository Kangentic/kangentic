import fs from 'node:fs';
import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentInfo } from './agent-adapter';

const execFileAsync = promisify(execFile);

export class GeminiDetector {
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
      const geminiPath = overridePath || await which('gemini');
      const version = await this.extractVersion(geminiPath);
      this.cached = { found: true, path: geminiPath, version };
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
      return stdout.trim() || stderr.trim() || null;
    } catch {
      return null;
    }
  }

  invalidateCache(): void {
    this.cached = null;
    this.inflight = null;
  }
}
