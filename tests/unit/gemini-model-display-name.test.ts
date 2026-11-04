/**
 * Gemini model labels derived from the id, in Gemini's own word order, and the
 * model a built command pins. What a user loses without them: the card shows a
 * raw id until the first reply, and a picker row learned from telemetry reads
 * as an id. The prompt case matters most: Gemini's builder puts no `--` before
 * the positional prompt, so a task text with `--model x` in it must not seed a
 * model the session never ran.
 */
import { describe, it, expect } from 'vitest';
import { geminiModelDisplayName, modelFromGeminiCommand } from '../../src/main/agent/adapters/gemini/model-display-name';
import { GeminiAdapter, GeminiCommandBuilder } from '../../src/main/agent/adapters/gemini';
import type { GeminiCommandOptions } from '../../src/main/agent/adapters/gemini';

function built(overrides: Partial<GeminiCommandOptions>, shell?: string): string {
  return new GeminiCommandBuilder().buildGeminiCommand({
    geminiPath: '/usr/local/bin/gemini',
    taskId: 'task-1',
    cwd: '/mock/project',
    permissionMode: 'acceptEdits',
    shell,
    ...overrides,
  });
}

describe('geminiModelDisplayName', () => {
  it('keeps the version where the id has it', () => {
    expect(geminiModelDisplayName('gemini-3-flash-preview')).toBe('Gemini 3 Flash Preview');
    expect(geminiModelDisplayName('gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
  });

  it('labels an alias too', () => {
    expect(geminiModelDisplayName('auto')).toBe('Auto');
  });

  it('is null for an empty id', () => {
    expect(geminiModelDisplayName('  ')).toBeNull();
  });
});

describe('modelFromGeminiCommand', () => {
  it('reads the --model the builder emitted, on each shell', () => {
    for (const shell of ['bash', 'pwsh', 'cmd.exe', undefined]) {
      const command = built({ model: 'gemini-2.5-pro', sessionId: 'abc-123', prompt: 'Fix the bug' }, shell);
      expect(modelFromGeminiCommand(command), String(shell)).toBe('gemini-2.5-pro');
    }
  });

  it('reads past readable directories and a resume', () => {
    const command = built({ model: 'gemini-3-pro-preview', resume: true, sessionId: 'abc-123', readableDirectories: ['/mock/other project'] }, 'bash');
    expect(modelFromGeminiCommand(command)).toBe('gemini-3-pro-preview');
  });

  it('never reads a --model inside the prompt', () => {
    const command = built({ prompt: 'Run the CLI with --model gemini-9 and report' }, 'bash');
    expect(modelFromGeminiCommand(command)).toBeNull();
  });

  it('is null when no model is pinned', () => {
    expect(modelFromGeminiCommand(built({ prompt: 'hello' }, 'bash'))).toBeNull();
  });

  it('skips a PowerShell call operator before the executable', () => {
    expect(modelFromGeminiCommand('& "C:\\Program Files\\gemini\\gemini.cmd" --model gemini-2.5-pro "hi"')).toBe('gemini-2.5-pro');
  });
});

describe('GeminiAdapter model members', () => {
  it('seeds the card with the pinned model and its label', () => {
    const command = built({ model: 'gemini-2.5-pro' }, 'bash');
    expect(new GeminiAdapter().configuredModelFromCommand(command)).toEqual({ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' });
  });

  it('labels a telemetry-learned id', () => {
    expect(new GeminiAdapter().modelDisplayName('gemini-3-flash-preview')).toBe('Gemini 3 Flash Preview');
  });
});
