import { describe, it, expect } from 'vitest';

/**
 * The "CLI CLI" stutter guard.
 *
 * Six of the registered adapters already end their displayName with "CLI"
 * (Codex CLI, Cursor CLI, GitHub Copilot CLI, Gemini CLI, Antigravity CLI,
 * Oz CLI). Three call sites used to append the word again, producing
 * "Codex CLI CLI not found on PATH" - which also fragmented the error-reporting
 * issue per agent, since the message interpolates the display name.
 *
 * The fix is that one function builds the sentence, so this walks EVERY
 * registered adapter through it. That is what makes the guard self-maintaining:
 * a new adapter whose displayName ends in "CLI" is covered the moment it is
 * registered, with no list here to update.
 */

import { agentRegistry } from '../../src/main/agent/agent-registry';
import {
  agentCliNotFoundMessage,
  AgentCliNotFoundError,
} from '../../src/main/agent/shared/agent-cli-not-found';
import { isUserConfigurationError } from '../../src/shared/user-configuration-error';

function everyAdapter() {
  return agentRegistry.list().map((name) => agentRegistry.getOrThrow(name));
}

describe('agentCliNotFoundMessage', () => {
  it('registers the adapters this guard assumes exist', () => {
    // Guards against the walk passing vacuously if the registry import ever
    // stops pre-registering, which would make every assertion below a no-op.
    const displayNames = everyAdapter().map((adapter) => adapter.displayName);
    expect(displayNames.length).toBeGreaterThanOrEqual(14);
    expect(displayNames).toContain('Codex CLI');
    expect(displayNames).toContain('Claude Code');
  });

  it('never doubles the word CLI, for any registered adapter', () => {
    for (const adapter of everyAdapter()) {
      const message = agentCliNotFoundMessage(adapter.displayName);
      expect(message, `adapter ${adapter.name}`).not.toMatch(/CLI CLI/i);
    }
  });

  it('opens by naming the adapter exactly as its displayName reads', () => {
    for (const adapter of everyAdapter()) {
      const message = agentCliNotFoundMessage(adapter.displayName);
      expect(message, `adapter ${adapter.name}`).toMatch(
        new RegExp(`^${adapter.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} not found on PATH\\.`),
      );
    }
  });

  it('points the user at the CLI path override', () => {
    // The whole reason this is surfaced in-app instead of reported as a bug:
    // the user can fix it, and the message has to say where.
    expect(agentCliNotFoundMessage('Codex CLI')).toContain('Settings > Agent');
  });

  it('reads correctly for an adapter that does not end in CLI', () => {
    expect(agentCliNotFoundMessage('Claude Code')).toBe(
      'Claude Code not found on PATH. Install it, or set its path in Settings > Agent.',
    );
  });

  it('reads correctly for an adapter that does end in CLI', () => {
    expect(agentCliNotFoundMessage('Codex CLI')).toBe(
      'Codex CLI not found on PATH. Install it, or set its path in Settings > Agent.',
    );
  });
});

describe('AgentCliNotFoundError', () => {
  it('carries the shared message verbatim', () => {
    const error = new AgentCliNotFoundError('codex', 'Codex CLI');
    expect(error.message).toBe(agentCliNotFoundMessage('Codex CLI'));
  });

  it('keeps the agent name and display name for callers that need them', () => {
    const error = new AgentCliNotFoundError('codex', 'Codex CLI');
    expect(error.agentName).toBe('codex');
    expect(error.displayName).toBe('Codex CLI');
    expect(error.name).toBe('AgentCliNotFoundError');
  });

  it('is a user-configuration error, so error reporting skips it', () => {
    // This is what keeps a missing CLI out of the issue stream. If the class
    // ever stops extending UserConfigurationError, reportHandledError starts
    // forwarding it again and the un-actionable issue returns.
    expect(isUserConfigurationError(new AgentCliNotFoundError('codex', 'Codex CLI'))).toBe(true);
  });

  it('is still an Error, so existing catch sites are unaffected', () => {
    expect(new AgentCliNotFoundError('codex', 'Codex CLI')).toBeInstanceOf(Error);
  });
});
