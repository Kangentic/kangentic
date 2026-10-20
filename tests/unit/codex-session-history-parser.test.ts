import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { CodexSessionHistoryParser, resetCodexCallMemosForTests } from '../../src/main/agent/adapters/codex/session-history-parser';
import { EventType, AgentTool, type SessionEvent } from '../../src/shared/types';
import { NO_ACTIVITY_HOLD_FLAG } from '../../src/shared/background-shell-hold';

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
      // A turn's end is the Stop hook's (task #859): a forced idle here raced
      // it and ended no turn for onTurnEnded.
      expect(result.activity).toBeNull();
      expect(result.events).toEqual([]);
    });

    it('forces no activity when task_started is the last record', () => {
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
      // The turn's start is the UserPromptSubmit hook's.
      expect(result.activity).toBeNull();
    });

    it('emits no tool event for a function_call: the PreToolUse hook reports it, with its id', () => {
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
      expect(result.events).toEqual([]);
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
      expect(result.activity).toBeNull();
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
      expect(result.activity).toBeNull();
    });
  });

  describe('what no Codex hook reports (task #859, measured on 0.154.0 and 0.163.0)', () => {
    beforeEach(() => {
      resetCodexCallMemosForTests();
    });

    const rolloutLines = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-rollout-background-session.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0);

    // Real Codex 0.163.0 records: a turn_aborted, then a task_complete carrying error.message.
    const turnEndLines = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-rollout-turn-ends.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0);

    it('reports a command still running at its yield as a named start keyed by its call id', () => {
      // Each line is its own read: a call and its output never share one.
      const events = rolloutLines.flatMap((line) => CodexSessionHistoryParser.parse(`${line}\n`, 'append').events);
      expect(events).toEqual([
        expect.objectContaining({ type: EventType.BackgroundShellStart, toolId: 'call_probe_1', detail: '88918' }),
        // The poll of a still-running process repeats the start; the engine reads a duplicate.
        expect.objectContaining({ type: EventType.BackgroundShellStart, toolId: 'call_probe_3', detail: '88918' }),
        expect.objectContaining({ type: EventType.BackgroundShellStart, toolId: 'call_probe_4', detail: '95311', noActivityHold: true }),
      ]);
      expect(events[0].noActivityHold).toBeUndefined();
    });

    it('ends a background command when a poll of its exec session finds it exited', () => {
      const call = JSON.stringify({ timestamp: '2026-10-20T15:30:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', arguments: '{"session_id":88918,"chars":"","yield_time_ms":5000}', call_id: 'call_poll' } });
      const output = JSON.stringify({ timestamp: '2026-10-20T15:30:05.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_poll', output: 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n' } });
      expect(CodexSessionHistoryParser.parse(`${call}\n`, 'append').events).toEqual([]);
      expect(CodexSessionHistoryParser.parse(`${output}\n`, 'append').events).toEqual([
        expect.objectContaining({ type: EventType.BackgroundShellEnd, detail: '88918' }),
      ]);
    });

    it('reports a foreground command that exited within its yield as nothing', () => {
      const exitedLine = rolloutLines.find((line) => line.includes('call_probe_2') && line.includes('function_call_output'));
      expect(exitedLine).toBeDefined();
      expect(CodexSessionHistoryParser.parse(`${exitedLine}\n`, 'append').events).toEqual([]);
    });

    it('replays the real turn-end rollout: an Esc interrupt is Interrupted, a failed turn is TurnFailed carrying its error message', () => {
      // Two real records from Codex 0.163.0: a turn_aborted (Esc fires no hook)
      // and a task_complete with error.message (a failed model request fires no
      // Stop hook). Replaced the synthetic one-line cases: this is the shape
      // Codex actually writes, envelope and ordinal included.
      const failedRecord = JSON.parse(turnEndLines[1]) as { payload: { error: { message: string } } };
      // Codex hands the provider's body through as one string, JSON and all, so
      // the detail is that string, read from the fixture rather than retyped.
      const expectedMessage = failedRecord.payload.error.message;
      expect(expectedMessage).toContain('stub refuses with 400');
      expect(expectedMessage.length).toBeLessThanOrEqual(200);

      const result = CodexSessionHistoryParser.parse(`${turnEndLines.join('\n')}\n`, 'append');
      expect(result.events).toEqual([
        { ts: Date.parse('2026-10-20T16:39:05.135Z'), type: EventType.Interrupted },
        { ts: Date.parse('2026-10-20T16:58:21.592Z'), type: EventType.TurnFailed, detail: expectedMessage },
      ]);
      // A turn's end belongs to the hooks, so the parse never forces activity.
      expect(result.activity).toBeNull();
    });

    it('reports the same events when each turn-end record arrives in its own read', () => {
      const events = turnEndLines.flatMap((line) => CodexSessionHistoryParser.parse(`${line}\n`, 'append').events);
      expect(events.map((event) => event.type)).toEqual([EventType.Interrupted, EventType.TurnFailed]);
    });

    it('caps a TurnFailed detail at 200 characters', () => {
      const longMessage = 'a'.repeat(200) + 'b'.repeat(100);
      const failed = JSON.stringify({ timestamp: '2026-10-20T16:58:22.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: null, error: { message: longMessage } } });
      const events = CodexSessionHistoryParser.parse(`${failed}\n`, 'append').events;
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.TurnFailed);
      expect(events[0].detail).toBe('a'.repeat(200));
    });

    it('names a failed turn "error" when its error carries no message, and reports nothing when error is absent or not an object', () => {
      const completeWith = (payloadFields: Record<string, unknown>): string => JSON.stringify({
        timestamp: '2026-10-20T16:58:22.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't', last_agent_message: null, ...payloadFields },
      });
      expect(CodexSessionHistoryParser.parse(`${completeWith({ error: { codex_error_info: 'other' } })}\n`, 'append').events).toEqual([
        expect.objectContaining({ type: EventType.TurnFailed, detail: 'error' }),
      ]);
      expect(CodexSessionHistoryParser.parse(`${completeWith({})}\n`, 'append').events).toEqual([]);
      expect(CodexSessionHistoryParser.parse(`${completeWith({ error: null })}\n`, 'append').events).toEqual([]);
      expect(CodexSessionHistoryParser.parse(`${completeWith({ error: 'boom' })}\n`, 'append').events).toEqual([]);
    });
  });

  describe('background commands read only an exec result\'s status block (task #859)', () => {
    beforeEach(() => {
      resetCodexCallMemosForTests();
    });

    const BASE_TIMESTAMP_MS = Date.parse('2026-10-20T15:30:00.000Z');

    function functionCallLine(callId: string, name: string, callArguments: Record<string, unknown>): string {
      return JSON.stringify({
        timestamp: '2026-10-20T15:30:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name, arguments: JSON.stringify(callArguments), call_id: callId },
      });
    }

    function functionCallOutputLine(callId: string, output: string): string {
      return JSON.stringify({
        timestamp: '2026-10-20T15:30:05.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: callId, output },
      });
    }

    /** An exec result as Codex writes it: a status block, an `Output:` line, then the command's own text. */
    function execResult(statusLine: string, outputBody: string): string {
      return [
        'Chunk ID: 3f9a1c',
        'Wall time: 0.0412 seconds',
        statusLine,
        'Original token count: 24',
        'Output:',
        outputBody,
      ].join('\n');
    }

    /** Each line is its own read of the rollout, as the file reader delivers them. */
    function parseEachLine(lines: string[]): SessionEvent[] {
      return lines.flatMap((line) => CodexSessionHistoryParser.parse(`${line}\n`, 'append').events);
    }

    describe('a line in the command\'s own output', () => {
      const quotedSource = [
        'const PROCESS_RUNNING_PATTERN = /^Process running with session ID (\\d+)$/m;',
        'Process running with session ID 88918',
        'Process exited with code 0',
      ].join('\n');

      it('is not a launch: a foreground command that exited, whose cat of a source file quotes the running line', () => {
        const events = parseEachLine([
          functionCallLine('call_cat', 'exec_command', { cmd: 'cat src/exec-status.ts' }),
          functionCallOutputLine('call_cat', execResult('Process exited with code 0', quotedSource)),
        ]);
        expect(events).toEqual([]);
      });

      it('is not a launch when the call was never seen either (a resume starts past the function_call)', () => {
        const events = parseEachLine([
          functionCallOutputLine('call_unseen', execResult('Process exited with code 0', quotedSource)),
        ]);
        expect(events).toEqual([]);
      });

      it('does not end a background command: a poll still running whose output quotes an exit line', () => {
        const events = parseEachLine([
          functionCallLine('call_poll_running', 'write_stdin', { session_id: 88918, chars: '', yield_time_ms: 5000 }),
          functionCallOutputLine('call_poll_running', execResult('Process running with session ID 88918', 'Process exited with code 0')),
        ]);
        // The repeated start is what a poll that finds the process still running
        // has always reported. The quoted exit line must not turn it into an end.
        expect(events).toEqual([
          {
            ts: BASE_TIMESTAMP_MS + 5000,
            type: EventType.BackgroundShellStart,
            tool: AgentTool.Bash,
            toolId: 'call_poll_running',
            detail: '88918',
          },
        ]);
      });
    });

    describe('the status block itself', () => {
      it('is empty when the result has no Output: line, so nothing in it is read as a launch', () => {
        const events = parseEachLine([
          functionCallLine('call_no_output_line', 'exec_command', { cmd: 'node server.js' }),
          functionCallOutputLine('call_no_output_line', 'Process running with session ID 88918\nlistening'),
        ]);
        expect(events).toEqual([]);
      });

      it('matches a running or exited line only as a whole line, never as text inside another line', () => {
        const events = parseEachLine([
          functionCallLine('call_exec_inline', 'exec_command', { cmd: 'node server.js' }),
          functionCallOutputLine('call_exec_inline', execResult('Warning: Process running with session ID 7 was restored', 'listening')),
          functionCallLine('call_poll_inline', 'write_stdin', { session_id: 7, chars: '' }),
          functionCallOutputLine('call_poll_inline', execResult('Last poll: Process exited with code 0', '')),
        ]);
        expect(events).toEqual([]);
      });

      it('is read with CRLF line endings (a Windows Codex)', () => {
        const crlfResult = execResult('Process running with session ID 88918', 'listening').replace(/\n/g, '\r\n');
        expect(crlfResult).toContain('\r\nOutput:\r\n');
        const events = parseEachLine([
          functionCallLine('call_crlf', 'exec_command', { cmd: 'node server.js' }),
          functionCallOutputLine('call_crlf', crlfResult),
        ]);
        expect(events).toEqual([
          expect.objectContaining({ type: EventType.BackgroundShellStart, toolId: 'call_crlf', detail: '88918' }),
        ]);
      });
    });

    describe('a result of a tool that is not an exec tool', () => {
      it.each(['apply_patch', 'view_image'])('is nothing for %s, even with a status-shaped line above its Output: line', (toolName) => {
        const statusShapedResult = execResult('Process running with session ID 5', 'patched');
        const events = parseEachLine([
          functionCallLine('call_other', toolName, { input: 'x' }),
          functionCallOutputLine('call_other', statusShapedResult),
        ]);
        expect(events).toEqual([]);
      });

      it('reads the same result as a launch when the memoized call is an exec_command (the control)', () => {
        const events = parseEachLine([
          functionCallLine('call_exec', 'exec_command', { cmd: 'node server.js' }),
          functionCallOutputLine('call_exec', execResult('Process running with session ID 5', 'listening')),
        ]);
        expect(events).toEqual([
          expect.objectContaining({ type: EventType.BackgroundShellStart, toolId: 'call_exec', detail: '5' }),
        ]);
      });
    });

    describe('the call memo is bounded at 512 calls, oldest out first', () => {
      // Mirrors CALL_MEMO_LIMIT in session-history-parser.ts, which is not exported.
      const MEMO_LIMIT = 512;
      const RUNNING_RESULT = execResult('Process running with session ID 95311', 'listening');

      function flaggedCall(callId: string): string {
        return functionCallLine(callId, 'exec_command', { cmd: `node server.js ${NO_ACTIVITY_HOLD_FLAG}` });
      }

      function fillerCalls(count: number): string[] {
        return Array.from({ length: count }, (_unused, index) => functionCallLine(`call_filler_${index}`, 'exec_command', { cmd: 'echo hi' }));
      }

      it('forgets the first call once one more than the limit has arrived: its flagged output starts without noActivityHold', () => {
        // 1 old + (limit - 1) fillers + 1 recent = limit + 1 calls, so exactly the old one is evicted.
        const calls = [flaggedCall('call_old'), ...fillerCalls(MEMO_LIMIT - 1), flaggedCall('call_recent')];
        expect(calls).toHaveLength(MEMO_LIMIT + 1);
        const callEvents = parseEachLine(calls);
        expect(callEvents).toEqual([]);

        const events = parseEachLine([
          functionCallOutputLine('call_old', RUNNING_RESULT),
          functionCallOutputLine('call_recent', RUNNING_RESULT),
        ]);
        // An evicted call is still read by its status block, but its flag is gone.
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({
          ts: BASE_TIMESTAMP_MS + 5000,
          type: EventType.BackgroundShellStart,
          tool: AgentTool.Bash,
          toolId: 'call_old',
          detail: '95311',
        });
        expect(events[0].noActivityHold).toBeUndefined();
        expect(events[1]).toEqual(expect.objectContaining({ toolId: 'call_recent', noActivityHold: true }));
      });

      it('keeps the first call while the limit is not exceeded', () => {
        const calls = [flaggedCall('call_old'), ...fillerCalls(MEMO_LIMIT - 2), flaggedCall('call_recent')];
        expect(calls).toHaveLength(MEMO_LIMIT);
        parseEachLine(calls);

        const events = parseEachLine([functionCallOutputLine('call_old', RUNNING_RESULT)]);
        expect(events).toEqual([expect.objectContaining({ toolId: 'call_old', noActivityHold: true })]);
      });
    });
  });
});
