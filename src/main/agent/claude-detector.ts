import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ClaudeInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

export class ClaudeDetector {
  private cached: ClaudeInfo | null = null;

  async detect(overridePath?: string | null): Promise<ClaudeInfo> {
    if (this.cached) return this.cached;

    try {
      const claudePath = overridePath || await which('claude');
      let version: string | null = null;
      try {
        const { stdout } = await execFileAsync(claudePath, ['--version'], {
          timeout: 5000,
        });
        version = stdout.trim();
      } catch { /* version detection failed */ }

      this.cached = { found: true, path: claudePath, version };
      return this.cached;
    } catch {
      this.cached = { found: false, path: null, version: null };
      return this.cached;
    }
  }

  invalidateCache(): void {
    this.cached = null;
  }
}
