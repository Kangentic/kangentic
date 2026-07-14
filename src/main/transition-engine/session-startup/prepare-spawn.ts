import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentRegistry } from '../../agent/agent-registry';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { McpHttpServerHandle } from '../../agent/mcp-http-server';
import type { AppConfig, Swimlane, Task } from '../../../shared/types';
import type { TaskRepository } from '../../db/repositories/task-repository';
import { runSpawnPreamble, resolveEffectivePermissionMode } from '../spawn-preamble';
import { sessionOutputPaths } from '../session-paths';

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
  /** Non-null → build a resume command with the given agent session ID. */
  resume: { agentSessionId: string } | null;
  /**
   * Whether any session row exists for the task. First-ever-spawn detection
   * for the override lock: recovery resumes pass `true` (a record is in hand,
   * the lock no-ops by construction); the startup reconcile derives it from
   * the session repository.
   */
  hasSessionRecord: boolean;
  tasks: Pick<TaskRepository, 'update'>;
}): Promise<PrepareResult> {
  const { task, swimlane, cwd, projectId, projectPath, effectiveConfig: config } = input;

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
  const canResume = input.resume !== null;
  if (canResume) {
    agentSessionId = input.resume!.agentSessionId;
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
    mcpServerUrl: input.mcpServerHandle?.urlForProject(projectId),
    mcpServerToken: input.mcpServerHandle?.token,
    // Task-level override (set by the ContextBar popover) wins over the
    // swimlane override, which wins over the project-level default - once a
    // user has expressed an explicit per-task preference, it sticks across
    // column moves until they clear it.
    model: task.model_override ?? swimlane?.model_override ?? input.projectDefaultModel ?? undefined,
    effort: task.effort_override ?? swimlane?.effort_override ?? input.projectDefaultEffort ?? undefined,
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
