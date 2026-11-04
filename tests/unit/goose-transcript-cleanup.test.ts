/**
 * Goose's handoff transcript cleanup (`adapters/goose/transcript-cleanup.ts`).
 *
 * Goose was not installed where this was written, so the scrollback below is
 * assembled from the lines Goose's source prints at 1.57.0
 * (`crates/goose-cli/src/session/output.rs`): the `display_session_info`
 * banner and the `display_context_usage` bar.
 */
import { describe, it, expect } from 'vitest';
import { cleanGooseTranscript } from '../../src/main/agent/adapters/goose/transcript-cleanup';
import { cleanTranscriptForHandoff } from '../../src/main/agent/handoff/transcript-cleanup';

const SCROLLBACK = [
  '  __( O)>  new session · openai · gpt-4o',
  ' \\____)    20261103_4 · /projects/my-app',
  '   L L     goose is ready',
  '',
  'Fix the login redirect',
  '',
  'I found the redirect in src/router.ts and changed it to keep the return path.',
  '',
  '  ━━━━━━━━╌╌╌╌╌╌╌╌╌╌╌╌ 9% 12k/128k',
  '',
  'Anything else?',
  'context usage unavailable (context limit is 0)',
].join('\n');

describe('cleanGooseTranscript', () => {
  it('drops the banner and the context bar and keeps the conversation', () => {
    expect(cleanGooseTranscript(SCROLLBACK)).toBe([
      'Fix the login redirect',
      '',
      'I found the redirect in src/router.ts and changed it to keep the return path.',
      '',
      'Anything else?',
    ].join('\n'));
  });

  it('keeps a line that only mentions goose', () => {
    expect(cleanGooseTranscript('goose is a good name for a bird')).toBe('goose is a good name for a bird');
  });

  it('returns null when nothing but chrome remains', () => {
    expect(cleanGooseTranscript('  __( O)>  resuming · openai · gpt-4o\n   L L     goose is ready\n')).toBeNull();
  });

  it('is what the handoff dispatcher runs for a Goose session', () => {
    expect(cleanTranscriptForHandoff(SCROLLBACK, 'goose')).toBe(cleanGooseTranscript(SCROLLBACK));
  });
});
