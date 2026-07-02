import { describe, it, expect } from 'vitest';
import {
  parseModelFromClaudeCommand,
  humanizeClaudeModelId,
  configuredModelFromClaudeCommand,
} from '../../src/main/agent/adapters/claude/model-display-name';

describe('parseModelFromClaudeCommand', () => {
  it('extracts an unquoted model id from a built command', () => {
    const command = '& "C:/claude.cmd" --settings "x.json" --model claude-opus-4-8 --effort xhigh';
    expect(parseModelFromClaudeCommand(command)).toBe('claude-opus-4-8');
  });

  it('extracts a quoted model id (bracketed variant gets quoted by quoteArg)', () => {
    expect(parseModelFromClaudeCommand('claude --model "claude-opus-4-8[1m]"')).toBe('claude-opus-4-8[1m]');
    expect(parseModelFromClaudeCommand("claude --model 'claude-fable-5'")).toBe('claude-fable-5');
  });

  it('returns null when the command encodes no model', () => {
    expect(parseModelFromClaudeCommand('claude --resume abc-123 --effort xhigh')).toBeNull();
  });

  it('ignores a --model substring inside the prompt (past the end-of-options -- marker)', () => {
    const command =
      '& "C:/claude.cmd" --resume abc-123 --print -- "<task><title>Fix the --model flag parsing regex</title></task>"';
    expect(parseModelFromClaudeCommand(command)).toBeNull();
  });

  it('extracts the real --model flag even when the prompt also mentions --model', () => {
    const command =
      '& "C:/claude.cmd" --model claude-opus-4-8 --print -- "<task>rework the --model regex</task>"';
    expect(parseModelFromClaudeCommand(command)).toBe('claude-opus-4-8');
  });
});

describe('humanizeClaudeModelId', () => {
  it('maps Anthropic ids to their display names', () => {
    expect(humanizeClaudeModelId('claude-opus-4-8')).toBe('Opus 4.8');
    expect(humanizeClaudeModelId('claude-fable-5')).toBe('Fable 5');
    expect(humanizeClaudeModelId('claude-sonnet-5')).toBe('Sonnet 5');
  });

  it('handles bare aliases', () => {
    expect(humanizeClaudeModelId('opus')).toBe('Opus');
  });

  it('drops a trailing date stamp but keeps the version', () => {
    expect(humanizeClaudeModelId('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('keeps a sub-6-digit numeric segment as a version part (date-stamp cutoff is >= 6 digits)', () => {
    expect(humanizeClaudeModelId('claude-opus-4-12345')).toBe('Opus 4.12345');
  });

  it('returns null when the id reduces to an empty label (a lone date stamp)', () => {
    expect(humanizeClaudeModelId('20251001')).toBeNull();
  });

  it('annotates a bracketed context-window variant', () => {
    expect(humanizeClaudeModelId('claude-opus-4-8[1m]')).toBe('Opus 4.8 (1M)');
  });

  it('returns null for empty input', () => {
    expect(humanizeClaudeModelId('')).toBeNull();
    expect(humanizeClaudeModelId('   ')).toBeNull();
  });
});

describe('configuredModelFromClaudeCommand', () => {
  it('returns id + display name for a command with a model', () => {
    const command = '& "C:/claude.cmd" --model claude-fable-5 --effort xhigh';
    expect(configuredModelFromClaudeCommand(command)).toEqual({
      id: 'claude-fable-5',
      displayName: 'Fable 5',
    });
  });

  it('returns null when no model is present', () => {
    expect(configuredModelFromClaudeCommand('claude --resume abc')).toBeNull();
  });
});
