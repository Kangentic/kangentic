import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  QwenSessionHistoryParser,
  qwenChatsDir,
} from '../../src/main/agent/adapters/qwen-code/session-history-parser';

/**
 * QwenSessionHistoryParser unit tests.
 *
 * Uses inline JSONL fixtures derived from real Qwen Code 0.15.3 chat
 * files at `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`.
 * Every shape comes from on-disk dumps, not the docs.
 *
 * `tests/fixtures/qwen-real-session.jsonl` is a fully-replayed sanitized
 * dump from a real `qwen` 0.15.3 invocation - the regression anchor for
 * the JSONL schema. If Qwen renames or removes a field we read
 * (`usageMetadata.promptTokenCount`, `contextWindowSize`, `type` enum),
 * the fixture-replay test below catches the drift before the live-smoke
 * (which is opt-in / paid) does.
 */
describe('QwenSessionHistoryParser', () => {
  describe('parse - real fixture replay', () => {
    it('parses a real sanitized Qwen 0.15.3 session JSONL', () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'qwen-real-session.jsonl');
      const content = fs.readFileSync(fixturePath, 'utf-8');
      const result = QwenSessionHistoryParser.parse(content, 'full');

      // Hard assertions that mirror the actual values in the fixture so
      // any field rename or schema change in upstream Qwen surfaces here.
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('claude-haiku-4-5-20251001');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(200_000);
      expect(result.usage!.contextWindow.totalInputTokens).toBe(10);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(43);
      expect(result.usage!.contextWindow.cacheTokens).toBe(0);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(10 / 200_000 * 100, 5);
      // Activity is intentionally null - PtyActivityTracker drives idle/thinking transitions.
      expect(result.activity).toBeNull();
      expect(result.events).toEqual([]);
    });
  });

  describe('parse', () => {
    it('extracts model + tokens + context window from the latest assistant event', () => {
      const userEvent = {
        uuid: 'aaa-1',
        parentUuid: null,
        sessionId: '08889b8d-c485-4aaa-b91d-ae966fa0ab4a',
        timestamp: '2026-04-01T23:38:36.391Z',
        type: 'user',
        cwd: '/project',
        version: '0.15.3',
        gitBranch: 'main',
        message: { role: 'user', parts: [{ text: 'say ok' }] },
      };
      const assistantEvent = {
        uuid: 'aaa-2',
        parentUuid: 'aaa-1',
        sessionId: '08889b8d-c485-4aaa-b91d-ae966fa0ab4a',
        timestamp: '2026-04-01T23:38:37.971Z',
        type: 'assistant',
        cwd: '/project',
        version: '0.15.3',
        gitBranch: 'main',
        model: 'claude-haiku-4-5-20251001',
        message: { role: 'model', parts: [{ text: 'ok' }] },
        usageMetadata: {
          cachedContentTokenCount: 0,
          promptTokenCount: 11199,
          candidatesTokenCount: 47,
          totalTokenCount: 11246,
        },
        contextWindowSize: 200000,
      };
      const jsonl = JSON.stringify(userEvent) + '\n' + JSON.stringify(assistantEvent) + '\n';

      const result = QwenSessionHistoryParser.parse(jsonl, 'full');

      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('claude-haiku-4-5-20251001');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(11199);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(47);
      expect(result.usage!.contextWindow.contextWindowSize).toBe(200000);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(11199 / 200000 * 100, 5);
    });

    it('walks lines backwards and finds the most recent assistant entry (post /model switch)', () => {
      const lines = [
        { type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } },
        {
          type: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          contextWindowSize: 200000,
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 0, totalTokenCount: 110 },
        },
        { type: 'user', message: { role: 'user', parts: [{ text: 'switch to opus' }] } },
        {
          type: 'assistant',
          model: 'claude-opus-4-7',
          contextWindowSize: 1000000,
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, cachedContentTokenCount: 0, totalTokenCount: 520 },
        },
      ];
      const jsonl = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

      const result = QwenSessionHistoryParser.parse(jsonl, 'full');
      expect(result.usage!.model.id).toBe('claude-opus-4-7');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(500);
      expect(result.usage!.contextWindow.contextWindowSize).toBe(1000000);
    });

    it('uses the contextWindowSize from each assistant event (no model lookup table)', () => {
      // Real Qwen records contextWindowSize directly. We trust the value.
      const cases: Array<{ model: string; window: number }> = [
        { model: 'claude-opus-4-7', window: 1000000 },
        { model: 'claude-sonnet-4-6', window: 1000000 },
        { model: 'claude-haiku-4-5-20251001', window: 200000 },
        { model: 'gpt-4.1', window: 128000 },
        { model: 'qwen3-coder-plus', window: 256000 },
        { model: 'completely-unknown-future-model', window: 999999 },
      ];
      for (const { model, window } of cases) {
        const event = {
          type: 'assistant',
          model,
          contextWindowSize: window,
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, cachedContentTokenCount: 0, totalTokenCount: 2 },
        };
        const result = QwenSessionHistoryParser.parse(JSON.stringify(event) + '\n', 'full');
        expect(result.usage!.model.id).toBe(model);
        expect(result.usage!.contextWindow.contextWindowSize).toBe(window);
      }
    });

    it('falls through to 0 contextWindowSize when the field is missing (older builds)', () => {
      const event = {
        type: 'assistant',
        model: 'some-future-model',
        usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 56, cachedContentTokenCount: 0, totalTokenCount: 1290 },
      };
      const result = QwenSessionHistoryParser.parse(JSON.stringify(event) + '\n', 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('some-future-model');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(0);
      expect(result.usage!.contextWindow.usedPercentage).toBe(0);
      // Token counts still surface - only the % bar is hidden.
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1234);
    });

    it('returns null usage when no assistant lines exist', () => {
      const onlyUser = { type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } };
      const result = QwenSessionHistoryParser.parse(JSON.stringify(onlyUser) + '\n', 'full');
      expect(result.usage).toBeNull();
    });

    it('skips system telemetry lines (subtype: ui_telemetry) when looking for assistant events', () => {
      const lines = [
        { type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } },
        {
          type: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          contextWindowSize: 200000,
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, cachedContentTokenCount: 0, totalTokenCount: 60 },
        },
        // System telemetry events appear after assistant events, MUST be skipped.
        { type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response' } } },
      ];
      const jsonl = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
      const result = QwenSessionHistoryParser.parse(jsonl, 'full');
      // Should still find the assistant event despite the trailing system line.
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('claude-haiku-4-5-20251001');
    });

    it('handles malformed JSON lines without throwing (skips them)', () => {
      const lines = [
        '{not valid json',
        JSON.stringify({
          type: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          contextWindowSize: 200000,
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, cachedContentTokenCount: 0, totalTokenCount: 6 },
        }),
        'also not valid',
      ];
      const jsonl = lines.join('\n') + '\n';
      const result = QwenSessionHistoryParser.parse(jsonl, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('claude-haiku-4-5-20251001');
    });

    it('handles missing usageMetadata fields (treats as 0)', () => {
      const event = { type: 'assistant', model: 'claude-haiku-4-5-20251001', contextWindowSize: 200000 };
      const result = QwenSessionHistoryParser.parse(JSON.stringify(event) + '\n', 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.totalInputTokens).toBe(0);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(0);
    });

    it('handles empty file', () => {
      expect(QwenSessionHistoryParser.parse('', 'full').usage).toBeNull();
      expect(QwenSessionHistoryParser.parse('\n\n\n', 'full').usage).toBeNull();
    });

    it('does not emit activity hints (lets PtyActivityTracker handle transitions)', () => {
      const event = {
        type: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        contextWindowSize: 200000,
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, cachedContentTokenCount: 0, totalTokenCount: 105 },
      };
      const result = QwenSessionHistoryParser.parse(JSON.stringify(event) + '\n', 'full');
      expect(result.activity).toBeNull();
    });
  });

  describe('locate', () => {
    let chatsDir: string;
    let cwd: string;
    const createdDirs: string[] = [];

    function writeSessionFile(sessionId: string): string {
      const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
      const userEvent = {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd,
        version: '0.15.3',
        gitBranch: 'mock',
        message: { role: 'user', parts: [{ text: 'hi' }] },
      };
      fs.writeFileSync(filePath, JSON.stringify(userEvent) + '\n');
      return filePath;
    }

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cwd-'));
      // Use the same chats-dir helper the parser uses, so our test's
      // mkdir tracks the parser's path derivation byte-for-byte.
      chatsDir = qwenChatsDir(cwd);
      fs.mkdirSync(chatsDir, { recursive: true });
      // Track the projects/<sanitized> dir for cleanup; the chats dir
      // sits inside it.
      createdDirs.push(path.dirname(chatsDir));
    });

    afterEach(() => {
      for (const directory of createdDirs) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      createdDirs.length = 0;
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('returns the direct <sessionId>.jsonl path when the file exists', async () => {
      const sessionId = 'cccc3333-dddd-eeee-ffff-aaaaaaaaaaaa';
      const filePath = writeSessionFile(sessionId);
      const located = await QwenSessionHistoryParser.locate({
        agentSessionId: sessionId,
        cwd,
      });
      expect(located).toBe(filePath);
    });

    it('returns null when the file never appears', async () => {
      const located = await QwenSessionHistoryParser.locate({
        agentSessionId: '00000000-0000-0000-0000-000000000000',
        cwd,
      });
      expect(located).toBeNull();
    }, 10000);
  });

  describe('path derivation', () => {
    it('matches sanitizeCwd from the real Qwen source (lowercase + non-alphanumeric -> "-")', () => {
      // Verified against on-disk directory names produced by Qwen 0.15.3.
      const home = os.homedir();
      const result = qwenChatsDir('/Users/dev/proj');
      // On Unix: "/Users/dev/proj" -> "-users-dev-proj"
      // On win32: lowercased first then sanitized
      const sanitized = process.platform === 'win32'
        ? '/users/dev/proj'.replace(/[^a-zA-Z0-9]/g, '-')
        : '/Users/dev/proj'.replace(/[^a-zA-Z0-9]/g, '-');
      expect(result).toBe(path.join(home, '.qwen', 'projects', sanitized, 'chats'));
    });
  });
});
