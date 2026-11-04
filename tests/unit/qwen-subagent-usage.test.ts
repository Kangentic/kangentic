/**
 * Qwen's subagent spend (`subagent-usage.ts`). In the parent's chat the
 * `agent` tool's result has its calls stripped, so the per-subagent files are
 * the only record of what a fan-out cost, and the turn-usage ledger reads them
 * here. Layout and shapes from packages/core/src/agents/agent-transcript.ts,
 * v0.26.6:
 *   <runtime>/projects/<slug>/subagents/<sessionId>/agent-<id>.jsonl
 *   <runtime>/projects/<slug>/subagents/<sessionId>/agent-<id>.meta.json
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseQwenSubagentUsage,
  qwenSubagentDir,
  statQwenSubagentDir,
} from '../../src/main/agent/adapters/qwen-code/subagent-usage';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';

const SESSION_ID = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

let qwenHome: string;
let cwd: string;

beforeEach(() => {
  qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-subagents-'));
  cwd = path.join(qwenHome, 'workspace', 'project');
  fs.mkdirSync(cwd, { recursive: true });
  process.env.QWEN_HOME = qwenHome;
  // An exported one would move the subagent folder out of the temp home.
  delete process.env.QWEN_RUNTIME_DIR;
});

afterEach(() => {
  delete process.env.QWEN_HOME;
  fs.rmSync(qwenHome, { recursive: true, force: true });
});

function writeSubagent(agentId: string, meta: Record<string, unknown> | null, records: ReadonlyArray<Record<string, unknown>>): string {
  const directory = qwenSubagentDir(SESSION_ID, cwd);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `agent-${agentId}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  if (meta) fs.writeFileSync(path.join(directory, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  return directory;
}

function assistantRecord(uuid: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { type: 'assistant', uuid, timestamp: '2026-11-01T10:00:00.000Z', isSidechain: true, message: { role: 'model', parts: [{ text: 'working' }] }, ...extra };
}

describe('qwenSubagentDir', () => {
  it('sits beside the session\'s chats, under the project folder', () => {
    expect(qwenSubagentDir(SESSION_ID, cwd)).toBe(path.join(path.dirname(qwenChatsDir(cwd)), 'subagents', SESSION_ID));
  });
});

describe('statQwenSubagentDir', () => {
  it('signs only the transcripts, never the sidecars or the live .stream files', () => {
    const directory = writeSubagent('a1', { agentId: 'a1' }, [assistantRecord('r1', {})]);
    fs.writeFileSync(path.join(directory, 'agent-a1.jsonl.stream'), 'partial text');
    const signature = statQwenSubagentDir(directory);
    expect(signature?.fileCount).toBe(1);
    expect(signature?.totalSize).toBe(fs.statSync(path.join(directory, 'agent-a1.jsonl')).size);
  });

  it('is null when the session never fanned out', () => {
    expect(statQwenSubagentDir(qwenSubagentDir(SESSION_ID, cwd))).toBeNull();
  });
});

describe('parseQwenSubagentUsage', () => {
  it('records one turn per API response, with the sidecar\'s type, model, parent call and depth', async () => {
    writeSubagent('top', { agentId: 'top', agentType: 'general-purpose', toolUseId: 'call-agent-1', parentAgentId: null, model: 'qwen3-coder-plus' }, [
      // A tool-call record carries no usage but may launch a nested subagent.
      { type: 'assistant', uuid: 'r1', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'model', parts: [{ functionCall: { id: 'call-agent-2', name: 'agent', args: {} } }] } },
      assistantRecord('r2', { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 20, totalTokenCount: 120 } }),
      { type: 'tool_result', uuid: 'r3', message: { role: 'user', parts: [] } },
    ]);
    writeSubagent('nested', { agentId: 'nested', agentType: 'Explore', toolUseId: 'call-agent-2', parentAgentId: 'top', depth: 9 }, [
      assistantRecord('n1', { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, totalTokenCount: 55 } }),
    ]);

    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed).toMatchObject({ directoryPresent: true, complete: true });
    expect(parsed.turns).toEqual(expect.arrayContaining([
      {
        turnUuid: 'sub:top:r2', subagentId: 'top', agentType: 'general-purpose', spawnDepth: 1,
        parentToolUseId: 'call-agent-1', ts: Date.parse('2026-11-01T10:00:00.000Z'), model: 'qwen3-coder-plus',
        usage: { inputTokens: 40, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 60 },
      },
      // Depth follows the parentAgentId chain, not the raw recorded depth.
      expect.objectContaining({ turnUuid: 'sub:nested:n1', subagentId: 'nested', spawnDepth: 2, parentToolUseId: 'call-agent-2', model: null }),
    ]));
    expect(parsed.turns).toHaveLength(2);
    // The nested launch rode a record with no usage, and is linked all the same.
    expect(parsed.spawnLinks).toEqual([{ toolUseId: 'call-agent-2', turnUuid: 'sub:top:r1' }]);
  });

  // Qwen's sidecar counts depth from 0 (a real 0.25.2 sidecar of a subagent
  // the session launched holds `"depth": 0`); the ledger counts from 1. The
  // recorded depth stands in only when the parent's sidecar is gone.
  it('reads a recorded 0-based depth as the ledger\'s 1-based one when the parent chain is broken', async () => {
    writeSubagent('orphaned', { agentId: 'orphaned', agentType: 'Explore', toolUseId: 'call-agent-9', parentAgentId: 'gone-parent', depth: 1 }, [
      assistantRecord('o1', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }),
    ]);
    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed.turns).toEqual([expect.objectContaining({ turnUuid: 'sub:orphaned:o1', spawnDepth: 2 })]);
  });

  it('keeps a subagent\'s tokens when its sidecar is missing', async () => {
    writeSubagent('lonely', null, [assistantRecord('x1', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })]);
    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed.turns).toEqual([expect.objectContaining({ turnUuid: 'sub:lonely:x1', subagentId: 'lonely', agentType: null, parentToolUseId: null, spawnDepth: 1 })]);
  });

  // The fixture is hand-written in the exact structure of a real 0.25.2
  // subagent transcript and sidecar (see qwen-transcript-metrics.test.ts):
  // `agentId` is `<type>-<toolUseId>`, the sidecar says `depth: 0` and
  // `parentAgentId: null`, and usage rides the thought records, not the
  // tool-call record.
  it('replays the 0.25.2-shaped subagent: two API responses, depth 1, linked to the parent agent call', async () => {
    const fixtureSession = '00000000-0000-4000-8000-000000000001';
    const source = path.join(__dirname, '..', 'fixtures', 'qwen-0.25.2-session', 'subagents', fixtureSession);
    const target = qwenSubagentDir(fixtureSession, cwd);
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source)) fs.copyFileSync(path.join(source, file), path.join(target, file));

    expect(statQwenSubagentDir(target)?.fileCount).toBe(1);
    const parsed = await parseQwenSubagentUsage(fixtureSession, cwd);
    const subagentId = 'general-purpose-toolu_fixture0001';
    const shared = { subagentId, agentType: 'general-purpose', spawnDepth: 1, parentToolUseId: 'toolu_fixture0001', model: 'qwen3-coder-plus' };
    expect(parsed).toMatchObject({ directoryPresent: true, complete: true, spawnLinks: [] });
    expect(parsed.turns).toEqual([
      {
        ...shared, turnUuid: `sub:${subagentId}:00000000-0000-4000-8000-000000000302`, ts: Date.parse('2026-10-19T05:15:42.264Z'),
        usage: { inputTokens: 20825, outputTokens: 439, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
      {
        ...shared, turnUuid: `sub:${subagentId}:00000000-0000-4000-8000-000000000307`, ts: Date.parse('2026-10-19T05:15:48.134Z'),
        usage: { inputTokens: 22372, outputTokens: 621, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    ]);
  });

  const USAGE = { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 };

  // Sidecars that name each other as parents must not wedge the ledger walk. The
  // chain cannot resolve, so the recorded 0-based depth stands in, plus one.
  it('terminates on a parentAgentId cycle and falls back to the recorded depth', async () => {
    writeSubagent('a', { agentId: 'a', parentAgentId: 'b', depth: 2 }, [assistantRecord('a1', { usageMetadata: USAGE })]);
    writeSubagent('b', { agentId: 'b', parentAgentId: 'a', depth: 4 }, [assistantRecord('b1', { usageMetadata: USAGE })]);
    writeSubagent('self', { agentId: 'self', parentAgentId: 'self', depth: 6 }, [assistantRecord('s1', { usageMetadata: USAGE })]);

    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    const depthByTurn = Object.fromEntries(parsed.turns.map((turn) => [turn.turnUuid, turn.spawnDepth]));
    expect(depthByTurn).toEqual({ 'sub:a:a1': 3, 'sub:b:b1': 5, 'sub:self:s1': 7 });
  }, 3000);

  it('counts a three-level parent chain as depth 3, whatever depth the leaf recorded', async () => {
    writeSubagent('top', { agentId: 'top', parentAgentId: null, depth: 0 }, [assistantRecord('t1', { usageMetadata: USAGE })]);
    writeSubagent('mid', { agentId: 'mid', parentAgentId: 'top', depth: 0 }, [assistantRecord('m1', { usageMetadata: USAGE })]);
    writeSubagent('leaf', { agentId: 'leaf', parentAgentId: 'mid', depth: 0 }, [assistantRecord('l1', { usageMetadata: USAGE })]);

    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    const depthByTurn = Object.fromEntries(parsed.turns.map((turn) => [turn.turnUuid, turn.spawnDepth]));
    expect(depthByTurn).toEqual({ 'sub:top:t1': 1, 'sub:mid:m1': 2, 'sub:leaf:l1': 3 });
  });

  it('is incomplete when a transcript cannot be read to its end, and still returns the other file\'s turns', async () => {
    const directory = writeSubagent('good', { agentId: 'good' }, [assistantRecord('g1', { usageMetadata: USAGE })]);
    // A directory named like a transcript: readdir lists it, the read fails.
    fs.mkdirSync(path.join(directory, 'agent-x.jsonl'));

    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed.complete).toBe(false);
    expect(parsed.turns.map((turn) => turn.turnUuid)).toEqual(['sub:good:g1']);
  });

  it('bills one turn for a record written twice with the same uuid', async () => {
    const record = assistantRecord('dup-1', { usageMetadata: USAGE });
    writeSubagent('twice', { agentId: 'twice' }, [record, record]);
    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed.turns).toHaveLength(1);
  });

  it('names a record with no uuid by its line, and links a spawn made through the legacy task tool', async () => {
    const withoutUuid = (extra: Record<string, unknown>): Record<string, unknown> => {
      const { uuid: omittedUuid, ...rest } = assistantRecord('unused', extra);
      void omittedUuid;
      return rest;
    };
    writeSubagent('bare', { agentId: 'bare' }, [
      withoutUuid({ message: { role: 'model', parts: [{ functionCall: { id: 'call-legacy-1', name: 'task', args: {} } }] } }),
      withoutUuid({ usageMetadata: USAGE }),
    ]);

    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed.turns.map((turn) => turn.turnUuid)).toEqual(['sub:bare:line-1']);
    expect(parsed.spawnLinks).toEqual([{ toolUseId: 'call-legacy-1', turnUuid: 'sub:bare:line-0' }]);
  });

  it('reports a missing folder as a coverage gap, not a quiet period', async () => {
    const parsed = await parseQwenSubagentUsage(SESSION_ID, cwd);
    expect(parsed).toMatchObject({ directoryPresent: false, complete: true, turns: [], spawnLinks: [] });
  });
});
