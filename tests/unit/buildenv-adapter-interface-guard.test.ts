/**
 * Interface-contract guard: only the adapters that genuinely need it should
 * implement AgentAdapter.buildEnv.
 *
 * Three adapters do, for different reasons. OpenCode delivers its ENTIRE MCP
 * config via OPENCODE_CONFIG_CONTENT because its CLI has no MCP flag at all.
 * Codex delivers only the TOKEN via KANGENTIC_MCP_TOKEN, paired with a
 * `-c mcp_servers.kangentic.env_http_headers` override in the command, so the
 * secret never appears in argv (argv is echoed into terminal scrollback).
 * Droid also delivers only the token: its project `.factory/mcp.json` holds
 * the literal `${KANGENTIC_MCP_TOKEN}`, which Droid expands at connect time,
 * keeping the secret out of a file that lives inside the user's repo.
 * Grok goes one further than Droid: its project `.grok/config.toml` block is
 * fully static (`${KANGENTIC_MCP_URL}` AND `${KANGENTIC_MCP_TOKEN}` are both
 * env references grok expands at load time), and the same env channel also
 * carries KANGENTIC_EVENTS_PATH for the hook bridge's `env:` sentinel - so
 * neither the per-session URL, the token, nor the events path reaches disk.
 * Every other adapter passes its MCP config by flag or settings file, and
 * adding buildEnv to one of those by mistake would silently double-inject.
 * This test catches that regression by iterating all registered adapters.
 *
 * If a new adapter legitimately needs buildEnv, add its name to
 * ADAPTERS_WITH_BUILDENV below and document why.
 */

import { describe, it, expect } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

/**
 * Exhaustive list of adapter names that are EXPECTED to implement buildEnv.
 * See the file docstring for why each one is here.
 */
const ADAPTERS_WITH_BUILDENV: ReadonlySet<string> = new Set(['opencode', 'codex', 'droid', 'grok']);

describe('AgentAdapter.buildEnv interface guard', () => {
  it('exactly the adapters in ADAPTERS_WITH_BUILDENV implement buildEnv', () => {
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
        + `If this adapter intentionally delivers MCP config or its token via env var, add it to ADAPTERS_WITH_BUILDENV in this test.`,
      );
    }

    if (missingExpectedAdapters.length > 0) {
      throw new Error(
        `Expected adapters are missing buildEnv: ${missingExpectedAdapters.join(', ')}. `
        + `These adapters are listed in ADAPTERS_WITH_BUILDENV but do not implement the method.`,
      );
    }
  });

  it('every adapter in ADAPTERS_WITH_BUILDENV exposes a callable buildEnv', () => {
    for (const adapterName of ADAPTERS_WITH_BUILDENV) {
      const adapter = agentRegistry.get(adapterName);
      expect(adapter, `Adapter "${adapterName}" is not registered`).toBeDefined();
      expect(typeof adapter?.buildEnv).toBe('function');
    }
  });

  it('every adapter outside ADAPTERS_WITH_BUILDENV has buildEnv === undefined', () => {
    const allAdapterNames = agentRegistry.list();
    const otherNames = allAdapterNames.filter(
      (adapterName) => !ADAPTERS_WITH_BUILDENV.has(adapterName),
    );

    for (const adapterName of otherNames) {
      const adapter = agentRegistry.get(adapterName)!;
      expect(
        adapter.buildEnv,
        `Adapter "${adapterName}" unexpectedly implements buildEnv - MCP for this adapter should use flag or settings-file injection, not env vars`,
      ).toBeUndefined();
    }
  });
});
