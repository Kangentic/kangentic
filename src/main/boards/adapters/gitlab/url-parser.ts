import { RefusalError } from '../../../../shared/refusal';
import { GITLAB_COM_BASE } from './constants';

/**
 * A GitLab source: the server's base URL (scheme, host, and any path prefix an
 * instance is served under), the project or group's full path on it, and the
 * issue board a pasted board link named.
 */
export interface GitLabSourceRef {
  base: string;
  path: string;
  board?: string;
}

const FIELD_SEPARATOR = '|';
const BOARD_FIELD = 'board=';

/** The line the Add Source popover shows for text that names no GitLab source. */
const NOT_A_GITLAB_LINK = 'Paste a GitLab project, group or board link.';

/** First path segments a GitLab server uses for its own pages, never a namespace. */
const RESERVED_FIRST_SEGMENTS = new Set(['-', 'explore', 'dashboard', 'users', 'help', 'admin', 'search', 'api']);

/** The repository string a source is saved under: `<base>|<path>`, plus `|board=<id>`. */
export function encodeGitLabRepository(ref: GitLabSourceRef): string {
  const fields = [ref.base, ref.path];
  if (ref.board) fields.push(`${BOARD_FIELD}${ref.board}`);
  return fields.join(FIELD_SEPARATOR);
}

export function decodeGitLabRepository(repository: string): GitLabSourceRef {
  const [base = '', path = '', ...rest] = repository.split(FIELD_SEPARATOR);
  if (!/^https?:\/\//i.test(base) || path.length === 0) throw new RefusalError(NOT_A_GITLAB_LINK);
  const boardField = rest.find((field) => field.startsWith(BOARD_FIELD));
  const board = boardField?.slice(BOARD_FIELD.length);
  return board ? { base, path, board } : { base, path };
}

/** True for a saved repository string, as opposed to a pasted link. */
export function isGitLabRepository(text: string): boolean {
  return /^https?:\/\/[^\s|]+\|[^\s|]+/i.test(text);
}

/** The server as people read it: the base URL without `https://`. */
export function serverLabel(base: string): string {
  return base.replace(/^https:\/\//i, '');
}

/** The host a base URL names, for the lines that name a server. */
export function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch { // report-ok: an unreadable base is named as it is
    return base;
  }
}

/** True for gitlab.com itself. */
export function isGitLabCom(base: string): boolean {
  return base.toLowerCase() === GITLAB_COM_BASE;
}

/**
 * Scheme, host and port, lowercased. gitlab.com is always `https://`: a typed
 * `http://` would send the first request's token in the clear before the redirect.
 */
export function originOf(url: URL): string {
  const host = url.host.toLowerCase();
  const protocol = host === 'gitlab.com' ? 'https:' : url.protocol;
  return `${protocol}//${host}`;
}

/** A URL from what was pasted or typed: a bare host gets `https://`. */
export function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname.length === 0) return null;
    return url;
  } catch { // report-ok: what was pasted is not a URL; the caller's refusal is the answer
    return null;
  }
}

/**
 * Read a pasted GitLab link: a project, a group (`/groups/<path>`), an issue
 * list, one issue or work item, or an issue board. Everything from GitLab's
 * `/-/` separator on is dropped, filters included, except a board's id. The
 * host is not checked here: whether it runs GitLab, and where an instance
 * served under a path prefix starts, is asked of the server before the source
 * is saved (`prepareSource`).
 */
export function parseGitLabUrl(input: string): { repository: string } {
  const url = toUrl(input);
  if (!url) throw new RefusalError(NOT_A_GITLAB_LINK);

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch { // report-ok: a malformed percent escape is not a GitLab link; the refusal is the answer
    throw new RefusalError(NOT_A_GITLAB_LINK);
  }
  path = path.replace(/^\/+/, '');

  const board = /(?:^|\/)-\/boards\/(\d+)/.exec(path)?.[1];
  const separatorIndex = path.indexOf('/-/');
  if (separatorIndex >= 0) path = path.slice(0, separatorIndex);
  path = path.replace(/\/-$/, '').replace(/\/+$/, '');
  if (path.startsWith('groups/')) path = path.slice('groups/'.length);

  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || RESERVED_FIRST_SEGMENTS.has(segments[0].toLowerCase())) {
    throw new RefusalError(NOT_A_GITLAB_LINK);
  }
  // `|` separates the saved repository's fields, and GitLab paths never hold one.
  if (segments.some((segment) => /[\s|]/.test(segment))) throw new RefusalError(NOT_A_GITLAB_LINK);

  return { repository: encodeGitLabRepository({ base: originOf(url), path: segments.join('/'), board }) };
}

/** The label a source shows until `prepareSource` names it: its path. */
export function buildGitLabLabel(repository: string): string {
  try {
    return decodeGitLabRepository(repository).path;
  } catch { // report-ok: an unreadable repository string shows as itself
    return repository;
  }
}
