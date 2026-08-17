import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentRegistry } from '../../agent/agent-registry';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { McpHttpServerHandle } from '../../agent/mcp-http-server';
import { appendCallerSession } from '../../agent/mcp-http/caller-url';
import type { AppConfig, BoardProfile, Swimlane, Task } from '../../../shared/types';
import type { TaskRepository } from '../../db/repositories/task-repository';
import { runSpawnPreamble, resolveEffectivePermissionMode, projectModelDefaultsApply } from '../spawn-preamble';
import { applyProfileToLane, findTaskProfile } from '../column-strategy';
import { sessionOutputPaths } from '../session-paths';
import { reconcileResumeAgentSessionId } from '../resume-id-reconcile';
import { isResumeConversationAbsent } from '../resume-conversation-guard';
import type { SessionRepository } from '../../db/repositories/session-repository';
import { resolveExecutionTarget } from '../../agent/shared/execution-target';
import { resolveLaunchOptions } from '../../agent/shared/launch-options';

/**
 * Fully-prepared agent spawn: the adapter has been resolved, the CLI
 * detected, the session directory created, and the command built. The
 * caller hands this to `SessionManager.spawn()` with minimal extra work.
 */
export interface PreparedSpawn {
  adapter: AgentAdapter;
  agent: string;
  command: string;
  cwd: string;
  /** PTY session UUID. Also used as the on-disk session directory name. */
  sessionRecordId: string;
  /** Agent-CLI-side session identifier. Null for agents that don't accept caller-specified IDs (Codex/Gemini). */
  agentSessionId: string | null;
  /** Effective permission mode after lane override + global fallback. */
  permissionMode: string;
  statusOutputPath: string;
  eventsOutputPath: string;
  /**
   * Adapter-specific env vars to merge into the PTY spawn env. Populated
   * from `adapter.buildEnv?.(...)` for adapters that wire MCP via env
   * (OpenCode `OPENCODE_CONFIG_CONTENT`). Null for adapters that wire MCP
   * via CLI flag or settings file.
   */
  extraEnv: Record<string, string> | null;
  /**
   * The model/effort this command actually applies via `--model` / `--effort`
   * (null = agent default, no flag). The caller persists these to the session
   * record's `applied_model` / `applied_effort` so a later column transition
   * diffs against the session's true running value. See `prepareInjectionPlan`.
   */
  appliedModel: string | null;
  appliedEffort: string | null;
}

export type PrepareResult =
  | { ok: true; data: PreparedSpawn }
  | { ok: false; reason: 'unknown-agent' | 'cli-not-found' };

/**
 * Shared pre-flight for both session recovery and reconciliation. This is
 * the STARTUP spawn chokepoint (see .claude/rules/spawn-entry-point-parity.md);
 * board-driven spawns go through `spawnAgent` instead.
 *
 *   1. Run the shared spawn preamble (`runSpawnPreamble`): lock the Advanced
 *      overrides on a first-ever spawn, then resolve which agent adapter
 *      applies (task override → column override → project default).
 *   2. Detect the agent CLI binary (skipped or errored → skip signal).
 *   3. Ensure the CLI trusts the working directory so no trust prompt
 *      blocks the spawn.
 *   4. Resolve the effective permission mode via
 *      `resolveEffectivePermissionMode` (lane 'plan' always wins, else
 *      task → lane → global).
 *   5. Generate a session record UUID (used as the PTY session ID and
 *      the on-disk session directory name).
 *   6. Generate the agent CLI session UUID - only for adapters that
 *      accept a caller-specified value (Claude). Others get null; their
 *      real ID is captured from hooks or PTY output later.
 *   7. Build the agent command line.
 *
 * Resume semantics are delegated to the caller via `resume`: pass
 * `{ agentSessionId }` to produce a `--resume <uuid>` command, or null
 * for a fresh spawn.
 */
export async function prepareAgentSpawn(input: {
  task: Task;
  swimlane: Swimlane | null;
  cwd: string;
  projectId: string;
  projectPath: string;
  effectiveConfig: AppConfig;
  projectDefaultAgent: string | null;
  projectDefaultModel: string | null;
  projectDefaultEffort: string | null;
  resolvedShell: string;
  mcpServerHandle: McpHttpServerHandle | null | undefined;
  /**
   * Non-null → build a resume command with the given agent session ID.
   * `recordId` (the resume-eligible record's id) additionally enables the
   * resume-time id reconcile against that record's own status.json (see
   * resume-id-reconcile.ts); omit it to skip the reconcile. `recordCwd` is
   * that record's own cwd for the reconcile's transcript probe, in case it
   * differs from the spawn `cwd` (falls back to the spawn cwd).
   */
  resume: { agentSessionId: string; recordId?: string; recordCwd?: string } | null;
  /** Persists a reconciled agent session id. Only consulted when `resume.recordId` is set. */
  sessionRepo?: Pick<SessionRepository, 'updateAgentSessionId'>;
  /**
   * Whether any session row exists for the task. First-ever-spawn detection
   * for the override lock: recovery resumes pass `true` (a record is in hand,
   * the lock no-ops by construction); the startup reconcile derives it from
   * the session repository.
   */
  hasSessionRecord: boolean;
  tasks: Pick<TaskRepository, 'update'>;
  /**
   * The board's Board Profiles, so a task riding one resumes under that
   * profile's rung for its current column rather than the column's base
   * settings. Omitted (or empty) means every task runs the columns' own
   * settings, which is the pre-profile behavior.
   */
  boardProfiles?: ReadonlyArray<BoardProfile>;
}): Promise<PrepareResult> {
  const { task, cwd, projectId, projectPath, effectiveConfig: config } = input;

  // Fold the task's profile over its column once, then shadow `swimlane` so
  // every read below (the preamble, permission mode, model/effort) sees the
  // profile-resolved strategy. Startup recovery must agree with the board path
  // here: a task that spawned under a profile and is then resumed after a crash
  // has to come back on the same rung.
  const swimlane = applyProfileToLane(
    input.swimlane,
    findTaskProfile({ profiles: input.boardProfiles, profileId: task.profile_id, taskId: task.id }),
  );

  // The task sits in the lane it is spawning into on the startup paths, so
  // the settings lane and the destination lane are the same lane here: the
  // lane whose inherited values the Edit dialog displays for the task now.
  const { agent } = runSpawnPreamble({
    task,
    hasSessionRecord: input.hasSessionRecord,
    settingsLane: swimlane,
    destinationLane: swimlane,
    project: {
      default_agent: input.projectDefaultAgent,
      default_model: input.projectDefaultModel,
      default_effort: input.projectDefaultEffort,
    },
    globalPermissionMode: () => config.agent.permissionMode,
    tasks: input.tasks,
  });
  const adapter = agentRegistry.get(agent);
  if (!adapter) return { ok: false, reason: 'unknown-agent' };

  // Model/effort ids are adapter-specific, so the project-level default only
  // applies when this spawn actually runs the project's default agent.
  const projectFallback = projectModelDefaultsApply(agent, input.projectDefaultAgent);

  const cliPathOverride = config.agent.cliPaths[agent] ?? null;
  const detection = await adapter.detect(cliPathOverride);
  if (!detection.found || !detection.path) return { ok: false, reason: 'cli-not-found' };

  await adapter.ensureTrust(cwd);

  // "Plan always wins, else task -> lane -> global" - the rule lives in
  // resolveEffectivePermissionMode (spawn-preamble.ts).
  const permissionMode = resolveEffectivePermissionMode(
    task.permission_mode, swimlane?.permission_mode, config.agent.permissionMode,
  );

  let agentSessionId: string | null;
  // Same downgrade the board spawn path applies: a record whose conversation
  // the agent never persisted (session ended before its first turn) must not be
  // recovered with `--resume`, or startup hands the user a dead CLI. Returns
  // false on every uncertainty, so a real conversation is never discarded.
  let canResume = input.resume !== null;
  if (canResume && await isResumeConversationAbsent({
    adapter,
    // Startup recovery holds only the record it is recovering; unlike the board
    // path it has no repository handle to walk the conversation's lineage. A
    // record recovered here ran until the crash, so it normally has its own
    // status report.
    recordIds: [input.resume!.recordId ?? null],
    projectPath,
  })) {
    console.log(
      `[SESSION_RECOVERY] Resume downgraded to fresh for task ${task.id.slice(0, 8)}:`
      + ` agent session ${input.resume!.agentSessionId.slice(0, 8)} never wrote a conversation`,
    );
    canResume = false;
  }
  if (canResume) {
    // Reconcile the resumed id against the retiring record's own status.json:
    // a mid-session fork (Claude /clear) in the final seconds before suspend
    // can leave the DB one id behind. Best-effort; missing file or recordId
    // keeps the stored id unchanged.
    agentSessionId = await reconcileResumeAgentSessionId({
      adapter,
      recordId: input.resume!.recordId ?? null,
      storedAgentSessionId: input.resume!.agentSessionId,
      cwd: input.resume!.recordCwd ?? cwd,
      projectPath,
      sessionRepo: input.sessionRepo,
    });
  } else {
    // Only Claude accepts caller-specified session IDs. Others capture
    // their real ID from hooks / PTY output later and come back here as null.
    agentSessionId = adapter.supportsCallerSessionId ? randomUUID() : null;
  }

  const sessionRecordId = randomUUID();
  const sessionDir = path.join(projectPath, '.kangentic', 'sessions', sessionRecordId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);

  const commandOptions = {
    agentPath: detection.path,
    taskId: task.id,
    prompt: undefined,
    cwd,
    permissionMode,
    projectRoot: projectPath,
    sessionId: agentSessionId ?? undefined,
    resume: canResume,
    statusOutputPath,
    eventsOutputPath,
    shell: input.resolvedShell,
    mcpServerEnabled: config.mcpServer?.enabled ?? true,
    // Carries this session's own id so the MCP server can identify the caller
    // (see appendCallerSession). Stamped, never looked up, so it cannot drift.
    mcpServerUrl: appendCallerSession(input.mcpServerHandle?.urlForProject(projectId), sessionRecordId),
    mcpServerToken: input.mcpServerHandle?.token,
    // Task-level override (set by the ContextBar popover) wins over the
    // swimlane override, which wins over the project-level default - once a
    // user has expressed an explicit per-task preference, it sticks across
    // column moves until they clear it.
    //
    // The project-level tier is gated on the resolved agent, exactly as the
    // board spawn path does (resolveSpawnOverrides) and the column-move
    // injection plan does (prepareInjectionPlan). All three must agree, or a
    // crash-recovery respawn would apply a model the board spawn never did.
    model: task.model_override ?? swimlane?.model_override
      ?? (projectFallback ? input.projectDefaultModel : undefined) ?? undefined,
    effort: task.effort_override ?? swimlane?.effort_override
      ?? (projectFallback ? input.projectDefaultEffort : undefined) ?? undefined,
    executionTarget: resolveExecutionTarget(agent, config.agent.executionServers, config.agent.execution) ?? undefined,
    launchOptions: resolveLaunchOptions(adapter, config.agent.launchOptions),
  };

  const command = adapter.buildCommand(commandOptions);
  const extraEnv = adapter.buildEnv?.(commandOptions) ?? null;

  return {
    ok: true,
    data: {
      adapter,
      agent,
      command,
      cwd,
      sessionRecordId,
      agentSessionId,
      permissionMode,
      statusOutputPath,
      eventsOutputPath,
      extraEnv,
      appliedModel: commandOptions.model ?? null,
      appliedEffort: commandOptions.effort ?? null,
    },
  };
}
