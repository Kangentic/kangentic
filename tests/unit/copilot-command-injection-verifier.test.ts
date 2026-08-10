/**
 * Tests for Copilot's `command-injection` verifier.
 *
 * Copilot's adapter used to declare "no history file". It has one -
 * `~/.copilot/command-history-state.json` - and it is the FASTEST of any
 * adapter: measured 36-38ms, dead flat against turns of 3s, 12s, 23s and 32s
 * (`scripts/measure-injection-flush.mjs`, 2026-08-09). Slash commands are
 * recorded too, unlike Codex and OpenCode.
 *
 * It is not a transcript though, and every guard below exists because of one of
 * its differences: GLOBAL across all sessions and projects, NEWEST FIRST, no
 * timestamps, no session id, rewritten in place.
 */
import { describe, it, expect } from 'vitest';
import { readRecentCopilotCommands } from '../../src/main/agent/adapters/copilot/command-injection-verifier';

/** The real on-disk shape, newest first (verified against live probe data). */
function historyFile(commands: string[]): string {
  return JSON.stringify({ commandHistory: commands });
}

describe('readRecentCopilotCommands', () => {
  it('returns entries newest-first, as Copilot writes them', () => {
    // Verified empirically: after submitting short, then long, then slash
    // probes, index 0 held the SLASH probe - the most recent.
    const recent = readRecentCopilotCommands(historyFile(['newest', 'middle', 'oldest']));
    expect(recent).toEqual(['newest', 'middle', 'oldest']);
  });

  it('caps how far back a match may come from', () => {
    const many = Array.from({ length: 20 }, (_, index) => `command-${index}`);
    const recent = readRecentCopilotCommands(historyFile(many));
    expect(recent).toHaveLength(5);
    expect(recent?.[0]).toBe('command-0');
  });

  it('survives a partial write mid-flush', () => {
    // The file is rewritten in place, so a poll can catch it half-written.
    expect(readRecentCopilotCommands('{"commandHistory": ["a", "b"')).toBeNull();
    expect(readRecentCopilotCommands('')).toBeNull();
  });

  it('returns null when the shape is not what we expect', () => {
    expect(readRecentCopilotCommands('{}')).toBeNull();
    expect(readRecentCopilotCommands('{"commandHistory": "not-an-array"}')).toBeNull();
    expect(readRecentCopilotCommands('[]')).toBeNull();
  });

  it('drops non-string entries rather than throwing on them', () => {
    const raw = JSON.stringify({ commandHistory: ['ok', 42, null, 'also-ok'] });
    expect(readRecentCopilotCommands(raw)).toEqual(['ok', 'also-ok']);
  });
});

describe('exactness', () => {
  // The verifier compares `entry.trim() === text.trim()` over these entries.
  // These cases pin the property that comparison must preserve.
  it('a containing entry is NOT the command', () => {
    const recent = readRecentCopilotCommands(historyFile(['instead can we/pull-request']))!;
    const expected = '/pull-request';
    // The swallowed-Enter bug verbatim: a substring test would confirm exactly
    // the failure the verifier exists to catch.
    expect(recent.some((entry) => entry.trim() === expected)).toBe(false);
    expect(recent.some((entry) => entry.includes(expected))).toBe(true);
  });

  it('an exact entry among the newest few IS the command', () => {
    // Not always index 0: the file is global, so a concurrent injection from
    // another task can push ours down. Matching a few leading entries biases
    // the residual error toward a harmless false positive rather than a false
    // negative, which would escalate into a session restart.
    const recent = readRecentCopilotCommands(historyFile([
      'another task command',
      '/pull-request',
      'older thing',
    ]))!;
    expect(recent.some((entry) => entry.trim() === '/pull-request')).toBe(true);
  });
});
