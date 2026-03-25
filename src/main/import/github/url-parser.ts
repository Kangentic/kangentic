/** Parse a GitHub Issues URL, returning the repository identifier. */
export function parseGitHubIssuesUrl(url: string): { repository: string } {
  const repoUrlPattern = /https?:\/\/github\.com\/(?!orgs\/)(?!users\/)([^/\s]+\/[^/\s]+?)(?:\/(?:issues|pulls|wiki|actions)?)?(?:\?.*)?$/;
  const repoMatch = repoUrlPattern.exec(url);
  if (repoMatch) {
    return { repository: repoMatch[1] };
  }
  throw new Error('Invalid GitHub repository URL. Expected format: https://github.com/owner/repo');
}

/** Parse a GitHub Projects URL, returning the repository identifier. */
export function parseGitHubProjectsUrl(url: string): { repository: string } {
  const projectUrlPattern = /https?:\/\/github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)/;
  const projectMatch = projectUrlPattern.exec(url);
  if (projectMatch) {
    return { repository: `${projectMatch[1]}/${projectMatch[2]}` };
  }
  throw new Error('Invalid GitHub Projects URL. Expected format: https://github.com/orgs/owner/projects/1');
}

/** Build a label for GitHub sources (just returns the repository identifier). */
export function buildGitHubLabel(repository: string): string {
  return repository;
}
