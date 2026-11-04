/**
 * Unit tests for AiderSessionHistoryParser - model, cost and token extraction
 * from Aider's chat history markdown.
 *
 * File format from Aider source (Aider-AI/aider v0.86.1):
 * - Run headers: `# aider chat started at <timestamp>` (aider/io.py)
 * - User input: `#### <prompt>`
 * - Assistant output: plain text (no prefix)
 * - Tool output: `> ` blockquotes (the command line, the model announcement,
 *   tokens, cost, file edits), since `tool_output` writes every message there
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

const { isBareCostLine, isSplitTokensReport } = await import(
  '../../src/main/agent/adapters/aider/chat-history-markdown'
);

describe('Aider cost line helpers', () => {
  it('isBareCostLine accepts the whole Cost line, with or without the dot and padding', () => {
    expect(isBareCostLine('Cost: $0.02 message, $0.05 session.')).toBe(true);
    expect(isBareCostLine('Cost: $0.02 message, $0.05 session')).toBe(true);
    expect(isBareCostLine('  Cost: $0.02 message, $0.05 session.  ')).toBe(true);
  });

  it('isBareCostLine accepts the older report wordings Aider published', () => {
    expect(isBareCostLine('Cost: $0.02 request, $0.05 session.')).toBe(true);
    expect(isBareCostLine('Cost: $0.07 message, $0.07 session. Use --no-stream for accurate caching costs.  ')).toBe(true);
    expect(isBareCostLine('Cost: $0.00024 message, $0.00024 session.Use --no-stream for accurate caching costs.  ')).toBe(true);
  });

  it('isBareCostLine rejects other text after Cost:', () => {
    expect(isBareCostLine('Cost: roughly five dollars')).toBe(false);
    expect(isBareCostLine('Cost: $0.02 message, $0.05 session. and more')).toBe(false);
  });

  it('isSplitTokensReport is true only for a Tokens report with no Cost on the line', () => {
    expect(isSplitTokensReport('Tokens: 1.8k sent, 500 cache write, 1.1k cache hit, 234 received.')).toBe(true);
    expect(isSplitTokensReport('Tokens: 1 sent, 2 received. Cost: $0.01 message, $0.02 session.')).toBe(false);
    expect(isSplitTokensReport('Cost: $0.01 message, $0.02 session.')).toBe(false);
    expect(isSplitTokensReport('not a report')).toBe(false);
  });
});

describe('AiderSessionHistoryParser', () => {
  beforeEach(() => {
    mockExistsSync = true;
  });

  // ── locate ──────────────────────────────────────────────────────────────

  describe('locate', () => {
    it("returns the session's own history file, named by its id", async () => {
      const cwd = path.join('C:', 'projects', 'my-app');
      const result = await AiderSessionHistoryParser.locate({
        agentSessionId: '3f1c2b7e-1d2a-4c55-9a7e-0b5e1c9d8f00',
        cwd,
      });
      expect(result).toBe(path.join(cwd, '.aider.chat.history.3f1c2b7e-1d2a-4c55-9a7e-0b5e1c9d8f00.md'));
    });

    it("returns Aider's default file for a session with no id", async () => {
      const cwd = path.join('C:', 'projects', 'my-app');
      const result = await AiderSessionHistoryParser.locate({ agentSessionId: '', cwd });
      expect(result).toBe(path.join(cwd, '.aider.chat.history.md'));
    });

    it('keeps an id with path characters inside the working directory', async () => {
      const cwd = path.join('C:', 'projects', 'my-app');
      const result = await AiderSessionHistoryParser.locate({ agentSessionId: '../../etc/passwd', cwd });
      expect(path.dirname(result!)).toBe(cwd);
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

    it('adds up every Tokens line, and reads the context from the newest', () => {
      // Each report is one message's tokens, so the totals are their sum. The
      // newest `sent` is the prompt the model last saw.
      const content = [
        '> Tokens: 500 sent, 200 received.',
        '',
        '> Tokens: 1.5k sent, 800 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(2000);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(1000);
      expect(result.usage!.contextWindow.usedTokens).toBe(1500);
    });

    it('does not count a Tokens line in the reply text', () => {
      const content = [
        '#### how are tokens reported?',
        'Tokens: 9k sent, 9k received is what it prints.',
        '> Tokens: 500 sent, 200 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(500);
    });

    it('adds up the last session cost of each run, since it starts over per run', () => {
      const content = [
        '# aider chat started at 2026-11-03 10:15:02',
        '> Tokens: 500 sent, 200 received. Cost: $0.01 message, $0.01 session.',
        '> Tokens: 600 sent, 100 received. Cost: $0.02 message, $0.03 session.',
        '',
        '# aider chat started at 2026-11-03 10:40:11',
        '> Tokens: 900 sent, 100 received. Cost: $0.04 message, $0.04 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.cost.totalCostUsd).toBeCloseTo(0.07, 10);
    });

    it('reads the model from the startup announcement, marked as reported by the agent', () => {
      const content = [
        '# aider chat started at 2026-11-03 10:15:02',
        '> Aider v0.86.1',
        '> Model: gpt-5 with diff edit format',
        '> Tokens: 500 sent, 200 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.model).toEqual({ id: 'gpt-5', displayName: 'gpt-5', reportedByAgent: true });
    });

    it('reads a Main model announcement, and the newest one after a switch', () => {
      const content = [
        '> Main model: anthropic/claude-sonnet-4-5-20250929 with diff edit format, infinite output',
        '> Weak model: anthropic/claude-haiku-4-5-20251001',
        '#### /model anthropic/claude-opus-4-1',
        '> Main model: anthropic/claude-opus-4-1 with diff edit format',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.model).toEqual({ id: 'anthropic/claude-opus-4-1', displayName: 'Opus 4.1', reportedByAgent: true });
      // A model alone is still worth reporting, with no token or cost fields.
      expect(result.usage!.contextWindow).toBeUndefined();
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

    it('leaves the model out when the file names none, so a seeded model survives the merge', () => {
      const content = [
        '# aider chat started at 2026-04-12 14:30:00',
        '',
        '> Tokens: 500 sent, 200 received.',
        '> Cost: $0.01 message, $0.01 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.model).toBeUndefined();
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

    it('ignores a bare Cost line in a reply that does not follow a Tokens report', () => {
      const content = [
        '# aider chat started at 2026-11-03 10:15:02',
        '#### what does it cost?',
        'It depends.',
        'Cost: $5.00 message, $9.00 session.',
        '> Tokens: 500 sent, 200 received.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(500);
      expect(result.usage!.cost.totalCostUsd).toBe(0);
    });

    it('ignores a bare Cost line after a complete one-line report', () => {
      const content = [
        '# aider chat started at 2026-11-03 10:15:02',
        '> Tokens: 500 sent, 200 received. Cost: $0.01 message, $0.02 session.',
        'Cost: $5.00 message, $9.00 session.',
      ].join('\n');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.cost.totalCostUsd).toBe(0.02);
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

      // One run, so its last Cost line: "$0.06 session"
      expect(result.usage!.cost.totalCostUsd).toBe(0.06);

      // Every Tokens line added up: 2.1k + 1.8k + 3.2k sent, 456 + 234 + 189 received.
      expect(result.usage!.contextWindow.totalInputTokens).toBe(7100);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(879);
      // The newest line: "3.2k sent, 1.5k cache write, 2k cache hit, 189 received."
      expect(result.usage!.contextWindow.usedTokens).toBe(3200);
      expect(result.usage!.contextWindow.cacheTokens).toBe(3500); // 1500 + 2000

      // This fixture holds no announcement.
      expect(result.usage!.model).toBeUndefined();
      expect(result.events).toEqual([]);
      expect(result.activity).toBeNull();
    });

    // Excerpts of the history Aider publishes in its own repository, with no
    // capture behind them: aider-published-chat-history.source.md names the
    // tag, the lines and the fetch date.
    it("parses Aider's published history", () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/aider-published-chat-history.md');
      const result = AiderSessionHistoryParser.parse(fs.readFileSync(fixturePath, 'utf-8'), 'full');

      // Each run's own session total, whichever word or trailing warning it wrote:
      // $0.000051 + $0.00024 + $0.0034 + $0.05 + $0.00077.
      expect(result.usage!.cost.totalCostUsd).toBeCloseTo(0.054461, 10);
      // Comma counts: 292 + 529 + 23,172 + 12,963 + 66 sent.
      expect(result.usage!.contextWindow.totalInputTokens).toBe(37022);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(254);
      expect(result.usage!.contextWindow.usedTokens).toBe(66);
      expect(result.usage!.model?.id).toBe('claude-3-5-sonnet-20240620');
    });

    it("reads an older Models announcement, as Aider's published history writes it", () => {
      const result = AiderSessionHistoryParser.parse(
        '> Models: gpt-4o with diff edit format, weak model gpt-4o-mini  \n> Tokens: 12 sent, 3 received.  \n',
        'full',
      );
      expect(result.usage!.model).toEqual({ id: 'gpt-4o', displayName: 'gpt-4o', reportedByAgent: true });
    });

    it("reads the k counts and split report of Aider's published history", () => {
      // Lines 87327-87328 of the published file, whose run is a verbose dump the
      // fixture leaves out.
      const content = '> Tokens: 15k sent, 13k cache write, 1.6k cache hit, 133 received.\nCost: $0.05 message, $0.05 session.  \n';
      const result = AiderSessionHistoryParser.parse(content, 'full');
      expect(result.usage!.cost.totalCostUsd).toBe(0.05);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(15000);
      expect(result.usage!.contextWindow.cacheTokens).toBe(14600);
    });

    // Aider publishes no restored run, so this file stays shaped to its source.
    it('parses a restored two-run session file with its command lines and announcements', () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/aider-chat-history-session.md');
      const content = fs.readFileSync(fixturePath, 'utf-8');

      const result = AiderSessionHistoryParser.parse(content, 'full');
      // Each run's own session total: $0.01 + $0.03.
      expect(result.usage!.cost.totalCostUsd).toBeCloseTo(0.04, 10);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(8500);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(350);
      expect(result.usage!.contextWindow.usedTokens).toBe(5100);
      expect(result.usage!.contextWindow.cacheTokens).toBe(5100);
      // The second run's announcement; the command line's `--model` is not one.
      expect(result.usage!.model).toEqual({ id: 'gpt-5', displayName: 'gpt-5', reportedByAgent: true });
    });
  });
});
