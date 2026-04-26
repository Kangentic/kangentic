/**
 * Unit tests for QwenStatusParser - verifies parseStatus returns null
 * (Qwen Code has no status line) and parseEvent handles JSONL correctly.
 */
import { describe, it, expect } from 'vitest';
import { QwenStatusParser } from '../../src/main/agent/adapters/qwen-code';

describe('QwenStatusParser', () => {
  describe('parseStatus', () => {
    it('always returns null (Qwen has no status line)', () => {
      expect(QwenStatusParser.parseStatus('{}')).toBeNull();
      expect(QwenStatusParser.parseStatus('{"context_window":{}}')).toBeNull();
      expect(QwenStatusParser.parseStatus('')).toBeNull();
    });
  });

  describe('parseEvent', () => {
    it('parses valid JSONL event line', () => {
      const event = QwenStatusParser.parseEvent(
        '{"ts":1234567890,"type":"tool_start","tool":"WriteFile"}',
      );
      expect(event).toEqual({
        ts: 1234567890,
        type: 'tool_start',
        tool: 'WriteFile',
      });
    });

    it('returns null for malformed JSON', () => {
      expect(QwenStatusParser.parseEvent('not json')).toBeNull();
      expect(QwenStatusParser.parseEvent('')).toBeNull();
    });

    it('parses idle event', () => {
      const event = QwenStatusParser.parseEvent(
        '{"ts":1234567890,"type":"idle"}',
      );
      expect(event).toEqual({ ts: 1234567890, type: 'idle' });
    });
  });
});
