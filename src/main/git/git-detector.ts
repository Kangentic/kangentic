import which from 'which';
import { execFileAsync } from '../utility-process/off-main-exec';
import { isVersionAtLeast, parseGitVersion } from './git-version';
import { MINIMUM_GIT_VERSION } from '../../shared/git-minimum-version';

export interface GitInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  meetsMinimum: boolean;
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
        version = parseGitVersion(stdout);
        meetsMinimum = version ? isVersionAtLeast(version, MINIMUM_GIT_VERSION) : false;
      } catch {
        // report-ok: git is on PATH but did not answer --version within 5 s, so the version
        // reads as unknown and the Welcome screen shows its git version warning.
      }

      this.cached = { found: true, path: gitPath, version, meetsMinimum };
      return this.cached;
    } catch {
      // report-ok: `which` throws when git is not on PATH, which is the answer.
      this.cached = { found: false, path: null, version: null, meetsMinimum: false };
      return this.cached;
    }
  }

  invalidateCache(): void {
    this.cached = null;
  }
}
