import { rateLimitWindowKey, type AgentUsageWindowShape } from '../../shared/agent-accounts';
import { RATE_LIMIT_RESET_EPSILON_SECONDS, rateLimitGeneration } from '../../shared/types';
import type { RateLimitWindow } from '../../shared/types';

/**
 * The shared account-wide rate-limit snapshot held by the session store. Rate
 * limits are account-wide, but each session only sees its own status.json
 * updates, so the renderer keeps ONE snapshot that every ContextBar reads.
 * `capturedAt` (epoch ms) and `sourceSessionId` are provenance for the pill's
 * "Updated ... via ..." tooltip.
 */
export interface RateLimitSnapshot {
  rateLimits: RateLimitWindow[];
  capturedAt: number;
  sourceSessionId: string;
}

/**
 * Whether a window's reset time has passed. Claude Code drops a window from its
 * status line once its `resets_at` passes, so a lapsed window is no longer part
 * of the account's limits and must not be shown. A `resetsAt` of 0 (or below)
 * means the reset time is unknown, not that it passed, so such a window never
 * expires here.
 */
export function isRateLimitWindowExpired(rateLimitWindow: RateLimitWindow, nowMs: number): boolean {
  return rateLimitWindow.resetsAt > 0 && rateLimitWindow.resetsAt * 1000 <= nowMs;
}

/**
 * The windows still open at `nowMs`. Returns the SAME array when none has
 * lapsed, so a caller can tell a prune from a no-op by reference.
 */
export function liveRateLimitWindows(rateLimitWindows: RateLimitWindow[], nowMs: number): RateLimitWindow[] {
  const anyExpired = rateLimitWindows.some((rateLimitWindow) => isRateLimitWindowExpired(rateLimitWindow, nowMs));
  if (!anyExpired) {
    return rateLimitWindows;
  }
  return rateLimitWindows.filter((rateLimitWindow) => !isRateLimitWindowExpired(rateLimitWindow, nowMs));
}

/**
 * The windows of the snapshot that belong to `agent`: those main stamped with
 * that agent, and those stamped with none (reports from before the stamp, and
 * fixtures). Rate limits are account-wide per provider, never across them, so
 * one agent's pill must not draw another's windows. With no agent to go by, it
 * returns them all: a pill that cannot say whose it is still shows what the
 * session reported, rather than going empty.
 */
export function rateLimitWindowsForAgent(rateLimitWindows: RateLimitWindow[], agent: string | null | undefined): RateLimitWindow[] {
  if (!agent) return rateLimitWindows;
  return rateLimitWindows.filter((rateLimitWindow) => rateLimitWindow.agent === undefined || rateLimitWindow.agent === agent);
}

/**
 * The windows of `agent`'s snapshot that belong to `accountId` (task #1057). An agent's windows
 * are per account, so a session draws only its own account's: those stamped with it, and an
 * unstamped window (a fixture, a report from before accounts) only where its account reported no
 * window of that id. With no account to go by, one window per id, the first held.
 */
export function rateLimitWindowsForAccount(rateLimitWindows: RateLimitWindow[], accountId: string | null | undefined): RateLimitWindow[] {
  if (!rateLimitWindows.some((rateLimitWindow) => rateLimitWindow.accountId !== undefined)) return rateLimitWindows;
  const own = accountId ? rateLimitWindows.filter((rateLimitWindow) => rateLimitWindow.accountId === accountId) : [];
  const ownIds = new Set(own.map((rateLimitWindow) => rateLimitWindow.id));
  const seen = new Set<string>();
  return rateLimitWindows.filter((rateLimitWindow) => {
    if (accountId && rateLimitWindow.accountId === accountId) return true;
    if (accountId && rateLimitWindow.accountId !== undefined) return false;
    if (ownIds.has(rateLimitWindow.id) || seen.has(rateLimitWindow.id)) return false;
    seen.add(rateLimitWindow.id);
    return true;
  });
}

/**
 * The agent whose windows a session's pill draws: the one main stamped on the
 * session's own reports, else `fallback`. The stamp comes first because a task
 * with no agent of its own falls back to the project default, which can have
 * changed since this session started.
 */
export function sessionRateLimitAgent(sessionWindows: RateLimitWindow[] | undefined, fallback: string | null | undefined): string | null | undefined {
  return sessionWindows?.find((rateLimitWindow) => rateLimitWindow.agent !== undefined)?.agent ?? fallback;
}

/**
 * The windows in the order the pill draws them: shortest `windowDurationSeconds`
 * first, then the windows with no fixed duration in their snapshot order. The
 * merge keeps a held window's position and appends a new id, so a 5h window that
 * lapsed and came back would otherwise draw after the 7d one. Never mutates its
 * input.
 */
export function rateLimitWindowsShortestFirst(rateLimitWindows: RateLimitWindow[]): RateLimitWindow[] {
  const durationOf = (rateLimitWindow: RateLimitWindow): number => rateLimitWindow.windowDurationSeconds ?? Number.POSITIVE_INFINITY;
  return [...rateLimitWindows].sort((first, second) => {
    const firstDuration = durationOf(first);
    const secondDuration = durationOf(second);
    if (firstDuration === secondDuration) return 0;
    return firstDuration < secondDuration ? -1 : 1;
  });
}

/**
 * Merge an incoming rate-limit snapshot into the shared one, per window key
 * (`rateLimitWindowKey`: the id, scoped by the account that reported it).
 * Rate-limit windows are FIXED windows anchored by a `resetsAt` epoch, so within
 * one window `usedPercentage` normally only rises. Each Claude CLI process
 * refreshes its rate-limit info only from its own API traffic, so a concurrently
 * running sibling session can report a much older cached value for the same
 * window. Under a naive last-writer-wins snapshot those two sessions make every
 * ContextBar flip-flop between the fresh and stale numbers every few seconds.
 * Merging per window instead keeps the account-wide truth: within one window we
 * keep the maximum, we take a genuine rollover wholesale, and we ignore a report
 * for an older window.
 *
 * A free usage reset lowers usage without moving `resetsAt`, which the maximum
 * alone would reject forever. Main's `RateLimitLedger` sees which session said
 * what and stamps each window with a reset `generation`, which decides between
 * two reports of the same window: a reset arrives as a higher generation, and a
 * stale sibling's pre-reset number carries a lower one. Windows without a stamp
 * (demo data, UI fixtures) read as generation 0 and merge exactly as before.
 *
 * Before any comparison, a window whose `resetsAt` has passed at `nowMs` is
 * dropped from both sides (`isRateLimitWindowExpired`; a `resetsAt` of 0 is
 * unknown and kept). Claude Code reports only the windows that apply, and stops
 * sending one once it resets, so without this a sibling session's last report
 * of a lapsed window would bring back a bar that no later report removes.
 *
 * Per window id, comparing the incoming window to the one we already hold:
 * - id not present in current   -> add the incoming window.
 * - resetsAt advanced past the epsilon (rollover) -> take incoming wholesale,
 *   even when its `usedPercentage` is lower (the window reset).
 * - resetsAt older than the epsilon (stale window) -> ignore the incoming window.
 * - resetsAt within the epsilon (same window), generation higher (a reset) ->
 *   take the incoming `usedPercentage` and generation even when lower.
 * - same window, generation lower (reported before the last reset) -> keep the
 *   current window, even when the incoming one is higher.
 * - same window, same generation -> keep the higher `usedPercentage`; a lower
 *   or equal report is stale and is dropped.
 * - In every same-window case the current window's `resetsAt` stays the anchor,
 *   so the anchor cannot drift within a window.
 * - id present in current but absent from incoming -> keep the current window
 *   while it has not lapsed.
 *
 * Returns the EXACT `current` reference when nothing changed, so Zustand
 * subscribers do not re-render and `useValuePulse` does not fire on a no-op
 * report. That includes a sibling that keeps re-sending a window that already
 * lapsed. Never mutates either input. A `null` current returns `incoming`
 * unchanged (the first snapshot, including the empty-array case), or a copy
 * without its lapsed windows. When the only change is a lapsed window dropped
 * from `current`, the result keeps the current provenance, since none of the
 * remaining numbers was refreshed.
 *
 * Per window the result is a maximum of (window, then generation, then value),
 * so folding many reports stays order-independent for realistic inputs, as the
 * `resetsAt` rules alone already were. The comparison between two reports never
 * reads a clock; only the expiry above uses `nowMs` (epoch ms).
 */
export function mergeRateLimitSnapshot(
  current: RateLimitSnapshot | null,
  incoming: RateLimitSnapshot,
  nowMs: number,
): RateLimitSnapshot {
  const incomingWindows = liveRateLimitWindows(incoming.rateLimits, nowMs);
  if (current === null) {
    return incomingWindows === incoming.rateLimits ? incoming : { ...incoming, rateLimits: incomingWindows };
  }

  const currentWindows = liveRateLimitWindows(current.rateLimits, nowMs);
  const pruned = currentWindows !== current.rateLimits;
  const incomingById = new Map<string, RateLimitWindow>(
    incomingWindows.map((rateLimitWindow): [string, RateLimitWindow] => [rateLimitWindowKey(rateLimitWindow), rateLimitWindow]),
  );
  let changed = false;

  const mergedWindows = currentWindows.map((currentWindow) => {
    const windowKey = rateLimitWindowKey(currentWindow);
    const incomingWindow = incomingById.get(windowKey);
    if (incomingWindow === undefined) {
      // Window absent from the incoming report: keep the one we already hold.
      return currentWindow;
    }
    incomingById.delete(windowKey);

    const resetDelta = incomingWindow.resetsAt - currentWindow.resetsAt;
    if (resetDelta > RATE_LIMIT_RESET_EPSILON_SECONDS) {
      // The window rolled over (resetsAt jumped forward by ~a window length).
      // Take the incoming window wholesale, even when its usedPercentage is lower.
      changed = true;
      return incomingWindow;
    }
    if (resetDelta < -RATE_LIMIT_RESET_EPSILON_SECONDS) {
      // The incoming report describes an OLDER window than the one we hold:
      // stale cached data. Keep the current window.
      return currentWindow;
    }
    // Same fixed window. The reset generation decides first, and only here. A
    // session can drop inside a window the account has already rolled past, so
    // a generation compared before the window would drag the bar back to it.
    // Main's twin of this same-window test is `isSameRateLimitWindow`
    // (rate-limit-ledger.ts), which also refuses a missing (0) anchor; change
    // the two together.
    const generationDelta = rateLimitGeneration(incomingWindow) - rateLimitGeneration(currentWindow);
    if (generationDelta > 0) {
      // A reset main detected (usage fell without resetsAt moving). Take the
      // incoming value even when it is lower, keeping the anchor pinned.
      changed = true;
      return { ...currentWindow, usedPercentage: incomingWindow.usedPercentage, generation: incomingWindow.generation };
    }
    if (generationDelta < 0) {
      // Reported by a session that has not seen anything new since the last
      // reset, so its number is the pre-reset one. Keep the current window.
      return currentWindow;
    }
    // Same generation: usedPercentage only rises within a window, so a strictly
    // higher report is fresher and wins; a lower or equal one is stale and must
    // not clobber the value already shown. Keep
    // the current window's `resetsAt` as the anchor (bump only usedPercentage)
    // rather than adopting the incoming one: taking the incoming resetsAt would
    // let the anchor walk by up to the epsilon on every accepted update, and
    // that drift compounds until a genuine rollover lands within the epsilon of
    // the drifted anchor and is misclassified as same-window (then rejected as
    // stale). Pinning the anchor to the first report of the window keeps it
    // moving only on a real detected rollover (`resetDelta > EPSILON` above).
    if (incomingWindow.usedPercentage > currentWindow.usedPercentage) {
      changed = true;
      return { ...currentWindow, usedPercentage: incomingWindow.usedPercentage };
    }
    return currentWindow;
  });

  // Any incoming window whose id the current snapshot has never carried is new.
  for (const remainingWindow of incomingById.values()) {
    mergedWindows.push(remainingWindow);
    changed = true;
  }

  if (changed) {
    return {
      rateLimits: mergedWindows,
      capturedAt: incoming.capturedAt,
      sourceSessionId: incoming.sourceSessionId,
    };
  }
  if (pruned) {
    return { ...current, rateLimits: mergedWindows };
  }
  return current;
}

/**
 * Elapsed fraction of a rate-limit window, expressed as a 0-100 percentage and
 * clamped to that range.
 *
 * Claude reports only the window's reset time (`resetsAt`) and its used budget,
 * not when the window opened. Because the window length is fixed, the start is
 * `resetsAt - windowDurationSeconds`, and elapsed time follows. This drives the
 * vertical time marker in the usage bar: it sits further right as the reset time
 * draws nearer.
 *
 * Returns `null` when the window has no usable timing anchor (a missing
 * `resetsAt` parses to 0, or a non-positive duration), so callers can skip the
 * marker. `windowDurationSeconds` is optional on RateLimitWindow; the single
 * caller simply does not call this when the adapter omitted it.
 */
export function windowElapsedPercentage(
  resetsAtEpochSeconds: number,
  windowDurationSeconds: number,
  nowMs: number,
): number | null {
  if (
    !Number.isFinite(resetsAtEpochSeconds) ||
    resetsAtEpochSeconds <= 0 ||
    !Number.isFinite(windowDurationSeconds) ||
    windowDurationSeconds <= 0
  ) {
    return null;
  }
  const windowMs = windowDurationSeconds * 1000;
  const remainingMs = resetsAtEpochSeconds * 1000 - nowMs;
  const percentage = (1 - remainingMs / windowMs) * 100;
  return Math.min(100, Math.max(0, percentage));
}

/**
 * One line of an account row's usage block in Settings > Accounts.
 * - `live`: a window the CLI reported and that has not reset.
 * - `not-started`: a window the agent always has that this account has not opened (Claude reports
 *   its 5h window only once the account has run in it). Drawn at 0% with no tick and no reset.
 * - `unread`: no usage has been read for the account yet. Drawn empty, with no figures.
 */
export type AccountUsageLine =
  | { kind: 'live'; window: RateLimitWindow }
  | { kind: 'not-started'; shape: AgentUsageWindowShape }
  | { kind: 'unread'; shape: AgentUsageWindowShape | null };

/**
 * The lines an account row draws, so every row of an agent is one height: one per window the
 * agent declares (`usageWindows`, in its order), then any other window the CLI reported (a
 * per-model weekly window), shortest first. `liveWindows` must already be free of lapsed windows
 * (`liveRateLimitWindows`), so a window whose reset passed reads Not started again. With no
 * reading yet (`hasReading` false) each declared window is `unread`; an agent that declares none
 * gets one unnamed `unread` line, as the row drew before anything was read.
 */
export function accountUsageLines(
  usageWindows: readonly AgentUsageWindowShape[],
  liveWindows: RateLimitWindow[],
  hasReading: boolean,
): AccountUsageLine[] {
  if (!hasReading) {
    return usageWindows.length > 0
      ? usageWindows.map((shape): AccountUsageLine => ({ kind: 'unread', shape }))
      : [{ kind: 'unread', shape: null }];
  }
  const declaredIds = new Set(usageWindows.map((shape) => shape.id));
  const lines: AccountUsageLine[] = usageWindows.map((shape): AccountUsageLine => {
    const reported = liveWindows.find((rateLimitWindow) => rateLimitWindow.id === shape.id);
    return reported ? { kind: 'live', window: reported } : { kind: 'not-started', shape };
  });
  const extra = rateLimitWindowsShortestFirst(liveWindows.filter((rateLimitWindow) => !declaredIds.has(rateLimitWindow.id)));
  for (const rateLimitWindow of extra) lines.push({ kind: 'live', window: rateLimitWindow });
  return lines.length > 0 ? lines : [{ kind: 'unread', shape: null }];
}
