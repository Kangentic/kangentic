import { DEFAULT_AGENT } from '../../shared/types';
import type { Project, SessionRecord, SessionUsage, Swimlane, Task } from '../../shared/types';
import { projectModelDefaultsApply } from './spawn-preamble';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { SessionRepository } from '../db/repositories/session-repository';
import { resolveOwnSessionRecord } from '../db/repositories/session-own-record';
import type { CommandVerifier, InjectionCommand, InjectionVerifyMode } from './terminal-submit-scheduler';
import type { SpawnPhase } from './spawn-progress';

/** The effort levels a session's agent has reported, read by `resolveReportedEffort`. */
export interface ReportedEffort {
  /**
   * The level the agent reports it runs at now, or null when it reports none
   * (a model with no effort levels, an agent with no live telemetry, or a
   * session that has not reported yet).
   */
  liveEffort: string | null;
  /** The first level the agent reported after this session launched, or null. */
  firstReportedEffort: string | null;
}

/**
 * The effort the AGENT itself reports for a session, now and at its launch.
 *
 * `applied_effort` records what Kangentic ASKED for at spawn or resume. An
 * `/effort` the user types straight into the terminal never reaches
 * it, so on its own it goes stale and a later column move diffs against a value
 * the session stopped running at. Claude Code documents its reported level as
 * the one in force "after any silent downgrade for the selected model", making
 * it the closest thing to ground truth available. The first report is what
 * `resolveSourceEffort` needs to tell that downgrade apart from a manual
 * `/effort`.
 *
 * The keys match `InjectionPlanInput`, so a caller spreads the result into it.
 * Type-only dependency on the usage cache shape, so this module stays free of a
 * runtime SessionManager import.
 */
export function resolveReportedEffort(
  reader: {
    getUsageCache(): Record<string, SessionUsage>;
    getFirstReportedEffort(sessionId: string): string | null;
  },
  sessionId: string | null | undefined,
): ReportedEffort {
  if (!sessionId) return { liveEffort: null, firstReportedEffort: null };
  return {
    // `model` is required on the type, but several adapters build sparse usage
    // via an `as unknown as SessionUsage` cast, so guard it rather than trust
    // the type.
    liveEffort: reader.getUsageCache()[sessionId]?.model?.effort ?? null,
    firstReportedEffort: reader.getFirstReportedEffort(sessionId),
  };
}

/**
 * Ground truth for "what effort is this session running at", the SOURCE side of
 * an effort delta. A column move, a column or profile edit, and a ContextBar
 * pick all read it, so they cannot disagree about it.
 *
 * Order:
 * 1. A per-task pin wins (the ContextBar contract: the session was spawned or
 *    restarted at the pin, so source = target = pin and nothing restarts).
 *    Keeping it ahead of live also preserves the protection a NULL
 *    `applied_effort` relies on for records that predate applied-settings
 *    recording. A pick passes null here, because the pin is what it changes.
 * 2. The target itself, when Kangentic launched this session at it
 *    (`appliedEffort`) and the agent's level has not moved since its first
 *    report. Claude silently downgrades a level the model lacks (`max` on a
 *    model that tops out at `high`) and reports the result, so without this a
 *    column or pick asking for `max` would read as changed, and restart, every
 *    time. A restart would launch at the same flag and land on the same level.
 *    A manual `/effort` moves the live level off its first report, so it still
 *    reads as a change.
 * 3. What the agent reports, then what we last asked for.
 *
 * Step 2 needs both conditions. Swapping live for applied whenever live is
 * unmoved would read a session at `high` (asked for `max`) as `max`, and a move
 * into a `high` column would restart a session already running at `high`.
 */
export function resolveSourceEffort(input: {
  taskEffortOverride: string | null | undefined;
  liveEffort: string | null;
  // Required, with the target below, so a caller cannot drop the downgrade
  // guard by omission: without them every move into a downgraded column
  // restarts again, and nothing else would fail.
  firstReportedEffort: string | null;
  appliedEffort: string | null | undefined;
  targetEffort: string | null;
}): string | null {
  if (input.taskEffortOverride != null) return input.taskEffortOverride;
  const launchedAtTarget = input.targetEffort !== null && input.targetEffort === input.appliedEffort;
  const levelUnmovedSinceLaunch = input.liveEffort === input.firstReportedEffort;
  if (launchedAtTarget && levelUnmovedSinceLaunch) return input.targetEffort;
  return input.liveEffort ?? input.appliedEffort ?? null;
}

/**
 * What a column transition or column-config edit must do to a task's LIVE
 * session: restart it to apply a model/effort change, and/or deliver the
 * column's auto_command as keystrokes with an appropriate verifier.
 *
 * Naming convention across the stack:
 * - "sequence" = pure data, agent-declared (adapter.getInjectionSequence,
 *   adapter.getExitSequence). The adapter names a sequence by the
 *   lifecycle event that drives it (injection / exit), not by the
 *   downstream consumer.
 * - "plan"     = the assembled artifact (restart decision + commands +
 *   verifier) handed to the executor.
 * - "scheduler" / "burst" = execution layer (TerminalSubmitScheduler).
 *
 * Centralizes what `task-move.ts` and `strategy-propagation.ts` would
 * otherwise both build by hand:
 *
 * 1. Diff the session's running model/effort against the destination and
 *    decide whether a restart (suspend + `--resume` with launch flags) is
 *    needed. Settings are never typed into a task session's PTY: see
 *    `restartReason` below.
 * 2. Carry the column's auto_command (already interpolated) if any.
 * 3. Ask the adapter for a per-command verifier
 *    (`getSubmissionVerifier('command-injection')`) bound to this task's
 *    session transcript via the captured `agentSessionId` and `cwd`.
 *
 * Returns null when there is nothing to do (no settings delta, no
 * auto_command). A caller acts on `restartReason` first. Only a plan with no
 * restart reaches `terminalSubmitScheduler.scheduleKeystrokes(task.id,
 * sessionId, plan.sequence, { verifier: plan.verifier })`.
 */
export interface InjectionPlanInput {
  adapter: AgentAdapter | undefined;
  sessionRepo: SessionRepository | null;
  /**
   * `model_override` and `effort_override` are read so that a task with an
   * explicit per-task override (set via the ContextBar popover) is treated as
   * a no-op for that field on column transitions - the user's choice wins
   * over the column's setting, and the field never forces a restart.
   */
  task: Pick<Task, 'id' | 'session_id' | 'agent' | 'agent_override' | 'model_override' | 'effort_override'>;
  toLane: Swimlane | null;
  /**
   * Project-level model/effort default - the tier below the column and above
   * the CLI default. Read on BOTH the source and target sides of the delta so
   * an override-less column move on a project with a default set does not
   * read a spurious change (source = the project default the session was
   * actually spawned with; target = null without this tier).
   */
  project?: Pick<Project, 'default_agent' | 'default_model' | 'default_effort'> | null;
  /** Already-interpolated auto_command from the destination column, or empty. */
  autoCommand?: string;
  /**
   * Effort the agent itself reports it is running at (`resolveReportedEffort`),
   * or null when it reports none, in which case the source falls back to the
   * session record. Resolved by the caller rather than read here so this module
   * needs no SessionManager at runtime and stays unit testable with plain
   * values.
   */
  liveEffort: string | null;
  /**
   * The first level the agent reported after this session launched
   * (`resolveReportedEffort`). Lets `resolveSourceEffort` read a silent
   * downgrade of the level we asked for as already applied. Required with
   * `liveEffort`, so a caller spreads `resolveReportedEffort` rather than
   * passing one and quietly losing the guard.
   */
  firstReportedEffort: string | null;
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
   * Why the caller must restart the session (suspend + `--resume` with the
   * destination's launch flags) instead of keeping it, or null when no restart
   * is needed. `'model'` when the destination has a CONCRETE model different
   * from the session's; otherwise `'effort'` when it has a CONCRETE effort
   * different from the session's. A model change that also changes effort
   * reads `'model'`: the respawn applies every flag either way, and the reason
   * only picks the progress label and log text.
   *
   * When set, the caller must act on it BEFORE scheduling any writes, and must
   * not schedule `sequence`: the respawn delivers the auto_command (or the
   * plan-exit continuation) as its resume prompt. See the rationale at the
   * `restartReason` computation below.
   */
  restartReason: InjectionRestartReason | null;
}

/** Which settings delta forced an `InjectionPlan` restart. */
export type InjectionRestartReason = 'model' | 'effort';

/**
 * The one rule for whether a model/effort delta restarts a task session. Both
 * `prepareInjectionPlan` and the ContextBar handler (`task-runtime-override.ts`)
 * call it, and both read the effort source through `resolveSourceEffort`, so a
 * move, a column edit, and a pick cannot disagree about it.
 *
 * Only a change to a CONCRETE value restarts. A null target means "use the
 * default", and `--resume` keeps whatever the session was running at, so there
 * is no flag to set. Model wins when both change, because the respawn applies
 * every flag either way and the reason only picks the label and log text.
 */
export function resolveRestartReason(input: {
  sourceModel: string | null;
  targetModel: string | null;
  sourceEffort: string | null;
  targetEffort: string | null;
}): InjectionRestartReason | null {
  if (input.targetModel !== null && input.targetModel !== input.sourceModel) return 'model';
  if (input.targetEffort !== null && input.targetEffort !== input.sourceEffort) return 'effort';
  return null;
}

/**
 * The model and effort a task should run at in a lane: the per-task pin, then
 * the lane (already folded through the task's Board Profile), then the
 * project default. The project tier applies only when the task runs the
 * project's default agent, since model and effort ids are adapter-specific.
 *
 * The TARGET side of a settings delta, shared by `prepareInjectionPlan` and
 * the ContextBar pick (`applyTaskSettingsToLiveSession`). It must agree with
 * the respawn's `resolveSpawnOverrides`, or a restart would aim at a value the
 * respawn never passes.
 */
export function resolveTargetSettings(input: {
  task: Pick<Task, 'agent_override' | 'model_override' | 'effort_override'>;
  lane: Pick<Swimlane, 'agent_override' | 'model_override' | 'effort_override'> | null | undefined;
  project: Pick<Project, 'default_agent' | 'default_model' | 'default_effort'> | null | undefined;
}): { targetModel: string | null; targetEffort: string | null } {
  const { task, lane, project } = input;
  const targetAgent = task.agent_override ?? lane?.agent_override ?? project?.default_agent ?? DEFAULT_AGENT;
  const projectDefaultsApply = projectModelDefaultsApply(targetAgent, project?.default_agent);
  return {
    targetModel: task.model_override ?? lane?.model_override
      ?? (projectDefaultsApply ? project?.default_model : null) ?? null,
    targetEffort: task.effort_override ?? lane?.effort_override
      ?? (projectDefaultsApply ? project?.default_effort : null) ?? null,
  };
}

/** The progress label a settings restart shows between its suspend and resume. */
export function restartPhaseFor(reason: InjectionRestartReason): SpawnPhase {
  return reason === 'model' ? 'switching-model' : 'applying-settings';
}

export function prepareInjectionPlan(input: InjectionPlanInput): InjectionPlan | null {
  const { adapter, sessionRepo, task, toLane, autoCommand, project, liveEffort, firstReportedEffort } = input;

  // SOURCE is the model/effort the live session is ACTUALLY running at, NOT the
  // leaving column's config. The leaving column disagrees after an in-flight
  // ContextBar switch or a kangentic.json column-config edit, which is what
  // produced the spurious `/effort` injection this module used to emit. A
  // per-task override still wins: the session was spawned/restarted at the pin,
  // so source = target = pin and that field never forces a restart (preserving
  // the ContextBar contract). When no record exists (unit stubs, a session
  // predating this column) the applied value is null, i.e. "agent default".
  //
  // For EFFORT the source prefers what the agent reports over what we asked for,
  // except where a silent downgrade of the level we asked for counts as applied
  // (`resolveSourceEffort` lists the tiers). The record alone cannot see an
  // `/effort` the user typed into the terminal, so it goes stale: with
  // applied=high, a manual switch to medium, and a destination column requiring
  // high, source and target would both read high, nothing would restart, and the
  // session would silently keep running at medium in a column that requires high.
  //
  // The project-default tier is read on BOTH sides: without it, a task moving
  // between two override-less columns on a project with a default_model set
  // would read source = the applied project default (recorded at the last
  // spawn) vs target = null, and spuriously restart even though nothing
  // actually changed.
  // The live session's own record, not the task's newest, which can belong to
  // an isolated track. The effort guard pairs this record's `applied_effort`
  // with the first level THIS session reported, so both must name one session.
  const record = sessionRepo ? resolveOwnSessionRecord(sessionRepo, task.session_id, task.id) : undefined;
  // MODEL is deliberately NOT sourced from live telemetry. The agent reports a
  // canonical id (`claude-opus-4-8`) while `applied_model` / `model_override` /
  // `default_model` hold whatever flag string the user configured (`opus`), so
  // comparing across those id spaces would read "changed" on almost every move,
  // and `restartReason` below turns that into a suspend + `--resume` PTY
  // restart per column transition. Effort has no such split: both sides draw
  // from the adapter's discovered `effortLevels` vocabulary.
  const { targetModel, targetEffort } = resolveTargetSettings({ task, lane: toLane, project });
  const sourceModel = task.model_override ?? record?.applied_model ?? null;
  const sourceEffort = resolveSourceEffort({
    taskEffortOverride: task.effort_override,
    liveEffort,
    firstReportedEffort,
    appliedEffort: record?.applied_effort,
    targetEffort,
  });

  // A MODEL or EFFORT change on a task session is applied by a full exit +
  // `--resume` with the destination's launch flags, NEVER a live `/model` or
  // `/effort` typed into the PTY:
  //
  // - A live mid-session model switch left the agent paused after a
  //   Planning -> Executing handoff (it stopped instead of continuing).
  // - A live `/effort` cannot be confirmed in the case that uses it most. On a
  //   plan-exit move the agent is mid-turn, a mid-turn `/effort` writes nothing
  //   to Claude's transcript, so the `command-match` verifier never confirmed
  //   it, and its retries pressed bare Enter into the running turn.
  //
  // The restart carries the column message or plan-exit continuation as its
  // resume prompt instead of keystrokes. It cuts an in-flight turn, the same
  // cost a model change already accepted. Measured from transcripts, a
  // same-model `--resume` within about an hour of the previous request reads
  // the conversation back from cache; a resume that also changes `--effort` is
  // expected to behave the same but has not been sampled.
  //
  // Only a CONCRETE destination value restarts, and model wins when both
  // change (see `resolveRestartReason`).
  //
  // A level the model silently downgrades restarts only the first move into a
  // column asking for it (`resolveSourceEffort`, step 2). Removing that one
  // restart needs per-model effort levels, and adapters discover
  // `effortLevels` per agent from `--help`, not per model.
  const restartReason = resolveRestartReason({ sourceModel, targetModel, sourceEffort, targetEffort });

  // The only thing ever typed into a task session's PTY is the auto_command.
  // Settings never are (see above); `adapter.getInjectionSequence` now serves
  // only the Command Terminal, which has no `--resume` to fall back on.
  const sequence: InjectionCommand[] = [];

  const trimmedAutoCommand = autoCommand?.trim() ?? '';
  if (trimmedAutoCommand) {
    // A slash-prefixed auto_command is only verifiable on agents that record
    // slash invocations in their history. Where an adapter declares it cannot
    // (see `canVerifySlashSubmission`), absence from the file is ambiguous
    // between "the CLI rejected it" and "the CLI ran it client-side", so
    // verifying would risk escalating a command that actually worked into a
    // session restart. `none` keeps the outcome `unconfirmed` instead.
    const slashUnverifiable = trimmedAutoCommand.startsWith('/')
      && adapter?.canVerifySlashSubmission?.() === false;
    // A CONFIRM-ONLY verifier (one whose adapter has not proven it end to end
    // in a running app) still confirms and still retries, but must never
    // authorize the restart that escalation performs. See
    // `canEscalateOnVerificationFailure`.
    //
    // Only SET when it is false. The field's contract is "omitted or true means
    // escalatable", so writing `true` explicitly would add a redundant key to
    // every ordinary command for no behavioural difference.
    const command: InjectionCommand = {
      text: trimmedAutoCommand,
      verify: slashUnverifiable ? 'none' : 'submitted',
    };
    if (adapter?.canEscalateOnVerificationFailure?.() === false) {
      command.escalatable = false;
    }
    sequence.push(command);
  }

  // Return null only when there is nothing to do at all: no auto_command AND no
  // restart needed. A settings-only change has an empty sequence but must still
  // return a plan so the caller can act on `restartReason`.
  if (sequence.length === 0 && restartReason === null) return null;

  // Verifier is best-effort: needs adapter support + a captured agent_session_id.
  // null is a documented fallback to time-based settle in
  // TerminalSubmit.submitKeystrokes. Pass the record we already read so the
  // verifier builder does not re-query.
  const verifier = adapter && sessionRepo
    ? buildCommandInjectionVerifier(adapter, sessionRepo, task.id, record)
    : null;

  // Nothing is recorded as applied here. A restart records `applied_model` /
  // `applied_effort` itself, from the launch flags its respawn passes.
  return { sequence, verifier, restartReason };
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
 * Shared between `prepareInjectionPlan` (a column message injected into a live
 * session on a move) and the spawn path's deferred auto_command delivery
 * (`agent-spawn.ts`). Without a shared helper both call sites would
 * re-implement the same record lookup + closure capture, and a fix in one
 * would silently miss the other.
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
  const needsAgentSessionId = adapter.requiresAgentSessionIdForVerification?.() !== false;
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
    //
    // An adapter whose history is keyed by cwd alone (Aider, which has no
    // session id at all) opts out of the id requirement - otherwise its
    // verifier could never confirm, and a verifier that always says no is
    // worse than none: the burst still retries and then reports `failed`
    // where it would previously have stayed silently `unconfirmed`.
    if (!currentCwd) return false;
    if (needsAgentSessionId && !currentAgentSessionId) return false;
    const verifiedInCurrent = await submissionVerifier({
      type: 'command-injection',
      text: command,
      agentSessionId: currentAgentSessionId ?? undefined,
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
