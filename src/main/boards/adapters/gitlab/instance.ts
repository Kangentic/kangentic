import { networkCode } from '../../shared/network-error';
import { GITLAB_PROBE_TIMEOUT_MS } from './constants';
import { isGitLabCom } from './url-parser';

/**
 * What a server answered when asked whether it runs GitLab. `gitlab`: it does,
 * at `base` (scheme, host and any path prefix). `not-gitlab`: it answered, but
 * not as GitLab. `unreachable`: no candidate answered at all.
 */
export type GitLabProbeResult =
  | { kind: 'gitlab'; base: string }
  | { kind: 'not-gitlab' }
  | { kind: 'unreachable'; detail?: string };

/**
 * Answers already read, per candidate base URL. A server does not change what it
 * runs between two pastes, but a passing outage does, so only a definitive answer
 * is kept (see `isTransientStatus`).
 */
const probeCache = new Map<string, boolean>();

/** A status a GitLab server can answer with while it is down or busy: a proxy's 502, a 429, a timeout. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Forget every cached answer. For tests. */
export function clearGitLabProbeCache(): void {
  probeCache.clear();
}

/**
 * Whether `base` serves GitLab's API. GitLab answers `/api/v4/version` on every
 * server: 401 with the JSON body `{"message":"401 Unauthorized"}` without a
 * token, or 200 with a `version`. GitHub, Jira and the rest answer 404 or a page
 * that is not JSON. Throws on a network failure, so the caller can tell "no
 * answer" from "not GitLab".
 */
async function servesGitLabApi(base: string, fetchImpl: typeof fetch): Promise<boolean> {
  const cached = probeCache.get(base);
  if (cached !== undefined) return cached;
  const response = await fetchImpl(`${base}/api/v4/version`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(GITLAB_PROBE_TIMEOUT_MS),
  });
  let answer = false;
  if (response.status === 401 || response.status === 200) {
    // report-ok: a body that is not JSON is not GitLab's API, which is the answer
    const body: unknown = await response.json().catch(() => null);
    if (body !== null && typeof body === 'object') {
      const record = body as { message?: unknown; version?: unknown };
      answer = response.status === 401
        ? typeof record.message === 'string' && record.message.includes('401')
        : typeof record.version === 'string';
    }
  }
  // A 502 from a restarting server must not read as "not GitLab" until the app restarts.
  if (!isTransientStatus(response.status)) probeCache.set(base, answer);
  return answer;
}

/**
 * Find the GitLab server a link lives on. `origin` is the link's scheme and
 * host; `pathSegments` its path. An instance can be served under a path prefix
 * (`example.com/gitlab/acme/web`), which the link alone cannot tell apart from a
 * group, so each prefix is tried from the left, the bare origin first. The last
 * segment is never a prefix candidate: a source needs at least one segment of
 * its own. gitlab.com is never asked.
 */
export async function probeGitLabServer(
  origin: string,
  pathSegments: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<GitLabProbeResult> {
  if (isGitLabCom(origin)) return { kind: 'gitlab', base: origin };
  let anyAnswer = false;
  let lastNetworkCode: string | undefined;
  for (let prefixLength = 0; prefixLength < Math.max(1, pathSegments.length); prefixLength++) {
    const prefix = pathSegments.slice(0, prefixLength).join('/');
    const base = prefix.length > 0 ? `${origin}/${prefix}` : origin;
    try {
      if (await servesGitLabApi(base, fetchImpl)) return { kind: 'gitlab', base };
      anyAnswer = true;
    } catch (error) {
      const code = networkCode(error);
      if (!code) throw error;
      lastNetworkCode = code;
      // A server that stops answering (at its origin or a longer path) will not
      // answer at the next longer path either, and each try costs a full timeout.
      break;
    }
  }
  if (anyAnswer) return { kind: 'not-gitlab' };
  return { kind: 'unreachable', detail: lastNetworkCode };
}

/**
 * Check one server address the Connect dialog's Server field names: the whole
 * address is the base, prefix and all. Same three answers as `probeGitLabServer`.
 */
export async function probeGitLabBase(base: string, fetchImpl: typeof fetch = fetch): Promise<GitLabProbeResult> {
  if (isGitLabCom(base)) return { kind: 'gitlab', base };
  try {
    return (await servesGitLabApi(base, fetchImpl)) ? { kind: 'gitlab', base } : { kind: 'not-gitlab' };
  } catch (error) {
    const code = networkCode(error);
    if (!code) throw error;
    return { kind: 'unreachable', detail: code };
  }
}
