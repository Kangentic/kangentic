import { describe, it, expect } from 'vitest';
import {
  parseModelFromClaudeCommand,
  humanizeClaudeModelId,
  configuredModelFromClaudeCommand,
} from '../../src/main/agent/adapters/claude/model-display-name';
import { CommandBuilder } from '../../src/main/agent/adapters/claude';

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

describe('configuredModelFromClaudeCommand (real CommandBuilder wiring)', () => {
  // The fixtures above are hand-typed strings that assume `--model <id>` is
  // emitted with a literal space, and that quoteArg leaves a plain model id
  // unquoted. Both are true today, but that assumption lives in a DIFFERENT
  // file (command-builder.ts) than the parser (model-display-name.ts) - a
  // refactor of the flag emission (e.g. to `--model=<id>`) would not be
  // caught by the fixture-string tests above, since they never call the real
  // command builder. These tests drive the REAL buildClaudeCommand() output
  // (with PowerShell-style quoting) through the REAL parser, to lock the
  // coupling between the two.
  it('extracts the model from a real buildClaudeCommand() PowerShell-quoted command', () => {
    const builder = new CommandBuilder();
    const command = builder.buildClaudeCommand({
      cliPath: 'C:\\Program Files\\nodejs\\claude.cmd',
      taskId: 'task-1',
      cwd: 'C:\\Users\\dev\\project',
      permissionMode: 'default',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      nonInteractive: true,
      // Deliberately mentions "--model" in the prompt to prove the real
      // end-of-options `--` marker (not just the fixture strings above)
      // shields the parser from a prompt-text decoy.
      prompt: '<task><title>Fix the --model flag parsing regex</title></task>',
      shell: 'powershell',
    });

    expect(configuredModelFromClaudeCommand(command)).toEqual({
      id: 'claude-opus-4-8',
      displayName: 'Opus 4.8',
    });
  });

  it('returns null for a real buildClaudeCommand() with no model option set', () => {
    const builder = new CommandBuilder();
    const command = builder.buildClaudeCommand({
      cliPath: 'C:\\Program Files\\nodejs\\claude.cmd',
      taskId: 'task-2',
      cwd: 'C:\\Users\\dev\\project',
      permissionMode: 'default',
      nonInteractive: true,
      prompt: '<task><title>Some other task</title></task>',
      shell: 'powershell',
    });

    expect(configuredModelFromClaudeCommand(command)).toBeNull();
  });
});
