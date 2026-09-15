/**
 * Tests for the Claude subagent usage parser - the reader that finally captures
 * Task-tool subagent tokens, which the turn-usage ledger never saw because they
 * live in a directory the main transcript does not mention.
 *
 * The load-bearing test here is the FOLD RULE. The main-transcript parser
 * attributes a message's usage to the first emitted line per `message.id`
 * (`usageAttributedMessageIds` in transcript-parser.ts), and that rule is exact
 * for main-thread data: 250 real main transcripts carry 7,508 duplicate-id
 * records with ZERO divergent usage. Subagent files are different - they re-emit
 * a message as its output grows - so reusing that rule undercounts output by
 * 30.1% (10.31M against 14.74M across 604 real subagent files) while every
 * existing test stays green. These tests pin the field-wise max that fixes it,
 * with the exact shape measured in the wild.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import {
  locateClaudeSubagentDir,
  parseClaudeSubagentUsage,
  statClaudeSubagentDir,
} from '../../src/main/agent/adapters/claude/subagent-usage-parser';

const AGENT_SESSION_ID = 'fan-out-session';
const CWD = '/mock/project';

interface UsageFields {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

function assistantLine(options: {
  messageId: string;
  usage: UsageFields;
  timestamp?: string;
  model?: string;
  attributionAgent?: string;
}): string {
  return `${JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    uuid: `${options.messageId}-${Math.random().toString(36).slice(2)}`,
    timestamp: options.timestamp ?? '2026-09-01T00:00:00.000Z',
    attributionAgent: options.attributionAgent,
    message: {
      id: options.messageId,
      model: options.model ?? 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'work' }],
      usage: {
        input_tokens: options.usage.input ?? 0,
        output_tokens: options.usage.output ?? 0,
        cache_creation_input_tokens: options.usage.cacheWrite ?? 0,
        cache_read_input_tokens: options.usage.cacheRead ?? 0,
      },
    },
  })}\n`;
}

/** Build a temp home with one session's subagents/ directory and return it. */
function seedHome(files: Array<{ subagentId: string; jsonl: string; meta?: unknown }>): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-subagents-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  const directory = path.join(
    tempHome,
    '.claude',
    'projects',
    claudeProjectSlug(CWD),
    AGENT_SESSION_ID,
    'subagents',
  );
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(directory, `${file.subagentId}.jsonl`), file.jsonl);
    if (file.meta !== undefined) {
      fs.writeFileSync(path.join(directory, `${file.subagentId}.meta.json`), JSON.stringify(file.meta));
    }
  }
  return tempHome;
}

describe('parseClaudeSubagentUsage', () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it('takes the FIELD-WISE MAX across records sharing a message id, not the first record', async () => {
    // The exact shape measured in a real subagent transcript: one message
    // written twice, the first record carrying a mid-stream output count.
    //   {"input":2,"output":1,"cacheWrite":6392,"cacheRead":9882}
    //   {"input":2,"output":253,"cacheWrite":6392,"cacheRead":9882}
    // First-wins yields 1. Summing yields 254. Only max yields 253.
    homes.push(seedHome([
      {
        subagentId: 'agent-a1',
        meta: { agentType: 'review-finder', spawnDepth: 1, toolUseId: 'toolu_01AAA' },
        jsonl:
          assistantLine({ messageId: 'msg_01', usage: { input: 2, output: 1, cacheWrite: 6392, cacheRead: 9882 } })
          + assistantLine({ messageId: 'msg_01', usage: { input: 2, output: 253, cacheWrite: 6392, cacheRead: 9882 } }),
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.directoryPresent).toBe(true);
    expect(parsed.complete).toBe(true);
    // One API message means ONE ledger row, however many records wrote it.
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].usage).toEqual({
      inputTokens: 2,
      outputTokens: 253,
      cacheCreationInputTokens: 6392,
      cacheReadInputTokens: 9882,
    });
  });

  it('folds max independently per field, in either record order', async () => {
    // Guards against a "take the last record" shortcut, which happens to pass
    // the test above. Here the later record is smaller on one field.
    homes.push(seedHome([
      {
        subagentId: 'agent-a1',
        meta: { agentType: 'test-builder', spawnDepth: 1 },
        jsonl:
          assistantLine({ messageId: 'msg_01', usage: { input: 5, output: 400, cacheWrite: 100, cacheRead: 9 } })
          + assistantLine({ messageId: 'msg_01', usage: { input: 2, output: 400, cacheWrite: 100, cacheRead: 50 } }),
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns[0].usage).toEqual({
      inputTokens: 5,
      outputTokens: 400,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 50,
    });
  });

  it('carries agentType, spawnDepth and the spawning toolUseId from the meta sidecar', async () => {
    homes.push(seedHome([
      {
        subagentId: 'agent-deep',
        meta: { agentType: 'test-builder', spawnDepth: 2, toolUseId: 'toolu_01TGXbLzMWBCj6YuVq8aN8LR' },
        jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 10 } }),
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns[0].subagentId).toBe('agent-deep');
    expect(parsed.turns[0].agentType).toBe('test-builder');
    // Depth 2 is real (measured: 50 of 2,288 files) and lives flat in the same
    // directory, so it must be carried rather than inferred from nesting.
    expect(parsed.turns[0].spawnDepth).toBe(2);
    expect(parsed.turns[0].parentToolUseId).toBe('toolu_01TGXbLzMWBCj6YuVq8aN8LR');
  });

  it('falls back to the record-inline attributionAgent when the sidecar is missing', async () => {
    homes.push(seedHome([
      {
        subagentId: 'agent-nometa',
        jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 10 }, attributionAgent: 'Explore' }),
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns[0].agentType).toBe('Explore');
    // Absent sidecar means these are genuinely unknown, not zero.
    expect(parsed.turns[0].spawnDepth).toBeNull();
    expect(parsed.turns[0].parentToolUseId).toBeNull();
  });

  it('degrades to a null agentType rather than dropping tokens when nothing names the subagent', async () => {
    homes.push(seedHome([
      {
        subagentId: 'agent-anon',
        meta: 'not json at all',
        jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 77 } }),
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].agentType).toBeNull();
    expect(parsed.turns[0].usage.outputTokens).toBe(77);
  });

  it('skips <synthetic> API-error records and groups with no tokens at all', async () => {
    homes.push(seedHome([
      {
        subagentId: 'agent-a1',
        meta: { agentType: 'review-finder', spawnDepth: 1 },
        jsonl:
          // Real spend.
          assistantLine({ messageId: 'msg_real', usage: { output: 42 } })
          // Claude's API-error notice: all-zero usage under a UUID-shaped id,
          // which is the one non-`msg_` key shape in this data.
          + assistantLine({
            messageId: 'd46fbbd9-ce18-42a1-9682-8eab32892614',
            model: '<synthetic>',
            usage: {},
          })
          // A real model reporting nothing on any of the four counts.
          + assistantLine({ messageId: 'msg_empty', usage: {} }),
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].turnUuid).toContain('msg_real');
  });

  it('keys each turn stably and disjointly from main-thread turn uuids', async () => {
    homes.push(seedHome([
      { subagentId: 'agent-a1', meta: { agentType: 'x' }, jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 1 } }) },
      { subagentId: 'agent-a2', meta: { agentType: 'y' }, jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 2 } }) },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    const uuids = parsed.turns.map((turn) => turn.turnUuid).sort();
    // Subagent-scoped, so the same message id under two subagents cannot
    // collapse onto one ledger row; and prefixed, so it cannot collide with a
    // main-thread row keyed by a JSONL record uuid.
    expect(uuids).toEqual(['sub:agent-a1:msg_01', 'sub:agent-a2:msg_01']);
    for (const uuid of uuids) expect(uuid.startsWith('sub:')).toBe(true);
  });

  it('is idempotent across a re-walk after the transcript is appended to', async () => {
    // The indexer re-walks from the start on every signature change, so an
    // appended file must reproduce the same row identity, timestamp and model -
    // otherwise the upsert churns a row per sweep.
    const home = seedHome([
      {
        subagentId: 'agent-a1',
        meta: { agentType: 'review-finder', spawnDepth: 1 },
        jsonl: assistantLine({
          messageId: 'msg_01',
          usage: { output: 1 },
          timestamp: '2026-09-01T00:00:01.000Z',
        }),
      },
    ]);
    homes.push(home);

    const first = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    const filePath = path.join(locateClaudeSubagentDir(AGENT_SESSION_ID, CWD), 'agent-a1.jsonl');
    fs.appendFileSync(filePath, assistantLine({
      messageId: 'msg_01',
      usage: { output: 253 },
      timestamp: '2026-09-01T00:00:09.000Z',
    }));

    const second = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(second.turns).toHaveLength(1);
    expect(second.turns[0].turnUuid).toBe(first.turns[0].turnUuid);
    // Earliest record of the group wins the timestamp, so the row does not walk
    // forward in time as the message is re-emitted.
    expect(second.turns[0].ts).toBe(first.turns[0].ts);
    expect(second.turns[0].model).toBe(first.turns[0].model);
    expect(second.turns[0].usage.outputTokens).toBe(253);
  });

  it('reports a missing directory as absent rather than as an empty fan-out', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-subagents-'));
    homes.push(tempHome);
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    // The caller records this as a coverage GAP (the agent pruned its
    // transcripts), which is what keeps it from reading as a quiet period.
    expect(parsed.directoryPresent).toBe(false);
    expect(parsed.turns).toEqual([]);
  });

  it('aggregates every subagent in the directory', async () => {
    homes.push(seedHome([
      { subagentId: 'agent-a1', meta: { agentType: 'review-finder', spawnDepth: 1 }, jsonl: assistantLine({ messageId: 'msg_01', usage: { cacheRead: 5_270_000 } }) },
      { subagentId: 'agent-a2', meta: { agentType: 'test-builder', spawnDepth: 1 }, jsonl: assistantLine({ messageId: 'msg_02', usage: { cacheRead: 14_140_000 } }) },
      { subagentId: 'agent-a3', meta: { agentType: 'test-builder', spawnDepth: 1 }, jsonl: assistantLine({ messageId: 'msg_03', usage: { cacheRead: 10_020_000 } }) },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns.reduce((total, turn) => total + turn.usage.cacheReadInputTokens, 0)).toBe(29_430_000);
  });

  it('ignores malformed lines and non-assistant records', async () => {
    homes.push(seedHome([
      {
        subagentId: 'agent-a1',
        meta: { agentType: 'review-finder' },
        jsonl:
          '{"type":"user","isSidechain":true,"message":{"content":"go"}}\n'
          + 'not json at all\n'
          + '{"type":"attachment","isSidechain":true}\n'
          + assistantLine({ messageId: 'msg_01', usage: { output: 5 } })
          + '{"type":"assistant","message":{"id":"msg_nousage","model":"claude-sonnet-5"}}\n',
      },
    ]));

    const parsed = await parseClaudeSubagentUsage(AGENT_SESSION_ID, CWD);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].usage.outputTokens).toBe(5);
  });
});

describe('statClaudeSubagentDir', () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns null for a directory that does not exist', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-subagents-'));
    homes.push(tempHome);
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    expect(statClaudeSubagentDir(locateClaudeSubagentDir(AGENT_SESSION_ID, CWD))).toBeNull();
  });

  it('counts only .jsonl transcripts, so a meta sidecar cannot move the signature', () => {
    homes.push(seedHome([
      { subagentId: 'agent-a1', meta: { agentType: 'x' }, jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 1 } }) },
    ]));

    const signature = statClaudeSubagentDir(locateClaudeSubagentDir(AGENT_SESSION_ID, CWD));

    expect(signature?.fileCount).toBe(1);
    expect(signature?.totalSize).toBeGreaterThan(0);
    expect(signature?.maxMtimeMs).toBeGreaterThan(0);
  });

  it('changes when a new subagent starts', () => {
    homes.push(seedHome([
      { subagentId: 'agent-a1', jsonl: assistantLine({ messageId: 'msg_01', usage: { output: 1 } }) },
    ]));
    const directory = locateClaudeSubagentDir(AGENT_SESSION_ID, CWD);
    const before = statClaudeSubagentDir(directory);

    // A second subagent starting is the case a size/mtime-only signature can
    // miss when both land inside one millisecond.
    fs.writeFileSync(path.join(directory, 'agent-a2.jsonl'), '');
    const after = statClaudeSubagentDir(directory);

    expect(after?.fileCount).toBe((before?.fileCount ?? 0) + 1);
  });
});
