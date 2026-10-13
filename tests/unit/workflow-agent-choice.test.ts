/**
 * The Workflow agent's one rule (`src/shared/workflow-agent-choice.ts`), read by
 * the Workflows view's pane and main's start alike: nothing starts until an
 * agent that can be a workflow's agent is chosen, with a model when its CLI
 * takes one. There is no fallback to the project's default agent, which is what
 * let a new workflow's agent start on Opus at xhigh while the user had set Haiku
 * at low.
 */
import { describe, it, expect } from 'vitest';
import { workflowAgentChoice, workflowAgentSetupGap } from '../../src/shared/workflow-agent-choice';

const claude = { name: 'claude', found: true, supportsWorkflowAgent: true, capabilities: { supportsModelOverride: true } };
const answerOnly = { name: 'codex', found: true, supportsWorkflowAgent: false, capabilities: { supportsModelOverride: true } };
const uninstalled = { name: 'claude', found: false, supportsWorkflowAgent: true, capabilities: undefined };
const modelless = { name: 'modelless', found: true, supportsWorkflowAgent: true, capabilities: {} };

describe('workflowAgentChoice', () => {
  it('reads the three settings, null when unset', () => {
    expect(workflowAgentChoice(undefined)).toEqual({ agent: null, model: null, effort: null });
    expect(workflowAgentChoice({ agentPrompt: 'custom' })).toEqual({ agent: null, model: null, effort: null });
    expect(workflowAgentChoice({ agent: 'claude', model: 'haiku', effort: 'low' })).toEqual({ agent: 'claude', model: 'haiku', effort: 'low' });
  });
});

describe('workflowAgentSetupGap', () => {
  const complete = { agent: 'claude', model: 'haiku', effort: null };

  it.each([
    { name: 'no agent is chosen', agents: [claude], choice: { agent: null, model: null, effort: null }, gap: 'agent' },
    { name: 'the chosen agent is not in the list', agents: [answerOnly], choice: complete, gap: 'agent' },
    { name: 'the chosen agent cannot be a workflow agent', agents: [answerOnly], choice: { agent: 'codex', model: 'gpt-5', effort: null }, gap: 'agent' },
    { name: 'the chosen agent takes a model and none is chosen', agents: [claude], choice: { agent: 'claude', model: null, effort: 'low' }, gap: 'model' },
  ] as const)('is $gap when $name', ({ agents, choice, gap }) => {
    expect(workflowAgentSetupGap({ agents, choice })).toBe(gap);
  });

  it.each([
    { name: 'agent and model are chosen, with no effort', agents: [claude], choice: complete },
    { name: 'the agent takes no model and none is chosen', agents: [modelless], choice: { agent: 'modelless', model: null, effort: null } },
    // Main detects the CLI right after, and the pane shows that reason, so a
    // chosen agent that is not installed is not asked for again.
    { name: 'the chosen agent is not installed', agents: [uninstalled], choice: complete },
  ])('is complete when $name', ({ agents, choice }) => {
    expect(workflowAgentSetupGap({ agents, choice })).toBeNull();
  });
});
