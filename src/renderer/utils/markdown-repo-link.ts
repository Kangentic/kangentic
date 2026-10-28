/**
 * Where a link or image in a repository's markdown file points, worked out the
 * way GitHub resolves it: a relative path is relative to the markdown file's
 * own folder, a path starting with `/` is relative to the repository root, and
 * `#section` names a heading in the same file. Pure, so the Changes panel's
 * document preview and its tests read one rule.
 *
 * Paths come back repo-relative and '/'-separated, the form git's file list
 * uses, with every `.` and `..` already resolved: main refuses any path that
 * still carries a `..` segment (isRepoRelativePath in diff-service.ts).
 */
import { EXTERNAL_OPEN_SCHEMES } from '../../shared/external-url';

export type MarkdownHrefTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'file'; path: string; anchor: string | null }
  | { kind: 'none' };

/** The schemes a click may hand to the OS: the ones main's shell.openExternal accepts. */
const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(EXTERNAL_OPEN_SCHEMES);

/** A URL scheme. A Windows drive letter (`C:/x`) matches too, and is refused as one. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

const NO_TARGET: MarkdownHrefTarget = { kind: 'none' };

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The folder part of a repo path: `packages/app/README.md` -> `packages/app`. */
function folderOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash === -1 ? '' : filePath.slice(0, lastSlash);
}

/**
 * Resolve a link's path part against the markdown file. Null when the path
 * climbs above the repository root, which no repo file can be.
 */
function resolvePath(pathPart: string, baseFilePath: string): string | null {
  const normalized = decodePart(pathPart).replace(/\\/g, '/');
  const fromRoot = normalized.startsWith('/');
  const segments = fromRoot ? [] : folderOf(baseFilePath).split('/').filter((segment) => segment !== '');
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Split `path?query#fragment` into its path and fragment. The query is dropped. */
function splitHref(href: string): { pathPart: string; fragment: string | null } {
  const hashIndex = href.indexOf('#');
  const withoutFragment = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1);
  const queryIndex = withoutFragment.indexOf('?');
  return {
    pathPart: queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex),
    fragment: fragment === null || fragment === '' ? null : decodePart(fragment),
  };
}

/** What a click on `href`, written in the markdown file at `baseFilePath`, should do. */
export function resolveMarkdownHref(href: string | null | undefined, baseFilePath: string): MarkdownHrefTarget {
  const trimmed = (href ?? '').trim();
  if (trimmed === '') return NO_TARGET;
  if (trimmed.startsWith('//')) return { kind: 'external', url: `https:${trimmed}` };
  const scheme = SCHEME_PATTERN.exec(trimmed)?.[0].toLowerCase();
  if (scheme !== undefined) {
    return EXTERNAL_SCHEMES.has(scheme) ? { kind: 'external', url: trimmed } : NO_TARGET;
  }
  const { pathPart, fragment } = splitHref(trimmed);
  if (pathPart === '') {
    // `#section` or `?plain=1#section`: the same file.
    return fragment === null ? { kind: 'file', path: baseFilePath, anchor: null } : { kind: 'anchor', anchor: fragment };
  }
  const path = resolvePath(pathPart, baseFilePath);
  if (path === null || path === '') return NO_TARGET;
  return { kind: 'file', path, anchor: fragment };
}

/**
 * The repo path an image `src` (or a `srcset` candidate) names, or null when it
 * is not a repo file: an absolute URL, a data URL, or a path above the root.
 */
export function resolveRepoAssetPath(source: string | null | undefined, baseFilePath: string): string | null {
  const trimmed = (source ?? '').trim();
  if (trimmed === '' || trimmed.startsWith('//') || SCHEME_PATTERN.test(trimmed)) return null;
  const { pathPart } = splitHref(trimmed);
  if (pathPart === '') return null;
  const path = resolvePath(pathPart, baseFilePath);
  return path === null || path === '' ? null : path;
}

/**
 * The ids (or `<a name>` values) a `#anchor` may name in the rendered
 * document, most likely first. The sanitizer prefixes every id and name it
 * keeps with `user-content-`, as GitHub does, so `#install` lands on
 * `user-content-install`. A link that already
 * carries the prefix is tried as written, and GitHub's slugs are lower case, so
 * a link written in another case is tried lowered too.
 */
export function anchorElementIds(anchor: string): string[] {
  const candidates = [`user-content-${anchor}`, anchor];
  const lowered = anchor.toLowerCase();
  if (lowered !== anchor) candidates.push(`user-content-${lowered}`, lowered);
  return candidates;
}
