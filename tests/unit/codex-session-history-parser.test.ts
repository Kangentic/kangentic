import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodexSessionHistoryParser } from '../../src/main/agent/adapters/codex/session-history-parser';
import { Activity, EventType } from '../../src/shared/types';

/**
 * CodexSessionHistoryParser unit tests. Uses inline JSONL fixtures derived from
 * real Codex v0.118 rollout files (sanitized - no PII, trimmed
 * base_instructions blobs).
 */
describe('CodexSessionHistoryParser', () => {
  describe('parse', () => {
    it('extracts model, context window, and token counts from a full turn', () => {
      const jsonl = [
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.068Z',
          type: 'session_meta',
          payload: {
            id: '019d7087-5456-7f83-977b-d06b857bed26',
            timestamp: '2026-04-09T04:36:50.394Z',
            cwd: 'C:/Users/dev/project',
            cli_version: '0.118.0',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.070Z',
          type: 'task_started',
          payload: {
            turn_id: 'turn-1',
            model_context_window: 258400,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.071Z',
          type: 'turn_context',
          payload: {
            turn_id: 'turn-1',
            model: 'gpt-5.3-codex',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T04:36:52.379Z',
          type: 'token_count',
          payload: {
            info: {
              // Parser uses last_token_usage (per-turn context snapshot),
              // not total_token_usage (cumulative billed spend).
              total_token_usage: {
                input_tokens: 11214,
                cached_input_tokens: 0,
                output_tokens: 35,
                total_tokens: 11249,
              },
              last_token_usage: {
                input_tokens: 11214,
                cached_input_tokens: 0,
                output_tokens: 35,
                total_tokens: 11249,
              },
              model_context_window: 258400,
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T04:36:52.380Z',
          type: 'task_complete',
          payload: { turn_id: 'turn-1' },
        }),
      ].join('\n') + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');

      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gpt-5.3-codex');
      expect(result.usage!.model.displayName).toBe('gpt-5.3-codex');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(258400);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(11214);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(35);
      expect(result.usage!.contextWindow.usedTokens).toBe(11214);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(11214 / 258400 * 100, 2);
      // Last activity seen is task_complete, so we should report Idle.
      expect(result.activity).toBe(Activity.Idle);
    });

    it('reports Activity.Thinking when task_started is the last activity event', () => {
      const jsonl = [
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.070Z',
          type: 'task_started',
          payload: { turn_id: 'turn-1', model_context_window: 258400 },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.071Z',
          type: 'turn_context',
          payload: { turn_id: 'turn-1', model: 'gpt-5.3-codex' },
        }),
      ].join('\n') + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.activity).toBe(Activity.Thinking);
    });

    it('emits ToolStart events for function_call response_items', () => {
      const jsonl = JSON.stringify({
        timestamp: '2026-04-09T04:36:52.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: JSON.stringify({ command: ['ls'] }),
        },
      }) + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe(EventType.ToolStart);
      expect(result.events[0].detail).toBe('shell');
    });

    it('ignores malformed JSON lines without throwing', () => {
      const jsonl = [
        'not valid json',
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.071Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        }),
        '{incomplete',
      ].join('\n') + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gpt-5.3-codex');
    });

    it('returns null usage when no relevant events seen', () => {
      const jsonl = JSON.stringify({
        timestamp: '2026-04-09T04:36:51.068Z',
        type: 'unrelated_event',
        payload: { foo: 'bar' },
      }) + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).toBeNull();
      expect(result.events).toHaveLength(0);
      expect(result.activity).toBeNull();
    });

    it('handles CRLF line endings (Windows)', () => {
      const jsonl = [
        JSON.stringify({
          timestamp: '2026-04-09T04:36:51.071Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T04:36:52.379Z',
          type: 'token_count',
          payload: {
            info: {
              last_token_usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 },
              model_context_window: 100_000,
            },
          },
        }),
      ].join('\r\n') + '\r\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gpt-5.3-codex');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(500);
    });

    it('later turn_context overrides earlier (mid-session /model change)', () => {
      const jsonl = [
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
          timestamp: '2026-04-09T04:36:51.071Z',
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.4' },
          timestamp: '2026-04-09T04:40:00.000Z',
        }),
      ].join('\n') + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage!.model.id).toBe('gpt-5.4');
    });

    it('handles empty content (no-op)', () => {
      const result = CodexSessionHistoryParser.parse('', 'append');
      expect(result.usage).toBeNull();
      expect(result.events).toHaveLength(0);
      expect(result.activity).toBeNull();
    });

    it('buildUsage omits uncaptured fields from contextWindow (model-only chunk)', () => {
      // A chunk with only turn_context (model name) must NOT include
      // contextWindowSize or token fields, so the spread merge in
      // setSessionUsage() does not overwrite previously-set values.
      const jsonl = JSON.stringify({
        timestamp: '2026-04-09T04:36:51.071Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.3-codex' },
      }) + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gpt-5.3-codex');
      // Model-only chunk: contextWindow should not be present at all,
      // so the spread merge in setSessionUsage() preserves the base.
      expect(Object.prototype.hasOwnProperty.call(result.usage!, 'contextWindow')).toBe(false);
    });

    it('buildUsage omits uncaptured fields from contextWindow (token-only chunk without window size)', () => {
      // A token_count entry without model_context_window must NOT
      // include contextWindowSize in the result, so a previously-set
      // window size from task_started is preserved during merge.
      const jsonl = JSON.stringify({
        timestamp: '2026-04-09T04:38:53.854Z',
        type: 'token_count',
        payload: {
          info: {
            last_token_usage: {
              input_tokens: 180000,
              output_tokens: 50,
              cached_input_tokens: 5000,
              total_tokens: 180050,
            },
            // model_context_window intentionally absent
          },
        },
      }) + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.totalInputTokens).toBe(180000);
      expect(result.usage!.contextWindow.usedTokens).toBe(180000);
      // contextWindowSize must NOT be an own property
      expect(Object.prototype.hasOwnProperty.call(result.usage!.contextWindow, 'contextWindowSize')).toBe(false);
      // usedPercentage is never set by buildUsage - recalculated after merge
      expect(Object.prototype.hasOwnProperty.call(result.usage!.contextWindow, 'usedPercentage')).toBe(false);
    });

    it('uses last_token_usage (per-turn) not total_token_usage (cumulative)', () => {
      // Regression test for context % bar climbing past 100% on long
      // sessions. Codex reports total_token_usage as cumulative billed
      // spend across all turns - using it for the context % would be
      // wrong. The parser must read info.last_token_usage instead,
      // which is a per-turn snapshot of current context occupancy.
      const jsonl = JSON.stringify({
        timestamp: '2026-04-09T04:38:53.854Z',
        type: 'token_count',
        payload: {
          info: {
            total_token_usage: {
              input_tokens: 33693, // cumulative - would be 13% of 258400
              cached_input_tokens: 22272,
              output_tokens: 47,
              total_tokens: 33740,
            },
            last_token_usage: {
              input_tokens: 11246, // per-turn - should be 4.3% of 258400
              cached_input_tokens: 11136,
              output_tokens: 6,
              total_tokens: 11252,
            },
            model_context_window: 258400,
          },
        },
      }) + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      // Must match last_token_usage, not total_token_usage.
      expect(result.usage!.contextWindow.totalInputTokens).toBe(11246);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(6);
      expect(result.usage!.contextWindow.cacheTokens).toBe(11136);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(11246 / 258400 * 100, 2);
    });

    it('extracts usage from event_msg-wrapped task_started + token_count (Codex 0.118+)', () => {
      // Regression test for the "Codex 0% context" bug. Codex 0.118+
      // wraps lifecycle events inside an `event_msg` envelope - the
      // outer entry.type is "event_msg" and the real event name moved
      // to payload.type. Inner field layout (model_context_window,
      // info.last_token_usage, ...) is unchanged. Before the parser
      // unwrap, none of the dispatch branches matched these lines and
      // usage stayed null all the way to the ContextBar - showing 0%
      // for the entire session.
      const jsonl = [
        JSON.stringify({
          timestamp: '2026-04-11T04:10:55.785Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: '019d7abc-5120-7be0-be2b-30cc72b45e80',
            model_context_window: 258400,
            collaboration_mode_kind: 'default',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-11T04:10:55.786Z',
          type: 'turn_context',
          payload: {
            turn_id: '019d7abc-5120-7be0-be2b-30cc72b45e80',
            model: 'gpt-5.3-codex',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-11T04:10:56.464Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 21122, cached_input_tokens: 10496, output_tokens: 334, total_tokens: 21456 },
              last_token_usage: { input_tokens: 10569, cached_input_tokens: 10496, output_tokens: 328, total_tokens: 10897 },
              model_context_window: 258400,
            },
            rate_limits: null,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-11T04:10:56.465Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: '019d7abc-5120-7be0-be2b-30cc72b45e80', last_agent_message: '...' },
        }),
      ].join('\n') + '\n';

      const result = CodexSessionHistoryParser.parse(jsonl, 'append');

      // Pre-fix this is the assertion that fails: result.usage is null
      // because no branch matched the wrapped event_msg shape.
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gpt-5.3-codex');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(258400);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(10569);
      expect(result.usage!.contextWindow.usedTokens).toBe(10569);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(10569 / 258400 * 100, 2);
      // task_complete was the last activity event in the chunk.
      expect(result.activity).toBe(Activity.Idle);
    });

    it('replays a sanitized real Codex 0.118 rollout fixture and gets non-zero usage', () => {
      // Empirical reproduction of the bug. The fixture is a hand-trimmed,
      // PII-stripped copy of an actual ~/.codex/sessions/.../rollout-*.jsonl
      // written by Codex CLI v0.118.0. Pre-fix the parser silently dropped
      // every event_msg-wrapped line and returned null usage; post-fix it
      // produces a real percentage. Catches future format drift the same
      // day Codex ships it - update the fixture, the test fails, we fix
      // the parser.
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'codex-rollout-event-msg.jsonl');
      const content = fs.readFileSync(fixturePath, 'utf-8');
      const result = CodexSessionHistoryParser.parse(content, 'append');

      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.contextWindowSize).toBe(258400);
      expect(result.usage!.contextWindow.usedPercentage).toBeGreaterThan(0);
      expect(result.usage!.contextWindow.usedTokens).toBeGreaterThan(0);
      // Last activity event in the fixture is task_complete.
      expect(result.activity).toBe(Activity.Idle);
    });
  });
});
