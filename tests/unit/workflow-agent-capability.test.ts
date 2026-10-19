/**
 * Which agents can be a workflow's own agent. The agent list offers only these in
 * Settings > Workflows, and the workflow agent's start keeps a recorded
 * conversation only on one of these, so both read this one answer.
 *
 * Two things, and read-only launch is not one of them: the agent reaches
 * Kangentic's MCP server with a URL of its own (`kangenticMcp: 'per-session'`),
 * since the plan is saved through the caller-scoped workflow tools; and its
 * conversation can be resumed, by an id Kangentic chose, one the CLI created
 * before launch, or one captured after launch. Read-only is an enhancement the
 * adapter adds where it can.
 */
import { describe, it, expect } from 'vitest';
import { canBeWorkflowAgent } from '../../src/main/agent/shared/workflow-agent-capability';

const createSessionId = async (): Promise<string | null> => 'chat-created';

describe('canBeWorkflowAgent', () => {
  it.each([
    { kangenticMcp: 'per-session', supportsCallerSessionId: true, capturesInteractiveSessionId: undefined, creates: false, expected: true },
    { kangenticMcp: 'per-session', supportsCallerSessionId: false, capturesInteractiveSessionId: true, creates: false, expected: true },
    { kangenticMcp: 'per-session', supportsCallerSessionId: false, capturesInteractiveSessionId: undefined, creates: true, expected: true },
    { kangenticMcp: 'per-session', supportsCallerSessionId: false, capturesInteractiveSessionId: undefined, creates: false, expected: false },
    { kangenticMcp: 'shared-folder', supportsCallerSessionId: true, capturesInteractiveSessionId: true, creates: true, expected: false },
    { kangenticMcp: undefined, supportsCallerSessionId: true, capturesInteractiveSessionId: true, creates: true, expected: false },
  ] as const)(
    'is $expected with MCP $kangenticMcp, a chosen id $supportsCallerSessionId, a captured id $capturesInteractiveSessionId and a created id $creates',
    ({ kangenticMcp, supportsCallerSessionId, capturesInteractiveSessionId, creates, expected }) => {
      const adapter = { kangenticMcp, supportsCallerSessionId, capturesInteractiveSessionId, createSessionId: creates ? createSessionId : undefined };
      expect(canBeWorkflowAgent(adapter)).toBe(expected);
    },
  );

  it('does not ask for read-only launch', () => {
    const adapter = { kangenticMcp: 'per-session' as const, supportsCallerSessionId: true, supportsReadOnlyLaunch: false };
    expect(canBeWorkflowAgent(adapter)).toBe(true);
  });

  // Every adapter in the registry, so a declaration that drifts from the rule's
  // intent shows up here: the agents that wire MCP per session and can resume.
  it('offers the registered agents that reach the MCP server per session and can resume', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const eligible = agentRegistry.list().filter((name) => canBeWorkflowAgent(agentRegistry.getOrThrow(name))).sort();
    expect(eligible).toEqual(['claude', 'codex', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'qwen']);
  });

  // `capturesInteractiveSessionId` is declared, not inferred, and it is what lets
  // an agent without a chosen or created id be a workflow's agent. A declaration
  // with nothing behind it would offer an agent whose conversation is never
  // recorded, so its Resume would silently start over. The capture itself is the
  // adapter's `runtime.sessionId` strategy, which SessionIdManager.init reads off
  // the adapter (the adapter is the agent parser at every spawn site).
  describe('capturesInteractiveSessionId across the registry', () => {
    async function registeredAdapters() {
      const { agentRegistry } = await import('../../src/main/agent/agent-registry');
      return agentRegistry.list().map((name) => agentRegistry.getOrThrow(name));
    }

    it('lists enough adapters, with some capturing, for the checks below to mean something', async () => {
      const adapters = await registeredAdapters();
      expect(adapters.length).toBeGreaterThan(10);
      expect(adapters.filter((adapter) => adapter.capturesInteractiveSessionId === true).length).toBeGreaterThan(0);
    });

    it('gives every adapter that declares it a way to capture the id (hook, output or filesystem)', async () => {
      const adapters = await registeredAdapters();
      const withoutCapturePath = adapters
        .filter((adapter) => adapter.capturesInteractiveSessionId === true)
        .filter((adapter) => {
          const strategy = adapter.runtime.sessionId;
          return !(typeof strategy?.fromHook === 'function'
            || typeof strategy?.fromOutput === 'function'
            || typeof strategy?.fromFilesystem === 'function');
        })
        .map((adapter) => adapter.name);
      expect(withoutCapturePath).toEqual([]);
    });

    // The two are alternatives for finding a conversation's id: Kangentic chooses
    // it at launch, or reads it after. An adapter claiming both has one of the
    // declarations wrong, and canBeWorkflowAgent would accept it for the wrong one.
    it('has no adapter that both takes a chosen id and captures one after launch', async () => {
      const adapters = await registeredAdapters();
      const claimingBoth = adapters
        .filter((adapter) => adapter.supportsCallerSessionId === true && adapter.capturesInteractiveSessionId === true)
        .map((adapter) => adapter.name);
      expect(claimingBoth).toEqual([]);
    });
  });
});
