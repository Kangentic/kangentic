/**
 * Unit tests for AiderSessionHistoryParser - cost and token extraction from
 * .aider.chat.history.md files.
 *
 * File format verified from Aider source (aider-ai/aider):
 * - Session headers: `# aider chat started at <timestamp>` (no model name)
 * - User input: `#### <prompt>`
 * - Assistant output: plain text (no prefix)
 * - Tool output: `> ` blockquotes (tokens, cost, file edits, etc.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs before importing the parser
let mockExistsSync = true;
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: () => mockExistsSync,
    },
  };
});

const { AiderSessionHistoryParser } = await import(
  '../../src/main/agent/adapters/aider/session-history-parser'
);

describe('AiderSessionHistoryParser', () => {
  beforeEach(() => {
    mockExistsSync = true;
  });

  // ── locate ──────────────────────────────────────────────────────────────

  describe('locate', () => {
    it('returns file path when .aider.chat.history.md exists', async () => {
      const cwd = path.join('C:', 'projects', 'my-app');
      const result = await AiderSessionHistoryParser.locate({
        agentSessionId: 'unused',
        cwd,
      });
      expect(result).toBe(path.join(cwd, '.aider.chat.history.md'));
    });

    it('returns null when file does not exist', async () => {
      mockExistsSync = false;
      const result = await AiderSessionHistoryParser.locate({
        agentSessionId: 'unused',
        cwd: path.join('C:', 'projects', 'my-app'),
      });
      expect(result).toBeNull();
    });
  });

  // ── parse ───────────────────────────────────────────────────────────────

  describe('parse', () => {
    it('extracts session cost from blockquoted Cost line', () => {
      const content = [
        '# aider chat started at 2026-04-12 14:30:00',
        '',
        '#### Fix the bug',
        '',
        'I found and fixed the bug.',
        '',
        '> Tokens: 1.2k sent, 300 received.',
        '> Cost: $0.01 message, $0.05 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.cost.totalCostUsd).toBe(0.05);
    });

    it('extracts token counts from blockquoted Tokens line', () => {
      const content = [
        '# aider chat started at 2026-04-12 14:30:00',
        '',
        '#### Fix the bug',
        '',
        'Fixed.',
        '',
        '> Tokens: 1.2k sent, 500 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1200);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(500);
    });

    it('handles token counts with cache fields', () => {
      const content = [
        '> Tokens: 2.5k sent, 800 cache write, 1.1k cache hit, 400 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.totalInputTokens).toBe(2500);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(400);
      expect(result.usage!.contextWindow.cacheTokens).toBe(1900); // 800 + 1100
    });

    it('uses the last Cost line (cumulative session cost)', () => {
      const content = [
        '> Cost: $0.01 message, $0.01 session.',
        '',
        '#### Another prompt',
        '',
        'Another response.',
        '',
        '> Cost: $0.02 message, $0.03 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.cost.totalCostUsd).toBe(0.03);
    });

    it('uses the last Tokens line', () => {
      const content = [
        '> Tokens: 500 sent, 200 received.',
        '',
        '> Tokens: 1.5k sent, 800 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1500);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(800);
    });

    it('handles M suffix for large token counts', () => {
      const content = '> Tokens: 1.5M sent, 50k received.';

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1_500_000);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(50_000);
    });

    it('handles comma-separated numbers', () => {
      const content = '> Tokens: 1,234 sent, 5,678 received.';

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1234);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(5678);
    });

    it('returns null usage when no cost or token lines found', () => {
      const content = [
        '# aider chat started at 2026-04-12 14:30:00',
        '',
        '#### Just a question',
        '',
        'Just an answer.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).toBeNull();
    });

    it('returns null usage for empty content', () => {
      const result = AiderSessionHistoryParser.parse('', 'full');
      expect(result.usage).toBeNull();
      expect(result.events).toEqual([]);
      expect(result.activity).toBeNull();
    });

    it('returns null usage for whitespace-only content', () => {
      const result = AiderSessionHistoryParser.parse('   \n  \n  ', 'full');
      expect(result.usage).toBeNull();
    });

    it('does not extract model name (not present in history file)', () => {
      const content = [
        '# aider chat started at 2026-04-12 14:30:00',
        '',
        '> Tokens: 500 sent, 200 received.',
        '> Cost: $0.01 message, $0.01 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      // Model name is empty - Aider only prints it to terminal, not the file
      expect(result.usage!.model.id).toBe('');
      expect(result.usage!.model.displayName).toBe('');
    });

    it('always sets contextWindowSize to 0', () => {
      const content = '> Tokens: 500 sent, 200 received.';
      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(0);
    });

    it('always returns empty events array', () => {
      const content = '> Cost: $0.05 message, $0.10 session.';
      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.events).toEqual([]);
    });

    it('always returns null activity', () => {
      const content = '> Cost: $0.05 message, $0.10 session.';
      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.activity).toBeNull();
    });

    it('handles cost-only (no token line)', () => {
      const content = '> Cost: $0.01 message, $0.02 session.';
      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.cost.totalCostUsd).toBe(0.02);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(0);
    });

    it('handles token-only (no cost line)', () => {
      const content = '> Tokens: 800 sent, 300 received.';
      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.totalInputTokens).toBe(800);
      expect(result.usage!.cost.totalCostUsd).toBe(0);
    });

    it('handles split-line Tokens/Cost format with cache tokens', () => {
      // Aider prints Cost on a separate unquoted line when the preceding
      // Tokens line carries cache-write/cache-hit fields. The regex must
      // accept `Cost:` with or without the `> ` blockquote prefix.
      const content = [
        '> Tokens: 1.8k sent, 500 cache write, 1.1k cache hit, 234 received.',
        'Cost: $0.02 message, $0.05 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.cost.totalCostUsd).toBe(0.05);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1800);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(234);
      expect(result.usage!.contextWindow.cacheTokens).toBe(1600);
    });

    // ── Real-shape fixture regression test ────────────────────────────────
    // Replays a realistic .aider.chat.history.md file to catch format drift.
    // See tests/fixtures/aider-chat-history.md for the fixture source.

    it('parses real-shape fixture with multi-turn conversation', () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/aider-chat-history.md');
      const content = fs.readFileSync(fixturePath, 'utf-8');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage).not.toBeNull();

      // Last Cost line: "$0.06 session" (cumulative across all turns)
      expect(result.usage!.cost.totalCostUsd).toBe(0.06);

      // Last Tokens line: "3.2k sent, 1.5k cache write, 2k cache hit, 189 received."
      expect(result.usage!.contextWindow.totalInputTokens).toBe(3200);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(189);
      expect(result.usage!.contextWindow.cacheTokens).toBe(3500); // 1500 + 2000

      // No model info in the file
      expect(result.usage!.model.id).toBe('');
      expect(result.events).toEqual([]);
      expect(result.activity).toBeNull();
    });
  });
});
