import { RefusalError } from '../../../../shared/refusal';
import { siteBaseFromUrl } from './site';

/**
 * What a Jira source reads: a board's issues, a project's issues, a saved
 * filter's results, or a JQL query's results.
 */
type JiraSourceKind ='board' | 'project' | 'filter' | 'jql';

export interface JiraSourceRef {
  /**
   * The site's base URL (`https://acme.atlassian.net`, or a Data Center base with
   * its context path, `https://example.com/jira`). Empty for typed JQL until the
   * source is prepared against the one connected site.
   */
  site: string;
  kind: JiraSourceKind;
  /** Board id, project key, filter id, or the JQL text. */
  value: string;
}

const SEPARATOR = '::';

/**
 * The kind between its two separators. Decoding finds this rather than the first
 * `::`, because an IPv6 site (`http://[::1]:8080`) has `::` in its host.
 */
const KIND_SEGMENT = /::(board|project|filter|jql)::/;

const NO_JIRA_SOURCE_IN_LINK = "That link doesn't name a Jira board, project, filter or search.";

/** The `repository` string a saved Jira source stores: `<site>::<kind>::<value>`. */
export function encodeJiraRepository(ref: JiraSourceRef): string {
  return `${ref.site}${SEPARATOR}${ref.kind}${SEPARATOR}${ref.value}`;
}

/** True for a saved source's `repository` string, as opposed to pasted or typed text. */
export function isJiraRepository(text: string): boolean {
  return KIND_SEGMENT.test(text);
}

/** Inverse of `encodeJiraRepository`. The value keeps any `::` it contains. */
export function decodeJiraRepository(repository: string): JiraSourceRef {
  const match = KIND_SEGMENT.exec(repository);
  if (!match) throw new RefusalError(`Not a Jira source: ${repository}`);
  return {
    site: repository.slice(0, match.index),
    kind: match[1] as JiraSourceKind,
    value: repository.slice(match.index + match[0].length),
  };
}

/** A Jira project key: a letter, then letters, digits or underscores. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * True for text that is a link rather than JQL: it starts with a scheme, or it
 * is a host with a path and no spaces (`acme.atlassian.net/browse/ENG`). A host
 * with no dot counts when it has a port or is `localhost`, as a Data Center
 * site on a company network often is (`jira:8080/browse/ENG`).
 */
function looksLikeLink(text: string): boolean {
  if (/^https?:\/\//i.test(text)) return true;
  return !/\s/.test(text) && /^(?:[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?|[a-z0-9-]+:\d+|localhost)\//i.test(text);
}

/**
 * Read what the user pasted or typed in the Add Source field. Matches a link by
 * the token that names its source, not by its whole path, so the many shapes
 * Jira's links take (team-managed and company-managed boards, a board's backlog
 * view, an open issue panel, Data Center's RapidBoard) all resolve. Text that is
 * not a link is typed JQL, saved with no site until it is prepared.
 */
export function parseJiraInput(text: string): { repository: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new RefusalError('Paste a Jira link, or type JQL.');

  if (!looksLikeLink(trimmed)) {
    return { repository: encodeJiraRepository({ site: '', kind: 'jql', value: trimmed }) };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch { // report-ok: text shaped like a link that does not parse (`http://`) names no source; the refusal is the answer
    throw new RefusalError(NO_JIRA_SOURCE_IN_LINK);
  }
  const site = siteBaseFromUrl(url);
  const path = url.pathname;
  const params = url.searchParams;

  const boardMatch = /\/boards\/(\d+)/.exec(path);
  const rapidView = params.get('rapidView');
  if (boardMatch) return { repository: encodeJiraRepository({ site, kind: 'board', value: boardMatch[1] }) };
  if (rapidView && /^\d+$/.test(rapidView)) {
    return { repository: encodeJiraRepository({ site, kind: 'board', value: rapidView }) };
  }

  const filter = params.get('filter');
  if (filter && /^\d+$/.test(filter)) {
    return { repository: encodeJiraRepository({ site, kind: 'filter', value: filter }) };
  }

  const jql = params.get('jql');
  if (jql && jql.trim().length > 0) {
    return { repository: encodeJiraRepository({ site, kind: 'jql', value: jql.trim() }) };
  }

  // An issue link (/browse/ENG-142) names its project too.
  const browseMatch = /\/browse\/([A-Za-z][A-Za-z0-9_]*)(?:-\d+)?(?:\/|$)/.exec(path);
  const projectsMatch = /\/projects\/([A-Za-z][A-Za-z0-9_]*)(?:\/|$)/.exec(path);
  const projectKey = browseMatch?.[1] ?? projectsMatch?.[1];
  if (projectKey && PROJECT_KEY.test(projectKey)) {
    return { repository: encodeJiraRepository({ site, kind: 'project', value: projectKey.toUpperCase() }) };
  }

  throw new RefusalError(NO_JIRA_SOURCE_IN_LINK);
}

/** The label a source gets before the remote names it (the prepared label replaces it). */
export function buildJiraLabel(repository: string): string {
  const ref = decodeJiraRepository(repository);
  switch (ref.kind) {
    case 'board': return `Board ${ref.value}`;
    case 'project': return ref.value;
    case 'filter': return `Filter ${ref.value}`;
    case 'jql': return ref.value;
  }
}
