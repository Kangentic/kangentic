import simpleGit from 'simple-git';

/**
 * "git version 2.43.0.windows.1" -> "2.43.0". Also covers "2.39.5 (Apple Git-154)"
 * and plain "2.43.0". Returns null when the output carries no x.y.z version.
 */
export function parseGitVersion(versionOutput: string): string | null {
  const match = versionOutput.trim().match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
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

let installedGitVersion: Promise<string | null> | null = null;

/**
 * Version of the `git` that simple-git runs (the first one on PATH), read once
 * per process. Kept apart from GitDetector, which is owned by the IPC context
 * and resolves the binary through `which`, so git code can gate on a version
 * without reaching into IPC. Never rejects: any failure reads as null
 * ("unknown"). A failed read is not cached, so the next call tries again
 * instead of pinning every later caller to the unknown answer.
 */
export function getInstalledGitVersion(): Promise<string | null> {
  if (!installedGitVersion) {
    const pending = Promise.resolve()
      .then(() => simpleGit().raw(['--version']))
      .then(parseGitVersion)
      .catch(() => null);
    installedGitVersion = pending;
    void pending.then((version) => {
      if (version === null && installedGitVersion === pending) installedGitVersion = null;
    });
  }
  return installedGitVersion;
}
