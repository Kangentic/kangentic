/**
 * Unit test for toTranscriptEntryWire's `kind: 'system'` subtype mapping
 * (src/main/mobile-bridge/handlers/wire-mappers.ts).
 *
 * `TranscriptSystemSubtypeWire` (`@kangentic/protocol`) deliberately stays at
 * four members and does NOT widen to include desktop-only 'truncated' - a
 * phone's `isTranscriptEntryWire` validator still whitelists only the four
 * original members, so an un-downgraded 'truncated' entry would be REJECTED
 * by every already-shipped mobile build. `toTranscriptEntryWire`'s single
 * ternary (`entry.subtype === 'truncated' ? 'session_boundary' : entry.subtype`)
 * is the only thing preventing that. This pins the downgrade, that a genuine
 * 'session_boundary' entry is NOT altered by the same ternary (so the first
 * case is a real downgrade assertion, not an identity assertion that happens
 * to match), and that the other two subtypes pass through unchanged.
 */
import { describe, it, expect } from 'vitest';
import { toTranscriptEntryWire } from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import type { TranscriptEntry } from '../../../src/shared/types';

describe('toTranscriptEntryWire system subtype mapping', () => {
  it("downgrades a 'truncated' system entry to 'session_boundary', passing text through unchanged", () => {
    const entry: TranscriptEntry = {
      kind: 'system',
      uuid: 'kangentic-truncated:127894620',
      ts: 1700000000000,
      subtype: 'truncated',
      text: 'Earlier 121.9 MB of this conversation are not shown (the transcript is 137.9 MB). Search still covers the full history.',
    };

    const wire = toTranscriptEntryWire(entry);

    expect(wire).toEqual({
      kind: 'system',
      uuid: 'kangentic-truncated:127894620',
      ts: 1700000000000,
      subtype: 'session_boundary',
      text: 'Earlier 121.9 MB of this conversation are not shown (the transcript is 137.9 MB). Search still covers the full history.',
    });
  });

  it("leaves a genuine 'session_boundary' entry unchanged (the ternary's else branch)", () => {
    const entry: TranscriptEntry = {
      kind: 'system',
      uuid: 'session-boundary-session-2-u1',
      ts: 1700000000001,
      subtype: 'session_boundary',
      text: 'New session',
    };

    const wire = toTranscriptEntryWire(entry);

    expect(wire).toEqual({
      kind: 'system',
      uuid: 'session-boundary-session-2-u1',
      ts: 1700000000001,
      subtype: 'session_boundary',
      text: 'New session',
    });
  });

  it("passes 'compaction' and 'command_output' subtypes through unchanged (the ternary must not over-broaden)", () => {
    const compaction: TranscriptEntry = {
      kind: 'system',
      uuid: 's-compaction',
      ts: 1700000000002,
      subtype: 'compaction',
      text: 'Conversation compacted (auto, 1000 tokens before compaction)',
    };
    const commandOutput: TranscriptEntry = {
      kind: 'system',
      uuid: 's-command-output',
      ts: 1700000000003,
      subtype: 'command_output',
      text: 'Goodbye!',
    };

    expect(toTranscriptEntryWire(compaction)).toMatchObject({ subtype: 'compaction' });
    expect(toTranscriptEntryWire(commandOutput)).toMatchObject({ subtype: 'command_output' });
  });
});
