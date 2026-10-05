/**
 * `scopesTranscriptReadsByTime` on the real agent adapters, which no
 * behavioral test reaches: every test that exercises
 * `fillEarlierRunResultTokens` and `refineTranscriptToolCounts` stubs the
 * registry with a hand-built adapter that already carries the flag, so nothing
 * else proves the REAL Claude adapter declares it. Without it, the earlier-run
 * Tokens fill never reads a Claude run and the run-end count backfill skips
 * every resumed Claude conversation.
 *
 * Tier: Unit. No mocks: reads the real adapters and the real registry.
 */

import { describe, it, expect } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { GrokAdapter } from '../../src/main/agent/adapters/grok/grok-adapter';
import { AntigravityAdapter } from '../../src/main/agent/adapters/antigravity/antigravity-adapter';

describe('scopesTranscriptReadsByTime on the real adapters', () => {
  // Reverting `readonly scopesTranscriptReadsByTime = true;` in
  // claude-adapter.ts (or flipping it to false) fails every Claude assertion
  // below. Claude's cursor filters calls by timestamp, so a read can be
  // scoped to one run with sinceMs and untilMs.
  it('ClaudeAdapter declares true, a real boolean and not merely a truthy value', () => {
    expect(new ClaudeAdapter().scopesTranscriptReadsByTime).toBe(true);
  });

  it('the registered Claude adapter carries it, and the earlier-run fill can reach its token reader', () => {
    // earlierRunWindows resolves the adapter by the record's session_type and
    // skips it unless it has BOTH transcriptToolResultTokens and the flag.
    const adapter = agentRegistry.getBySessionType('claude_agent');
    expect(adapter, 'claude_agent must resolve to a registered adapter').toBeDefined();
    expect(adapter?.scopesTranscriptReadsByTime).toBe(true);
    expect(typeof adapter?.transcriptToolResultTokens).toBe('function');
  });

  // Grok and Antigravity count tool calls over the whole transcript and ignore
  // sinceMs and untilMs. Declaring the flag on either would let a whole
  // conversation's calls land on one run's record, double counting every
  // earlier run on the track.
  it('GrokAdapter leaves it falsy because its transcriptToolCounts ignores the time bounds', () => {
    expect(new GrokAdapter().scopesTranscriptReadsByTime).toBeFalsy();
  });

  it('AntigravityAdapter leaves it falsy because its transcriptToolCounts ignores the time bounds', () => {
    expect(new AntigravityAdapter().scopesTranscriptReadsByTime).toBeFalsy();
  });

  it('the registered Grok and Antigravity adapters resolve and stay unscoped', () => {
    // Each adapter is asserted defined first so a registry that stopped
    // returning one cannot satisfy toBeFalsy() with undefined.
    const grok = agentRegistry.getBySessionType('grok_agent');
    const antigravity = agentRegistry.getBySessionType('antigravity_agent');
    expect(grok, 'grok_agent must resolve to a registered adapter').toBeDefined();
    expect(antigravity, 'antigravity_agent must resolve to a registered adapter').toBeDefined();
    expect(grok?.scopesTranscriptReadsByTime).toBeFalsy();
    expect(antigravity?.scopesTranscriptReadsByTime).toBeFalsy();
  });
});
