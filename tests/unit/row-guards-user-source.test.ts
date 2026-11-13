/**
 * Row guards for a Text match on the user's message (#1078): which rows need the
 * agent's reply, which need the user's, and how a stored source is read.
 */
import { describe, it, expect } from 'vitest';
import { hasUserTextMatch, needsAgentReply, textMatchSourceOf } from '../../src/main/automations/row-guards';
import { textMatchSourceOf as sharedTextMatchSourceOf } from '../../src/shared/final-line-match';
import type { ColumnAutomation, TextMatchSource } from '../../src/shared/types';

type Row = Pick<ColumnAutomation, 'condition' | 'final_line' | 'trigger' | 'config'> & { text_match_source?: TextMatchSource | null };

function row(overrides: Partial<Row> = {}): Row {
  return { condition: null, final_line: null, trigger: 'turn_end', config: {}, ...overrides };
}

describe('needsAgentReply', () => {
  it('is false for a user-source Text match with no {{agentReply}} in its config', () => {
    expect(needsAgentReply(row({ final_line: 'signed off', text_match_source: 'user' }))).toBe(false);
  });

  it('is true for an agent-source Text match', () => {
    expect(needsAgentReply(row({ final_line: 'Verdict: Ready', text_match_source: 'agent' }))).toBe(true);
  });

  it('is true for a Text match with no source, which reads as the agent\'s', () => {
    expect(needsAgentReply(row({ final_line: 'Verdict: Ready' }))).toBe(true);
  });

  it('is true for a user-source row whose config holds {{agentReply}}', () => {
    expect(needsAgentReply(row({
      final_line: 'signed off',
      text_match_source: 'user',
      config: { message: 'Agent said: {{agentReply}}' },
    }))).toBe(true);
  });
});

describe('hasUserTextMatch', () => {
  it('is true for a turn_end row with a final_line and the user source', () => {
    expect(hasUserTextMatch(row({ final_line: 'signed off', text_match_source: 'user' }))).toBe(true);
  });

  it('is false for the agent source, or none', () => {
    expect(hasUserTextMatch(row({ final_line: 'x', text_match_source: 'agent' }))).toBe(false);
    expect(hasUserTextMatch(row({ final_line: 'x' }))).toBe(false);
    expect(hasUserTextMatch(row({ final_line: 'x', text_match_source: null }))).toBe(false);
  });

  it('is false with no Text match, a blank one, or off a turn end', () => {
    expect(hasUserTextMatch(row({ text_match_source: 'user' }))).toBe(false);
    expect(hasUserTextMatch(row({ final_line: '   ', text_match_source: 'user' }))).toBe(false);
    expect(hasUserTextMatch(row({ final_line: 'x', text_match_source: 'user', trigger: 'enter' }))).toBe(false);
  });
});

describe('textMatchSourceOf', () => {
  it('reads only an exact "user" as the user\'s', () => {
    expect(textMatchSourceOf({ text_match_source: 'user' })).toBe('user');
    expect(textMatchSourceOf({ text_match_source: 'agent' })).toBe('agent');
    expect(textMatchSourceOf({ text_match_source: null })).toBe('agent');
    expect(textMatchSourceOf({})).toBe('agent');
    expect(textMatchSourceOf({ text_match_source: 'USER' as TextMatchSource })).toBe('agent');
    expect(textMatchSourceOf({ text_match_source: ' user' as TextMatchSource })).toBe('agent');
  });

  it('is the shared function, re-exported', () => {
    expect(textMatchSourceOf).toBe(sharedTextMatchSourceOf);
  });
});
