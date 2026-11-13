import { RefusalError } from '../../../../shared/refusal';
/** Parse a GitHub Issues URL, returning the repository identifier. */
export function parseGitHubIssuesUrl(url: string): { repository: string } {
  const repoUrlPattern = /https?:\/\/github\.com\/(?!orgs\/)(?!users\/)([^/\s]+\/[^/\s]+?)(?:\/(?:issues|pulls|wiki|actions)?)?(?:\?.*)?$/;
  const repoMatch = repoUrlPattern.exec(url);
  if (repoMatch) {
    return { repository: repoMatch[1] };
  }
  throw new RefusalError('Invalid GitHub repository URL. Expected format: https://github.com/owner/repo');
}

/** Build a label for GitHub Issues sources (just returns the repository identifier). */
export function buildGitHubLabel(repository: string): string {
  return repository;
}
