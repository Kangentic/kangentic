import { describe, it, expect, vi } from 'vitest';
import {
  ClaudeSessionHistoryParser,
  claudeProjectSlug,
} from '../../src/main/agent/adapters/claude/session-history-parser';
import { EventType } from '../../src/shared/types';

/**
 * ClaudeSessionHistoryParser unit tests. Uses inline JSONL fixtures
 * derived from real Claude Code session log files (sanitized - no PII,
 * generic placeholder paths only).
 */
describe('ClaudeSessionHistoryParser', () => {
  describe('claudeProjectSlug', () => {
    it('replaces backslashes and colons on Windows-style paths', () => {
      expect(claudeProjectSlug('C:\\Users\\dev\\project')).toBe('C--Users-dev-project');
    });

    it('replaces forward slashes on POSIX paths', () => {
      expect(claudeProjectSlug('/home/dev/project')).toBe('-home-dev-project');
    });

    it('replaces dots (project names with extensions)', () => {
      expect(claudeProjectSlug('C:\\Users\\dev\\my.app')).toBe('C--Users-dev-my-app');
    });

    it('handles worktree subpaths the same way', () => {
      expect(
        claudeProjectSlug('C:\\Users\\dev\\proj\\.kangentic\\worktrees\\feature-x'),
      ).toBe('C--Users-dev-proj--kangentic-worktrees-feature-x');
    });

    it('does not collapse adjacent separators', () => {
      // C: + \ → two separate dashes, not one
      expect(claudeProjectSlug('C:\\x')).toBe('C--x');
    });
  });

  describe('parse', () => {
    it('extracts model and usage from the latest assistant turn', () => {
      const jsonl = [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-09T04:36:51.000Z',
          uuid: 'u1',
          sessionId: 's1',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-09T04:36:52.000Z',
          uuid: 'a1',
          sessionId: 's1',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-6',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 5000,
              output_tokens: 50,
            },
          },
        }),
      ].join('\n') + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');

      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('claude-opus-4-6');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(200_000);
      expect(result.usage!.contextWindow.cacheTokens).toBe(5000);
      // usedTokens = input + cache_creation + cache_read (output excluded)
      expect(result.usage!.contextWindow.usedTokens).toBe(5300);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(50);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(5300 / 200_000 * 100, 2);
      // Activity is intentionally null - hook pipeline owns it.
      expect(result.activity).toBeNull();
    });

    it('emits ToolStart events for tool_use content blocks', () => {
      const jsonl = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-09T04:36:52.000Z',
        uuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'reading...' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
            { type: 'tool_use', id: 'tu2', name: 'Edit', input: {} },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.events).toHaveLength(2);
      expect(result.events[0].type).toBe(EventType.ToolStart);
      expect(result.events[0].detail).toBe('Read');
      expect(result.events[1].detail).toBe('Edit');
    });

    it('uses the last assistant turn when multiple are present', () => {
      const jsonl = [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-09T04:36:52.000Z',
          message: {
            model: 'claude-opus-4-6',
            content: [],
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-09T04:37:00.000Z',
          message: {
            model: 'claude-opus-4-6',
            content: [],
            usage: { input_tokens: 500, output_tokens: 20 },
          },
        }),
      ].join('\n') + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage!.contextWindow.usedTokens).toBe(500);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(20);
    });

    it('returns null usage for unknown models (no guessing)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const jsonl = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-09T04:36:52.000Z',
        message: {
          model: 'claude-future-99',
          content: [],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }) + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).toBeNull();
      warnSpy.mockRestore();
    });

    it('detects the [1m] context-window suffix', () => {
      const jsonl = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-09T04:36:52.000Z',
        message: {
          model: 'claude-opus-4-6[1m]',
          content: [],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }) + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(1_000_000);
    });

    it('ignores malformed JSON lines', () => {
      const jsonl = [
        'not valid json',
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-09T04:36:52.000Z',
          message: {
            model: 'claude-sonnet-4-5',
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        '{incomplete',
      ].join('\n') + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('claude-sonnet-4-5');
    });

    it('handles CRLF line endings', () => {
      const jsonl = [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-09T04:36:52.000Z',
          message: {
            model: 'claude-opus-4-6',
            content: [],
            usage: { input_tokens: 50, output_tokens: 5 },
          },
        }),
      ].join('\r\n') + '\r\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.usedTokens).toBe(50);
    });

    it('returns null usage and empty events on empty input', () => {
      const result = ClaudeSessionHistoryParser.parse('', 'append');
      expect(result.usage).toBeNull();
      expect(result.events).toHaveLength(0);
      expect(result.activity).toBeNull();
    });

    it('ignores user, system, and summary entries', () => {
      const jsonl = [
        JSON.stringify({ type: 'user', message: { content: 'q' } }),
        JSON.stringify({ type: 'system', content: 'sys' }),
        JSON.stringify({ type: 'summary', summary: 's' }),
      ].join('\n') + '\n';

      const result = ClaudeSessionHistoryParser.parse(jsonl, 'append');
      expect(result.usage).toBeNull();
      expect(result.events).toHaveLength(0);
    });
  });
});
