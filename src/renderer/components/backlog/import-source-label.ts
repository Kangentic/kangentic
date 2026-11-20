/**
 * Path parts a tracker's link puts after the project's name, which name no
 * source: `gitlab.com/acme/web/-/issues`, `acme.atlassian.net/jira/software/projects/WEB/boards/12`,
 * `dev.azure.com/acme/web/_workitems`. Compared in lower case.
 */
const GENERIC_SEGMENTS = new Set([
  '-', '_workitems', '_boards', '_backlogs', 'b', 'backlog', 'board', 'boards', 'browse', 'issues',
  'items', 'list', 'lists', 'projects', 'project', 'software', 'jira', 'tasks', 'team', 'view', 'views',
]);

/**
 * The Label a new source's form starts with: the last part of the typed link or
 * the picked folder that names something, with a query, a fragment, trailing
 * slashes and a `.git` ending dropped. Numbers (a board's id) and the generic
 * parts trackers add after a project's name are passed over, so
 * `https://github.com/acme/web.git` gives `web`, `gitlab.com/acme/web/-/issues`
 * gives `web`, and `openspec/changes/` gives `changes`. Blank when nothing is
 * left. The field stays editable, so this is a starting point, never a rule.
 */
export function labelFromSourceText(text: string): string {
  const withoutQuery = text.trim().split(/[?#]/)[0] ?? '';
  const segments = withoutQuery.replace(/\\/g, '/').split('/').filter((segment) => segment !== '');
  // A bare host ("https:" then "github.com") has no path to name the source by.
  // Only a link has a scheme: `C:\Notes` is a drive and a folder, never a host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery.trim());
  if (segments.length <= 2 && hasScheme) return '';
  // The host itself never names the source.
  const firstPathIndex = hasScheme ? 2 : 0;
  for (let index = segments.length - 1; index >= firstPathIndex; index -= 1) {
    const segment = segments[index].replace(/\.git$/i, '');
    // A drive letter (`C:`) names no source either.
    if (segment === '' || /^\d+$/.test(segment) || /^[a-z]:$/i.test(segment) || GENERIC_SEGMENTS.has(segment.toLowerCase())) continue;
    return segment;
  }
  return '';
}
