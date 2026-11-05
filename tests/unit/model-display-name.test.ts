import { describe, it, expect } from 'vitest';
import {
  parseModelFromClaudeCommand,
  humanizeClaudeModelId,
  claudeCoreOf,
  configuredModelFromClaudeCommand,
  buildModelDisplayNames,
  buildModelCapabilityFields,
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

  // Every id the CLI listed under a provider, from check-label-rule on 2.1.318.
  it.each([
    ['us.anthropic.claude-fable-5-1', 'Fable 5.1'],
    ['us.anthropic.claude-sonnet-5-5', 'Sonnet 5.5'],
    ['us.anthropic.claude-sonnet-5', 'Sonnet 5'],
    ['us.anthropic.claude-sonnet-4-6', 'Sonnet 4.6'],
    ['us.anthropic.claude-sonnet-4-6[1m]', 'Sonnet 4.6 (1M)'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'Opus 4.1'],
    ['us.anthropic.claude-opus-5-5', 'Opus 5.5'],
    ['us.anthropic.claude-opus-5', 'Opus 5'],
    ['us.anthropic.claude-opus-4-8', 'Opus 4.8'],
    ['us.anthropic.claude-opus-4-6-v1', 'Opus 4.6'],
    ['us.anthropic.claude-opus-4-6-v1[1m]', 'Opus 4.6 (1M)'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'Haiku 4.5'],
    ['claude-haiku-4-5@20251001', 'Haiku 4.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-4-6[1m]', 'Sonnet 4.6 (1M)'],
    ['claude-opus-4-6[1m]', 'Opus 4.6 (1M)'],
    ['claude-fable-5-1[1m]', 'Fable 5.1 (1M)'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['eu.anthropic.claude-sonnet-5', 'Sonnet 5'],
  ])('labels %s as %s from its claude- core', (id, label) => {
    expect(humanizeClaudeModelId(id)).toBe(label);
  });
});

describe('claudeCoreOf', () => {
  it.each([
    ['claude-opus-4-8', 'claude-opus-4-8'],
    ['us.anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['vendor/claude-haiku-4-5', 'claude-haiku-4-5'],
    ['vendor:claude-haiku-4-5', 'claude-haiku-4-5'],
  ])('finds the core of %s', (id, core) => {
    expect(claudeCoreOf(id)).toBe(core);
  });

  it.each([
    'team-claude-proxy-v2',
    'databricks-claude-sonnet-4-5',
    'my-gateway-model',
    'opus',
  ])('finds no core in %s, where claude- sits mid-word or is absent', (id) => {
    expect(claudeCoreOf(id)).toBeNull();
  });

  it('keeps the whole id\'s words when claude- sits mid-word, rather than the tail after it', () => {
    expect(humanizeClaudeModelId('team-claude-proxy-v2')).toBe('Team Claude Proxy V2');
  });

  it('still labels an ARN from the core it ends with', () => {
    expect(
      humanizeClaudeModelId('arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.anthropic.claude-opus-5-5'),
    ).toBe('Opus 5.5');
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

describe('buildModelDisplayNames', () => {
  it('maps every discovered id to its humanized label', () => {
    expect(buildModelDisplayNames(['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5'])).toEqual({
      'claude-opus-4-7': 'Opus 4.7',
      'claude-opus-4-8': 'Opus 4.8',
      'claude-fable-5': 'Fable 5',
    });
  });

  it('omits an id that humanizes to nothing meaningful', () => {
    expect(buildModelDisplayNames(['20251001'])).toEqual({});
  });

  it('returns an empty map for an empty list', () => {
    expect(buildModelDisplayNames([])).toEqual({});
  });

  it('takes the CLI\'s name for an id with no claude- core, the two ids a label cannot be derived from', () => {
    const arn = 'arn:aws:bedrock:us-west-2:111122223333:inference-profile/custom-7f3a';
    expect(buildModelDisplayNames(['my-gateway-model', arn, 'claude-opus-4-8'], {
      'my-gateway-model': 'My Team Gateway',
      [arn]: 'Opus',
    })).toEqual({ 'my-gateway-model': 'My Team Gateway', [arn]: 'Opus', 'claude-opus-4-8': 'Opus 4.8' });
  });
});

describe('buildModelCapabilityFields', () => {
  it('names the ids and the alias ids, and carries the aliases through in the given order', () => {
    const aliases = [
      { id: 'opus', resolvesTo: 'claude-opus-4-8' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
    ];
    const fields = buildModelCapabilityFields(['claude-opus-4-8', 'claude-haiku-4-5'], aliases);
    expect(fields.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(fields.modelAliases).toEqual(aliases);
    // An alias shows as its bare family name, beside the versioned ids it resolves to.
    expect(fields.modelDisplayNames).toEqual({
      'claude-opus-4-8': 'Opus 4.8',
      'claude-haiku-4-5': 'Haiku 4.5',
      opus: 'Opus',
      haiku: 'Haiku',
    });
  });

  it('leaves modelAliases out entirely (not an empty array) when the CLI offered none', () => {
    const fields = buildModelCapabilityFields(['claude-opus-4-8'], []);
    expect('modelAliases' in fields).toBe(false);
    expect(fields.modelDisplayNames).toEqual({ 'claude-opus-4-8': 'Opus 4.8' });
  });

  it('still names aliases when the model list is empty', () => {
    const fields = buildModelCapabilityFields([], [{ id: 'sonnet' }]);
    expect(fields.models).toEqual([]);
    expect(fields.modelDisplayNames).toEqual({ sonnet: 'Sonnet' });
    expect(fields.modelAliases).toEqual([{ id: 'sonnet' }]);
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
