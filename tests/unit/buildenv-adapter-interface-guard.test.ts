/**
 * Interface-contract guard: only OpenCode should implement AgentAdapter.buildEnv.
 *
 * Every other adapter wires MCP via a CLI flag (Claude: --mcp-config) or a
 * settings file (Codex/Gemini: hooks injection). Adding buildEnv to those
 * adapters by mistake would silently double-inject MCP config. This test
 * catches that regression immediately by iterating all registered adapters.
 *
 * If a new adapter legitimately needs buildEnv, add its name to ADAPTERS_WITH_BUILDENV
 * below and document why.
 */

import { describe, it, expect } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

/**
 * Exhaustive list of adapter names that are EXPECTED to implement buildEnv.
 * Currently only OpenCode delivers MCP config via an env var because it has
 * no --mcp-config CLI flag and no shared settings-file hook system.
 */
const ADAPTERS_WITH_BUILDENV: ReadonlySet<string> = new Set(['opencode']);

describe('AgentAdapter.buildEnv interface guard', () => {
  it('only opencode implements buildEnv - all other adapters must not have it', () => {
    const allAdapterNames = agentRegistry.list();

    // Sanity: the registry must have at least one adapter registered.
    expect(allAdapterNames.length).toBeGreaterThan(0);

    const unexpectedAdapters: string[] = [];
    const missingExpectedAdapters: string[] = [];

    for (const adapterName of allAdapterNames) {
      const adapter = agentRegistry.get(adapterName)!;
      const hasBuildEnv = typeof adapter.buildEnv === 'function';

      if (hasBuildEnv && !ADAPTERS_WITH_BUILDENV.has(adapterName)) {
        unexpectedAdapters.push(adapterName);
      }
      if (!hasBuildEnv && ADAPTERS_WITH_BUILDENV.has(adapterName)) {
        missingExpectedAdapters.push(adapterName);
      }
    }

    if (unexpectedAdapters.length > 0) {
      throw new Error(
        `Unexpected adapters with buildEnv: ${unexpectedAdapters.join(', ')}. `
        + `If this adapter intentionally delivers MCP via env var, add it to ADAPTERS_WITH_BUILDENV in this test.`,
      );
    }

    if (missingExpectedAdapters.length > 0) {
      throw new Error(
        `Expected adapters are missing buildEnv: ${missingExpectedAdapters.join(', ')}. `
        + `These adapters are listed in ADAPTERS_WITH_BUILDENV but do not implement the method.`,
      );
    }
  });

  it('opencode.buildEnv is callable', () => {
    const opencodeAdapter = agentRegistry.get('opencode');
    expect(opencodeAdapter).toBeDefined();
    expect(typeof opencodeAdapter?.buildEnv).toBe('function');
  });

  it('all non-opencode adapters have buildEnv === undefined', () => {
    const allAdapterNames = agentRegistry.list();
    const nonOpenCodeNames = allAdapterNames.filter((adapterName) => adapterName !== 'opencode');

    for (const adapterName of nonOpenCodeNames) {
      const adapter = agentRegistry.get(adapterName)!;
      expect(
        adapter.buildEnv,
        `Adapter "${adapterName}" unexpectedly implements buildEnv - MCP for this adapter should use --mcp-config or settings-file injection, not env vars`,
      ).toBeUndefined();
    }
  });
});
