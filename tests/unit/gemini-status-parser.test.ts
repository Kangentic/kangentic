/**
 * Unit tests for GeminiStatusParser - verifies parseStatus returns null
 * (Gemini has no status line) and parseEvent handles JSONL correctly.
 */
import { describe, it, expect } from 'vitest';
import { GeminiStatusParser } from '../../src/main/agent/adapters/gemini';

describe('GeminiStatusParser', () => {
  describe('parseStatus', () => {
    it('always returns null (Gemini has no status line)', () => {
      expect(GeminiStatusParser.parseStatus('{}')).toBeNull();
      expect(GeminiStatusParser.parseStatus('{"context_window":{}}')).toBeNull();
      expect(GeminiStatusParser.parseStatus('')).toBeNull();
    });
  });

  describe('parseEvent', () => {
    it('parses valid JSONL event line', () => {
      const event = GeminiStatusParser.parseEvent(
        '{"ts":1234567890,"type":"tool_start","tool":"WriteFile"}',
      );
      expect(event).toEqual({
        ts: 1234567890,
        type: 'tool_start',
        tool: 'WriteFile',
      });
    });

    it('returns null for malformed JSON', () => {
      expect(GeminiStatusParser.parseEvent('not json')).toBeNull();
      expect(GeminiStatusParser.parseEvent('')).toBeNull();
    });

    it('parses idle event', () => {
      const event = GeminiStatusParser.parseEvent(
        '{"ts":1234567890,"type":"idle"}',
      );
      expect(event).toEqual({ ts: 1234567890, type: 'idle' });
    });
  });
});
