import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSessionStore } from '../stores/session-store';
import { isActive } from '../../shared/activity-state';
import type { GitWorkState } from '../../shared/git-work-state';

/** At most one read this often per checkout, so an agent writing files does not run git on every burst. */
const MIN_READ_GAP_MS = 3_000;

export interface GitWorkStateRequest {
  worktreePath?: string | null;
  projectPath: string;
  baseBranch: string;
  cutFromBranch?: string | null;
  pushedBranch?: string | null;
  prMerged?: boolean;
  /** The agent whose turn end may have committed or pushed. */
  sessionId?: string | null;
  /** The project's checkout is on an SSH host: its folder cannot be watched from here without polling. */
  onHost?: boolean;
}

interface Entry {
  state: GitWorkState | null;
  listeners: Set<() => void>;
  watchers: number;
  reading: boolean;
  /** The newest read's number. An older read's answer is dropped. */
  generation: number;
  /** Asked for while a read ran. */
  queued: boolean;
  lastReadAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  request: GitWorkStateRequest;
  stopWatching: (() => void) | null;
}

// Kept in `hot.data` itself, not in a dispose: this module is never the one that accepts an update,
// so no dispose of its runs. An action in flight across an edit then still refreshes the live
// entries, and a mounted badge keeps the state it shows.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const entries: Map<string, Entry> = import.meta.hot?.data?.gitWorkEntries ?? new Map<string, Entry>();
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) import.meta.hot.data.gitWorkEntries = entries;

function folderOf(request: GitWorkStateRequest): string {
  return request.worktreePath ?? request.projectPath;
}

function keyOf(request: GitWorkStateRequest): string {
  return [
    folderOf(request), request.baseBranch, request.cutFromBranch ?? '', request.pushedBranch ?? '', request.prMerged ? 'merged' : '',
  ].join('\u0000');
}

/** What a surface of the same folder shows now, so a key that changes (a push, a merged PR) does not blank the badge. */
function shownStateOf(folder: string): GitWorkState | null {
  for (const entry of entries.values()) {
    if (entry.state !== null && folderOf(entry.request) === folder) return entry.state;
  }
  return null;
}

function schedule(entry: Entry): void {
  if (entry.timer !== null || entry.listeners.size === 0) return;
  const wait = Math.max(0, entry.lastReadAt + MIN_READ_GAP_MS - Date.now());
  entry.timer = setTimeout(() => {
    entry.timer = null;
    read(entry);
  }, wait);
}

/** `now` starts a read beside one already running, whose answer may be from before what just happened. */
function read(entry: Entry, now = false): void {
  if (entry.reading && !now) {
    entry.queued = true;
    return;
  }
  entry.reading = true;
  entry.queued = false;
  entry.generation += 1;
  const generation = entry.generation;
  entry.lastReadAt = Date.now();
  const { worktreePath, projectPath, baseBranch, cutFromBranch, pushedBranch, prMerged } = entry.request;
  window.electronAPI.git.workState({
    worktreePath: worktreePath ?? undefined, projectPath, baseBranch, cutFromBranch, pushedBranch, prMerged,
  }).then(
    (state) => {
      if (generation !== entry.generation) return;
      entry.state = state;
      for (const listener of entry.listeners) listener();
    },
    // A host that did not answer: keep what is shown rather than reading as clean.
    () => undefined, // report-ok: main already reported the rejection; the badge keeps its last answer
  ).finally(() => {
    if (generation !== entry.generation) return;
    entry.reading = false;
    if (entry.queued) {
      entry.queued = false;
      schedule(entry);
    }
  });
}

/** Read every shown checkout under `folder` again, now: an action of Kangentic's own just changed it. */
export function refreshGitWorkState(folder: string): void {
  for (const entry of entries.values()) {
    if (entry.watchers > 0 && folderOf(entry.request) === folder) read(entry, true);
  }
}

function watch(entry: Entry): void {
  entry.watchers += 1;
  if (entry.watchers > 1) return;
  const folder = folderOf(entry.request);
  const onHost = entry.request.onHost === true;
  if (!onHost) window.electronAPI.git.subscribeDiff(folder);
  const stopDiff = window.electronAPI.git.onDiffChanged((changedFolder) => {
    if (changedFolder === folder) schedule(entry);
  });
  // A push or a fetch in another program moves no watched file.
  const onFocus = (): void => schedule(entry);
  window.addEventListener('focus', onFocus);
  entry.stopWatching = () => {
    stopDiff();
    window.removeEventListener('focus', onFocus);
    if (!onHost) window.electronAPI.git.unsubscribeDiff(folder);
  };
}

function unwatch(key: string, entry: Entry): void {
  entry.watchers -= 1;
  if (entry.watchers > 0) return;
  entry.stopWatching?.();
  entry.stopWatching = null;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.listeners.size === 0) entries.delete(key);
}

const NO_SUBSCRIPTION = (): void => undefined;

/**
 * A checkout's git work state, one read shared by every surface that shows it
 * (the header's badge and tip, the panel's line, the window menu). Null while
 * unknown, with nothing to ask (`request` null), or when git could not say.
 *
 * `enabled` is whether the surface is on screen: a retained, parked or minimized
 * window watches nothing. Reads again on a file change in the folder (never for a
 * checkout on a host, which is not watched), when the agent's turn ends (which is
 * when a push of its own shows), and when the app gets focus.
 */
export function useGitWorkState(request: GitWorkStateRequest | null, enabled: boolean): GitWorkState | null {
  const active = enabled ? request : null;
  const key = active ? keyOf(active) : null;

  const entry = useMemo(() => {
    if (!active || key === null) return null;
    const existing = entries.get(key);
    if (existing) return existing;
    const created: Entry = {
      state: shownStateOf(folderOf(active)), listeners: new Set(), watchers: 0, reading: false, generation: 0, queued: false,
      lastReadAt: 0, timer: null, request: active, stopWatching: null,
    };
    entries.set(key, created);
    return created;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key carries every field the entry is made from
  }, [key]);

  const subscribe = useCallback((listener: () => void) => {
    if (!entry || key === null) return NO_SUBSCRIPTION;
    entries.set(key, entry);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [entry, key]);
  const state = useSyncExternalStore(subscribe, () => entry?.state ?? null);

  useEffect(() => {
    if (!entry || key === null) return;
    watch(entry);
    schedule(entry);
    return () => unwatch(key, entry);
  }, [entry, key]);

  // A turn that just ended may have committed or pushed. A push moves nothing the watcher sees.
  const sessionId = active?.sessionId ?? null;
  const working = useSessionStore((store) => sessionId !== null && isActive(store.sessionActivity[sessionId]));
  useEffect(() => {
    if (entry && !working) schedule(entry);
  }, [entry, working]);

  return state;
}
