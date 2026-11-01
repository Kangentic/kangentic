import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude';
import { EventType } from '../../src/shared/types';
import { claudeSessionStartContext } from './helpers/claude-session-start';

describe('ClaudeStatusParser', () => {
  // -------------------------------------------------------------------------
  // computeContextPercentage
  // -------------------------------------------------------------------------
  describe('computeContextPercentage', () => {
    it('returns Claude used_percentage 1:1', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: 42 })).toBe(42);
    });

    it('honors explicit used_percentage of 0', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: 0 })).toBe(0);
    });

    it('caps used_percentage at 100', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: 105 })).toBe(100);
    });

    it('clamps negative used_percentage to 0', () => {
      expect(ClaudeStatusParser.computeContextPercentage({ used_percentage: -5 })).toBe(0);
    });

    it('returns 0 when used_percentage is missing', () => {
      expect(ClaudeStatusParser.computeContextPercentage({})).toBe(0);
    });

    it('returns 0 for null context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(null)).toBe(0);
    });

    it('returns 0 for undefined context_window', () => {
      expect(ClaudeStatusParser.computeContextPercentage(undefined)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // parseStatus
  // -------------------------------------------------------------------------
  describe('parseStatus', () => {
    it('parses valid Claude Code JSON into SessionUsage', () => {
      const raw = JSON.stringify({
        context_window: {
          current_usage: {
            input_tokens: 20_000,
            output_tokens: 5_000,
            cache_creation_input_tokens: 1_000,
            cache_read_input_tokens: 4_000,
          },
          used_percentage: 20,
          total_input_tokens: 20_000,
          total_output_tokens: 5_000,
          context_window_size: 200_000,
        },
        cost: {
          total_cost_usd: 0.15,
          total_duration_ms: 12345,
        },
        model: {
          id: 'claude-sonnet-4-20250514',
          display_name: 'Claude Sonnet 4',
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      // Trusts Claude's used_percentage 1:1 (raw token sum would compute 15)
      expect(usage!.contextWindow.usedPercentage).toBe(20);
      // usedTokens: sum of all token buckets including output
      expect(usage!.contextWindow.usedTokens).toBe(30_000);
      // cacheTokens: cache_creation + cache_read
      expect(usage!.contextWindow.cacheTokens).toBe(5_000);
      expect(usage!.contextWindow.totalInputTokens).toBe(20_000);
      expect(usage!.contextWindow.totalOutputTokens).toBe(5_000);
      expect(usage!.contextWindow.contextWindowSize).toBe(200_000);
      expect(usage!.cost.totalCostUsd).toBe(0.15);
      expect(usage!.cost.totalDurationMs).toBe(12345);
      expect(usage!.model.id).toBe('claude-sonnet-4-20250514');
      expect(usage!.model.displayName).toBe('Claude Sonnet 4');
      // No effort emitted in this fixture
      expect(usage!.model.effort).toBeUndefined();
    });

    it('ROOT CAUSE A: a plain claude-opus-4-8 id reports a 1M window (status.json is authoritative, not the id)', () => {
      // Real machine evidence (#286): a 1M-entitled account runs plain
      // claude-opus-4-8 (no [1m] suffix) at a 1,000,000 window. The window is
      // NOT derivable from the model id - only status.json knows it. This locks
      // that the parser reports Claude's own context_window_size verbatim.
      const raw = JSON.stringify({
        context_window: {
          current_usage: { input_tokens: 2, output_tokens: 459, cache_creation_input_tokens: 896, cache_read_input_tokens: 91_887 },
          used_percentage: 9,
          total_input_tokens: 92_785,
          total_output_tokens: 459,
          context_window_size: 1_000_000,
        },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.id).toBe('claude-opus-4-8');
      expect(usage!.contextWindow.contextWindowSize).toBe(1_000_000);
      expect(usage!.contextWindow.usedPercentage).toBe(9);
    });

    it('extracts effort.level into model.effort', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 11, context_window_size: 1_000_000 },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-7[1m]', display_name: 'Opus 4.7 (1M context)' },
        effort: { level: 'xhigh' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.effort).toBe('xhigh');
      expect(usage!.model.reportedByAgent).toBe(true);
    });

    it('ROOT CAUSE: a Haiku 4.5 payload reports its model but omits effort entirely', () => {
      // Fixture shape authored from the Claude Code 2.1.220 statusline payload
      // builder, NOT invented. That builder assembles the field as
      // `supportsEffort(model) ? { level } : undefined` and JSON.stringify drops
      // an undefined key; the capability check's exclusion list contains
      // `claude-haiku-4-5`. So on Haiku there is no `effort` key to read, while
      // `model` still reports normally - exactly what the bug screenshot showed
      // (model pill updated to Haiku 4.5, effort pill stuck on a stale `high`).
      const raw = JSON.stringify({
        session_id: 'a1b2c3d4-0000-4000-8000-000000000000',
        transcript_path: '/mock/projects/demo/a1b2c3d4.jsonl',
        cwd: '/mock/demo',
        prompt_id: 'b2c3d4e5-0000-4000-8000-000000000000',
        model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
        context_window: { used_percentage: 38, context_window_size: 200_000, total_input_tokens: 76_200 },
        cost: { total_cost_usd: 0.57, total_duration_ms: 176_000 },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.displayName).toBe('Haiku 4.5');
      expect(usage!.model.effort).toBeUndefined();
      // The snapshot still ARRIVED. That is what lets the renderer say "this
      // model has no effort level" rather than "nothing has reported yet".
      expect(usage!.model.reportedByAgent).toBe(true);
    });

    it('leaves model.effort undefined when status omits effort', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5, context_window_size: 200_000 },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.effort).toBeUndefined();
    });

    it('leaves model.effort undefined when effort is null', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5, context_window_size: 200_000 },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
        effort: null,
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.effort).toBeUndefined();
    });

    it('leaves model.effort undefined when effort.level is non-string', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5, context_window_size: 200_000 },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
        effort: { level: 3 },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.effort).toBeUndefined();
    });

    it('leaves model.effort undefined when effort object has no level key', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5, context_window_size: 200_000 },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
        effort: {},
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.model.effort).toBeUndefined();
    });

    it('returns null for invalid JSON', () => {
      expect(ClaudeStatusParser.parseStatus('not json')).toBeNull();
    });

    it('estimates usedTokens from used_percentage when current_usage is absent', () => {
      const raw = JSON.stringify({
        context_window: {
          used_percentage: 14,
          total_input_tokens: 3,
          total_output_tokens: 0,
          context_window_size: 200_000,
        },
        cost: { total_cost_usd: 0, total_duration_ms: 0 },
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      // 14% of 200k = 28000
      expect(usage!.contextWindow.usedTokens).toBe(28_000);
      // Without current_usage, all context is assumed to be cache
      expect(usage!.contextWindow.cacheTokens).toBe(28_000);
      // used_percentage returned directly
      expect(usage!.contextWindow.usedPercentage).toBe(14);
    });

    it('returns SessionUsage with zero defaults when context_window is missing', () => {
      const raw = JSON.stringify({ cost: { total_cost_usd: 0.01 } });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.contextWindow.usedPercentage).toBe(0);
      expect(usage!.contextWindow.usedTokens).toBe(0);
      expect(usage!.contextWindow.cacheTokens).toBe(0);
      expect(usage!.contextWindow.totalInputTokens).toBe(0);
      expect(usage!.contextWindow.contextWindowSize).toBe(0);
      expect(usage!.model.id).toBe('');
    });

    it('parses rate_limits when present', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 10, context_window_size: 200_000 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
        rate_limits: {
          five_hour: { used_percentage: 18, resets_at: 1775883600 },
          seven_day: { used_percentage: 4, resets_at: 1776452400 },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toEqual([
        { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 18, resetsAt: 1775883600, windowDurationSeconds: 5 * 60 * 60 },
        { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 4, resetsAt: 1776452400, windowDurationSeconds: 7 * 24 * 60 * 60 },
      ]);
    });

    it('omits rateLimits when rate_limits is absent', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 10 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toBeUndefined();
    });

    it('defaults rate_limits values to 0 when non-numeric or NaN', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 0 },
        cost: {},
        model: {},
        rate_limits: {
          five_hour: { used_percentage: 'broken', resets_at: null },
          seven_day: { used_percentage: NaN, resets_at: 'tomorrow' },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toEqual([
        { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 0, resetsAt: 0, windowDurationSeconds: 5 * 60 * 60 },
        { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 0, resetsAt: 0, windowDurationSeconds: 7 * 24 * 60 * 60 },
      ]);
    });

    it('clamps rate_limits used_percentage to 0..100', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 0 },
        cost: {},
        model: {},
        rate_limits: {
          five_hour: { used_percentage: 150, resets_at: 1 },
          seven_day: { used_percentage: -5, resets_at: 2 },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits![0].usedPercentage).toBe(100);
      expect(usage!.rateLimits![1].usedPercentage).toBe(0);
    });

    it('emits the five_hour window alone when only five_hour is present', () => {
      // Claude sends each window only while it applies: a lapsed weekly window is
      // dropped from the payload until the next response. One window still shows.
      const raw = JSON.stringify({
        context_window: { used_percentage: 5 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
        rate_limits: {
          five_hour: { used_percentage: 30, resets_at: 1775883600 },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toEqual([
        { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 30, resetsAt: 1775883600, windowDurationSeconds: 5 * 60 * 60 },
      ]);
    });

    it('emits the seven_day window alone when only seven_day is present (Ultra has no 5h limit)', () => {
      // The payload an Ultra plan sends: no five_hour window at all.
      const raw = JSON.stringify({
        context_window: { used_percentage: 5 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
        rate_limits: {
          seven_day: { used_percentage: 56, resets_at: 1793718000 },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toEqual([
        { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 56, resetsAt: 1793718000, windowDurationSeconds: 7 * 24 * 60 * 60 },
      ]);
    });

    it('omits rateLimits when rate_limits carries no window', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
        rate_limits: {},
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toBeUndefined();
    });

    it('skips a window that is not an object and keeps the other', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
        rate_limits: {
          five_hour: null,
          seven_day: { used_percentage: 10, resets_at: 1776452400 },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits!.map((rateLimitWindow) => rateLimitWindow.id)).toEqual(['seven-day']);
    });

    it('skips a window that arrives as an array', () => {
      const raw = JSON.stringify({
        context_window: { used_percentage: 5 },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
        rate_limits: {
          five_hour: [],
          seven_day: { used_percentage: 10, resets_at: 1776452400 },
        },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage!.rateLimits!.map((rateLimitWindow) => rateLimitWindow.id)).toEqual(['seven-day']);
    });

    it('real payload: a 2.1.316 status.json that carries only seven_day yields one window', () => {
      // Captured from Claude Code 2.1.316 and sanitized (paths, ids, session name).
      const raw = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-status-seven-day-only.json'), 'utf8');
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toEqual([
        { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 60, resetsAt: 1793718000, windowDurationSeconds: 7 * 24 * 60 * 60 },
      ]);
    });

    it('real-world: 14% raw shows 14% on bar (not inflated)', () => {
      const raw = JSON.stringify({
        context_window: {
          used_percentage: 14,
          context_window_size: 200_000,
        },
        cost: { total_cost_usd: 0 },
        model: { id: 'claude-opus-4-6' },
      });
      const usage = ClaudeStatusParser.parseStatus(raw);
      expect(usage).not.toBeNull();
      expect(usage!.contextWindow.usedPercentage).toBe(14);
    });
  });

  // -------------------------------------------------------------------------
  // parseEvent
  // -------------------------------------------------------------------------
  describe('parseEvent', () => {
    it('parses a valid event JSON line', () => {
      const line = JSON.stringify({
        ts: 1700000000,
        type: EventType.ToolStart,
        tool: 'Read',
        detail: '/src/main.ts',
      });
      const event = ClaudeStatusParser.parseEvent(line);
      expect(event).not.toBeNull();
      expect(event!.ts).toBe(1700000000);
      expect(event!.type).toBe(EventType.ToolStart);
      expect(event!.tool).toBe('Read');
      expect(event!.detail).toBe('/src/main.ts');
    });

    it('returns null for malformed line', () => {
      expect(ClaudeStatusParser.parseEvent('not valid json {')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // parseSessionStart
  // -------------------------------------------------------------------------
  describe('parseSessionStart', () => {
    const SESSION_ID = '58bd8a86-0d47-4861-8449-63202d8e6a43';

    it('reads a fresh launch (startup) as not moving the conversation', () => {
      expect(ClaudeStatusParser.parseSessionStart(claudeSessionStartContext(SESSION_ID, 'startup')))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: false, inBackgroundSession: false });
    });

    it.each(['clear', 'resume', 'compact'] as const)('reads %s as moving the conversation to its id, in the terminal', (source) => {
      expect(ClaudeStatusParser.parseSessionStart(claudeSessionStartContext(SESSION_ID, source)))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: true, inBackgroundSession: false });
    });

    it('reads fork as the conversation moving into a background session (/bg)', () => {
      expect(ClaudeStatusParser.parseSessionStart(claudeSessionStartContext(SESSION_ID, 'fork')))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: true, inBackgroundSession: true });
    });

    it('reads a payload with no source, or an empty one, as a launch', () => {
      expect(ClaudeStatusParser.parseSessionStart(JSON.stringify({ session_id: SESSION_ID })))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: false, inBackgroundSession: false });
      expect(ClaudeStatusParser.parseSessionStart(JSON.stringify({ session_id: SESSION_ID, source: '' })))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: false, inBackgroundSession: false });
    });

    it('reads the fields by pattern when the bridge cut the payload short', () => {
      const full = claudeSessionStartContext(SESSION_ID, 'fork');
      // Cut just past the source value, as the bridge's 2048-char cap does
      // to a payload with longer paths: the JSON no longer parses.
      const cut = full.slice(0, full.indexOf('"fork"') + '"fork"'.length + 3);
      expect(() => JSON.parse(cut)).toThrow();
      expect(ClaudeStatusParser.parseSessionStart(cut))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: true, inBackgroundSession: true });
    });

    it('reads a payload cut before its source as a launch, which confirms nothing', () => {
      const full = claudeSessionStartContext(SESSION_ID, 'fork');
      const cut = full.slice(0, full.indexOf('"source"'));
      expect(ClaudeStatusParser.parseSessionStart(cut))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: false, inBackgroundSession: false });
    });

    it('does not read a quoted "source" inside a path as the field', () => {
      const tricky = `{"session_id":"${SESSION_ID}","cwd":"C:\\\\x\\"source\\":\\"fork\\"","source":"startup"`;
      expect(ClaudeStatusParser.parseSessionStart(tricky))
        .toEqual({ agentSessionId: SESSION_ID, movesConversation: false, inBackgroundSession: false });
    });

    it('returns null without a session id, or for something that is not a payload', () => {
      expect(ClaudeStatusParser.parseSessionStart(JSON.stringify({ source: 'fork' }))).toBeNull();
      expect(ClaudeStatusParser.parseSessionStart(JSON.stringify({ session_id: 42, source: 'fork' }))).toBeNull();
      expect(ClaudeStatusParser.parseSessionStart('null')).toBeNull();
      expect(ClaudeStatusParser.parseSessionStart('[]')).toBeNull();
      expect(ClaudeStatusParser.parseSessionStart('not json at all')).toBeNull();
    });
  });
});
