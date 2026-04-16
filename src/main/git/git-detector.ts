import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Minimum git version required for full functionality (sparse-checkout, worktrees). */
const MINIMUM_GIT_VERSION = '2.25.0';

export interface GitInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  meetsMinimum: boolean;
}

/**
 * Compare two semver-style version strings (e.g. "2.25.1" vs "2.25.0").
 * Returns true if `actual` >= `minimum`.
 */
export function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < minimumParts.length; index++) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

export class GitDetector {
  private cached: GitInfo | null = null;

  async detect(): Promise<GitInfo> {
    if (this.cached) return this.cached;

    try {
      const gitPath = await which('git');
      let version: string | null = null;
      let meetsMinimum = false;
      try {
        const { stdout } = await execFileAsync(gitPath, ['--version'], {
          timeout: 5000,
        });
        // "git version 2.43.0.windows.1" -> "2.43.0"
        const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
        version = match ? match[1] : null;
        meetsMinimum = version ? isVersionAtLeast(version, MINIMUM_GIT_VERSION) : false;
      } catch { /* version detection failed */ }

      this.cached = { found: true, path: gitPath, version, meetsMinimum };
      return this.cached;
    } catch {
      this.cached = { found: false, path: null, version: null, meetsMinimum: false };
      return this.cached;
    }
  }

  invalidateCache(): void {
    this.cached = null;
  }
}
