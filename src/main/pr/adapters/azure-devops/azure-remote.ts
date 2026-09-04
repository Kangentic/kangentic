/**
 * Azure DevOps git-remote parsing for the PR connector.
 *
 * The board adapter's `azure-devops/url-parser.ts` deliberately parses BOARD
 * URLs only (org + project, no `_git` segment and no repo), so it cannot be
 * reused here: every PR command needs the org/project/repo triple.
 *
 * A `null` return is load-bearing, not just a parse failure. It is the
 * connector's own provider gate: on a non-Azure remote every resolver returns
 * null instead of throwing, which is what keeps registering this connector from
 * degrading PR linking on GitHub repos (a throw would set `degradeStatus` in
 * `pr-linking.ts` and permanently disable the confident-not-found clear).
 */

export interface AzureRemote {
  org: string;
  project: string;
  repo: string;
}

/**
 * Azure's SSH remotes put the repo last with no `_git` segment
 * (`git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`), while the HTTPS forms
 * interpose one. Both `git@host:path` (scp-like) and `ssh://git@host:22/path`
 * spellings reach the same `v3/` prefix, which is what `[:/]` absorbs.
 */
const SSH_MODERN = /^(?:ssh:\/\/)?(?:[^@\s/]+@)?(?:ssh\.)?dev\.azure\.com(?::\d+)?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i;
const SSH_LEGACY = /^(?:ssh:\/\/)?(?:[^@\s/]+@)?vs-ssh\.visualstudio\.com(?::\d+)?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i;

/**
 * The userinfo half of `https://{org}@dev.azure.com/{org}/...` is discarded on
 * purpose: it is a login hint, not the organization. The org always comes from
 * the path, so a remote cloned with a different account still parses correctly.
 */
const HTTPS_MODERN = /^https?:\/\/(?:[^@\s/]+@)?dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+?)\/?$/i;

/** Legacy VSTS, where the org is the host label and `DefaultCollection` is optional. */
const HTTPS_LEGACY = /^https?:\/\/(?:[^@\s/]+@)?([^./\s]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/\s]+)\/_git\/([^/\s]+?)\/?$/i;

/** Azure percent-encodes spaces in project names (`AOGCC%20AKWISE`). Decode per segment. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not worth failing the whole parse over.
    return segment;
  }
}

function stripGitSuffix(repo: string): string {
  return repo.toLowerCase().endsWith('.git') ? repo.slice(0, -4) : repo;
}

/**
 * Parse an Azure DevOps git remote into its org/project/repo triple, or null
 * when the URL is not an Azure DevOps remote.
 */
export function parseAzureRemote(remoteUrl: string): AzureRemote | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  for (const pattern of [SSH_MODERN, SSH_LEGACY, HTTPS_MODERN, HTTPS_LEGACY]) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const org = decodeSegment(match[1]);
    const project = decodeSegment(match[2]);
    const repo = stripGitSuffix(decodeSegment(match[3]));
    if (!org || !project || !repo) return null;
    return { org, project, repo };
  }
  return null;
}

/** The first Azure DevOps remote among `remoteUrls`, or null when none is one. */
export function firstAzureRemote(remoteUrls: readonly string[]): AzureRemote | null {
  for (const url of remoteUrls) {
    const parsed = parseAzureRemote(url);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The browser URL for a PR. Azure returns null for `_links.web.href`,
 * `remoteUrl`, AND `repository.webUrl` on every tier (branch, number, and
 * commit), so this has to be constructed rather than read off the payload.
 *
 * Segments are re-encoded because `parseAzureRemote` decoded them, so a project
 * named "AOGCC AKWISE" round-trips back to `AOGCC%20AKWISE` without
 * double-encoding.
 */
export function buildAzurePrWebUrl(remote: AzureRemote, prNumber: number): string {
  const org = encodeURIComponent(remote.org);
  const project = encodeURIComponent(remote.project);
  const repo = encodeURIComponent(remote.repo);
  return `https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequest/${prNumber}`;
}
