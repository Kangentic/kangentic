/**
 * Tells a phone's board when a queued task's place in line changes (protocol
 * 0.28.0, `BoardTaskWire.queue_place`).
 *
 * A place moves without any edge of the task's own session: a slot opening
 * drains the line (`SessionManager`'s `queue-changed`), so the task one behind
 * the promoted one goes from "1 task ahead" to "Next in line" while its own
 * session row never changes. `SessionLifecycleBoardFeed` hears only the edges
 * of the session that moved, so this feed reads the line on the same three
 * events the desktop's queue push reads it on, coalesced the same way, and
 * tells its listeners only of the tasks whose place changed or that left the
 * line. read-board forwards each as a `task-updated`. A task joining the line
 * is announced by both feeds; the phone re-reads its board once per event
 * either way.
 *
 * Bridge-owned and kept off `context.boardEvents`, for the reason
 * `SpawnProgressFeed` is: a place is not a board mutation, and that bus wakes
 * the retrieval task-record sweep, the Agent Monitor push and the workflow
 * engine on every event. With no phone watching a board it reads nothing.
 */
import { queuePlacesByTaskId } from '../../shared/queue-place';
import type { QueueSnapshot } from '../../shared/types';
import type { SessionManager } from '../pty/session-manager';
import { toQueuePlaceWire } from './handlers/wire-mappers';

/** The desktop's own queue push coalesces at this interval (`QUEUE_PUSH_COALESCE_MS`). */
const QUEUE_PLACE_COALESCE_MS = 100;

const QUEUE_EVENTS = ['queue-changed', 'session-changed', 'session-removed'] as const;

export type QueuePlacesChangedListener = (projectId: string, taskIds: string[]) => void;

export interface QueuePlaceFeedOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off'>;
  /** The line as it stands (`readQueueSnapshot`). */
  readSnapshot: () => QueueSnapshot;
  coalesceMs?: number;
}

interface AnnouncedPlace {
  projectId: string;
  key: string;
}

/**
 * Each queued board task's place, keyed by task id. A task with no place, or no
 * title (a Command Terminal has no board row), is left out. The key is the wire
 * place itself, so a field the phone reads cannot change unannounced. The
 * global limit is left out of it: settings raise no event, and a phone reads a
 * new limit with its next snapshot.
 */
export function queuePlaceKeysOf(snapshot: QueueSnapshot): Map<string, AnnouncedPlace> {
  const places = new Map<string, AnnouncedPlace>();
  for (const [taskId, { queued, place }] of queuePlacesByTaskId(snapshot)) {
    if (queued.title === null) continue;
    places.set(taskId, { projectId: queued.projectId, key: JSON.stringify(toQueuePlaceWire(place, null)) });
  }
  return places;
}

export class QueuePlaceFeed {
  private readonly options: QueuePlaceFeedOptions;
  private readonly coalesceMs: number;
  private readonly listeners = new Set<QueuePlacesChangedListener>();
  private announced = new Map<string, AnnouncedPlace>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;

  constructor(options: QueuePlaceFeedOptions) {
    this.options = options;
    this.coalesceMs = options.coalesceMs ?? QUEUE_PLACE_COALESCE_MS;
  }

  private readonly schedule = (): void => {
    if (this.disposed || this.timer) return;
    if (this.listeners.size === 0) {
      // Nobody is told, so nothing announced stays true: the next listener
      // takes a fresh snapshot, and the first read after it announces every
      // queued task once.
      this.announced.clear();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.coalesceMs);
    this.timer.unref?.();
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const eventName of QUEUE_EVENTS) this.options.sessionManager.on(eventName, this.schedule);
  }

  /** Subscribe to place changes, grouped by project. Returns an unsubscribe function. */
  onQueuePlacesChanged(listener: QueuePlacesChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads the line and tells each listener of every task whose place changed since the last read. */
  flush(): void {
    if (this.disposed) return;
    if (this.listeners.size === 0) {
      this.announced.clear();
      return;
    }
    let current: Map<string, AnnouncedPlace>;
    try {
      current = queuePlaceKeysOf(this.options.readSnapshot());
    } catch (error) {
      // A read that fails costs the phone a count, never the bridge.
      console.warn('[mobile-bridge] could not read the queue for the board feed:', error);
      return;
    }
    const changedByProject = new Map<string, string[]>();
    const note = (taskId: string, projectId: string): void => {
      const taskIds = changedByProject.get(projectId) ?? [];
      taskIds.push(taskId);
      changedByProject.set(projectId, taskIds);
    };
    for (const [taskId, place] of current) {
      if (this.announced.get(taskId)?.key !== place.key) note(taskId, place.projectId);
    }
    for (const [taskId, place] of this.announced) {
      if (!current.has(taskId)) note(taskId, place.projectId);
    }
    this.announced = current;
    for (const [projectId, taskIds] of changedByProject) {
      for (const listener of this.listeners) {
        try {
          listener(projectId, taskIds);
        } catch (error) {
          console.warn('[mobile-bridge] queue-place listener failed:', error);
        }
      }
    }
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners and clears the pending read. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      for (const eventName of QUEUE_EVENTS) this.options.sessionManager.off(eventName, this.schedule);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
