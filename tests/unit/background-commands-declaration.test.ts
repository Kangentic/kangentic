/**
 * Which agents declare `AgentAdapter.backgroundCommands`, and that each one
 * meets the conditions the declaration stands for (task #859).
 *
 * A declaring agent's background launch holds its session `thinking` until the
 * command exits or the agent marks it a service, and its sessions are offered
 * `kangentic_mark_background_service`. Two conditions are mechanical and
 * checked here:
 *
 * - Its activity is hook-driven (`hooks` or `hooks_and_pty`). For a PTY-driven
 *   agent PTY silence calls `forceIdle`, which clears every shell set, so its
 *   hold would be gone at the next quiet moment.
 * - Its MCP URL is per-session. A folder-shared URL can name another session,
 *   so a mark could land on the wrong one.
 *
 * The list itself is pinned, so a new declaration is a decision someone
 * records in docs/integrations/agents/background-commands.md ("Background commands"), with the
 * captured payloads that back it, and not a flag flipped on its own. The two
 * conditions that need the real CLI (the payloads, and the hold staying while
 * the process runs and releasing when it exits) are the probe's, and are
 * pinned by `background-command-reporting.test.ts` and the replay fixtures.
 */
import { describe, it, expect } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

/** Every declaring agent, with where its starts come from and whether it gets the launch hint. */
const DECLARED: Record<string, { source: 'hooks' | 'session-history'; launchHint: boolean }> = {
  claude: { source: 'hooks', launchHint: true },
  qwen: { source: 'hooks', launchHint: true },
  gemini: { source: 'hooks', launchHint: true },
  copilot: { source: 'hooks', launchHint: true },
  grok: { source: 'hooks', launchHint: false },
  kimi: { source: 'session-history', launchHint: false },
  codex: { source: 'session-history', launchHint: false },
};

describe('background command declarations', () => {
  const adapterNames = agentRegistry.list();

  it('are exactly the agents the decision table names', () => {
    const declared = adapterNames.filter((name) => agentRegistry.getOrThrow(name).backgroundCommands !== undefined).sort();
    expect(declared).toEqual(Object.keys(DECLARED).sort());
  });

  for (const [name, expected] of Object.entries(DECLARED)) {
    describe(name, () => {
      it('declares the source and hint the table records', () => {
        expect(agentRegistry.getOrThrow(name).backgroundCommands).toEqual(expected);
      });

      it('is hook-driven, so PTY silence cannot clear a hold', () => {
        const kind = agentRegistry.getOrThrow(name).runtime.activity.kind;
        expect(['hooks', 'hooks_and_pty']).toContain(kind);
      });

      it('reaches the MCP server with a per-session URL, so a mark lands on its own session', () => {
        expect(agentRegistry.getOrThrow(name).kangenticMcp).toBe('per-session');
      });
    });
  }
});
