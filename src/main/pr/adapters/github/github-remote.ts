/**
 * GitHub git-remote parsing, for building web links to a repository's pages.
 *
 * The connector's `matchesRemote` only asks whether a remote is GitHub's; a web
 * link needs the host, owner and repo. The host test matches `matchesRemote`
 * (any host label containing `github`), so a GitHub Enterprise host such as
 * `github.mycorp.com` gets links too.
 */

export interface GitHubRemote {
  /**
   * The web host: `github.com`, or a GitHub Enterprise host, with its port
   * when an https remote names one (that port serves the web pages too).
   */
  host: string;
  owner: string;
  repo: string;
}

/**
 * `https://[user[:token]@]host[:port]/owner/repo[.git][/]`. The port is kept
 * with the host: over https it is the web server's. The ssh forms below drop
 * theirs, which is the ssh daemon's.
 */
const HTTPS_REMOTE = /^https?:\/\/(?:[^@\s/]+@)?([^/:@\s]+(?::\d+)?)\/([^/\s]+)\/([^/\s]+?)\/?$/i;

/** `ssh://[user@]host[:port]/owner/repo[.git]` */
const SSH_URL_REMOTE = /^ssh:\/\/(?:[^@\s/]+@)?([^/:@\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)\/?$/i;

/** `[user@]host:owner/repo[.git]` (the scp-like form). */
const SCP_REMOTE = /^(?:[^@\s/]+@)?([^/:@\s]+):(?!\/)([^/\s]+)\/([^/\s]+?)\/?$/i;

function stripGitSuffix(repo: string): string {
  return repo.toLowerCase().endsWith('.git') ? repo.slice(0, -4) : repo;
}

/**
 * GitHub's SSH-over-443 endpoint `ssh.github.com` serves the same repositories
 * as `github.com`, whose name the web pages use.
 */
function webHostOf(host: string): string {
  return host.toLowerCase() === 'ssh.github.com' ? 'github.com' : host;
}

/**
 * Parse a GitHub git remote into host, owner and repo, or null when the URL is
 * not a GitHub remote.
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  for (const pattern of [HTTPS_REMOTE, SSH_URL_REMOTE, SCP_REMOTE]) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const host = match[1];
    if (!/github/i.test(host)) return null;
    const owner = match[2];
    const repo = stripGitSuffix(match[3]);
    if (!owner || !repo) return null;
    return { host: webHostOf(host), owner, repo };
  }
  return null;
}

/** The first GitHub remote among `remoteUrls`, or null when none is one. */
export function firstGitHubRemote(remoteUrls: readonly string[]): GitHubRemote | null {
  for (const url of remoteUrls) {
    const parsed = parseGitHubRemote(url);
    if (parsed) return parsed;
  }
  return null;
}

/** The browser URL for one commit. */
export function buildGitHubCommitWebUrl(remote: GitHubRemote, sha: string): string {
  return `https://${remote.host}/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/commit/${sha}`;
}
