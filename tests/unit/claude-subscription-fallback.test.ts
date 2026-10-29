/**
 * A headless Claude run whose inherited external API key the CLI refuses runs
 * once more with that key unset, so print mode falls back to the stored login
 * (#683). In print mode Claude always uses `ANTHROPIC_API_KEY` when it is set,
 * so a stale key failed every terminal name, task title, summary and Condition
 * check with "Invalid API key · Fix external API key" while the user's own
 * terminals, which can decline the key, kept working.
 *
 * Pinned here: the inherited names are found case-insensitively; the override
 * unsets them in the run's environment and nowhere else; only that refusal,
 * with a key actually inherited, earns the second run, and only one; a streamed
 * answer the user already saw is never run again; and both headless methods,
 * `summarize` and `answerFromContext`, take the second run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunCliPrintOptions } from '../../src/main/agent/shared/cli-print';

const { summarizeSpy, answerSpy } = vi.hoisted(() => ({
  summarizeSpy: vi.fn(async (_options: RunCliPrintOptions): Promise<string> => 'Unused'),
  answerSpy: vi.fn(async (_options: RunCliPrintOptions): Promise<string> => 'Unused'),
}));

vi.mock('../../src/main/agent/shared/auto-name', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/auto-name')>();
  return { ...actual, runCliPrintSummarize: summarizeSpy };
});

vi.mock('../../src/main/agent/shared/cli-answer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/cli-answer')>();
  return { ...actual, runCliPrintAnswer: answerSpy };
});

import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import {
  inheritedCredentialNames,
  isExternalKeyRejection,
  runWithSubscriptionFallback,
  withoutExternalCredential,
} from '../../src/main/agent/adapters/claude/subscription-fallback';
import { childProcessEnv } from '../../src/main/shared/child-env';

/** The refusal exactly as the background-call ledger recorded it. */
const REFUSAL = 'Invalid API key · Fix external API key';

/** A text delta as Claude's stream-json prints it, which the answer stream shows. */
const STREAMED_TEXT_LINE = `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } })}\n`;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  summarizeSpy.mockReset();
  answerSpy.mockReset();
  // The developer machine this ran on has its own key set; every case says
  // which credential the run inherits.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-stale');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe('the external credential', () => {
  it('names the inherited credential variables case-insensitively, and only set ones', () => {
    expect(inheritedCredentialNames({
      ANTHROPIC_API_KEY: 'sk-ant-stale',
      Anthropic_Auth_Token: 'token',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 'login-token',
    })).toEqual(['ANTHROPIC_API_KEY', 'Anthropic_Auth_Token']);
    expect(inheritedCredentialNames({ ANTHROPIC_API_KEY: '' })).toEqual([]);
  });

  it('unsets the inherited spelling and the canonical names a distro reads', () => {
    const override = withoutExternalCredential(['Anthropic_Api_Key']);
    expect(Object.keys(override).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'Anthropic_Api_Key']);
    expect(Object.values(override).every((value) => value === undefined)).toBe(true);
  });

  it('is gone from the run\'s environment and still set in main\'s', () => {
    const environment = childProcessEnv({ MAX_THINKING_TOKENS: '0', ...withoutExternalCredential(inheritedCredentialNames()) });

    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(environment.MAX_THINKING_TOKENS).toBe('0');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-stale');
  });

  it('reads only Claude\'s refusal of the key as one', () => {
    expect(isExternalKeyRejection(new Error(REFUSAL))).toBe(true);
    expect(isExternalKeyRejection(new Error('the agent timed out'))).toBe(false);
    expect(isExternalKeyRejection(REFUSAL)).toBe(false);
  });
});

describe('runWithSubscriptionFallback', () => {
  it('runs once more with the inherited key unset when the CLI refuses it', async () => {
    const run = vi.fn(async (_credentialEnv: Record<string, undefined>): Promise<string> => 'Audit Unused Feature Flags');
    run.mockRejectedValueOnce(new Error(REFUSAL));

    await expect(runWithSubscriptionFallback(run)).resolves.toBe('Audit Unused Feature Flags');

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toEqual({});
    const second = run.mock.calls[1][0];
    expect(Object.keys(second)).toContain('ANTHROPIC_API_KEY');
    expect(second.ANTHROPIC_API_KEY).toBeUndefined();
    // Says why, and never the key itself.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ANTHROPIC_API_KEY');
    expect(String(warn.mock.calls[0][0])).not.toContain('sk-ant-stale');
  });

  it('runs once when the first run succeeds, with nothing unset', async () => {
    const run = vi.fn(async (_credentialEnv: Record<string, undefined>): Promise<string> => 'Title');

    await runWithSubscriptionFallback(run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({});
  });

  it('never runs again for another failure', async () => {
    const run = vi.fn(async (_credentialEnv: Record<string, undefined>): Promise<string> => {
      throw new Error('the agent timed out');
    });

    await expect(runWithSubscriptionFallback(run)).rejects.toThrow('the agent timed out');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs again when no key was inherited, since unsetting would change nothing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    const run = vi.fn(async (_credentialEnv: Record<string, undefined>): Promise<string> => {
      throw new Error(REFUSAL);
    });

    await expect(runWithSubscriptionFallback(run)).rejects.toThrow(REFUSAL);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs again when the caller refuses it', async () => {
    const run = vi.fn(async (_credentialEnv: Record<string, undefined>): Promise<string> => {
      throw new Error(REFUSAL);
    });

    await expect(runWithSubscriptionFallback(run, () => false)).rejects.toThrow(REFUSAL);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs at most twice, and a user with no login gets the second run\'s reason', async () => {
    const run = vi.fn(async (_credentialEnv: Record<string, undefined>): Promise<string> => 'Unused');
    run.mockRejectedValueOnce(new Error(REFUSAL));
    run.mockRejectedValueOnce(new Error('Not logged in · Please run /login'));

    await expect(runWithSubscriptionFallback(run)).rejects.toThrow('Not logged in');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('ClaudeAdapter headless runs', () => {
  it('summarize names the terminal on the stored login after the key is refused', async () => {
    summarizeSpy.mockRejectedValueOnce(new Error(REFUSAL));
    summarizeSpy.mockResolvedValueOnce('Audit Unused Feature Flags');

    const title = await new ClaudeAdapter().summarize('find feature flags nobody reads', '/usr/bin/claude', '/answer-home', { model: 'claude-haiku-5-5', effort: 'low' });

    expect(title).toBe('Audit Unused Feature Flags');
    expect(summarizeSpy).toHaveBeenCalledTimes(2);
    const [first, second] = summarizeSpy.mock.calls.map((call) => call[0]);
    expect(first.env).toEqual({ MAX_THINKING_TOKENS: '0' });
    expect(second.env?.MAX_THINKING_TOKENS).toBe('0');
    expect(Object.keys(second.env ?? {})).toContain('ANTHROPIC_API_KEY');
    expect(second.env?.ANTHROPIC_API_KEY).toBeUndefined();
    // The same run otherwise: only the environment differs.
    expect(second.args).toEqual(first.args);
    expect(second.cwd).toBe('/answer-home');
  });

  it('summarize hands back the refusal when no key was inherited', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    summarizeSpy.mockRejectedValueOnce(new Error(REFUSAL));

    await expect(new ClaudeAdapter().summarize('hello', '/usr/bin/claude', '/answer-home')).rejects.toThrow(REFUSAL);
    expect(summarizeSpy).toHaveBeenCalledTimes(1);
  });

  it('answerFromContext answers a summary or a check on the stored login after the key is refused', async () => {
    answerSpy.mockRejectedValueOnce(new Error(REFUSAL));
    answerSpy.mockResolvedValueOnce('yes');

    const answer = await new ClaudeAdapter().answerFromContext('THE PROMPT', '/usr/bin/claude', '/answer-home', 'claude-haiku-5-5', { effort: 'low' });

    expect(answer).toBe('yes');
    expect(answerSpy).toHaveBeenCalledTimes(2);
    const second = answerSpy.mock.calls[1][0];
    expect(second.env?.MAX_THINKING_TOKENS).toBe('0');
    expect(Object.keys(second.env ?? {})).toContain('ANTHROPIC_API_KEY');
    expect(second.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('answerFromContext streams a refused run again when nothing reached the user', async () => {
    answerSpy.mockRejectedValueOnce(new Error(REFUSAL));
    answerSpy.mockImplementationOnce(async (options) => {
      options.onChunk?.(STREAMED_TEXT_LINE);
      return 'Hello';
    });
    const events: unknown[] = [];

    await new ClaudeAdapter().answerFromContext('THE PROMPT', '/usr/bin/claude', '/answer-home', null, { onEvent: (event) => events.push(event) });

    expect(answerSpy).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ kind: 'text', text: 'Hello' }]);
  });

  it('answerFromContext never runs again once the user saw streamed output', async () => {
    answerSpy.mockImplementationOnce(async (options) => {
      options.onChunk?.(STREAMED_TEXT_LINE);
      throw new Error(REFUSAL);
    });
    const events: unknown[] = [];

    await expect(new ClaudeAdapter().answerFromContext('THE PROMPT', '/usr/bin/claude', '/answer-home', null, {
      onEvent: (event) => events.push(event),
    })).rejects.toThrow(REFUSAL);

    expect(answerSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ kind: 'text', text: 'Hello' }]);
  });
});
