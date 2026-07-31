/**
 * Who currently owns each open task detail, and where a new one should open.
 *
 * Two product rules live here, and ONLY here:
 *
 *   1. A given task's detail can never be open twice. Asking for one that is
 *      already open focuses the existing host instead of mounting a second.
 *   2. THE REQUESTER WINS. A request from a surface that does not already hold
 *      the detail opens it THERE, displacing whoever had it (who is told to let
 *      go first). There is deliberately no placement heuristic - an earlier
 *      draft routed a detached-monitor request to the board when the main window
 *      already showed that project, which made where a click landed depend on
 *      state the user could not see. `resolveOpen` is unconditional.
 *
 * In main rather than the renderer because main is the only place that knows
 * which renderer owns what: a pop-out is a separate renderer with its own
 * stores, invisible to the main window. Putting the rule anywhere else means
 * implementing it twice and watching the two drift.
 *
 * Rule 1 is also what makes the one-xterm-per-session invariant structural. Two
 * hosts mounting the same task would each mount a terminal for its session, and
 * the PTY backpressure protocol assumes a single acking reader.
 */

/** A task detail's identity, stable across renderers. */
export function detailKey(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`;
}

/**
 * Which SURFACE hosts a detail. Both live in the main window, so a webContents id
 * alone cannot tell the board's window layer from the monitor's - they would both
 * answer the same mount push.
 */
export type DetailHost = 'board' | 'monitor';

/** Who currently holds a task detail. */
export interface DetailOwner {
  webContentsId: number;
  host: DetailHost;
}

/** What main decided should happen to a task detail. */
export type DetailDestination =
  /** The requester already holds it; its window was focused, nothing remounts. */
  | { kind: 'focused-existing'; owner: DetailOwner }
  /** The requester mounts it. `closedElsewhere` names the host that gave it up. */
  | { kind: 'open-here'; owner: DetailOwner; closedElsewhere: DetailOwner | null };

export interface ResolveOpenInput {
  projectId: string;
  taskId: string;
  /** The renderer that asked. */
  requesterWebContentsId: number;
  /** The surface within that renderer that asked. */
  requesterHost: DetailHost;
}

/** One detail a host reports it currently hosts. */
export interface OwnedDetail {
  projectId: string;
  taskId: string;
}

/** What a sync changed, so the caller can repair the losers and skip a no-op push. */
export interface SyncOwnedResult {
  /** Keys this reporter now owns and did not before. */
  added: string[];
  /** Keys dropped because the reporter no longer hosts them. */
  removed: string[];
  /**
   * Keys taken from another surface, which must now be told to close. Ownership
   * moving is legitimate; leaving the loser's window on screen is not - that would
   * be the same task open twice, so two xterms on one PTY.
   */
  displaced: Array<{ projectId: string; taskId: string; previous: DetailOwner }>;
}

/** One mutation of the registry, for the dev-only ownership view. */
export interface OwnershipEvent {
  ts: number;
  action: 'resolve' | 'sync' | 'release-all';
  projectId: string | null;
  taskId: string | null;
  webContentsId: number;
  host: DetailHost | null;
  /** Whatever the action needs to be self-explanatory (the verdict, the prior owner). */
  detail?: Record<string, unknown>;
}

const OWNERSHIP_LOG_SIZE = 200;

export class DetailOwnerRegistry {
  /** detailKey -> the surface hosting it. */
  private owners = new Map<string, DetailOwner>();

  /**
   * Bounded history of every mutation, so a LEAKED claim is diagnosable.
   *
   * A leak presents as `focused-existing` for a task with no window on screen, and
   * the registry's current state cannot explain it: the interesting fact is the
   * release that never arrived, which is an absence. Only the sequence shows that.
   *
   * Note the failure mode this replaces: the only way to observe the registry was
   * to call `resolveOpen` through the IPC handler, which FOCUSES and can mount a
   * window. Probing changed the thing being measured, and a read-only view is the
   * fix. Dev-gated - the sole reader lives under `src/devtools/`.
   */
  private log: OwnershipEvent[] = [];

  private record(event: OwnershipEvent): void {
    if (!__KANGENTIC_DEV__) return;
    this.log.push(event);
    while (this.log.length > OWNERSHIP_LOG_SIZE) this.log.shift();
  }

  /**
   * Current owners plus recent history. Read-only and side-effect free, unlike
   * `resolveOpen`, so an investigation can look without perturbing.
   */
  snapshot(): {
    owners: Array<{ projectId: string; taskId: string; webContentsId: number; host: DetailHost }>;
    recent: OwnershipEvent[];
  } {
    const owners: Array<{ projectId: string; taskId: string; webContentsId: number; host: DetailHost }> = [];
    for (const [key, owner] of this.owners) {
      const separator = key.indexOf(':');
      owners.push({
        projectId: key.slice(0, separator),
        taskId: key.slice(separator + 1),
        webContentsId: owner.webContentsId,
        host: owner.host,
      });
    }
    return { owners, recent: this.log.slice() };
  }

  /**
   * Decide what happens when a surface asks to open a task detail.
   *
   * The requester always wins. Whoever asked is where the detail goes, and any
   * other surface holding it gives it up - so a monitor click opens in the
   * monitor, and opening the same task on the board takes it back and closes the
   * monitor's copy. One rule in one direction, rather than a placement heuristic
   * the user has to predict.
   *
   * Pure: it reads the registry but does not mutate it, so the caller routes
   * first and claims only once a host has actually mounted.
   */
  resolveOpen(input: ResolveOpenInput): DetailDestination {
    const requester: DetailOwner = {
      webContentsId: input.requesterWebContentsId,
      host: input.requesterHost,
    };
    const existing = this.owners.get(detailKey(input.projectId, input.taskId));

    if (existing
      && existing.webContentsId === requester.webContentsId
      && existing.host === requester.host) {
      // Re-asking the surface that already has it: focus, never remount. A
      // remount would tear down and re-attach a live agent's terminal.
      this.record({
        ts: Date.now(), action: 'resolve', projectId: input.projectId, taskId: input.taskId,
        webContentsId: requester.webContentsId, host: requester.host,
        detail: { kind: 'focused-existing' },
      });
      return { kind: 'focused-existing', owner: existing };
    }

    this.record({
      ts: Date.now(), action: 'resolve', projectId: input.projectId, taskId: input.taskId,
      webContentsId: requester.webContentsId, host: requester.host,
      detail: { kind: 'open-here', closedElsewhere: existing ?? null },
    });
    return { kind: 'open-here', owner: requester, closedElsewhere: existing ?? null };
  }

  /**
   * Make the registry match what a surface ACTUALLY has mounted.
   *
   * `entries` is the reporting surface's COMPLETE current set, derived from its
   * window store, so ownership is a function of what is mounted rather than a tally
   * of claim/release messages. That is the whole point: a lost, dropped, or
   * out-of-order message used to strand a claim forever, which presented as a task
   * answering `focused-existing` with no window anywhere on screen and therefore
   * being permanently unopenable. Now the next report from that surface repairs it,
   * whatever went wrong.
   *
   * SCOPING IS LOAD-BEARING: a report may only remove keys owned by exactly this
   * `(webContentsId, host)` pair. Two different renderers both report host
   * `'monitor'` (the in-app layer and the detached pop-out mount the same
   * component), so neither half of the pair identifies a surface on its own. The
   * scoping is also what makes a handover safe in either interleaving: main tells A
   * to close and B to open, and whether A's report (without the key) or B's report
   * (with it) arrives first, both orders converge on B owning it - A can never
   * remove a key B now owns. This subsumes the old "ignore a release from a
   * non-owner" guard structurally instead of as a special case.
   *
   * Order-stable by construction: a key this pair already owns is left in place
   * rather than re-inserted, so `ownedElsewhere`'s insertion-order iteration is
   * stable for any consumer that needs it. Note the one consumer today,
   * `useRemoteDetailOwnersSync`, compares by SET MEMBERSHIP rather than
   * positionally, so it is already immune to a reorder; the stability is kept
   * because a positional or serialize-and-diff consumer would otherwise read an
   * unchanged set as changed and needlessly re-publish the focused session set
   * (which gates whether main streams PTY bytes at all).
   *
   * The caller MUST send `DETAIL_CLOSE_HERE` for every `displaced` entry. Taking a
   * key without closing the loser's window is the one way this can be worse than
   * the old protocol: the detail would be mounted twice.
   */
  syncOwned(
    webContentsId: number,
    host: DetailHost,
    entries: ReadonlyArray<OwnedDetail>,
  ): SyncOwnedResult {
    const reported = new Set(entries.map((entry) => detailKey(entry.projectId, entry.taskId)));
    const result: SyncOwnedResult = { added: [], removed: [], displaced: [] };

    for (const [key, owner] of this.owners) {
      if (owner.webContentsId !== webContentsId || owner.host !== host) continue;
      if (reported.has(key)) continue;
      this.owners.delete(key);
      result.removed.push(key);
    }

    for (const entry of entries) {
      const key = detailKey(entry.projectId, entry.taskId);
      const owner = this.owners.get(key);
      // Already ours: leave the entry untouched so its insertion order survives.
      if (owner && owner.webContentsId === webContentsId && owner.host === host) continue;
      // Taking it from another surface is legitimate - a surface only reports a
      // window main told it to open, so the handover was already arbitrated - but
      // the previous holder has to be told, or the detail is open twice.
      if (owner) result.displaced.push({ projectId: entry.projectId, taskId: entry.taskId, previous: owner });
      this.owners.set(key, { webContentsId, host });
      result.added.push(key);
    }

    if (result.added.length === 0 && result.removed.length === 0) return result;
    this.record({
      ts: Date.now(), action: 'sync', projectId: null, taskId: null,
      webContentsId, host,
      detail: {
        added: result.added,
        removed: result.removed,
        displaced: result.displaced.map((entry) => detailKey(entry.projectId, entry.taskId)),
        reported: [...reported],
      },
    });
    return result;
  }

  /**
   * Drop every claim held by a renderer that went away (a closed pop-out, a
   * reloaded window). Without this a closed window pins its tasks forever and
   * they can never be opened again.
   */
  releaseAllFor(webContentsId: number): void {
    const dropped: string[] = [];
    for (const [key, owner] of this.owners) {
      if (owner.webContentsId !== webContentsId) continue;
      this.owners.delete(key);
      dropped.push(key);
    }
    this.record({
      ts: Date.now(), action: 'release-all', projectId: null, taskId: null,
      webContentsId, host: null, detail: { dropped },
    });
  }

  /** The surface hosting this task's detail, or null. */
  ownerOf(projectId: string, taskId: string): DetailOwner | null {
    return this.owners.get(detailKey(projectId, taskId)) ?? null;
  }

  /**
   * Every open detail NOT held by `webContentsId`, as `{ projectId, taskId }`.
   *
   * This is what a renderer needs to honour one-xterm-per-PTY across renderers:
   * "these sessions already have a terminal on screen somewhere that is not me, so
   * do not mount one." Filtered here rather than in the renderer because the
   * renderer does not know its own webContents id, and sending it one would invite
   * a caller to compare ids itself and get the direction wrong.
   */
  ownedElsewhere(webContentsId: number): Array<{ projectId: string; taskId: string }> {
    const result: Array<{ projectId: string; taskId: string }> = [];
    for (const [key, owner] of this.owners) {
      if (owner.webContentsId === webContentsId) continue;
      const separator = key.indexOf(':');
      result.push({ projectId: key.slice(0, separator), taskId: key.slice(separator + 1) });
    }
    return result;
  }

  /** Open detail count, for tests and diagnostics. */
  get size(): number {
    return this.owners.size;
  }
}
