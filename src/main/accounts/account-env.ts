import type { AgentAdapter, SpawnCommandOptions } from '../agent/agent-adapter';

/**
 * A session's extra env: the adapter's own (`buildEnv`), then the account's (the CLI's home
 * variable, or a key file's keys). Every spawn chokepoint calls this instead of `buildEnv`
 * directly, so the account always reaches the PTY and adapters only declare, never build, it.
 * Null when neither sets anything, exactly as before accounts.
 */
export function buildSessionEnv(adapter: AgentAdapter, options: SpawnCommandOptions): Record<string, string> | null {
  const adapterEnv = adapter.buildEnv?.(options) ?? null;
  const accountEnv = options.account?.env;
  if (!accountEnv || Object.keys(accountEnv).length === 0) return adapterEnv;
  return { ...(adapterEnv ?? {}), ...accountEnv };
}
