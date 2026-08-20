/**
 * Which agent answers a question from the index.
 *
 * Shared between the renderer (which decides whether to offer Ask and whose name
 * to print) and main (which decides who runs). A disagreement between those two
 * is invisible until someone presses the button, so the chain lives in one place
 * and is pinned here.
 */

import { describe, it, expect } from 'vitest';
import { resolveAnswerAgent } from '../../src/shared/answer-agent';

const claude = { name: 'claude', displayName: 'Claude Code', found: true, supportsAnswerFromContext: true };
const codex = { name: 'codex', displayName: 'Codex', found: true, supportsAnswerFromContext: true };
const aider = { name: 'aider', displayName: 'Aider', found: true };
const uninstalled = { name: 'droid', displayName: 'Droid', found: false, supportsAnswerFromContext: true };

describe('resolving the answering agent', () => {
  it('prefers the configured agent over the project default', () => {
    // Which agent RUNS your tasks and which READS their history are different
    // choices, which is the whole reason the setting exists.
    const resolved = resolveAnswerAgent({
      agents: [claude, codex],
      configured: 'codex',
      projectAgent: 'claude',
    });
    expect(resolved?.name).toBe('codex');
  });

  it('follows the project when nothing is configured', () => {
    const resolved = resolveAnswerAgent({
      agents: [claude, codex],
      configured: null,
      projectAgent: 'codex',
    });
    expect(resolved?.name).toBe('codex');
  });

  it('falls through to any capable agent when the project names one that is not', () => {
    // A named fallback beats no affordance, and the caller prints the name it
    // resolved, so this is stated rather than silent.
    const resolved = resolveAnswerAgent({
      agents: [aider, claude],
      projectAgent: 'aider',
    });
    expect(resolved?.name).toBe('claude');
  });

  it('ignores a configured agent that cannot answer, rather than failing', () => {
    // A stale setting - the agent lost the capability, or the name was never
    // valid - must not disable Ask for someone who never touched it since.
    const resolved = resolveAnswerAgent({
      agents: [aider, claude],
      configured: 'aider',
      projectAgent: 'aider',
    });
    expect(resolved?.name).toBe('claude');
  });

  it('ignores a name that matches no installed agent', () => {
    const resolved = resolveAnswerAgent({
      agents: [claude],
      configured: 'an-agent-that-was-uninstalled',
    });
    expect(resolved?.name).toBe('claude');
  });

  it('returns nothing when no agent can answer', () => {
    expect(resolveAnswerAgent({ agents: [aider], projectAgent: 'aider' })).toBeNull();
    expect(resolveAnswerAgent({ agents: [] })).toBeNull();
  });

  it('respects requireFound only when the caller asks for it', () => {
    // The renderer has the detection flag and must not offer Ask for an agent
    // that is not installed. Main detects the CLI itself a moment later and
    // reports a precise reason, so it does not re-check against a stale list.
    expect(resolveAnswerAgent({ agents: [uninstalled], requireFound: true })).toBeNull();
    expect(resolveAnswerAgent({ agents: [uninstalled] })?.name).toBe('droid');
  });

  it('skips an uninstalled configured agent for the renderer', () => {
    const resolved = resolveAnswerAgent({
      agents: [uninstalled, claude],
      configured: 'droid',
      requireFound: true,
    });
    expect(resolved?.name).toBe('claude');
  });
});
