import { RefusalError } from '../../../../shared/refusal';
/** Parse a GitHub Projects URL, returning the repository identifier as `owner/projectNumber`. */
export function parseGitHubProjectsUrl(url: string): { repository: string } {
  const projectUrlPattern = /https?:\/\/github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)/;
  const projectMatch = projectUrlPattern.exec(url);
  if (projectMatch) {
    return { repository: `${projectMatch[1]}/${projectMatch[2]}` };
  }
  throw new RefusalError('Invalid GitHub Projects URL. Expected format: https://github.com/orgs/owner/projects/1');
}

/** Build a label for GitHub Projects sources (just returns the repository identifier). */
export function buildGitHubProjectsLabel(repository: string): string {
  return repository;
}
