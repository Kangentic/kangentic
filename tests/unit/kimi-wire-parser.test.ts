/**
 * Unit tests for the Kimi wire.jsonl parser.
 *
 * Drives the parser with three fixtures:
 *
 *   1. wire-real.jsonl - captured from a real `kimi --print` run on this
 *      machine (no LLM auth, so only metadata + TurnBegin/TurnEnd events).
 *      Pins the empirical envelope shape so a future Kimi release can't
 *      silently break the parser by reformatting the JSONL header.
 *
 *   2. wire-rich.jsonl - synthesized to exercise StatusUpdate, ToolCall,
 *      ToolResult, StepBegin, and full token-usage parsing per the
 *      upstream schema in docs/en/customization/wire-mode.md (wire
 *      protocol 1.9).
 *
 *   3. wire-subagent.jsonl - synthesized capture of a turn that delegates
 *      to the `Agent` tool, exercising the `SubagentEvent` envelope and
 *      its nested-Event lifecycle. Mirrors the upstream Pydantic schema
 *      in `src/kimi_cli/wire/types.py` and the runner emission site at
 *      `src/kimi_cli/subagents/runner.py:419-426`. Replace with a real
 *      capture once Moonshot credentials are wired into the dev loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseWireJsonl,
  KIMI_TOOL_FALLBACK_NAME,
  KIMI_BTW_SUBAGENT_NAME,
  KIMI_SUBAGENT_FALLBACK_NAME,
} from '../../src/main/agent/adapters/kimi/wire-parser';
import { Activity, EventType, IdleReason } from '../../src/shared/types';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'kimi');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('parseWireJsonl', () => {
  describe('against the real captured wire.jsonl (TurnBegin/End only)', () => {
    const content = loadFixture('wire-real.jsonl');

    it('skips the metadata header line without throwing', () => {
      const result = parseWireJsonl(content, 'append');
      // Real fixture is TurnBegin "hello" / TurnEnd / TurnBegin "hello" / TurnEnd.
      // Each TurnBegin extracts the user_input text into a Prompt event; the
      // metadata header line itself is silently skipped (no error, no event).
      expect(result.events).toHaveLength(2);
      expect(result.events.every((event) => event.type === EventType.Prompt)).toBe(true);
      expect(result.events.every((event) => event.detail === 'hello')).toBe(true);
    });

    it('settles on Idle when the chunk ends with TurnEnd', () => {
      const result = parseWireJsonl(content, 'append');
      // Real fixture has TurnBegin, TurnEnd, TurnBegin, TurnEnd.
      // The final transition is Idle.
      expect(result.activity).toBe(Activity.Idle);
    });

    it('emits no usage when no StatusUpdate is present', () => {
      const result = parseWireJsonl(content, 'append');
      expect(result.usage).toBeNull();
    });
  });

  describe('against the synthesized rich fixture', () => {
    const content = loadFixture('wire-rich.jsonl');

    it('parses both ToolCall events as ToolStart entries', () => {
      const result = parseWireJsonl(content, 'append');
      const toolStarts = result.events.filter((event) => event.type === EventType.ToolStart);
      expect(toolStarts).toHaveLength(2);
      expect(toolStarts[0].detail).toBe('Shell');
      expect(toolStarts[1].detail).toBe('ReadFile');
    });

    it('parses both ToolResult events as ToolEnd entries with error flag', () => {
      const result = parseWireJsonl(content, 'append');
      const toolEnds = result.events.filter((event) => event.type === EventType.ToolEnd);
      expect(toolEnds).toHaveLength(2);
      expect(toolEnds[0].detail).toBe('ok');
      expect(toolEnds[1].detail).toBe('error');
    });

    it('converts unix-seconds timestamps to epoch milliseconds', () => {
      const result = parseWireJsonl(content, 'append');
      const firstToolStart = result.events.find((event) => event.type === EventType.ToolStart);
      // 1776824399.500 seconds -> 1776824399500 ms (rounded).
      expect(firstToolStart?.ts).toBe(1776824399500);
    });

    it('captures the final StatusUpdate context_usage as last-wins', () => {
      const result = parseWireJsonl(content, 'append');
      // 0.18 ratio → 18%.
      expect(result.usage?.contextWindow.usedPercentage).toBeCloseTo(18, 1);
    });

    it('captures context_tokens and max_context_tokens', () => {
      const result = parseWireJsonl(content, 'append');
      expect(result.usage?.contextWindow.usedTokens).toBe(36864);
      expect(result.usage?.contextWindow.contextWindowSize).toBe(200000);
    });

    it('aggregates token_usage into totalInputTokens (input_other + cache_read + cache_creation)', () => {
      const result = parseWireJsonl(content, 'append');
      // Last StatusUpdate: input_other=1200, cache_read=2048, cache_creation=0.
      expect(result.usage?.contextWindow.totalInputTokens).toBe(3248);
    });

    it('carries totalOutputTokens through as last-wins', () => {
      const result = parseWireJsonl(content, 'append');
      expect(result.usage?.contextWindow.totalOutputTokens).toBe(280);
    });

    it('captures cacheTokens as the sum of cache_read + cache_creation', () => {
      const result = parseWireJsonl(content, 'append');
      // Last StatusUpdate: cache_read=2048, cache_creation=0.
      expect(result.usage?.contextWindow.cacheTokens).toBe(2048);
    });

    it('settles on Idle when the rich chunk ends with TurnEnd', () => {
      const result = parseWireJsonl(content, 'append');
      expect(result.activity).toBe(Activity.Idle);
    });
  });

  describe('event ordering', () => {
    it('preserves the chronological order of Prompt + ToolStart/ToolEnd pairs', () => {
      const content = loadFixture('wire-rich.jsonl');
      const result = parseWireJsonl(content, 'append');
      const ordered = result.events.map((event) => `${event.type}:${event.detail}`);
      // The rich fixture begins with TurnBegin (user_input: "list files"),
      // which now emits a Prompt event ahead of the tool pairs.
      expect(ordered).toEqual([
        'prompt:list files',
        'tool_start:Shell',
        'tool_end:ok',
        'tool_start:ReadFile',
        'tool_end:error',
      ]);
    });
  });

  describe('partial chunks (append-mode incremental parsing)', () => {
    it('settles on Thinking when the chunk only contains TurnBegin', () => {
      const partial = '{"timestamp": 1.0, "message": {"type": "TurnBegin", "payload": {}}}\n';
      const result = parseWireJsonl(partial, 'append');
      expect(result.activity).toBe(Activity.Thinking);
    });

    it('settles on Thinking when the chunk only contains StepBegin', () => {
      const partial = '{"timestamp": 1.0, "message": {"type": "StepBegin", "payload": {}}}\n';
      const result = parseWireJsonl(partial, 'append');
      expect(result.activity).toBe(Activity.Thinking);
    });

    it('settles on Idle when the chunk contains StepInterrupted', () => {
      const partial = '{"timestamp": 1.0, "message": {"type": "StepInterrupted", "payload": {}}}\n';
      const result = parseWireJsonl(partial, 'append');
      expect(result.activity).toBe(Activity.Idle);
    });

    it('returns activity null on a chunk with no transitional events', () => {
      const partial = '{"timestamp": 1.0, "message": {"type": "ContentPart", "payload": {"type": "text", "text": "x"}}}\n';
      const result = parseWireJsonl(partial, 'append');
      expect(result.activity).toBeNull();
    });
  });

  describe('defensive parsing', () => {
    it('skips malformed JSON lines without throwing', () => {
      const mixed = [
        '{"type": "metadata", "protocol_version": "1.9"}',
        'this is not json',
        '{"timestamp": 1.0, "message": {"type": "TurnBegin", "payload": {}}}',
        '{"timestamp": 2.0, "message": {"type": "TurnEnd", "payload": {}}}',
      ].join('\n');
      const result = parseWireJsonl(mixed, 'append');
      expect(result.activity).toBe(Activity.Idle);
    });

    it('skips lines whose message envelope is missing a recognized type', () => {
      const content = '{"timestamp": 1.0, "message": {"type": "FutureUnknownEvent", "payload": {}}}\n';
      const result = parseWireJsonl(content, 'append');
      expect(result.events).toEqual([]);
      expect(result.activity).toBeNull();
      expect(result.usage).toBeNull();
    });

    it('returns a fully-empty result for an empty body', () => {
      const result = parseWireJsonl('', 'append');
      expect(result).toEqual({ usage: null, events: [], activity: null });
    });

    it('handles CRLF line endings', () => {
      const content = '{"type": "metadata", "protocol_version": "1.9"}\r\n'
        + '{"timestamp": 1.0, "message": {"type": "TurnBegin", "payload": {}}}\r\n'
        + '{"timestamp": 2.0, "message": {"type": "TurnEnd", "payload": {}}}\r\n';
      const result = parseWireJsonl(content, 'append');
      expect(result.activity).toBe(Activity.Idle);
    });
  });

  describe('defensive ToolCall / ToolResult handling', () => {
    it('falls back to payload.type when ToolCall payload has no function.name', () => {
      // When the upstream Kimi release sends a ToolCall without a nested
      // function.name, the parser falls back to payload.type (e.g. "function")
      // as the detail field so the ToolStart event is still emitted.
      const content = JSON.stringify({
        timestamp: 1776824399.5,
        message: {
          type: 'ToolCall',
          payload: {
            // No `function` property at all.
            type: 'function',
            call_id: 'call-abc',
          },
        },
      }) + '\n';
      const result = parseWireJsonl(content, 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe(EventType.ToolStart);
      // detail should be the fallback payload.type value.
      expect(result.events[0].detail).toBe('function');
    });

    it('falls back to "tool" when ToolCall payload has no function.name and no payload.type', () => {
      const content = JSON.stringify({
        timestamp: 1776824399.5,
        message: {
          type: 'ToolCall',
          payload: {
            call_id: 'call-xyz',
            // Neither function nor type field.
          },
        },
      }) + '\n';
      const result = parseWireJsonl(content, 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe(EventType.ToolStart);
      expect(result.events[0].detail).toBe(KIMI_TOOL_FALLBACK_NAME);
    });

    it('emits a ToolEnd event with detail "ok" when ToolResult has no return_value', () => {
      // A ToolResult payload missing return_value entirely must still produce
      // a ToolEnd event. The isError check falls to false when return_value is
      // absent (undefined is not a Record), so detail must be "ok".
      const content = JSON.stringify({
        timestamp: 1776824400.0,
        message: {
          type: 'ToolResult',
          payload: {
            call_id: 'call-abc',
            // return_value intentionally absent.
          },
        },
      }) + '\n';
      const result = parseWireJsonl(content, 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe(EventType.ToolEnd);
      expect(result.events[0].detail).toBe('ok');
    });

    it('emits a ToolEnd event with detail "ok" when ToolResult return_value is a non-Record (e.g. string)', () => {
      // If return_value is a plain string instead of a Record, the isError check
      // must safely short-circuit and emit "ok", not throw.
      const content = JSON.stringify({
        timestamp: 1776824400.5,
        message: {
          type: 'ToolResult',
          payload: {
            call_id: 'call-abc',
            return_value: 'success output',
          },
        },
      }) + '\n';
      const result = parseWireJsonl(content, 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe(EventType.ToolEnd);
      expect(result.events[0].detail).toBe('ok');
    });
  });

  describe('derived percentage fallback', () => {
    it('derives usedPercentage from tokens when context_usage is absent', () => {
      const content = '{"timestamp": 1.0, "message": {"type": "StatusUpdate", "payload": {'
        + '"context_tokens": 50000, "max_context_tokens": 200000}}}';
      const result = parseWireJsonl(content, 'append');
      expect(result.usage?.contextWindow.usedPercentage).toBeCloseTo(25, 1);
    });

    it('omits usedPercentage entirely when neither ratio nor token math is possible', () => {
      const content = '{"timestamp": 1.0, "message": {"type": "StatusUpdate", "payload": {'
        + '"token_usage": {"input_other": 100, "output": 50, "input_cache_read": 0, "input_cache_creation": 0}}}}';
      const result = parseWireJsonl(content, 'append');
      expect(result.usage?.contextWindow.usedPercentage).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Full wire-protocol coverage (every documented Event + Request type).
  // Schema source: docs/en/customization/wire-mode.md (wire protocol 1.9).
  // ────────────────────────────────────────────────────────────────────

  /** Build one wire-envelope JSONL line. */
  function envelope(messageType: string, payload: object, timestamp = 1_000_000.0): string {
    return JSON.stringify({ timestamp, message: { type: messageType, payload } });
  }

  describe('TurnBegin user_input variants', () => {
    it('extracts a string user_input directly into the Prompt detail', () => {
      const result = parseWireJsonl(envelope('TurnBegin', { user_input: 'hello world' }), 'append');
      expect(result.activity).toBe(Activity.Thinking);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: EventType.Prompt,
        detail: 'hello world',
      });
    });

    it('joins multiple TextPart parts in a ContentPart[] user_input', () => {
      const result = parseWireJsonl(envelope('TurnBegin', {
        user_input: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      }), 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].detail).toBe('part one part two');
    });

    it('skips ThinkPart and media parts when extracting prompt text', () => {
      const result = parseWireJsonl(envelope('TurnBegin', {
        user_input: [
          { type: 'think', think: 'reasoning content' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
          { type: 'text', text: 'real prompt' },
        ],
      }), 'append');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].detail).toBe('real prompt');
    });

    it('emits no Prompt event when user_input is empty/whitespace', () => {
      const result = parseWireJsonl(envelope('TurnBegin', { user_input: '   \n' }), 'append');
      expect(result.events).toHaveLength(0);
      // Activity transition still fires.
      expect(result.activity).toBe(Activity.Thinking);
    });

    it('emits no Prompt event when ContentPart[] has no text parts', () => {
      const result = parseWireJsonl(envelope('TurnBegin', {
        user_input: [
          { type: 'think', think: 'thoughts' },
          { type: 'image_url', image_url: { url: 'x' } },
        ],
      }), 'append');
      expect(result.events).toHaveLength(0);
    });

    it('handles a missing user_input field defensively', () => {
      const result = parseWireJsonl(envelope('TurnBegin', {}), 'append');
      expect(result.activity).toBe(Activity.Thinking);
      expect(result.events).toHaveLength(0);
    });
  });

  describe('CompactionBegin / CompactionEnd', () => {
    it('CompactionBegin emits a Compact event and sets activity to Thinking', () => {
      const result = parseWireJsonl(envelope('CompactionBegin', {}), 'append');
      expect(result.activity).toBe(Activity.Thinking);
      expect(result.events).toEqual([
        expect.objectContaining({ type: EventType.Compact }),
      ]);
    });

    it('CompactionEnd preserves prior activity and emits no event', () => {
      // Run a chunk that goes Thinking → CompactionBegin → CompactionEnd.
      // Final activity should remain Thinking (last *transition* was Begin).
      const content = [
        envelope('TurnBegin', { user_input: 'x' }, 1.0),
        envelope('CompactionBegin', {}, 1.1),
        envelope('CompactionEnd', {}, 1.2),
      ].join('\n');
      const result = parseWireJsonl(content, 'append');
      expect(result.activity).toBe(Activity.Thinking);
      // Events: Prompt (from TurnBegin), Compact (from CompactionBegin).
      // CompactionEnd contributes nothing.
      expect(result.events.map((event) => event.type)).toEqual([
        EventType.Prompt,
        EventType.Compact,
      ]);
    });
  });

  describe('StepInterrupted', () => {
    it('emits an Interrupted event and sets activity to Idle', () => {
      const result = parseWireJsonl(envelope('StepInterrupted', {}), 'append');
      expect(result.activity).toBe(Activity.Idle);
      expect(result.events).toEqual([
        expect.objectContaining({ type: EventType.Interrupted }),
      ]);
    });
  });

  describe('SteerInput (mid-turn user steering)', () => {
    it('emits a Prompt event and re-asserts Thinking activity', () => {
      const content = [
        envelope('TurnEnd', {}, 1.0),
        envelope('SteerInput', { user_input: 'change direction' }, 2.0),
      ].join('\n');
      const result = parseWireJsonl(content, 'append');
      // SteerInput overrides the prior Idle from TurnEnd.
      expect(result.activity).toBe(Activity.Thinking);
      const promptEvents = result.events.filter((event) => event.type === EventType.Prompt);
      expect(promptEvents).toHaveLength(1);
      expect(promptEvents[0].detail).toBe('change direction');
    });
  });

  describe('ContentPart and ToolCallPart (streaming fragments)', () => {
    it('ContentPart does not emit an event or change activity', () => {
      const result = parseWireJsonl(
        envelope('ContentPart', { type: 'text', text: 'streamed partial...' }),
        'append',
      );
      expect(result.events).toEqual([]);
      expect(result.activity).toBeNull();
    });

    it('ToolCallPart does not emit an event or change activity', () => {
      const result = parseWireJsonl(
        envelope('ToolCallPart', { arguments_part: '{"foo":' }),
        'append',
      );
      expect(result.events).toEqual([]);
      expect(result.activity).toBeNull();
    });
  });

  describe('Approval / Question flow (Requests)', () => {
    it('ApprovalRequest sets activity to Idle with IdleReason.Permission', () => {
      const result = parseWireJsonl(envelope('ApprovalRequest', {
        id: 'req-1',
        tool_call_id: 'tc-1',
        sender: 'agent',
        action: 'edit_file',
        description: 'Modify package.json',
      }), 'append');
      expect(result.activity).toBe(Activity.Idle);
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.Idle,
          detail: IdleReason.Permission,
        }),
      ]);
    });

    it('QuestionRequest also drops to Idle with IdleReason.Permission', () => {
      const result = parseWireJsonl(envelope('QuestionRequest', {
        id: 'q-1',
        tool_call_id: 'tc-2',
        questions: [{ question: 'Pick a framework', options: [{ label: 'React' }] }],
      }), 'append');
      expect(result.activity).toBe(Activity.Idle);
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.Idle,
          detail: IdleReason.Permission,
        }),
      ]);
    });

    it('ApprovalResponse flips activity back to Thinking and notes the response', () => {
      const result = parseWireJsonl(envelope('ApprovalResponse', {
        request_id: 'req-1',
        response: 'approve',
      }), 'append');
      expect(result.activity).toBe(Activity.Thinking);
      const notification = result.events.find((event) => event.type === EventType.Notification);
      expect(notification?.detail).toBe('approve');
    });

    it('ApprovalResponse with reject still resumes activity (the agent unblocks either way)', () => {
      const result = parseWireJsonl(envelope('ApprovalResponse', {
        request_id: 'req-1',
        response: 'reject',
        feedback: 'too risky',
      }), 'append');
      expect(result.activity).toBe(Activity.Thinking);
      expect(result.events[0].detail).toBe('reject');
    });

    it('ApprovalRequest → ApprovalResponse settles on Thinking (response is most recent)', () => {
      const content = [
        envelope('ApprovalRequest', { id: 'r1', tool_call_id: 't1', sender: 'a', action: 'x', description: 'y' }, 1.0),
        envelope('ApprovalResponse', { request_id: 'r1', response: 'approve' }, 2.0),
      ].join('\n');
      const result = parseWireJsonl(content, 'append');
      expect(result.activity).toBe(Activity.Thinking);
    });
  });

  describe('Subagent / BtwBegin / BtwEnd', () => {
    it('SubagentEvent emits a Notification with subagent_type', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        parent_tool_call_id: 'tc-parent',
        agent_id: 'sub-1',
        subagent_type: 'researcher',
        event: { type: 'started', payload: {} },
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('researcher');
    });

    it('SubagentEvent falls back to agent_id when subagent_type is missing', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        agent_id: 'sub-42',
        event: { type: 'tick', payload: {} },
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('sub-42');
    });

    it('SubagentEvent falls back to a stable sentinel when neither subagent_type nor agent_id present', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        event: { type: 'tick', payload: {} },
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe(KIMI_SUBAGENT_FALLBACK_NAME);
    });

    it('BtwBegin emits SubagentStart with the "btw" sentinel', () => {
      const result = parseWireJsonl(envelope('BtwBegin', {
        id: 'btw-1',
        question: 'What does this regex match?',
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.SubagentStart,
          detail: KIMI_BTW_SUBAGENT_NAME,
        }),
      ]);
    });

    it('BtwEnd emits SubagentStop with the "btw" sentinel', () => {
      const result = parseWireJsonl(envelope('BtwEnd', {
        id: 'btw-1',
        response: 'matches uppercase letters',
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.SubagentStop,
          detail: KIMI_BTW_SUBAGENT_NAME,
        }),
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SubagentEvent inner-event lifecycle decoding.
  //
  // The runner wraps every wire Event a subagent emits inside a
  // SubagentEvent envelope (src/kimi_cli/subagents/runner.py:419-426).
  // The inner `event` is itself a full wire Event union, so TurnBegin /
  // TurnEnd are the natural lifecycle markers. The parser maps those to
  // SubagentStart / SubagentStop and falls back to Notification for
  // every other inner type so non-lifecycle chatter (StatusUpdate,
  // ToolCall, ContentPart, ...) still surfaces in the activity log.
  // ────────────────────────────────────────────────────────────────────

  describe('SubagentEvent inner lifecycle decoding', () => {
    it('emits SubagentStart when inner event.type === "TurnBegin"', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        parent_tool_call_id: 'tc-1',
        agent_id: 'sub-1',
        subagent_type: 'explore',
        event: { type: 'TurnBegin', payload: { user_input: 'list files' } },
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.SubagentStart,
          detail: 'explore',
        }),
      ]);
    });

    it('emits SubagentStop when inner event.type === "TurnEnd"', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        parent_tool_call_id: 'tc-1',
        agent_id: 'sub-1',
        subagent_type: 'explore',
        event: { type: 'TurnEnd', payload: {} },
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.SubagentStop,
          detail: 'explore',
        }),
      ]);
    });

    it('uses agent_id as detail when subagent_type is missing on a TurnBegin lifecycle event', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        agent_id: 'sub-42',
        event: { type: 'TurnBegin', payload: {} },
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.SubagentStart,
          detail: 'sub-42',
        }),
      ]);
    });

    it('falls back to KIMI_SUBAGENT_FALLBACK_NAME when both subagent_type and agent_id are absent', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        event: { type: 'TurnEnd', payload: {} },
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.SubagentStop,
          detail: KIMI_SUBAGENT_FALLBACK_NAME,
        }),
      ]);
    });

    it('routes inner StatusUpdate to Notification (non-lifecycle inner type)', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        agent_id: 'sub-1',
        subagent_type: 'coder',
        event: {
          type: 'StatusUpdate',
          payload: { context_usage: 0.1, context_tokens: 1000, max_context_tokens: 200000 },
        },
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.Notification,
          detail: 'coder',
        }),
      ]);
    });

    it('routes inner ToolCall to Notification (non-lifecycle inner type)', () => {
      const result = parseWireJsonl(envelope('SubagentEvent', {
        subagent_type: 'coder',
        event: {
          type: 'ToolCall',
          payload: { type: 'function', function: { name: 'Shell', arguments: '{}' } },
        },
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.Notification,
          detail: 'coder',
        }),
      ]);
    });

    it('routes inner events with malformed envelopes to Notification (defensive)', () => {
      // Inner `event` is missing entirely - the envelope still produces
      // a Notification keyed by subagent_type. Robust against future
      // protocol bumps that ship optional or malformed inner payloads.
      const result = parseWireJsonl(envelope('SubagentEvent', {
        subagent_type: 'plan',
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.Notification,
          detail: 'plan',
        }),
      ]);
    });

    it('routes scalar event field values (number, string, null) to Notification (extractInnerEventType returns null)', () => {
      // extractInnerEventType guards against non-Record values (scalars,
      // null, arrays). Each of these must fall through to the Notification
      // branch so the Activity log row is still emitted rather than silently
      // dropped. This completes the defensive-parsing matrix for the `event`
      // field alongside the "missing event" test above.
      const scalarCases: unknown[] = [42, 'TurnBegin', null, ['TurnBegin']];
      for (const scalarEvent of scalarCases) {
        const content = JSON.stringify({
          timestamp: 1_000_000.0,
          message: {
            type: 'SubagentEvent',
            payload: {
              subagent_type: 'explorer',
              event: scalarEvent,
            },
          },
        });
        const result = parseWireJsonl(content, 'append');
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe(EventType.Notification);
        expect(result.events[0].detail).toBe('explorer');
      }
    });

    it('drives the wire-subagent.jsonl fixture into the expected lifecycle sequence', () => {
      const content = loadFixture('wire-subagent.jsonl');
      const result = parseWireJsonl(content, 'append');
      // Final transition is the outer TurnEnd → Idle.
      expect(result.activity).toBe(Activity.Idle);
      // Events: parent Prompt, parent ToolStart(Agent), then the wrapped
      // subagent lifecycle (SubagentStart, two Notifications for the
      // mid-run StatusUpdate + ToolCall chatter, SubagentStop), and
      // finally the parent ToolEnd.
      const ordered = result.events.map((event) => `${event.type}:${event.detail}`);
      expect(ordered).toEqual([
        'prompt:delegate exploration',
        'tool_start:Agent',
        'subagent_start:explore',
        'notification:explore',
        'notification:explore',
        'subagent_stop:explore',
        'tool_end:ok',
      ]);
    });
  });

  describe('Plan / hook telemetry', () => {
    it('PlanDisplay emits a Notification with the file_path', () => {
      const result = parseWireJsonl(envelope('PlanDisplay', {
        content: '# Plan\n- step 1',
        file_path: '/projects/foo/PLAN.md',
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('/projects/foo/PLAN.md');
    });

    it('PlanDisplay falls back to "plan" when file_path is missing', () => {
      const result = parseWireJsonl(envelope('PlanDisplay', {
        content: '# inline plan',
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('plan');
    });

    it('HookTriggered formats detail as "<event>:<target>"', () => {
      const result = parseWireJsonl(envelope('HookTriggered', {
        event: 'pre_tool_use',
        target: 'Shell',
        hook_count: 2,
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('pre_tool_use:Shell');
    });

    it('HookResolved formats detail as "<event>:<action>" with reason in parens when present', () => {
      const result = parseWireJsonl(envelope('HookResolved', {
        event: 'pre_tool_use',
        target: 'Shell',
        action: 'block',
        reason: 'rm -rf forbidden',
        duration_ms: 12,
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('pre_tool_use:block (rm -rf forbidden)');
    });

    it('HookResolved omits the parens block when reason is missing', () => {
      const result = parseWireJsonl(envelope('HookResolved', {
        event: 'pre_tool_use',
        target: 'Shell',
        action: 'allow',
        duration_ms: 0,
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('pre_tool_use:allow');
    });

    it('HookRequest is treated as Notification telemetry (request form of HookTriggered)', () => {
      const result = parseWireJsonl(envelope('HookRequest', {
        id: 'hreq-1',
        subscription_id: 'sub-1',
        event: 'on_user_input',
        target: 'all',
        input_data: { user_input: 'hi' },
      }), 'append');
      const notif = result.events.find((event) => event.type === EventType.Notification);
      expect(notif?.detail).toBe('on_user_input:all');
    });
  });

  describe('ToolCallRequest (bidirectional tool call)', () => {
    it('emits ToolStart so activity tracking sees an in-flight tool', () => {
      const result = parseWireJsonl(envelope('ToolCallRequest', {
        id: 'tcr-1',
        name: 'WriteFile',
        arguments: '{"path":"foo"}',
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.ToolStart,
          detail: 'WriteFile',
        }),
      ]);
    });

    it('falls back to KIMI_TOOL_FALLBACK_NAME when name is missing', () => {
      const result = parseWireJsonl(envelope('ToolCallRequest', {
        id: 'tcr-2',
      }), 'append');
      expect(result.events).toEqual([
        expect.objectContaining({
          type: EventType.ToolStart,
          detail: KIMI_TOOL_FALLBACK_NAME,
        }),
      ]);
    });
  });

  describe('Full lifecycle replay (every dispatch type in one chunk)', () => {
    /**
     * Synthesizes a realistic session covering every documented wire
     * message type in roughly the order they would fire on a turn that
     * involves: a user prompt, a step that calls a tool, a hook firing,
     * a sub-agent (Brain Truster) being consulted, a permission prompt
     * being resolved, a context compaction, mid-turn steering, a plan
     * display, and finally turn end.
     *
     * Asserts the parser produces events in the expected shape and
     * settles on Idle (final TurnEnd).
     */
    it('produces a coherent SessionHistoryParseResult covering every message type', () => {
      const lines = [
        envelope('TurnBegin', { user_input: 'fix the bug' }, 1.0),
        envelope('StepBegin', { n: 1 }, 1.05),
        envelope('StatusUpdate', {
          context_usage: 0.05, context_tokens: 10000, max_context_tokens: 200000,
          token_usage: { input_other: 500, output: 100, input_cache_read: 0, input_cache_creation: 0 },
        }, 1.1),
        envelope('ContentPart', { type: 'text', text: 'I will start by ' }, 1.15),
        envelope('ToolCall', {
          type: 'function', id: 'tc-1',
          function: { name: 'Shell', arguments: '{"command":"ls"}' },
        }, 1.2),
        envelope('ToolCallPart', { arguments_part: '"--all"' }, 1.21),
        envelope('ApprovalRequest', {
          id: 'a-1', tool_call_id: 'tc-1', sender: 'agent', action: 'shell', description: 'ls',
        }, 1.25),
        envelope('ApprovalResponse', { request_id: 'a-1', response: 'approve' }, 1.3),
        envelope('ToolResult', {
          tool_call_id: 'tc-1',
          return_value: { is_error: false, output: 'ok', message: '', display: [] },
        }, 1.35),
        envelope('HookTriggered', { event: 'post_tool_use', target: 'Shell', hook_count: 1 }, 1.4),
        envelope('HookResolved', {
          event: 'post_tool_use', target: 'Shell', action: 'allow', reason: '', duration_ms: 5,
        }, 1.45),
        envelope('BtwBegin', { id: 'btw-1', question: 'review?' }, 1.5),
        envelope('BtwEnd', { id: 'btw-1', response: 'looks good' }, 1.55),
        envelope('SubagentEvent', { subagent_type: 'reviewer', event: { type: 'finished', payload: {} } }, 1.6),
        envelope('CompactionBegin', {}, 1.65),
        envelope('CompactionEnd', {}, 1.7),
        envelope('SteerInput', { user_input: 'also write tests' }, 1.75),
        envelope('PlanDisplay', { content: '# plan', file_path: 'PLAN.md' }, 1.8),
        envelope('QuestionRequest', { id: 'q-1', tool_call_id: 'tc-1', questions: [{ question: 'continue?', options: [{ label: 'yes' }] }] }, 1.85),
        envelope('StepInterrupted', {}, 1.9),
        envelope('TurnEnd', {}, 1.95),
      ];
      const content = lines.join('\n');
      const result = parseWireJsonl(content, 'append');

      // Final activity is Idle (TurnEnd is the last transition).
      expect(result.activity).toBe(Activity.Idle);

      // Pluck event types in order to verify the dispatch firing.
      const eventTypes = result.events.map((event) => event.type);
      // Prompt (TurnBegin), ToolStart (ToolCall), Idle (ApprovalRequest),
      // Notification (ApprovalResponse), ToolEnd (ToolResult),
      // Notification (HookTriggered), Notification (HookResolved),
      // SubagentStart (BtwBegin), SubagentStop (BtwEnd),
      // Notification (SubagentEvent), Compact (CompactionBegin),
      // Prompt (SteerInput), Notification (PlanDisplay),
      // Idle (QuestionRequest), Interrupted (StepInterrupted).
      expect(eventTypes).toEqual([
        EventType.Prompt,
        EventType.ToolStart,
        EventType.Idle,
        EventType.Notification,
        EventType.ToolEnd,
        EventType.Notification,
        EventType.Notification,
        EventType.SubagentStart,
        EventType.SubagentStop,
        EventType.Notification,
        EventType.Compact,
        EventType.Prompt,
        EventType.Notification,
        EventType.Idle,
        EventType.Interrupted,
      ]);

      // Usage was captured from the StatusUpdate.
      expect(result.usage?.contextWindow.contextWindowSize).toBe(200000);
      expect(result.usage?.contextWindow.usedTokens).toBe(10000);
    });
  });
});
