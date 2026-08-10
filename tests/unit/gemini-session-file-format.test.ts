/**
 * Gemini writes its chat session files in two on-disk generations, and the
 * resolver has to read both.
 *
 * Gemini 0.37 wrote ONE JSON object per file, named `session-<ts>-<shortId>.json`.
 * Current builds write append-only JSONL named `session-<ts>-<shortId>.jsonl`
 * whose FIRST line is the session header. On a real machine every chat file
 * written from 2026-04-28 onward is `.jsonl`.
 *
 * Both breakages were live: the discovery pattern was anchored `\.json$`, which
 * a `.jsonl` name cannot match, and the meta reader ran `JSON.parse` over the
 * whole file, which throws on JSONL. Together they meant session-id capture
 * found nothing at all for current Gemini, which also disables live telemetry
 * (usage + activity) for every Gemini session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiSessionHistoryParser, clearDiscoveredSessionPaths } from '../../src/main/agent/adapters/gemini/session-history-parser';

let homeDir: string;
let cwd: string;
let chatsDir: string;
let originalHomedir: typeof os.homedir;

const SESSION_ID = '4d1a59b9-1111-2222-3333-444455556666';

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-gemini-home-'));
  cwd = path.join(homeDir, 'my-project');
  fs.mkdirSync(cwd, { recursive: true });
  // `computeGeminiProjectDirName` lowercases the cwd basename.
  chatsDir = path.join(homeDir, '.gemini', 'tmp', 'my-project', 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });

  originalHomedir = os.homedir;
  (os as { homedir: () => string }).homedir = () => homeDir;
  clearDiscoveredSessionPaths();
});

afterEach(() => {
  (os as { homedir: () => string }).homedir = originalHomedir;
  try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Current format: append-only JSONL whose first line is the session header. */
function writeJsonlSession(fileName: string, startTime: string): string {
  const filePath = path.join(chatsDir, fileName);
  const header = JSON.stringify({
    sessionId: SESSION_ID,
    projectHash: 'abc123',
    startTime,
    lastUpdated: startTime,
    kind: 'main',
  });
  const message = JSON.stringify({
    $set: { messages: [{ id: 'm1', timestamp: startTime, type: 'user', content: [{ text: 'hi' }] }] },
  });
  fs.writeFileSync(filePath, `${header}\n${message}\n`);
  return filePath;
}

/** Legacy format: a single JSON object. */
function writeJsonSession(fileName: string, startTime: string): string {
  const filePath = path.join(chatsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    sessionId: SESSION_ID,
    projectHash: 'abc123',
    startTime,
    lastUpdated: startTime,
    messages: [],
  }));
  return filePath;
}

describe('GeminiSessionHistoryParser.locate', () => {
  it('finds a current-format .jsonl session file', async () => {
    const expected = writeJsonlSession(
      'session-2026-08-08T16-48-4d1a59b9.jsonl',
      new Date().toISOString(),
    );
    const found = await GeminiSessionHistoryParser.locate({ agentSessionId: SESSION_ID, cwd });
    expect(found).toBe(expected);
  });

  it('still finds a legacy .json session file', async () => {
    const expected = writeJsonSession(
      'session-2026-04-11T03-42-4d1a59b9.json',
      new Date().toISOString(),
    );
    const found = await GeminiSessionHistoryParser.locate({ agentSessionId: SESSION_ID, cwd });
    expect(found).toBe(expected);
  });
});

describe('GeminiSessionHistoryParser.captureSessionIdFromFilesystem', () => {
  it('captures the session id from a current-format .jsonl file', async () => {
    const spawnedAt = new Date();
    writeJsonlSession('session-2026-08-08T16-48-4d1a59b9.jsonl', spawnedAt.toISOString());

    const captured = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd,
      maxAttempts: 1,
    });
    expect(captured).toBe(SESSION_ID);
  });

  it('still captures from a legacy .json file', async () => {
    const spawnedAt = new Date();
    writeJsonSession('session-2026-04-11T03-42-4d1a59b9.json', spawnedAt.toISOString());

    const captured = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd,
      maxAttempts: 1,
    });
    expect(captured).toBe(SESSION_ID);
  });

  it('parses usage identically from both on-disk generations', () => {
    // `parse` feeds LIVE TELEMETRY (usage accounting and activity state) for
    // every Gemini session, so the JSONL reader must agree with the legacy
    // object reader rather than merely not crash.
    const assistant = {
      id: 'g1',
      timestamp: new Date().toISOString(),
      type: 'gemini',
      content: [{ text: 'done' }],
      model: 'gemini-2.5-pro',
      tokens: { input: 1200, output: 300, cached: 100 },
    };

    const legacy = GeminiSessionHistoryParser.parse(
      JSON.stringify({ sessionId: SESSION_ID, messages: [assistant] }),
      'full',
    );
    const current = GeminiSessionHistoryParser.parse(
      [
        JSON.stringify({ sessionId: SESSION_ID, startTime: new Date().toISOString() }),
        JSON.stringify(assistant),
      ].join('\n'),
      'full',
    );

    expect(current.usage).not.toBeNull();
    expect(current.usage).toEqual(legacy.usage);
  });

  it('counts a streaming reply once, not once per re-emission', () => {
    // Gemini re-emits the same `id` as a response streams. Appending each
    // emission would multiply the token totals for a single reply.
    const header = JSON.stringify({ sessionId: SESSION_ID, startTime: new Date().toISOString() });
    const partial = JSON.stringify({
      id: 'g1', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 10, output: 5 },
    });
    const final = JSON.stringify({
      id: 'g1', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 1200, output: 300 },
    });

    const result = GeminiSessionHistoryParser.parse([header, partial, final].join('\n'), 'full');
    const contextWindow = (result.usage as unknown as {
      contextWindow?: { totalInputTokens?: number; totalOutputTokens?: number };
    } | null)?.contextWindow;
    expect(contextWindow?.totalInputTokens).toBe(1200);
    expect(contextWindow?.totalOutputTokens).toBe(300);
  });

  it('survives a torn final line from a write in flight', () => {
    const header = JSON.stringify({ sessionId: SESSION_ID, startTime: new Date().toISOString() });
    const complete = JSON.stringify({
      id: 'g1', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 42, output: 7 },
    });
    const result = GeminiSessionHistoryParser.parse(
      [header, complete, '{"id":"g2","typ'].join('\n'),
      'full',
    );
    const contextWindow = (result.usage as unknown as {
      contextWindow?: { totalInputTokens?: number };
    } | null)?.contextWindow;
    expect(contextWindow?.totalInputTokens).toBe(42);
  });

  it('ignores a session started long before the spawn', async () => {
    const spawnedAt = new Date();
    const longAgo = new Date(spawnedAt.getTime() - 10 * 60 * 1000).toISOString();
    writeJsonlSession('session-2026-08-08T10-00-4d1a59b9.jsonl', longAgo);

    const captured = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd,
      maxAttempts: 1,
    });
    expect(captured).toBeNull();
  });
});
