import type { JiraDeployment } from '../../../../shared/types';
import { RefusalError } from '../../../../shared/refusal';

/**
 * Path segments Jira serves directly under its base URL. Whatever comes before
 * the first of them in a Data Center link is the site's context path
 * (`https://example.com/jira/secure/RapidBoard.jspa` has the base
 * `https://example.com/jira`). Cloud sites have no context path.
 */
const JIRA_ROOT_SEGMENTS = ['/browse/', '/secure/', '/issues/', '/projects/', '/plugins/', '/rest/', '/login.jsp'];

/** True for a host Atlassian serves Jira Cloud from. */
export function isCloudHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower.endsWith('.atlassian.net') || lower.endsWith('.jira.com');
}

/**
 * The site's base URL from any link on it: scheme, host and port, plus a Data
 * Center context path. Lowercased host, no trailing slash.
 */
export function siteBaseFromUrl(url: URL): string {
  const origin = `${url.protocol}//${url.host.toLowerCase()}`;
  if (isCloudHost(url.hostname)) return origin;
  const contextEnd = jiraRootIndex(url.pathname);
  const context = contextEnd > 0 ? url.pathname.slice(0, contextEnd).replace(/\/+$/, '') : '';
  return `${origin}${context}`;
}

/** Where the first of Jira's own path segments starts, or -1 when the path has none. */
function jiraRootIndex(path: string): number {
  let first = -1;
  for (const segment of JIRA_ROOT_SEGMENTS) {
    const index = path.indexOf(segment);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  return first;
}

/**
 * Normalize what the user typed in the Site field, or any link, to the site's
 * base URL. A bare host gets `https://`; a typed `http://` is kept. A host with
 * no dot is allowed, because a Data Center site on a company network is often
 * one (`http://jira:8080`).
 */
export function normalizeSiteBase(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new RefusalError('Enter your Jira site.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch { // report-ok: what the user typed is not a URL; the refusal is the answer
    throw new RefusalError(`Not a Jira site: ${trimmed}`);
  }
  if (url.hostname.length === 0) throw new RefusalError(`Not a Jira site: ${trimmed}`);
  const origin = `${url.protocol}//${url.host.toLowerCase()}`;
  // A bare host, or Cloud, which has no context path.
  if (url.pathname === '/' || url.pathname === '' || isCloudHost(url.hostname)) return origin;
  // A pasted link: its context path is whatever comes before Jira's own segments.
  if (jiraRootIndex(url.pathname) >= 0) return siteBaseFromUrl(url);
  // A typed Data Center base with its context path (`example.com/jira`), which a
  // pasted link on the same site resolves to as well.
  return `${origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The site as people read it: the base URL without `https://`. */
export function siteLabel(base: string): string {
  return base.replace(/^https:\/\//i, '');
}

/** How long the anonymous deployment probe waits before falling back to the host name. */
const DETECT_TIMEOUT_MS = 10_000;

/**
 * Whether a site runs Jira Cloud or Data Center. Asks the site's anonymous
 * `serverInfo`, which Cloud always answers with `deploymentType: "Cloud"`. A
 * private Data Center site may refuse an anonymous call, so when the probe gets
 * no usable answer, an Atlassian host is Cloud and anything else is Data Center.
 */
export async function detectDeployment(base: string, fetchImpl: typeof fetch = fetch): Promise<JiraDeployment> {
  const fallback: JiraDeployment = isCloudHost(new URL(base).hostname) ? 'cloud' : 'datacenter';
  try {
    const response = await fetchImpl(`${base}/rest/api/2/serverInfo`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    if (!response.ok) return fallback;
    const info = (await response.json()) as { deploymentType?: string };
    if (typeof info.deploymentType !== 'string') return fallback;
    return info.deploymentType === 'Cloud' ? 'cloud' : 'datacenter';
  } catch { // report-ok: an unreachable or private site is answered from its host name; Connect reports reachability itself
    return fallback;
  }
}
