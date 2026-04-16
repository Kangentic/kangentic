import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentRegistry } from '../../agent/agent-registry';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { McpHttpServerHandle } from '../../agent/mcp-http-server';
import type { AppConfig, PermissionMode, Swimlane, Task } from '../../../shared/types';
import { resolveTargetAgent } from '../agent-resolver';
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
}

export type PrepareResult =
  | { ok: true; data: PreparedSpawn }
  | { ok: false; reason: 'unknown-agent' | 'cli-not-found' };

/**
 * Shared pre-flight for both session recovery and reconciliation.
 *
 *   1. Resolve which agent adapter applies (column override → task hint
 *      → project default).
 *   2. Detect the agent CLI binary (skipped or errored → skip signal).
 *   3. Ensure the CLI trusts the working directory so no trust prompt
 *      blocks the spawn.
 *   4. Resolve the effective permission mode (lane → global).
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
  resolvedShell: string;
  mcpServerHandle: McpHttpServerHandle | null | undefined;
  /** Non-null → build a resume command with the given agent session ID. */
  resume: { agentSessionId: string } | null;
}): Promise<PrepareResult> {
  const { task, swimlane, cwd, projectId, projectPath, effectiveConfig: config } = input;

  const { agent } = resolveTargetAgent({
    columnAgent: swimlane?.agent_override ?? null,
    taskAgent: task.agent,
    projectDefaultAgent: input.projectDefaultAgent,
  });
  const adapter = agentRegistry.get(agent);
  if (!adapter) return { ok: false, reason: 'unknown-agent' };

  const cliPathOverride = config.agent.cliPaths[agent] ?? null;
  const detection = await adapter.detect(cliPathOverride);
  if (!detection.found || !detection.path) return { ok: false, reason: 'cli-not-found' };

  await adapter.ensureTrust(cwd);

  const permissionMode = swimlane?.permission_mode ?? config.agent.permissionMode;

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

  const command = adapter.buildCommand({
    agentPath: detection.path,
    taskId: task.id,
    prompt: undefined,
    cwd,
    permissionMode: permissionMode as PermissionMode,
    projectRoot: projectPath,
    sessionId: agentSessionId ?? undefined,
    resume: canResume,
    statusOutputPath,
    eventsOutputPath,
    shell: input.resolvedShell,
    mcpServerEnabled: config.mcpServer?.enabled ?? true,
    mcpServerUrl: input.mcpServerHandle?.urlForProject(projectId),
    mcpServerToken: input.mcpServerHandle?.token,
  });

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
    },
  };
}
