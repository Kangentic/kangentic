import type { Project, SessionRecord, Swimlane, Task } from '../../shared/types';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { CommandVerifier } from './terminal-submit-scheduler';

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
 * `terminalSubmitScheduler.scheduleKeystrokes(task.id, sessionId, plan.sequence, { verifier: plan.verifier, verifiedPrefixLength: plan.verifiedPrefixLength })`.
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
}

export interface InjectionPlan {
  sequence: string[];
  verifier: CommandVerifier | null;
  /**
   * Number of leading commands in `sequence` that are safe to verify against
   * the agent's transcript. This covers the deterministic adapter-emitted
   * writes (`/effort Y` from `getInjectionSequence`) but excludes any trailing
   * user-supplied auto_command, because the verifier cannot tell a `/`-prefixed
   * user command from a settings command and would risk dropping the user's
   * intended action after retry exhaustion.
   */
  verifiedPrefixLength: number;
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
  const { adapter, sessionRepo, task, toLane, autoCommand, project } = input;

  // SOURCE is the model/effort the live session is ACTUALLY running at, read
  // from the session record (`applied_model` / `applied_effort`), NOT the
  // leaving column's config. The leaving column disagrees after an in-flight
  // ContextBar switch or a kangentic.json column-config edit, which is what
  // produced the spurious `/effort` injection. A per-task override still wins:
  // the session was spawned/switched to the pin, so source = target = pin and no
  // slash fires for that field (preserving the ContextBar contract). When no
  // record exists (unit stubs, a session predating this column) the applied
  // value is null, i.e. "agent default".
  //
  // The project-default tier is read on BOTH sides: without it, a task moving
  // between two override-less columns on a project with a default_model set
  // would read source = the applied project default (recorded at the last
  // spawn) vs target = null, and spuriously restart/re-inject even though
  // nothing actually changed.
  const record = sessionRepo?.getLatestForTask(task.id) ?? null;
  const sourceModel = task.model_override ?? record?.applied_model ?? null;
  const targetModel = task.model_override ?? toLane?.model_override ?? project?.default_model ?? null;
  const sourceEffort = task.effort_override ?? record?.applied_effort ?? null;
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

  const trimmedAutoCommand = autoCommand?.trim() ?? '';
  const sequence = trimmedAutoCommand
    ? [...settingsSequence, trimmedAutoCommand]
    : settingsSequence;

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
    verifiedPrefixLength: settingsSequence.length,
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
  if (!record?.agent_session_id || !record.cwd) return null;
  const agentSessionId = record.agent_session_id;
  const cwd = record.cwd;
  return async (command: string, sentAt: number) => submissionVerifier({
    type: 'command-injection',
    text: command,
    agentSessionId,
    cwd,
    sentAt,
  });
}
