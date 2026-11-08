import { useEffect, useState } from 'react';
import type { GitResolveRefResult } from '../../shared/types';
import { useProjectStore } from '../stores/project-store';

/** What a task's base names, as main's `git:resolveRef` answered it. */
export interface BaseRefKind {
  kind: 'branch' | 'tag' | 'commit';
  sha: string;
}

/**
 * The cache key for `ref` in a project. A null `projectId` asks about the open
 * project, so it is keyed by the open project's id: a tag in one project must
 * not answer for the same name in the next one opened.
 */
function cacheKey(ref: string, projectId: string | null): string {
  const keyProjectId = projectId ?? useProjectStore.getState().currentProject?.id ?? '';
  return `${keyProjectId}\u0000${ref}`;
}

// hmr-safe: a cache of what each base names; a reset on HMR only asks main again.
const answered = new Map<string, GitResolveRefResult>();
// hmr-safe: the same, for requests still in flight.
const inFlight = new Map<string, Promise<GitResolveRefResult>>();

/**
 * Ask main once per base what it names. Concurrent callers for the same base
 * (the picker, the Branch row's check, the task header) share one request,
 * and an answer that names something is kept for the session. A miss is not,
 * since the ref may be created or fetched a moment later.
 *
 * `fetchTag` is for the picker's typed Use row only: main may then fetch the
 * value from origin as a tag. A request without it never joins one with it,
 * or the picker would wait on a local-only answer and read a false miss.
 */
export function resolveBaseRef(ref: string, projectId: string | null, options?: { fetchTag?: boolean }): Promise<GitResolveRefResult> {
  const key = cacheKey(ref, projectId);
  const known = answered.get(key);
  if (known) return Promise.resolve(known);
  const fetchTag = options?.fetchTag === true;
  const requestKey = `${key}\u0000${fetchTag ? 'fetch' : 'local'}`;
  const pending = inFlight.get(requestKey);
  if (pending) return pending;
  const request = window.electronAPI.git.resolveRef(ref, projectId, fetchTag ? { fetchTag: true } : undefined)
    .then((result) => {
      if (result.ok) answered.set(key, result);
      return result;
    })
    .finally(() => { inFlight.delete(requestKey); });
  inFlight.set(requestKey, request);
  return request;
}

/**
 * Whether `ref` names a branch, a tag or a commit, or null while unknown, for
 * an empty ref, or for one that names nothing. `projectId` is the project the
 * task belongs to; null asks about the open one. Reads local refs only.
 */
export function useBaseRefKind(ref: string, projectId: string | null, enabled = true): BaseRefKind | null {
  const trimmed = ref.trim();
  const key = cacheKey(trimmed, projectId);
  const [resolved, setResolved] = useState<{ key: string; result: GitResolveRefResult } | null>(null);

  useEffect(() => {
    if (!enabled || !trimmed) return;
    let cancelled = false;
    resolveBaseRef(trimmed, projectId)
      .then((result) => { if (!cancelled) setResolved({ key, result }); })
      .catch(() => { /* an unreachable main reads as unknown */ });
    return () => { cancelled = true; };
  }, [enabled, trimmed, projectId, key]);

  if (!enabled || !trimmed) return null;
  const result = resolved?.key === key ? resolved.result : answered.get(key) ?? null;
  if (!result || !result.ok) return null;
  return { kind: result.kind, sha: result.sha };
}

/**
 * A commit base shortened to the seven characters git shows; any other base,
 * a hex-named branch or tag included, as given.
 */
export function shortRefLabel(ref: string, kind: BaseRefKind['kind'] | null | undefined): string {
  return kind === 'commit' && /^[0-9a-f]{8,64}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
