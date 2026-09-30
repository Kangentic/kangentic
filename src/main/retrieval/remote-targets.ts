import type { AgentAdapter } from '../agent/agent-adapter';
import type { ResolvedExecutionTarget } from '../../shared/types';

/**
 * The remote execution servers main's adapters learned at spawn, for the
 * retrieval worker's own copies of those adapters (see
 * `AgentAdapter.remoteExecution.knownTargets`). Sent with every index job, so
 * a remote session's transcript is read from its server in the worker as it
 * was on main. Empty for every adapter without remote execution.
 */
export type RemoteTargets = Array<{ adapter: string; targets: Array<[string, ResolvedExecutionTarget]> }>;

interface AdapterRegistry {
  list(): string[];
  get(name: string): AgentAdapter | undefined;
}

/** What main's adapters know, to send. */
export function collectRemoteTargets(registry: AdapterRegistry): RemoteTargets {
  const collected: RemoteTargets = [];
  for (const name of registry.list()) {
    const targets = registry.get(name)?.remoteExecution?.knownTargets?.();
    if (targets && targets.length > 0) collected.push({ adapter: name, targets });
  }
  return collected;
}

/** Hand what main sent to the worker's adapters. An adapter main sent
 *  nothing for is told it knows none. */
export function adoptRemoteTargets(registry: AdapterRegistry, remoteTargets: RemoteTargets): void {
  const byAdapter = new Map(remoteTargets.map((entry) => [entry.adapter, entry.targets]));
  for (const name of registry.list()) {
    registry.get(name)?.remoteExecution?.adoptTargets?.(byAdapter.get(name) ?? []);
  }
}
