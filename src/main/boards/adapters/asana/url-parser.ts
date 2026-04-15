/**
 * Parse an Asana project URL, returning the numeric project GID as `repository`.
 *
 * Accepts the shapes the Asana web app actually produces:
 *   https://app.asana.com/0/<project_gid>                  (project root)
 *   https://app.asana.com/0/<project_gid>/list             (list view)
 *   https://app.asana.com/0/<project_gid>/board            (board view)
 *   https://app.asana.com/0/<project_gid>/calendar         (calendar view)
 *   https://app.asana.com/0/<project_gid>/<task_gid>       (task URL -> still scopes to project)
 *   https://app.asana.com/1/<workspace_gid>/project/<project_gid>[/...]  (newer shell)
 */
export function parseAsanaUrl(url: string): { repository: string } {
  const legacyPattern = /https?:\/\/app\.asana\.com\/0\/(\d+)(?:\/|\?|$)/;
  const legacyMatch = legacyPattern.exec(url);
  if (legacyMatch) {
    return { repository: legacyMatch[1] };
  }

  const newerPattern = /https?:\/\/app\.asana\.com\/1\/\d+\/project\/(\d+)(?:\/|\?|$)/;
  const newerMatch = newerPattern.exec(url);
  if (newerMatch) {
    return { repository: newerMatch[1] };
  }

  throw new Error('Invalid Asana project URL. Expected format: https://app.asana.com/0/<project_id>/list');
}

/**
 * Build a label for an Asana source. The project GID is not human-readable, so
 * we prefix it; the ImportDialog will show the real project name once the user
 * opens it (the tasks arrive with their own titles and metadata).
 */
export function buildAsanaLabel(repository: string): string {
  return `Asana project ${repository}`;
}
