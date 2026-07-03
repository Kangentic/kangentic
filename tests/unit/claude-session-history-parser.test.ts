/**
 * Tests for `ClaudeSessionHistoryParser` - the background-session fallback that
 * derives a LIVE model + token occupancy from Claude Code's native transcript
 * JSONL until status.json flows. It emits token counts + the model ONLY: it
 * never guesses a context-window size or percentage from the model id (a plain
 * `claude-opus-4-8` runs a 1M window on a 1M-entitled account and 200K
 * elsewhere). The authoritative window comes from status.json, live or seeded on
 * resume; the accumulator computes the percentage.
 *
 * Distinct from `parseClaudeTranscriptUsage` (claude-transcript-usage.test.ts),
 * which sums a CUMULATIVE lifetime total. This parser reports the CURRENT
 * context occupancy from the latest assistant message (latest-wins).
 *
 * Cross-checked against pinned fixtures under tests/fixtures/transcripts/.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeSessionHistoryParser } from '../../src/main/agent/adapters/claude/session-history-parser';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { UsageAccumulator } from '../../src/main/activity-engine/usage-accumulator';
import type { SessionUsage } from '../../src/shared/types';

const FIXTURE_PATH = path.join(
  __dirname, '..', 'fixtures', 'transcripts', 'claude-live-context-sample.jsonl',
);
const STALE_OCCUPANCY_FIXTURE = path.join(
  __dirname, '..', 'fixtures', 'transcripts', 'claude-resume-stale-occupancy.jsonl',
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

/** The set of contextWindow keys the parser must NEVER emit (window is not derivable from an id). */
function assertNoWindowKeys(usage: SessionUsage): void {
  const contextWindow = (usage as unknown as { contextWindow: Record<string, unknown> }).contextWindow;
  expect(Object.prototype.hasOwnProperty.call(contextWindow, 'contextWindowSize')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(contextWindow, 'usedPercentage')).toBe(false);
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
    expect(usage.model.id).toBe('claude-opus-4-8');
    expect(usage.model.displayName).toBe('Opus 4.8');
    // Tokens + model only: NEVER a window or percentage (not derivable from an id).
    assertNoWindowKeys(usage);
    // Fallback never sets activity or events - those stay hooks-owned.
    expect(result.events).toEqual([]);
    expect(result.activity).toBeNull();
  });

  it('emits a SPARSE usage object (no window / percentage / cost / rateLimits / effort keys) so the merge never clobbers base values', () => {
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
    // The window and percentage are deliberately omitted so a cached authoritative
    // window (live or seeded on resume) survives the merge.
    expect(Object.prototype.hasOwnProperty.call(contextWindow, 'contextWindowSize')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(contextWindow, 'usedPercentage')).toBe(false);
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

  it('reports shrinking occupancy after a compaction (post-compaction chunk carries a smaller context)', () => {
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
    expect(before.contextWindow.usedTokens).toBe(100_000);
    expect(after.contextWindow.usedTokens).toBe(20_000);
    expect(after.contextWindow.usedTokens).toBeLessThan(before.contextWindow.usedTokens);
  });

  it('emits the humanized 1M display name for a bracketed [1m] variant but still no window', () => {
    const usage = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-opus-4-8[1m]', input: 100_000 }), 'append',
    ).usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(100_000);
    expect(usage.model.displayName).toBe('Opus 4.8 (1M)');
    assertNoWindowKeys(usage);
  });

  it('emits tokens + display name for a dated-snapshot model id, still no window', () => {
    const usage = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-opus-4-8-20260115', input: 20_000 }), 'append',
    ).usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(20_000);
    assertNoWindowKeys(usage);
  });

  it('emits tokens + a display name for an unrecognized model id, never a window', () => {
    const usage = ClaudeSessionHistoryParser.parse(
      assistantLine({ model: 'claude-quasar-9', input: 1000 }), 'append',
    ).usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(1000);
    expect(usage.model.id).toBe('claude-quasar-9');
    expect(usage.model.displayName).toBe('Quasar 9');
    assertNoWindowKeys(usage);
  });

  it('INCIDENT LOCK: a stale 650,398-token resume entry on plain claude-opus-4-8 never yields >100% (no window guess)', () => {
    // Reproduces #286: the last pre-suspend assistant entry (input 2 +
    // cache_creation 446 + cache_read 649,950 = 650,398) on a plain
    // claude-opus-4-8 id. The old parser divided by a guessed 200K window and
    // rendered 325%. It must now emit tokens only, and running that through the
    // real accumulator on a base with no known window must degrade to the
    // 0-sentinel (model-only), never a percentage.
    const content = fs.readFileSync(STALE_OCCUPANCY_FIXTURE, 'utf-8');
    const usage = ClaudeSessionHistoryParser.parse(content, 'append').usage as SessionUsage;
    expect(usage.contextWindow.usedTokens).toBe(650_398);
    expect(usage.model.id).toBe('claude-opus-4-8');
    assertNoWindowKeys(usage);

    const accumulator = new UsageAccumulator();
    const merged = accumulator.setSessionUsage('incident-session', usage as unknown as Partial<SessionUsage>);
    expect(merged.contextWindow.usedTokens).toBe(650_398);
    // No window was ever known, so it stays at the 0 sentinel and the percentage
    // stays 0 - the card shows the model name only, never 325%.
    expect(merged.contextWindow.contextWindowSize).toBe(0);
    expect(merged.contextWindow.usedPercentage).toBe(0);
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
