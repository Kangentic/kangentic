import type { AgentExecutionServer, AgentProjectExecution, ResolvedExecutionTarget } from '../../../shared/types';

/**
 * Resolve the flattened value threaded through `CommandOptions.executionTarget`
 * for a spawn: the global server identity (`agent.executionServers[agentName]`)
 * combined with this project's usage of it (`agent.execution[agentName]`).
 * Shared by both spawn chokepoints (`transition-engine.ts`,
 * `session-startup/prepare-spawn.ts`) per spawn-entry-point-parity.md, so the
 * local/remote decision is made identically regardless of which one spawned.
 *
 * Returns `null` when the project's mode for this agent is 'local' or unset
 * (the common case - every other adapter, and OpenCode projects that have not
 * opted in). Throws when the mode is 'remote' but no server URL is
 * configured, rather than silently falling back to a local spawn: the
 * worktree for this task was already skipped upstream
 * (`ensureTaskWorktree`/`task-git.ts`) on the assumption that remote mode is
 * genuinely in effect, so a silent local fallback here would run the agent
 * unisolated in the project root instead of a worktree.
 */
export function resolveExecutionTarget(
  agentName: string,
  executionServers: Record<string, AgentExecutionServer> | undefined,
  execution: Record<string, AgentProjectExecution> | undefined,
): ResolvedExecutionTarget | null {
  // Both maps are optional at runtime even though `AppConfig` declares them
  // required: a caller may hold a config snapshot taken before
  // `deepMergeConfig(DEFAULT_CONFIG, ...)` seeded them (production always
  // merges, but partial fixtures and future direct callers may not). A
  // missing map means "no project has opted into remote", which is exactly
  // the local case, so degrade to local rather than throwing on every spawn.
  const projectUsage = execution?.[agentName];
  if (!projectUsage || projectUsage.mode !== 'remote') return null;

  const server = executionServers?.[agentName];
  if (!server?.url) {
    throw new Error(
      `${agentName} is set to remote execution for this project, but no server URL is configured. `
      + 'Set one in Settings -> Agent.',
    );
  }

  return {
    url: server.url,
    auth: server.auth,
    workingDirectory: projectUsage.workingDirectory,
  };
}
