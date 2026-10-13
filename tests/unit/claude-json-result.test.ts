/**
 * A Claude answer run with no stream prints one `--output-format json` object:
 * the answer plus what the call cost. `createJsonResultExtractor` takes the
 * answer out and hands the usage to `onUsage`, which is how a background call's
 * model, tokens and cost reach its record.
 *
 * The first fixture is the real envelope of a condition check, captured on CLI
 * 2.1.296 with the check's exact flags on Haiku 5.5. The second is an older
 * capture on Haiku 4.5. Built by hand only where no CLI output exists to copy:
 * an error result, and a call that used two models.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createJsonResultExtractor, extractStreamedAnswer, usageFromResultRecord } from '../../src/main/agent/shared/cli-answer';
import type { AgentCallUsage } from '../../src/shared/types';

const fixturesDirectory = path.join(__dirname, '..', 'fixtures');
const conditionCheck = fs.readFileSync(path.join(fixturesDirectory, 'claude-print-result-condition-check.json'), 'utf-8');
const olderCapture = fs.readFileSync(path.join(fixturesDirectory, 'claude-print-result-success.json'), 'utf-8');

describe('createJsonResultExtractor', () => {
  it('returns the answer and reports the call\'s model, tokens and cost (CLI 2.1.296 capture)', () => {
    const onUsage = vi.fn();
    const answer = createJsonResultExtractor(onUsage)(conditionCheck);

    expect(answer).toBe('C1: yes - The agent reply\'s final line is "Findings: applied", which matches the condition exactly.');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      model: 'claude-haiku-5-5',
      inputTokens: 2,
      cacheCreationInputTokens: 2402,
      cacheReadInputTokens: 535,
      outputTokens: 35,
      costUsd: 0.00050345,
    } satisfies AgentCallUsage);
  });

  it('reads an older capture the same way', () => {
    const onUsage = vi.fn();
    expect(createJsonResultExtractor(onUsage)(olderCapture)).toBe('ok');
    expect(onUsage.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 65, costUsd: 0.020622 });
  });

  it('reports usage BEFORE an error result throws: a failed call was still paid for', () => {
    const onUsage = vi.fn();
    const errorResult = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: 529 overloaded',
      total_cost_usd: 0.0001,
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    });

    expect(() => createJsonResultExtractor(onUsage)(errorResult)).toThrow('API Error: 529 overloaded');
    expect(onUsage).toHaveBeenCalledWith({
      model: null, inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, costUsd: 0.0001,
    });
  });

  it('reads empty or non-JSON stdout as no answer, so the runner reports the exit and stderr', () => {
    const onUsage = vi.fn();
    const extract = createJsonResultExtractor(onUsage);

    expect(extract('')).toBe('');
    expect(extract('error: unknown option \'--bogus\'\n')).toBe('');
    expect(extract('{"type":"system","subtype":"init"}\n')).toBe('');
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('works without an onUsage sink', () => {
    expect(createJsonResultExtractor()(conditionCheck)).toContain('C1: yes');
  });
});

describe('usageFromResultRecord', () => {
  it('sums every model the call used, names the one that wrote the most, and keeps the CLI\'s own total cost', () => {
    const usage = usageFromResultRecord({
      type: 'result',
      total_cost_usd: 0.012,
      modelUsage: {
        'claude-haiku-5-5': { inputTokens: 40, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0002 },
        'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 220, cacheReadInputTokens: 900, cacheCreationInputTokens: 50, costUSD: 0.0118 },
      },
    });

    expect(usage).toEqual({
      model: 'claude-sonnet-5-5',
      inputTokens: 140,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 900,
      outputTokens: 223,
      costUsd: 0.012,
    });
  });

  it('falls back to the per-model costs when the total is missing', () => {
    const usage = usageFromResultRecord({
      modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 0.25 } },
    });
    expect(usage?.costUsd).toBe(0.25);
  });

  it('reports null cost, never zero, when the CLI priced nothing', () => {
    const usage = usageFromResultRecord({ usage: { input_tokens: 3, output_tokens: 4 } });
    expect(usage).toEqual({ model: null, inputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 4, costUsd: null });
  });

  it('returns null for a result line that says nothing about usage', () => {
    expect(usageFromResultRecord({ type: 'result', result: 'hi' })).toBeNull();
  });
});

describe('extractStreamedAnswer', () => {
  it('reports the result line\'s usage when given a sink', () => {
    const onUsage = vi.fn();
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The answer.' }] } }),
      conditionCheck.trim(),
    ].join('\n');

    expect(extractStreamedAnswer(stream, onUsage)).toContain('C1: yes');
    expect(onUsage.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5', outputTokens: 35 });
  });

  it('reports the result line\'s usage BEFORE an error result throws: a failed streamed call was still paid for', () => {
    const onUsage = vi.fn();
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Searching.' }] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'API Error: 529 overloaded',
        total_cost_usd: 0.0003,
        usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 1 },
      }),
    ].join('\n');

    expect(() => extractStreamedAnswer(stream, onUsage)).toThrow('API Error: 529 overloaded');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      model: null, inputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 100, outputTokens: 1, costUsd: 0.0003,
    });
  });

  it('reports nothing for a stream cut before its result line (a timeout or output budget)', () => {
    const onUsage = vi.fn();
    const cutStream = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Partial.' }] } });

    expect(extractStreamedAnswer(cutStream, onUsage)).toBe('Partial.');
    expect(onUsage).not.toHaveBeenCalled();
  });
});
