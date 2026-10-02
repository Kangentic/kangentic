/**
 * Which agent answers a question from the index, and what is still missing.
 *
 * Shared between the renderer (which decides whether a question runs or goes to
 * Settings > Knowledge Graph first) and main (which decides who runs). A disagreement
 * between those two is invisible until someone presses Enter, so the rule lives
 * in one place and is pinned here.
 *
 * The rule is explicit: one global agent and model, chosen in Settings > Knowledge Graph,
 * never inferred from the project or from whichever agent happens to be capable.
 */

import { describe, it, expect } from 'vitest';
import { agentJobChoice, answerSetupGap, codeIndexOn, codeSweepPlan, resolveAnswerAgent, taskSummariesOn } from '../../src/shared/answer-agent';

const takesModel = { streaming: false, search: false, model: true };
const takesNoModel = { streaming: false, search: false, model: false };
const claude = { name: 'claude', displayName: 'Claude Code', found: true, supportsAnswerFromContext: true, answerCapabilities: takesModel };
const codex = { name: 'codex', displayName: 'Codex', found: true, supportsAnswerFromContext: true, answerCapabilities: takesModel };
const modelless = { name: 'modelless', displayName: 'Modelless', found: true, supportsAnswerFromContext: true, answerCapabilities: takesNoModel };
const cannotAnswer = { name: 'aider', displayName: 'Aider', found: true };
const uninstalled = { name: 'droid', displayName: 'Droid', found: false, supportsAnswerFromContext: true, answerCapabilities: takesModel };

describe('resolving the answering agent', () => {
  it('resolves the configured agent', () => {
    expect(resolveAnswerAgent({ agents: [claude, codex], configured: 'codex' })?.name).toBe('codex');
  });

  it('resolves nothing when no agent has been chosen, even with capable agents installed', () => {
    // The old chain fell through to the project's agent and then to any capable
    // one, so a question ran on an agent and model nobody chose.
    expect(resolveAnswerAgent({ agents: [claude, codex], configured: null })).toBeNull();
    expect(resolveAnswerAgent({ agents: [claude, codex] })).toBeNull();
  });

  it('does not substitute another agent for a configured one that cannot answer', () => {
    expect(resolveAnswerAgent({ agents: [cannotAnswer, claude], configured: 'aider' })).toBeNull();
  });

  it('does not substitute another agent for a name that matches none', () => {
    expect(resolveAnswerAgent({ agents: [claude], configured: 'an-agent-that-was-uninstalled' })).toBeNull();
  });

  it('respects requireFound only when the caller asks for it', () => {
    // The renderer has the detection flag and must not treat an agent that is
    // not installed as chosen. Main detects the CLI itself a moment later and
    // reports a precise reason, so it does not re-check against a stale list.
    expect(resolveAnswerAgent({ agents: [uninstalled], configured: 'droid', requireFound: true })).toBeNull();
    expect(resolveAnswerAgent({ agents: [uninstalled], configured: 'droid' })?.name).toBe('droid');
  });
});

describe('the setup gap', () => {
  it('asks for an agent when none is chosen', () => {
    expect(answerSetupGap({ agents: [claude], configured: null, configuredModel: 'haiku' })).toBe('agent');
  });

  it('asks for an agent when the chosen one cannot run', () => {
    expect(answerSetupGap({ agents: [cannotAnswer, claude], configured: 'aider' })).toBe('agent');
    expect(answerSetupGap({ agents: [uninstalled], configured: 'droid', configuredModel: 'x', requireFound: true })).toBe('agent');
  });

  it('asks for a model when the agent takes one and none is chosen', () => {
    // There is no "agent default" to fall back on, for the same reason there is
    // no default agent.
    expect(answerSetupGap({ agents: [claude], configured: 'claude', configuredModel: null })).toBe('model');
    expect(answerSetupGap({ agents: [claude], configured: 'claude', configuredModel: '' })).toBe('model');
  });

  it('needs no model for an agent whose answer run takes none', () => {
    expect(answerSetupGap({ agents: [modelless], configured: 'modelless', configuredModel: null })).toBeNull();
  });

  it('is complete once both are chosen', () => {
    expect(answerSetupGap({ agents: [claude, codex], configured: 'claude', configuredModel: 'haiku' })).toBeNull();
  });
});

describe('one search agent for both jobs', () => {
  const memory = { agent: 'claude', model: 'sonnet', effort: 'max' };

  it('answers and writes summaries with the same agent and model', () => {
    expect(agentJobChoice(memory, 'answer')).toEqual({ agent: 'claude', model: 'sonnet', effort: 'max' });
    expect(agentJobChoice(memory, 'summary')).toMatchObject({ agent: 'claude', model: 'sonnet' });
  });

  it('writes summaries at the recommended effort whatever the chosen one', () => {
    // Measured: summaries at high read the same as at low and took twice as
    // long, so raising effort for a hard question never reaches the summaries.
    // Null resolves to the adapter's recommended level in main.
    expect(agentJobChoice(memory, 'summary').effort).toBeNull();
  });

  it('waits on the same setup gap for both jobs', () => {
    const unset = {};
    expect(answerSetupGap({ agents: [claude], configured: agentJobChoice(unset, 'summary').agent })).toBe('agent');
    expect(answerSetupGap({ agents: [claude], configured: agentJobChoice(unset, 'answer').agent })).toBe('agent');
  });

  it('treats task summaries (summaries) as on unless switched off', () => {
    // On by default: nothing is spent until an agent is chosen, and the
    // switch stays usable while they wait.
    expect(taskSummariesOn(undefined)).toBe(true);
    expect(taskSummariesOn({})).toBe(true);
    expect(taskSummariesOn({ taskSummaries: true })).toBe(true);
    expect(taskSummariesOn({ taskSummaries: false })).toBe(false);
  });

  it('indexes source code by default, once the Knowledge Graph is on and an agent chosen', () => {
    // Only the agent's answers read the code index, so without one the first
    // fill would be half an hour of embedding nothing reads.
    const on = { indexingEnabled: true, enabled: true, agent: 'claude' };
    expect(codeIndexOn(on)).toBe(true);
    expect(codeIndexOn({ ...on, sourceCode: true })).toBe(true);
    expect(codeIndexOn(undefined)).toBe(false);
    expect(codeIndexOn({ ...on, agent: null })).toBe(false);
    expect(codeIndexOn({ ...on, agent: undefined })).toBe(false);
    expect(codeIndexOn({ ...on, enabled: false })).toBe(false);
    expect(codeIndexOn({ ...on, indexingEnabled: false })).toBe(false);
    expect(codeIndexOn({ ...on, sourceCode: false })).toBe(false);
  });

  it('clears the code index only for its own switch, and keeps it while it waits', () => {
    // The first fill is half an hour of embedding, so an off and on again of
    // the Knowledge Graph or its agent must not throw it away.
    const on = { indexingEnabled: true, enabled: true, agent: 'claude' };
    expect(codeSweepPlan(() => on)).toBe('index');
    expect(codeSweepPlan(() => ({ ...on, sourceCode: false }))).toBe('clear');
    expect(codeSweepPlan(() => ({ ...on, enabled: false }))).toBe('keep');
    expect(codeSweepPlan(() => ({ ...on, agent: null }))).toBe('keep');
    expect(codeSweepPlan(() => ({ ...on, indexingEnabled: false }))).toBe('keep');
    expect(codeSweepPlan(() => undefined)).toBe('keep');
    // A config read that throws is not a switch turned off.
    expect(codeSweepPlan(() => {
      throw new Error('config unreadable');
    })).toBe('keep');
  });
});
