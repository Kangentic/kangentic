/**
 * Cross-project Agent Monitor aggregator.
 *
 * Assembles one snapshot of every live (and recently finished) agent session
 * across EVERY registered project, not just the one whose board is open.
 *
 * Why this can be cheap, and why there is no polling:
 *
 *   - The session registry (`SessionManager`) and the activity / event / usage
 *     caches are already PROCESS-GLOBAL and session-keyed. They are not scoped to
 *     the open project, so reading all of them is a handful of in-memory Map reads.
 *   - The only genuinely per-project data is DB-resident (task title, ticket
 *     number, labels, PR, column name, and the model the session was spawned
 *     with). Those come from `getProjectDb`, whose handle cache never evicts, so a
 *     background project's DB is already warm.
 *   - Live state therefore does NOT flow through here. `SESSION_ACTIVITY` is
 *     already broadcast unbuffered with its projectId, and the renderer patches it
 *     onto the matching row in place. This snapshot only needs to be rebuilt when
 *     the DB-resident half changes (session spawned/exited, task retitled/moved).
 *
 * Per-project repositories are resolved ONCE per snapshot rather than once per
 * session, which is the guard against N-projects x M-sessions blowing up.
 */
import type { IpcContext } from '../ipc/ipc-context';
import type {
  MonitorLastEvent,
  MonitorSessionRow,
  MonitorSnapshot,
  SessionEvent,
  SessionUsage,
} from '../../shared/types';
import { commandTerminalTitle } from '../../shared/command-terminal-name';
import { getProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { getProjectRepos } from '../ipc/helpers/project-repos';

/**
 * How long an exited session stays visible as "recently finished". Exited entries
 * live in the registry until the app quits (only project deletion removes them),
 * so without a window the monitor would accumulate every session of the session.
 */
export const RECENTLY_FINISHED_WINDOW_MS = 30 * 60 * 1000;

/** Hard cap on recently-finished rows, so a long-running app cannot grow the list without bound. */
export const RECENTLY_FINISHED_CAP = 50;

interface ProjectLookup {
  projectName: string;
  tasks: ReturnType<typeof getProjectRepos>['tasks'];
  swimlaneNames: Map<string, string>;
  sessions: SessionRepository;
}

/**
 * Resolve (and memoize for this snapshot) the per-project reads the rows need.
 * Returns null when the project row is gone, which realistically only happens on
 * a race with project deletion; the caller drops those sessions rather than
 * inventing a placeholder project.
 */
function resolveProject(
  context: IpcContext,
  projectId: string,
  cache: Map<string, ProjectLookup | null>,
): ProjectLookup | null {
  const cached = cache.get(projectId);
  if (cached !== undefined) return cached;

  let resolved: ProjectLookup | null = null;
  try {
    const project = context.projectRepo.getById(projectId);
    if (project) {
      const repos = getProjectRepos(context, projectId);
      const swimlaneNames = new Map<string, string>();
      for (const swimlane of repos.swimlanes.list()) {
        swimlaneNames.set(swimlane.id, swimlane.name);
      }
      resolved = {
        projectName: project.name,
        tasks: repos.tasks,
        swimlaneNames,
        sessions: new SessionRepository(getProjectDb(projectId)),
      };
    }
  } catch (error) {
    // A project whose DB cannot be opened (moved on disk, corrupt) must not take
    // the whole cross-project snapshot down with it.
    console.error(`[monitor] Failed to resolve project ${projectId}:`, error);
    resolved = null;
  }

  cache.set(projectId, resolved);
  return resolved;
}

/**
 * Whole-number percentage 0-100, or null when the agent has not reported a usable
 * context window yet.
 *
 * Rounded here rather than at render time so the DTO carries the same clean value
 * the board card shows. The raw `usedPercentage` is a float (9.1948), and passing
 * it through produced a "9.1948%" label next to the board's "63%" - the one place
 * the shared footer would otherwise have looked different.
 */
function resolveContextPercent(usage: SessionUsage | undefined): number | null {
  if (!usage) return null;
  const { usedPercentage, contextWindowSize } = usage.contextWindow;
  if (!contextWindowSize || contextWindowSize <= 0) return null;
  if (!Number.isFinite(usedPercentage)) return null;
  return Math.min(100, Math.max(0, Math.round(usedPercentage)));
}

/**
 * The most recent telemetry event, which becomes the row's "doing now" line.
 *
 * Projected down to the two fields the row needs. The full `SessionEvent` also
 * carries correlation ids and per-tool telemetry, none of which the monitor
 * renders, and this row is re-sent to every subscriber on every push.
 */
function lastEventOf(events: SessionEvent[] | undefined): MonitorLastEvent | null {
  if (!events || events.length === 0) return null;
  const event = events[events.length - 1];
  return { type: event.type, detail: event.detail ?? null };
}

/**
 * Build the full cross-project snapshot. Synchronous by design: every read is
 * either an in-memory cache or an indexed lookup against an already-open DB
 * handle, so there is no await to serialize against a concurrent board mutation.
 */
export function buildMonitorSnapshot(context: IpcContext): MonitorSnapshot {
  const { sessionManager } = context;
  const activityCache = sessionManager.getActivityCache();
  const reasonCache = sessionManager.getActivityReasonsCache();
  // Both caches below are unscoped by design. `getUsageCache()` is safe to read
  // for a background session: the 2s BACKGROUND_FLUSH_MS buffering in the
  // sessions handler wraps only the BROADCAST to the renderer, while telemetry
  // updates this cache at ingest, so it is current even for an unfocused session.
  const eventsCache = sessionManager.getEventsCache();
  const usageCache = sessionManager.getUsageCache();

  const projectCache = new Map<string, ProjectLookup | null>();
  const rows: MonitorSessionRow[] = [];
  const finishedCutoff = Date.now() - RECENTLY_FINISHED_WINDOW_MS;

  for (const managed of sessionManager.listManagedSummaries()) {
    const project = resolveProject(context, managed.projectId, projectCache);
    if (!project) continue;

    // Per-SESSION guard, matching the per-PROJECT one in `resolveProject`. That
    // one covers only the DB open; the two row reads below run against an
    // already-open handle and can still throw (a transient SQLITE_IOERR, a row
    // that fails to parse). Without this, one bad session anywhere blanks the
    // cross-project view for every project, because the caller can only discard
    // the whole snapshot.
    try {

    // Command Terminals ARE included, and the monitor is the only place they can
    // appear: they have no task and therefore no board card, and the Command
    // Terminal layer only ever shows the currently-open project. They carry a
    // synthetic taskId, so the task lookup is skipped rather than failed.
    const isCommandTerminal = managed.transient;
    const task = isCommandTerminal ? undefined : project.tasks.getById(managed.taskId);
    if (!isCommandTerminal && !task) continue;

    // One indexed primary-key lookup per monitored session. This is where both
    // `applied_model` (the model actually spawned/resumed/switched with) and
    // `exited_at` come from, so recently-finished needs no extra query.
    const record = project.sessions.findByAnyId(managed.id);
    const exitedAt = record?.exited_at ?? null;

    if (managed.status === 'exited') {
      // Drop long-finished sessions. A missing exited_at means we cannot date it,
      // so keep it rather than silently hiding a session the user may care about.
      if (exitedAt && Date.parse(exitedAt) < finishedCutoff) continue;
    }

    const usage = usageCache[managed.id];

    rows.push({
      sessionId: managed.id,
      projectId: managed.projectId,
      projectName: project.projectName,
      taskId: managed.taskId,
      taskTitle: task?.title ?? commandTerminalTitle(managed.commandTerminalSlot),
      // Seeded on every snapshot so the row is self-consistent and an idle session
      // that never emits still shows something. Live updates between snapshots
      // ride MONITOR_PEEK. A synchronous O(rows) grid read, negligible next to the
      // two indexed DB lookups this loop already does per session.
      outputPeek: sessionManager.getOutputPeek(managed.id),
      displayId: task?.display_id ?? null,
      columnName: task ? project.swimlaneNames.get(task.swimlane_id) ?? '' : '',
      commandTerminalBranch: managed.commandTerminalBranch,
      labels: task?.labels ?? [],
      prUrl: task?.pr_url ?? null,
      prNumber: task?.pr_number ?? null,
      prState: task?.pr_state ?? null,
      agentName: managed.agentName,
      // Prefer the agent-reported live model (what the card shows); fall back to
      // the persisted applied model, which is all we have before first output
      // and after exit. Null means "the agent's own default".
      //
      // `|| undefined` before the `??` chain, not a second `??`: UsageAccumulator
      // seeds `displayName: ''` (emptyUsage) and status.json can omit
      // `display_name` (status-parser.ts uses `?? ''`), so an empty string is a
      // real, reachable value here - and `??` treats '' as present, never falling
      // through to `applied_model`. `||` is deliberately safe on this field: a
      // model display name is never legitimately falsy other than ''.
      modelDisplayName: (usage?.model.displayName || undefined) ?? record?.applied_model ?? null,
      // Prefer the agent-reported live effort (status.json) over the value the
      // session was spawned with, mirroring how model is resolved above.
      effort: usage?.model.effort ?? record?.applied_effort ?? null,
      permissionMode: record?.permission_mode ?? null,
      startedAt: managed.startedAt,
      exitedAt,
      status: managed.status,
      activity: activityCache[managed.id] ?? null,
      activityReason: reasonCache[managed.id] ?? null,
      lastEvent: lastEventOf(eventsCache[managed.id]),
      contextPercent: resolveContextPercent(usage),
      isolated: managed.isolatedSwimlaneId !== null,
      isCommandTerminal,
    });

    } catch (error) {
      console.error(`[monitor] Failed to build row for session ${managed.id}:`, error);
    }
  }

  capRecentlyFinished(rows);

  return { rows, generatedAt: new Date().toISOString() };
}

/**
 * Trim the oldest finished rows past the cap, in place. Live rows are never
 * dropped: the whole point of the monitor is that nothing running is hidden.
 *
 * A row with no `exited_at` sorts as the NEWEST, not the oldest. That matches the
 * window filter above, which deliberately keeps an undateable exited row rather
 * than hiding it - sorting it as oldest here would have made the cap cull exactly
 * the rows the filter just chose to preserve.
 */
function capRecentlyFinished(rows: MonitorSessionRow[]): void {
  const finished = rows.filter((row) => row.status === 'exited');
  if (finished.length <= RECENTLY_FINISHED_CAP) return;

  const exitedMs = (row: MonitorSessionRow): number => {
    if (!row.exitedAt) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(row.exitedAt);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };

  finished.sort((left, right) => exitedMs(right) - exitedMs(left));
  const doomed = new Set(finished.slice(RECENTLY_FINISHED_CAP).map((row) => row.sessionId));
  for (let index = rows.length - 1; index >= 0; index--) {
    if (doomed.has(rows[index].sessionId)) rows.splice(index, 1);
  }
}
