/**
 * Which agent answers a question from the index, and what is still missing.
 *
 * Shared between the renderer (which decides whether a question runs or goes to
 * Settings > Search first) and main (which decides who runs). A disagreement
 * between those two is invisible until someone presses Enter, so the rule lives
 * in one place and is pinned here.
 *
 * The rule is explicit: one global agent and model, chosen in Settings > Search,
 * never inferred from the project or from whichever agent happens to be capable.
 */

import { describe, it, expect } from 'vitest';
import { answerSetupGap, resolveAnswerAgent } from '../../src/shared/answer-agent';

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
