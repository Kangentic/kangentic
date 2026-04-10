import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiSessionHistoryParser, clearDiscoveredSessionPaths } from '../../src/main/agent/adapters/gemini/session-history-parser';

/**
 * GeminiSessionHistoryParser unit tests. Uses inline JSON fixtures derived from
 * real Gemini CLI chat files at ~/.gemini/tmp/<dir>/chats/session-*.json.
 */
describe('GeminiSessionHistoryParser', () => {
  describe('parse', () => {
    it('extracts model and tokens from the latest gemini message', () => {
      const json = JSON.stringify({
        sessionId: '08889b8d-c485-4aaa-b91d-ae966fa0ab4a',
        projectHash: '35ad1238',
        startTime: '2026-04-01T23:38:36.391Z',
        lastUpdated: '2026-04-01T23:38:37.971Z',
        messages: [
          {
            id: 'user-1',
            timestamp: '2026-04-01T23:38:36.391Z',
            type: 'user',
            content: [{ text: 'hello' }],
          },
          {
            id: 'gemini-1',
            timestamp: '2026-04-01T23:38:37.971Z',
            type: 'gemini',
            content: 'Hello! I am Gemini.',
            tokens: {
              input: 11199,
              output: 47,
              cached: 0,
              thoughts: 0,
              tool: 0,
              total: 11246,
            },
            model: 'gemini-3-flash-preview',
          },
        ],
        kind: 'main',
      });

      const result = GeminiSessionHistoryParser.parse(json, 'full');

      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gemini-3-flash-preview');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(11199);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(47);
      expect(result.usage!.contextWindow.contextWindowSize).toBe(1_000_000);
      expect(result.usage!.contextWindow.usedPercentage).toBeCloseTo(11199 / 1_000_000 * 100, 5);
    });

    it('walks messages backwards and finds the most recent gemini entry', () => {
      const json = JSON.stringify({
        sessionId: 'test',
        messages: [
          {
            type: 'gemini',
            model: 'gemini-2.5-flash',
            tokens: { input: 100, output: 10, total: 110 },
          },
          { type: 'user', content: [{ text: 'follow up' }] },
          {
            type: 'gemini',
            model: 'gemini-3-pro',
            tokens: { input: 500, output: 20, total: 520 },
          },
        ],
      });

      const result = GeminiSessionHistoryParser.parse(json, 'full');
      expect(result.usage!.model.id).toBe('gemini-3-pro');
      expect(result.usage!.contextWindow.totalInputTokens).toBe(500);
      expect(result.usage!.contextWindow.contextWindowSize).toBe(2_000_000);
    });

    it('resolves context window sizes for known model families', () => {
      const cases: Array<{ model: string; expected: number }> = [
        { model: 'gemini-3-flash-preview', expected: 1_000_000 },
        { model: 'gemini-3-pro', expected: 2_000_000 },
        { model: 'gemini-2.5-pro', expected: 2_000_000 },
        { model: 'gemini-2.5-flash', expected: 1_000_000 },
        { model: 'gemini-2.0-flash', expected: 1_000_000 },
      ];
      for (const { model, expected } of cases) {
        const json = JSON.stringify({
          sessionId: 'test',
          messages: [
            { type: 'gemini', model, tokens: { input: 0, output: 0, total: 0 } },
          ],
        });
        const result = GeminiSessionHistoryParser.parse(json, 'full');
        expect(result.usage!.contextWindow.contextWindowSize).toBe(expected);
      }
    });

    it('uses 0 as sentinel contextWindowSize for unknown models', () => {
      // Unknown models must NOT get a guessed context window. The
      // 0 sentinel tells the TaskCard renderer to hide the progress
      // bar and show only the model name (graceful degradation).
      const json = JSON.stringify({
        sessionId: 'test',
        messages: [
          {
            type: 'gemini',
            model: 'gemini-5-hypothetical-future-model',
            tokens: { input: 1234, output: 56, total: 1290 },
          },
        ],
      });
      const result = GeminiSessionHistoryParser.parse(json, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.model.id).toBe('gemini-5-hypothetical-future-model');
      expect(result.usage!.contextWindow.contextWindowSize).toBe(0);
      expect(result.usage!.contextWindow.usedPercentage).toBe(0);
      // Token counts are still reported - only the window size / % is hidden.
      expect(result.usage!.contextWindow.totalInputTokens).toBe(1234);
    });

    it('returns null usage when no gemini messages exist', () => {
      const json = JSON.stringify({
        sessionId: 'test',
        messages: [{ type: 'user', content: [{ text: 'hi' }] }],
      });

      const result = GeminiSessionHistoryParser.parse(json, 'full');
      expect(result.usage).toBeNull();
    });

    it('handles malformed JSON without throwing', () => {
      const result = GeminiSessionHistoryParser.parse('{not valid', 'full');
      expect(result.usage).toBeNull();
      expect(result.events).toHaveLength(0);
    });

    it('handles missing token fields (treats as 0)', () => {
      const json = JSON.stringify({
        sessionId: 'test',
        messages: [
          { type: 'gemini', model: 'gemini-3-flash-preview' },
        ],
      });

      const result = GeminiSessionHistoryParser.parse(json, 'full');
      expect(result.usage).not.toBeNull();
      expect(result.usage!.contextWindow.totalInputTokens).toBe(0);
      expect(result.usage!.contextWindow.totalOutputTokens).toBe(0);
    });

    it('handles empty messages array', () => {
      const json = JSON.stringify({ sessionId: 'test', messages: [] });
      const result = GeminiSessionHistoryParser.parse(json, 'full');
      expect(result.usage).toBeNull();
    });

    it('does not emit activity hints (lets PtyActivityTracker handle transitions)', () => {
      const json = JSON.stringify({
        sessionId: 'test',
        messages: [
          { type: 'gemini', model: 'gemini-3-flash-preview', tokens: { input: 100, output: 5, total: 105 } },
        ],
      });
      const result = GeminiSessionHistoryParser.parse(json, 'full');
      expect(result.activity).toBeNull();
    });
  });

  describe('captureSessionIdFromFilesystem', () => {
    let chatsDir: string;
    let cwd: string;
    const createdDirs: string[] = [];

    function writeSessionFile(sessionId: string, startTime: Date): string {
      const shortId = sessionId.slice(0, 8);
      const timestamp = startTime.toISOString().replace(/[:.]/g, '-').replace('Z', '');
      const filename = `session-${timestamp}${shortId}.json`;
      const filePath = path.join(chatsDir, filename);
      const content = JSON.stringify({
        sessionId,
        projectHash: 'abcd1234',
        startTime: startTime.toISOString(),
        lastUpdated: startTime.toISOString(),
        messages: [
          { type: 'user', content: [{ text: 'hello' }] },
          {
            type: 'gemini',
            model: 'gemini-3-flash-preview',
            content: 'Hello!',
            tokens: { input: 100, output: 10, total: 110 },
          },
        ],
      });
      fs.writeFileSync(filePath, content);
      return filePath;
    }

    beforeEach(() => {
      clearDiscoveredSessionPaths();
      // Build the path the parser expects: ~/.gemini/tmp/<basename>/chats/
      // We create a temporary cwd whose basename matches our testProjectName.
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cwd-'));
      // The parser uses basename(cwd).toLowerCase() as the directory name.
      // Since mkdtemp adds random chars, we need the chats dir to match
      // the actual basename. Build it under ~/.gemini/tmp/.
      const projectDirName = path.basename(cwd).toLowerCase();
      chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectDirName, 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      createdDirs.push(path.join(os.homedir(), '.gemini', 'tmp', projectDirName));
    });

    afterEach(() => {
      for (const directory of createdDirs) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      createdDirs.length = 0;
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('captures session ID from a matching session file', async () => {
      const sessionId = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
      const now = new Date();
      writeSessionFile(sessionId, now);

      const result = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(now.getTime() - 1000),
        cwd,
        maxAttempts: 2,
      });
      expect(result).toBe(sessionId);
    });

    it('returns null when no matching session file exists', async () => {
      const result = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(),
        cwd,
        maxAttempts: 1,
      });
      expect(result).toBeNull();
    });

    it('populates locate() cache so locate() returns immediately', async () => {
      const sessionId = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
      const now = new Date();
      const filePath = writeSessionFile(sessionId, now);

      // Step 1: captureSessionIdFromFilesystem finds the file and caches it
      const capturedId = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(now.getTime() - 1000),
        cwd,
        maxAttempts: 2,
      });
      expect(capturedId).toBe(sessionId);

      // Step 2: locate() should return immediately from cache (no polling needed)
      const locatedPath = await GeminiSessionHistoryParser.locate({
        agentSessionId: sessionId,
        cwd,
      });
      expect(locatedPath).toBe(filePath);
    });

    it('locate() still polls when cache has no entry', async () => {
      const sessionId = 'cccc3333-dddd-eeee-ffff-aaaaaaaaaaaa';
      const now = new Date();
      writeSessionFile(sessionId, now);

      // Don't call captureSessionIdFromFilesystem - no cache entry
      // locate() should still find the file via directory scanning
      const locatedPath = await GeminiSessionHistoryParser.locate({
        agentSessionId: sessionId,
        cwd,
      });
      expect(locatedPath).not.toBeNull();
      expect(locatedPath!.endsWith('.json')).toBe(true);
    });

    it('logs warning when polling budget exhausts without finding a file', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(),
        cwd,
        maxAttempts: 1,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no matching session file found after'),
      );
      warnSpy.mockRestore();
    });

    it('ignores session files with startTime outside the time window', async () => {
      const sessionId = 'dddd4444-eeee-ffff-aaaa-bbbbbbbbbbbb';
      // Create a file with startTime 2 minutes ago - outside the +-30s window
      const oldTime = new Date(Date.now() - 120_000);
      const filePath = writeSessionFile(sessionId, oldTime);
      // Touch mtime to now so it passes the mtime pre-filter
      const now = new Date();
      fs.utimesSync(filePath, now, now);

      const result = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
        spawnedAt: new Date(),
        cwd,
        maxAttempts: 1,
      });
      expect(result).toBeNull();
    });
  });
});
