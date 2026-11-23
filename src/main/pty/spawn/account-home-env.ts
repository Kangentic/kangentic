import type { SpawnSessionInput } from '../../../shared/types';
import type { AgentAdapter } from '../../agent/agent-adapter';

/**
 * The account home variables a spawn sets: the adapter's `homeEnvVars` found in its env. A shell's
 * startup files must not replace them, so the typed line sets them again
 * (`buildEnvReassertPrelude`, Sentry DESKTOP-4R). Read off the adapter the session was given, the
 * way `performSpawn` reads its name, so this layer names no agent. `agentParser` is the shared,
 * renderer-safe shape, which does not declare `accounts`, so it is read as the main-side adapter
 * field it is: a rename of `accounts` or `homeEnvVars` fails the typecheck here. Undefined when it
 * sets none: the agent's own login, an agent with no folder accounts, a spawn with no adapter.
 */
export function accountHomeEnvOf(input: Pick<SpawnSessionInput, 'agentParser' | 'env'>): Record<string, string> | undefined {
  const env = input.env;
  if (!input.agentParser || !env) return undefined;
  const accounts = (input.agentParser as typeof input.agentParser & Partial<Pick<AgentAdapter, 'accounts'>>).accounts;
  if (accounts?.kind !== 'folder') return undefined;
  const picked: Record<string, string> = {};
  for (const name of accounts.homeEnvVars) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}
