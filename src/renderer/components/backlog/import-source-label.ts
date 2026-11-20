/**
 * Path parts a tracker's link puts after the project's name, which name no
 * source: `gitlab.com/acme/web/-/issues`, `acme.atlassian.net/jira/software/projects/WEB/boards/12`,
 * `dev.azure.com/acme/web/_workitems`. Compared in lower case. They apply to a
 * link only: a folder a person picked is named by its own folder, whatever it is
 * called (a vault folder named "Projects" or "Tasks" is exactly that).
 */
const GENERIC_SEGMENTS = new Set([
  '-', '_workitems', '_boards', '_backlogs', 'b', 'backlog', 'board', 'boards', 'browse', 'issues',
  'items', 'list', 'lists', 'projects', 'project', 'software', 'jira', 'tasks', 'team', 'view', 'views',
]);

/** A host name typed without its scheme: `github.com`, `acme.atlassian.net`. Never a dot-folder like `.changeset`. */
function looksLikeHost(segment: string | undefined): boolean {
  return segment !== undefined && /^[^./\s][^/\s]*\.[a-z]{2,}$/i.test(segment);
}

/**
 * The Label a new source's form starts with: the last part of the typed link or
 * the picked folder that names something, with a query, a fragment, trailing
 * slashes and a `.git` ending dropped. For a link, numbers (a board's id) and the
 * generic parts trackers add after a project's name are passed over too, so
 * `https://github.com/acme/web.git` gives `web`, `gitlab.com/acme/web/-/issues`
 * gives `web`, and `openspec/changes/` gives `changes`. A folder keeps its own
 * name: `/vaults/Work/Projects` gives `Projects`. Blank when nothing is left. The
 * field stays editable, so this is a starting point, never a rule.
 */
export function labelFromSourceText(text: string): string {
  const withoutQuery = text.trim().split(/[?#]/)[0] ?? '';
  const segments = withoutQuery.replace(/\\/g, '/').split('/').filter((segment) => segment !== '');
  // Only a link has a scheme: `C:\Notes` is a drive and a folder, never a host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery.trim());
  const isLink = hasScheme || looksLikeHost(segments[0]);
  // A link's host never names the source, so a bare host has no path to name it by.
  const hostIndex = hasScheme ? 1 : 0;
  const firstPathIndex = isLink ? hostIndex + 1 : 0;
  for (let index = segments.length - 1; index >= firstPathIndex; index -= 1) {
    const segment = segments[index].replace(/\.git$/i, '');
    // A drive letter (`C:`) names no source either.
    if (segment === '' || /^[a-z]:$/i.test(segment)) continue;
    if (isLink && (/^\d+$/.test(segment) || GENERIC_SEGMENTS.has(segment.toLowerCase()))) continue;
    return segment;
  }
  return '';
}
