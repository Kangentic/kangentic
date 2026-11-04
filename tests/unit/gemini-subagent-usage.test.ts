/**
 * Gemini subagent chats for the turn-usage ledger. Gemini 0.66.0 nests a
 * subagent's chat under its parent's id, `chats/<parent id>/<subagent id>.jsonl`,
 * with `kind: 'subagent'` in its header and `tokens` on its replies. Without
 * this the ledger holds a Gemini session's main-thread turns only, and a task
 * that fanned out reads cheaper than it was.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';

const PARENT_ID = '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70';
const SUBAGENT_ID = 'c0ffee11-2222-4333-8444-555566667777';

let home: string;
let chats: string;
let cwd: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-subagent-'));
  chats = path.join(home, '.gemini', 'tmp', 'petclinic', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  cwd = path.join(home, 'work', 'petclinic');
  previousHome = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSubagentChat(lines: unknown[]): string {
  const folder = path.join(chats, PARENT_ID);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${SUBAGENT_ID}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return file;
}

const header = { sessionId: SUBAGENT_ID, projectHash: '4c1e9a07', startTime: '2026-10-01T09:00:00.000Z', kind: 'subagent' };

describe('Gemini subagent usage', () => {
  it('turns each subagent reply\'s last tokens into one ledger row', async () => {
    writeSubagentChat([
      header,
      { id: 'u1', type: 'user', content: [{ text: 'Investigate.' }] },
      { id: 'g1', timestamp: '2026-10-01T09:00:05.000Z', type: 'gemini', model: 'gemini-2.5-flash', content: '', tokens: { input: 10, output: 1, cached: 0, total: 11 } },
      { id: 'g1', timestamp: '2026-10-01T09:00:05.000Z', type: 'gemini', model: 'gemini-2.5-flash', content: 'Found it.', tokens: { input: 900, output: 60, cached: 500, thoughts: 20, total: 980 } },
      // A reply with no counts adds no row.
      { id: 'g2', type: 'gemini', content: 'Done.', tokens: { input: 0, output: 0, cached: 0, total: 0 } },
    ]);
    const parsed = await new GeminiAdapter().parseSubagentUsage(PARENT_ID, cwd);
    expect(parsed).toMatchObject({ directoryPresent: true, complete: true, spawnLinks: [] });
    expect(parsed.turns).toEqual([{
      turnUuid: `${SUBAGENT_ID}:g1`,
      subagentId: SUBAGENT_ID,
      agentType: null,
      spawnDepth: 1,
      parentToolUseId: null,
      ts: Date.parse('2026-10-01T09:00:05.000Z'),
      model: 'gemini-2.5-flash',
      usage: { inputTokens: 400, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 500 },
    }]);
  });

  it('records a missing folder as a gap, not a quiet session', async () => {
    const parsed = await new GeminiAdapter().parseSubagentUsage(PARENT_ID, cwd);
    expect(parsed.directoryPresent).toBe(false);
    expect(new GeminiAdapter().statSubagentTranscripts(PARENT_ID, cwd)).toBeNull();
  });

  it('signs the folder by count, size and newest write', () => {
    const file = writeSubagentChat([header, { id: 'g1', type: 'gemini', content: 'x', tokens: { input: 1, output: 1, cached: 0, total: 2 } }]);
    const signature = new GeminiAdapter().statSubagentTranscripts(PARENT_ID, cwd);
    expect(signature).toEqual({ fileCount: 1, totalSize: fs.statSync(file).size, maxMtimeMs: fs.statSync(file).mtimeMs });
  });

  it('follows the reported chat path to its folder', async () => {
    // The agent's own transcript_path wins over the folder the cwd maps to.
    const otherChats = path.join(home, '.gemini', 'tmp', 'moved-project', 'chats');
    fs.mkdirSync(path.join(otherChats, PARENT_ID), { recursive: true });
    fs.writeFileSync(path.join(otherChats, PARENT_ID, `${SUBAGENT_ID}.jsonl`),
      `${JSON.stringify(header)}\n${JSON.stringify({ id: 'g1', type: 'gemini', content: 'x', tokens: { input: 5, output: 2, cached: 0, total: 7 } })}\n`);
    const reported = path.join(otherChats, 'session-2026-10-01T09-00-7d21b8e4.jsonl');
    const parsed = await new GeminiAdapter().parseSubagentUsage(PARENT_ID, cwd, null, reported);
    expect(parsed.sourcePath).toBe(path.join(otherChats, PARENT_ID));
    expect(parsed.turns).toHaveLength(1);
  });
});
