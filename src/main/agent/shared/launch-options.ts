import type { AgentAdapter } from '../agent-adapter';

/**
 * Resolve the fully-defaulted launch-option values threaded through
 * `CommandOptions.launchOptions` for a spawn: the adapter's declared options
 * (`AgentAdapter.launchOptions`) combined with the user's stored overrides
 * (`agent.launchOptions[agentName]`). Shared by both spawn chokepoints
 * (`transition-engine.ts`, `session-startup/prepare-spawn.ts`) per
 * spawn-entry-point-parity.md, so the resolved values are identical regardless of
 * which one spawned.
 *
 * Returns `undefined` when the adapter declares no launch options (every adapter
 * but Codex today) - the command builder then has nothing to read. `configured`
 * is optional-chained throughout: several existing test config builders pass
 * partial `agent` configs, mirroring execution-target.ts's tolerance.
 */
export function resolveLaunchOptions(
  adapter: Pick<AgentAdapter, 'name' | 'launchOptions'>,
  configured: Record<string, Record<string, boolean>> | undefined,
): Record<string, boolean> | undefined {
  if (!adapter.launchOptions || adapter.launchOptions.length === 0) return undefined;

  const stored = configured?.[adapter.name];
  const resolved: Record<string, boolean> = {};
  for (const option of adapter.launchOptions) {
    resolved[option.id] = stored?.[option.id] ?? option.default;
  }
  return resolved;
}
