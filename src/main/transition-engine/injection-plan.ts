import type { Project, SessionRecord, SessionUsage, Swimlane, Task } from '../../shared/types';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { CommandVerifier, InjectionCommand, InjectionVerifyMode } from './terminal-submit-scheduler';

/**
 * The effort the AGENT itself reports it is running at, or null when it reports
 * none (a model with no effort levels, an agent with no live telemetry, or a
 * session that has not reported yet).
 *
 * `applied_effort` records what Kangentic ASKED for at spawn, resume, or a live
 * switch. An `/effort` the user types straight into the terminal never reaches
 * it, so on its own it goes stale and a later column move diffs against a value
 * the session stopped running at. Claude Code documents its reported level as
 * the one in force "after any silent downgrade for the selected model", making
 * it the closest thing to ground truth available.
 *
 * Type-only dependency on the usage cache shape, so this module stays free of a
 * runtime SessionManager import.
 */
export function resolveLiveEffort(
  usageCacheReader: { getUsageCache(): Record<string, SessionUsage> },
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  // `model` is required on the type, but several adapters build sparse usage via
  // an `as unknown as SessionUsage` cast, so guard it rather than trust the type.
  return usageCacheReader.getUsageCache()[sessionId]?.model?.effort ?? null;
}

/**
 * Ground truth for "what effort is this session running at", used as the SOURCE
 * side of a column-transition delta.
 *
 * Order: a per-task pin wins (the ContextBar contract - the session was spawned
 * or switched to the pin, so source = target = pin and no slash fires), then
 * what the agent reports, then what we last asked for. Keeping the pin ahead of
 * live also preserves the protection a NULL `applied_effort` relies on for
 * records that predate applied-settings recording.
 */
export function resolveSourceEffort(input: {
  taskEffortOverride: string | null | undefined;
  liveEffort: string | null | undefined;
  appliedEffort: string | null | undefined;
}): string | null {
  return input.taskEffortOverride ?? input.liveEffort ?? input.appliedEffort ?? null;
}

/**
 * Per-agent translation of a column-level model/effort change (and an
 * optional auto_command) into a chained sequence of writes plus an
 * appropriate verifier - i.e. the input TerminalSubmitScheduler needs to
 * actually push the writes onto the PTY.
 *
 * Naming convention across the stack:
 * - "sequence" = pure data, agent-declared (adapter.getInjectionSequence,
 *   adapter.getExitSequence). The adapter names a sequence by the
 *   lifecycle event that drives it (injection / exit), not by the
 *   downstream consumer.
 * - "plan"     = the assembled artifact (sequence + verifier) handed to
 *   the executor. The plan is what gets injected.
 * - "scheduler" / "burst" = execution layer (TerminalSubmitScheduler).
 *
 * Centralizes what `task-move.ts` and `board.ts` would otherwise both
 * build by hand:
 *
 * 1. Ask the destination adapter for the writes needed to apply settings
 *    deltas (`getInjectionSequence`).
 * 2. Append the column's auto_command (already interpolated) if any.
 * 3. Ask the adapter for a per-command verifier
 *    (`getSubmissionVerifier('command-injection')`) bound to this task's
 *    session transcript via the captured `agentSessionId` and `cwd`.
 *
 * Returns null when there is nothing to inject (no settings delta, no
 * auto_command). Callers pass the result straight to
 * `terminalSubmitScheduler.scheduleKeystrokes(task.id, sessionId, plan.sequence, { verifier: plan.verifier })`.
 */
export interface InjectionPlanInput {
  adapter: AgentAdapter | undefined;
  sessionRepo: SessionRepository | null;
  /**
   * `model_override` and `effort_override` are read so that a task with an
   * explicit per-task override (set via the ContextBar popover) is treated as
   * a no-op for that field on column transitions - the user's choice wins
   * over the column's setting.
   */
  task: Pick<Task, 'id' | 'agent' | 'model_override' | 'effort_override'>;
  toLane: Swimlane | null;
  /**
   * Project-level model/effort default - the tier below the column and above
   * the CLI default. Read on BOTH the source and target sides of the delta so
   * an override-less column move on a project with a default set does not
   * read a spurious change (source = the project default the session was
   * actually spawned with; target = null without this tier).
   */
  project?: Pick<Project, 'default_model' | 'default_effort'> | null;
  /** Already-interpolated auto_command from the destination column, or empty. */
  autoCommand?: string;
  /**
   * Effort the agent itself reports it is running at (`resolveLiveEffort`), or
   * null/omitted when it reports none. Resolved by the caller rather than read
   * here so this module needs no SessionManager at runtime and stays unit
   * testable with plain values. Omitting it reproduces the previous behaviour
   * exactly (source falls back to the session record).
   */
  liveEffort?: string | null;
}

export interface InjectionPlan {
  /**
   * The commands to deliver, each carrying how its delivery may be confirmed.
   *
   * This replaced a `sequence: string[]` plus a single `verifiedPrefixLength`
   * count. That shape could express only ONE verification semantic for a whole
   * burst, so the trailing user auto_command - the thing users actually care
   * about - had to be excluded from verification entirely and settled on a
   * fixed timer. Per-command modes remove that hole by construction rather
   * than by tuning the count.
   */
  sequence: InjectionCommand[];
  verifier: CommandVerifier | null;
  /**
   * Set when the destination has a CONCRETE model different from the session's
   * running model. A model change is never applied as a live `/model` swap on an
   * automated path (column transition or column-config edit); the caller must
   * suspend + `--resume --model X` instead. See the rationale on
   * `needsRestartForModel` below. When set, `sequence` may be empty (model-only
   * change) and the caller must act on this flag BEFORE scheduling any writes.
   */
  needsRestartForModel: boolean;
  /**
   * The effort the live session will be at once this burst applies - present
   * only when effort changed to a concrete target (i.e. a `/effort` slash was
   * emitted). The caller persists this via `sessionRepo.updateAppliedSettings`
   * after scheduling so the next column transition diffs against the session's
   * true running value. Model is never recorded here: a model change restarts,
   * and the respawn records `applied_model` itself via its `--model` flag.
   */
  appliedSettings?: { effort?: string };
}

export function prepareInjectionPlan(input: InjectionPlanInput): InjectionPlan | null {
  const { adapter, sessionRepo, task, toLane, autoCommand, project, liveEffort } = input;

  // SOURCE is the model/effort the live session is ACTUALLY running at, NOT the
  // leaving column's config. The leaving column disagrees after an in-flight
  // ContextBar switch or a kangentic.json column-config edit, which is what
  // produced the spurious `/effort` injection. A per-task override still wins:
  // the session was spawned/switched to the pin, so source = target = pin and no
  // slash fires for that field (preserving the ContextBar contract). When no
  // record exists (unit stubs, a session predating this column) the applied
  // value is null, i.e. "agent default".
  //
  // For EFFORT the source now prefers what the agent reports over what we asked
  // for (`resolveSourceEffort`). The record alone cannot see an `/effort` the
  // user typed into the terminal, so it goes stale: with applied=high, a manual
  // switch to medium, and a destination column requiring high, source and target
  // both read high, no slash fires, and the session silently keeps running at
  // medium in a column that requires high.
  //
  // The project-default tier is read on BOTH sides: without it, a task moving
  // between two override-less columns on a project with a default_model set
  // would read source = the applied project default (recorded at the last
  // spawn) vs target = null, and spuriously restart/re-inject even though
  // nothing actually changed.
  const record = sessionRepo?.getLatestForTask(task.id) ?? null;
  // MODEL is deliberately NOT sourced from live telemetry. The agent reports a
  // canonical id (`claude-opus-4-8`) while `applied_model` / `model_override` /
  // `default_model` hold whatever flag string the user configured (`opus`), so
  // comparing across those id spaces would read "changed" on almost every move,
  // and `needsRestartForModel` below turns that into a suspend + `--resume` PTY
  // restart per column transition. Effort has no such split: both sides draw
  // from the adapter's discovered `effortLevels` vocabulary.
  const sourceModel = task.model_override ?? record?.applied_model ?? null;
  const targetModel = task.model_override ?? toLane?.model_override ?? project?.default_model ?? null;
  const sourceEffort = resolveSourceEffort({
    taskEffortOverride: task.effort_override,
    liveEffort,
    appliedEffort: record?.applied_effort,
  });
  const targetEffort = task.effort_override ?? toLane?.effort_override ?? project?.default_effort ?? null;

  const modelChanged = targetModel !== sourceModel;
  const effortChanged = targetEffort !== sourceEffort;

  // A MODEL change on an automated path (column transition or column-config
  // edit) is applied by a full exit + `--resume --model`, NOT a live `/model`
  // swap: a live mid-session model switch left the agent paused after a
  // Planning -> Executing handoff (it stopped instead of continuing). Only a
  // concrete destination model restarts; a null target is the "Default" column
  // (`--resume` preserves the saved model and there is no `/model <agent-default>`
  // slash), which is not a real change. The caller suspends + respawns when this
  // is set.
  const needsRestartForModel = modelChanged && targetModel !== null;

  // Settings writes come from the adapter so the IPC layer never names a slash.
  // An adapter without getInjectionSequence contributes none. We pass
  // `modelChanged: false` so this helper NEVER emits `/model` (a model change is
  // handled by the restart above, not a live write); `/effort` still flows
  // through for a live swap.
  const settingsSequence = adapter?.getInjectionSequence?.({
    model: targetModel,
    modelChanged: false,
    effort: targetEffort,
    effortChanged,
  }) ?? [];

  // Adapter-emitted settings writes are verified strictly: we know the exact
  // invocation we asked for, so a combined-args entry must read as a miss and
  // retry. The user's auto_command is verified as "exactly this text was
  // submitted", which holds whether or not it is a registered slash command.
  const sequence: InjectionCommand[] = settingsSequence.map((text) => ({
    text,
    verify: 'command-match' as const,
  }));

  const trimmedAutoCommand = autoCommand?.trim() ?? '';
  if (trimmedAutoCommand) {
    sequence.push({ text: trimmedAutoCommand, verify: 'submitted' });
  }

  // Return null only when there is nothing to do at all: no live writes AND no
  // restart needed. A model-only change has an empty sequence but must still
  // return a plan so the caller can act on `needsRestartForModel`.
  if (sequence.length === 0 && !needsRestartForModel) return null;

  // Verifier is best-effort: needs adapter support + a captured agent_session_id.
  // null is a documented fallback to time-based settle in
  // TerminalSubmit.submitKeystrokes. Pass the record we already read so the
  // verifier builder does not re-query.
  const verifier = adapter && sessionRepo
    ? buildCommandInjectionVerifier(adapter, sessionRepo, task.id, record)
    : null;

  // What the session will be at after this burst: only effort, and only when it
  // changed to a concrete value (i.e. a `/effort` slash was emitted). Model is
  // never live-applied here (it restarts), and a change to a null target
  // ("Default" column) emits no slash and leaves the session as-is.
  const appliedSettings: { effort?: string } = {};
  if (effortChanged && targetEffort !== null) appliedSettings.effort = targetEffort;
  const hasApplied = appliedSettings.effort !== undefined;

  return {
    sequence,
    verifier,
    needsRestartForModel,
    ...(hasApplied ? { appliedSettings } : {}),
  };
}

/**
 * Wrap an adapter's `command-injection` `SubmissionVerifier` as the
 * `CommandVerifier` shape that `TerminalSubmit.submitKeystrokes` expects.
 *
 * Returns `null` when (a) the adapter doesn't implement
 * `getSubmissionVerifier('command-injection')`, or (b) the latest session
 * record for the task lacks `agent_session_id` / `cwd` (e.g. a fresh spawn
 * whose session ID hasn't been captured yet). In both cases callers should
 * fall back to the time-based settle path inside `TerminalSubmit`.
 *
 * Shared between `prepareInjectionPlan` (column-transition slash bursts) and
 * the `task:setRuntimeOverride` IPC handler (user-driven model/effort
 * picks). Without a shared helper both call sites would re-implement the
 * same record lookup + closure capture, and a fix in one would silently
 * miss the other.
 *
 * `prefetchedRecord` lets a caller that already read the latest session record
 * (e.g. `prepareInjectionPlan` reading it for the delta source) pass it through
 * to avoid a second query. Omit it to read fresh.
 */
/**
 * How long a resolved session record is reused before the verifier re-reads it.
 * See the comment at the re-resolve site: this exists to keep a synchronous
 * SQLite call out of a 40Hz poll loop without losing mid-burst `/clear`
 * detection.
 */
const RECORD_RERESOLVE_TTL_MS = 250;

export function buildCommandInjectionVerifier(
  adapter: AgentAdapter,
  sessionRepo: SessionRepository,
  taskId: string,
  prefetchedRecord?: SessionRecord | null,
): CommandVerifier | null {
  if (!adapter.getSubmissionVerifier) return null;
  const submissionVerifier = adapter.getSubmissionVerifier('command-injection');
  if (!submissionVerifier) return null;
  const record = prefetchedRecord !== undefined ? prefetchedRecord : sessionRepo.getLatestForTask(taskId);
  // A record is required (there is nothing to re-resolve against without one),
  // but its agent_session_id is NOT. A fresh spawn has no captured id yet, and
  // returning null here would leave fresh-spawn auto_commands permanently
  // unverifiable - the exact delivery path that most needed the check, since
  // it is the one that runs without a leading clear. Delivery is deferred
  // until the CLI comes alive, and the id is resolved on every poll below, so
  // by the time verification actually runs the id is there.
  if (!record) return null;
  const recordId = record.id;
  const capturedAgentSessionId = record.agent_session_id;
  const capturedCwd = record.cwd;
  let resolvedRecord: SessionRecord | null = record;
  let resolvedAt = 0;
  return async (command: string, sentAt: number, mode: InjectionVerifyMode) => {
    // `none` never reaches a verifier (submitKeystrokes skips the call), but
    // guard anyway so an unverifiable command can never be reported confirmed.
    if (mode === 'none') return false;
    // Re-resolve the agent session id from the SAME record (by primary key,
    // never latest-for-task, which could shadow an isolated session's row): a
    // /clear mid-burst forks the live conversation to a new id (persisted by
    // the live status-file reconcile), and the slash entries being verified
    // land in the NEW transcript. Polling only the plan-build-time id would
    // never confirm, so the burst would spend its whole retry budget pressing
    // Enter into a session whose evidence is being written somewhere else.
    //
    // Re-resolved on a TTL rather than on every poll. `findByAnyId` calls
    // `db.prepare` inline, so better-sqlite3 recompiles the SQL each time, and
    // better-sqlite3 is synchronous - at a 25ms poll cadence that is 40 blocking
    // DB round trips per second per in-flight burst, on the same thread that
    // services IPC. It buys nothing at that rate: the thing it watches for is a
    // human typing /clear. The TTL stays well inside one retry attempt
    // (VERIFY_WINDOW_MS is 400ms, and there are 5 attempts), so a fork is still
    // picked up within the same attempt that follows it.
    const now = Date.now();
    if (now - resolvedAt >= RECORD_RERESOLVE_TTL_MS) {
      resolvedRecord = sessionRepo.findByAnyId(recordId) ?? null;
      resolvedAt = now;
    }
    const currentRecord = resolvedRecord;
    const currentAgentSessionId = currentRecord?.agent_session_id ?? capturedAgentSessionId;
    const currentCwd = currentRecord?.cwd ?? capturedCwd;
    // Still no captured id/cwd: the transcript we would scan does not exist
    // yet, so this poll simply has no answer. Reporting "not confirmed" lets
    // the caller keep retrying rather than treating it as a hard failure.
    if (!currentAgentSessionId || !currentCwd) return false;
    const verifiedInCurrent = await submissionVerifier({
      type: 'command-injection',
      text: command,
      agentSessionId: currentAgentSessionId,
      cwd: currentCwd,
      sentAt,
      mode,
    });
    if (verifiedInCurrent || currentAgentSessionId === capturedAgentSessionId) {
      return verifiedInCurrent;
    }
    // The id changed mid-burst: also accept a match under the id captured at
    // plan-build time - the command may have landed in the pre-fork
    // transcript an instant before the fork. Skipped when nothing was captured
    // (fresh spawn), where there is no earlier transcript to fall back to.
    if (!capturedAgentSessionId || !capturedCwd) return false;
    return submissionVerifier({
      type: 'command-injection',
      text: command,
      agentSessionId: capturedAgentSessionId,
      cwd: capturedCwd,
      sentAt,
      mode,
    });
  };
}
