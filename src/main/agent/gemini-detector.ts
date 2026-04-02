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
      let version: string | null = null;
      try {
        const { stdout } = await execFileAsync(geminiPath, ['--version'], {
          timeout: 5000,
        });
        version = stdout.trim();
      } catch { /* version detection failed */ }

      this.cached = { found: true, path: geminiPath, version };
      return this.cached;
    } catch {
      this.cached = { found: false, path: null, version: null };
      return this.cached;
    }
  }

  invalidateCache(): void {
    this.cached = null;
    this.inflight = null;
  }
}
