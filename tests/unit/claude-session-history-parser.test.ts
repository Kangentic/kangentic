/**
 * Tests for `ClaudeSessionHistoryParser` - the background-session fallback
 * that derives a LIVE model + context % from Claude Code's native transcript
 * JSONL when status.json never flows (a never-painted background session).
 *
 * Distinct from `parseClaudeTranscriptUsage` (claude-transcript-usage.test.ts),
 * which sums a CUMULATIVE lifetime total. This parser reports the CURRENT
 * context occupancy from the latest assistant message, so it uses latest-wins
 * semantics and emits a sparse SessionUsage safe for the merge pipeline.
 *
 * Cross-checked against a pinned fixture
 * (tests/fixtures/transcripts/claude-live-context-sample.jsonl).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  ClaudeSessionHistoryParser,
  resolveClaudeContextWindowSize,
} from '../../src/main/agent/adapters/claude/session-history-parser';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import type { SessionUsage } from '../../src/shared/types';

const FIXTURE_PATH = path.join(
  __dirname, '..', 'fixtures', 'transcripts', 'claude-live-context-sample.jsonl',
);

/** Build one assistant JSONL line with the given fields. */
function assistantLine(options: {
  model: string;
  input: number;
  cacheCreation?: number;
  cacheRead?: number;
  output?: number;
  isSidechain?: boolean;
  id?: string;
}): string {
  const message: Record<string, unknown> = {
    id: options.id ?? 'msg',
    model: options.model,
    usage: {
      input_tokens: options.input,
      cache_creation_input_tokens: options.cacheCreation ?? 0,
      cache_read_input_tokens: options.cacheRead ?? 0,
      output_tokens: options.output ?? 0,
    },
  };
  const raw: Record<string, unknown> = { type: 'assistant', message };
  if (options.isSidechain) raw.isSidechain = true;
  return JSON.stringify(raw);
}

describe('ClaudeSessionHistoryParser.parse', () => {
  it('picks the latest qualifying assistant entry across a full fixture chunk, skipping sidechain/synthetic/malformed lines', () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    const result = ClaudeSessionHistoryParser.parse(content, 'full');

    expect(result.usage).not.toBeNull();
    const usage = result.usage as SessionUsage;
    // Latest legit entry is msg_a2 (post-compaction): input 500 + cache_read 300 = 800.
    // The isSidechain entry (900000) and the <synthetic> entry (5) must be skipped.
    expect(usage.contextWindow.usedTokens).toBe(800);
    expect(usage.contextWindow.totalInputTokens).toBe(800);
    expect(usage.contextWindow.cacheTokens).toBe(300);
    expect(usage.contextWindow.totalOutputTokens).toBe(40);
    expect(usage.contextWindow.contextWindowSize).toBe(200_000);
    expect(usage.contextWindow.usedPercentage).toBeCloseTo(0.4, 5);
    expect(usage.model.id).toBe('claude-opus-4-8');
    expect(usage.model.displayName).toBe('Opus 4.8');
    // Fallback never sets activity or events - those stay hooks-owned.
    expect(result.events).toEqual([]);
    expect(result.activity).toBeNull();
  });

  it('emits a SPARSE usage object (no cost / rateLimits / effort keys) so the merge never clobbers base values', () => {
    const result = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-opus-4-8', input: 1000 }), 'append',
    );
    const record = result.usage as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(record, 'cost')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'rateLimits')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'sessionId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'transcriptPath')).toBe(false);
    const contextWindow = record.contextWindow as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(contextWindow, 'effort')).toBe(false);
  });

  it('skips a trailing isSidechain assistant entry (subagent context is not the main thread)', () => {
    const content = [
      assistantLine({ model: 'claude-opus-4-8', input: 2000, id: 'main' }),
      assistantLine({ model: 'claude-opus-4-8', input: 900_000, id: 'sub', isSidechain: true }),
    ].join('\n');
    const usage = ClaudeSessionHistoryParser.parse(content, 'append').usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(2000);
  });

  it('skips a trailing <synthetic> assistant entry (API-error notice, not real occupancy)', () => {
    const content = [
      assistantLine({ model: 'claude-opus-4-8', input: 2000, id: 'real' }),
      assistantLine({ model: '<synthetic>', input: 5, id: 'syn' }),
    ].join('\n');
    const usage = ClaudeSessionHistoryParser.parse(content, 'append').usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(2000);
  });

  it('skips a trailing zero-input assistant entry', () => {
    const content = [
      assistantLine({ model: 'claude-opus-4-8', input: 2000, id: 'real' }),
      assistantLine({ model: 'claude-opus-4-8', input: 0, cacheRead: 0, id: 'empty' }),
    ].join('\n');
    const usage = ClaudeSessionHistoryParser.parse(content, 'append').usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(2000);
  });

  it('returns usage null for a chunk with no qualifying assistant entry', () => {
    const content = [
      '{"type":"user","message":{"content":"hi"}}',
      '{"type":"system","subtype":"compact_boundary"}',
      '{bad json',
    ].join('\n');
    const result = ClaudeSessionHistoryParser.parse(content, 'append');
    expect(result.usage).toBeNull();
    expect(result.events).toEqual([]);
    expect(result.activity).toBeNull();
  });

  it('drops the context percentage after a compaction (post-compaction chunk reports a smaller window occupancy)', () => {
    const before = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-opus-4-8', input: 100_000 }), 'append',
    ).usage as SessionUsage;
    const after = ClaudeSessionHistoryParser.parse(
      [
        '{"type":"system","subtype":"compact_boundary"}',
        assistantLine({ model: 'claude-opus-4-8', input: 20_000 }),
      ].join('\n'),
      'append',
    ).usage as SessionUsage;
    expect(before.contextWindow.usedPercentage).toBeCloseTo(50, 5);
    expect(after.contextWindow.usedPercentage).toBeCloseTo(10, 5);
    expect(after.contextWindow.usedPercentage).toBeLessThan(before.contextWindow.usedPercentage);
  });

  it('resolves the 1M window for a bracketed [1m] variant', () => {
    const usage = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-opus-4-8[1m]', input: 100_000 }), 'append',
    ).usage as SessionUsage;
    expect(usage.contextWindow.contextWindowSize).toBe(1_000_000);
    expect(usage.contextWindow.usedPercentage).toBeCloseTo(10, 5);
    expect(usage.model.displayName).toBe('Opus 4.8 (1M)');
  });

  it('matches a dated-snapshot model id by family prefix', () => {
    const usage = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-opus-4-8-20260115', input: 20_000 }), 'append',
    ).usage as SessionUsage;
    expect(usage.contextWindow.contextWindowSize).toBe(200_000);
    expect(usage.contextWindow.usedPercentage).toBeCloseTo(10, 5);
  });

  it('degrades to the 0-sentinel window for an unknown model but still sets the display name', () => {
    const usage = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-quasar-9', input: 1000 }), 'append',
    ).usage as SessionUsage;
    expect(usage.contextWindow.contextWindowSize).toBe(0);
    // 0 window -> percentage stays 0 (card shows model name, no bar).
    expect(usage.contextWindow.usedPercentage).toBe(0);
    expect(usage.model.id).toBe('claude-quasar-9');
    expect(usage.model.displayName).toBe('Quasar 9');
  });
});

describe('resolveClaudeContextWindowSize', () => {
  it('returns 200K for standard recognized families (Claude Code default window)', () => {
    expect(resolveClaudeContextWindowSize('claude-opus-4-8')).toBe(200_000);
    expect(resolveClaudeContextWindowSize('claude-sonnet-5')).toBe(200_000);
    expect(resolveClaudeContextWindowSize('claude-haiku-4-5')).toBe(200_000);
    expect(resolveClaudeContextWindowSize('claude-fable-5')).toBe(200_000);
    expect(resolveClaudeContextWindowSize('claude-opus-4-7')).toBe(200_000);
  });

  it('returns 1M for a bracketed [1m] variant', () => {
    expect(resolveClaudeContextWindowSize('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(resolveClaudeContextWindowSize('claude-sonnet-5[1m]')).toBe(1_000_000);
  });

  it('returns null (0-sentinel caller) for an unrecognized model family', () => {
    expect(resolveClaudeContextWindowSize('claude-quasar-9')).toBeNull();
    expect(resolveClaudeContextWindowSize('gpt-5')).toBeNull();
  });
});

describe('ClaudeSessionHistoryParser.locate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves immediately when the transcript file already exists', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-locate-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    try {
      const agentSessionId = 'exists-session';
      const cwd = '/mock/project';
      const dir = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${agentSessionId}.jsonl`);
      fs.writeFileSync(filePath, '');

      const resolved = await ClaudeSessionHistoryParser.locate({ agentSessionId, cwd });
      expect(resolved).toBe(filePath);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves once the transcript file appears mid-poll', async () => {
    vi.useFakeTimers();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-locate-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    try {
      const agentSessionId = 'appears-session';
      const cwd = '/mock/project';
      const dir = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${agentSessionId}.jsonl`);

      const promise = ClaudeSessionHistoryParser.locate({ agentSessionId, cwd });
      // First poll: file absent -> the loop sleeps.
      await vi.advanceTimersByTimeAsync(500);
      // File now appears.
      fs.writeFileSync(filePath, '');
      // Next poll picks it up.
      await vi.advanceTimersByTimeAsync(500);
      expect(await promise).toBe(filePath);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('returns null after the poll budget when the file never appears', async () => {
    vi.useFakeTimers();
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-locate-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    try {
      const promise = ClaudeSessionHistoryParser.locate({
        agentSessionId: 'never-appears',
        cwd: '/mock/project',
      });
      await vi.runAllTimersAsync();
      expect(await promise).toBeNull();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
