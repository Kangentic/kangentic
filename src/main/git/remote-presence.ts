import { gitAt } from './git-client';

/**
 * Bounds the walk below. The commits asked about are a History pane's or one
 * task's, so the unpushed ones among them and their unpushed ancestors fit
 * well inside it; past it a commit reads as pushed, and its link may 404.
 */
const MAX_WALK = 2000;

/**
 * Which of `shas` no remote-tracking ref reaches yet, so their web pages do
 * not exist. One local `git rev-list <shas> --not --remotes` (no fetch): it
 * prints every commit reachable from the list and from no remote ref, which is
 * intersected with the list. Any remote counts, not only the primary: on a fork
 * a commit that reached only `upstream` still resolves on GitHub through the
 * fork network, and the cost of being wrong is one dead link.
 *
 * Null when git fails, which callers read as "unknown" and show no links.
 */
export async function commitsMissingFromRemotes(repoCwd: string, shas: readonly string[]): Promise<Set<string> | null> {
  if (shas.length === 0) return new Set();
  try {
    const git = gitAt(repoCwd);
    const output = await git.raw(['rev-list', `--max-count=${MAX_WALK}`, ...shas, '--not', '--remotes']);
    const wanted = new Set(shas);
    const missing = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
      const sha = line.trim();
      if (sha && wanted.has(sha)) missing.add(sha);
    }
    return missing;
  } catch {
    return null;
  }
}
