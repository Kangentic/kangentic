/**
 * Tells us which sites people keep artifacts on that Kangentic does not
 * recognise yet (#1056), so the platform table grows from what is used rather
 * than from guesses.
 *
 * What is sent is the site and who added the link, nothing else: no path, no
 * query, no task, and no tenant label (`collapseTenantLabels`, so
 * `acme.sharepoint.com` goes as `*.sharepoint.com`). Each site is sent once per
 * install. A host that only means
 * something inside a private network (a bare name, an IP address, `.local`,
 * `.internal`, ...) is never sent, and nothing is sent with error reporting
 * off. Listed in Settings > Privacy and `docs/telemetry/error-reporting.md`.
 */

import { artifactPlatformOf, isPrivateHost, parseArtifactUrl } from '../../shared/artifact-platforms';
import type { TaskArtifact, TaskArtifactSource } from '../../shared/types';
import { isErrorReportingActive, reportHandledMessage } from '../analytics/error-reporting';
import { claimArtifactDomainReport } from '../analytics/usage';

/** The host to report for a link, or null when the link is recognised, private or not a link. */
export function unrecognisedArtifactDomain(link: string): string | null {
  const url = parseArtifactUrl(link);
  if (!url || artifactPlatformOf(url)) return null;
  // One spelling per site, so a site is reported once: no `www.`, and no
  // trailing dot of a fully qualified name (`example.com.`).
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return isPrivateHost(host) ? null : host;
}

/** Report the unrecognised hosts among the artifacts a write added: those in `after` and not in `before`. */
export function reportAddedArtifactDomains(
  before: readonly TaskArtifact[],
  after: readonly TaskArtifact[],
  source: TaskArtifactSource,
): void {
  if (after.length === 0 || !isErrorReportingActive()) return;
  const known = new Set(before.map((artifact) => artifact.url));
  reportUnrecognisedArtifactDomains(
    after.filter((artifact) => !known.has(artifact.url)).map((artifact) => artifact.url),
    source,
  );
}

/** Second-level suffixes under which a site's own name is the third label (`acme.co.uk`). */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
  'co.za', 'com.br', 'com.mx', 'com.cn', 'com.tw', 'co.kr',
]);

/**
 * The site a host belongs to, with every label left of it collapsed to `*`:
 * `acme.sharepoint.com` becomes `*.sharepoint.com`. A tenant host names the
 * customer's organization in its first label, and the platform is what we need
 * to know, so the tenant never leaves the machine. A host that is already the
 * site (`example.com`) is sent as it is.
 */
export function collapseTenantLabels(host: string): string {
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const siteLabelCount = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length <= siteLabelCount) return host;
  return `*.${labels.slice(-siteLabelCount).join('.')}`;
}

/** Report each unrecognised host among `links`, once per install. Never throws. */
export function reportUnrecognisedArtifactDomains(links: readonly string[], source: TaskArtifactSource): void {
  if (!isErrorReportingActive()) return;
  try {
    for (const link of links) {
      const host = unrecognisedArtifactDomain(link);
      const domain = host ? collapseTenantLabels(host) : null;
      if (!domain || !claimArtifactDomainReport(domain)) continue;
      reportHandledMessage(
        'Unrecognised artifact domain',
        { artifact_domain: domain, artifact_source: source },
        ['unrecognised-artifact-domain', domain],
      );
    }
  } catch {
    // Telemetry never disturbs the write it follows.
  }
}
