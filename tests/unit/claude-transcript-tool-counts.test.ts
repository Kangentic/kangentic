/**
 * Tests for `parseClaudeTranscriptToolCounts` - the transcript-derived
 * tool-call-count fallback that backfills the live `UsageAccumulator` count
 * for sessions whose ToolStart/ToolEnd hook events never reached it (e.g. a
 * suspended/parked session that reports 0 despite real cost/tokens).
 *
 * Cross-checked against a pinned transcript fixture
 * (tests/fixtures/transcripts/claude-tool-use-sample.jsonl) so the dedup-by-
 * tool_use.id math is locked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseClaudeTranscriptToolCounts,
  claudeProjectSlug,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'transcripts', 'claude-tool-use-sample.jsonl');
const USAGE_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'transcripts', 'claude-usage-sample.jsonl');

describe('parseClaudeTranscriptToolCounts', () => {
  it('counts distinct tool_use ids, deduping a re-emitted message and counting parallel calls separately', async () => {
    const counts = await parseClaudeTranscriptToolCounts(FIXTURE_PATH);
    expect(counts).not.toBeNull();
    // The fixture has:
    //   tu_bash (Bash): single tool_use -> counted once
    //   tu_grep (Grep): same message re-emitted across TWO lines, same id -> counted once
    //   tu_read (Read) + tu_write (Write): parallel tool_use blocks in one message -> both counted
    //   tu_mcp (mcp__github__create_issue) + tu_todo (TodoWrite): ordinary tool_use blocks -> both counted
    //   a user line, a compact_boundary system line, a malformed line, a text-only assistant line -> all skipped
    expect(counts!.toolCallCount).toBe(6);

    const byName = new Map(counts!.toolBreakdown.map((stat) => [stat.toolName, stat]));
    expect(byName.get('Bash')?.callCount).toBe(1);
    expect(byName.get('Grep')?.callCount).toBe(1);
    expect(byName.get('Read')?.callCount).toBe(1);
    expect(byName.get('Write')?.callCount).toBe(1);
    expect(byName.get('mcp__github__create_issue')?.callCount).toBe(1);
    expect(byName.get('TodoWrite')?.callCount).toBe(1);

    for (const stat of counts!.toolBreakdown) {
      expect(stat.totalDurationMs).toBe(0);
      expect(stat.interruptedCount).toBe(0);
      expect(stat.costUsd).toBeUndefined();
      expect(stat.inputTokens).toBeUndefined();
      expect(stat.outputTokens).toBeUndefined();
    }
  });

  it('cross-checks against the token-usage fixture (one tool_use, Read)', async () => {
    const counts = await parseClaudeTranscriptToolCounts(USAGE_FIXTURE_PATH);
    expect(counts).not.toBeNull();
    expect(counts!.toolCallCount).toBe(1);
    expect(counts!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
    ]);
  });

  it('returns null for a missing transcript file (caller keeps the live count)', async () => {
    const missing = path.join(os.tmpdir(), 'kangentic-no-such-transcript-tool-counts-12345.jsonl');
    expect(await parseClaudeTranscriptToolCounts(missing)).toBeNull();
  });

  it('returns null for a transcript with assistant text but no tool_use blocks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-tool-counts-'));
    const filePath = path.join(dir, 'no-tools.jsonl');
    try {
      fs.writeFileSync(
        filePath,
        '{"type":"user","message":{"content":"hi"}}\n' +
          '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"hello"}]}}\n',
      );
      expect(await parseClaudeTranscriptToolCounts(filePath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to "tool" as the breakdown key when a tool_use block has no name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-tool-counts-'));
    const filePath = path.join(dir, 'missing-name.jsonl');
    try {
      fs.writeFileSync(
        filePath,
        '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"tu_1"}]}}\n' +
          '{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","id":"tu_2","name":""}]}}\n',
      );
      const counts = await parseClaudeTranscriptToolCounts(filePath);
      expect(counts).not.toBeNull();
      // Both a missing `name` field and an empty-string `name` fall back to
      // the same "tool" bucket, and each has a distinct tool_use.id, so both
      // are counted (not deduped against each other).
      expect(counts!.toolCallCount).toBe(2);
      expect(counts!.toolBreakdown).toEqual([
        { toolName: 'tool', callCount: 2, totalDurationMs: 0, interruptedCount: 0 },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an assistant message whose content is not an array (a single tool_use-shaped object, not block-array-wrapped)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-tool-counts-'));
    const filePath = path.join(dir, 'non-array-content.jsonl');
    try {
      // A well-formed transcript always wraps content in an array, even for
      // a single block. This simulates a malformed/legacy line where content
      // is a bare object shaped like a tool_use block - it must be skipped
      // entirely, not unwrapped and counted.
      fs.writeFileSync(
        filePath,
        '{"type":"assistant","message":{"id":"msg_1","content":{"type":"tool_use","id":"tu_bare","name":"Bash"}}}\n',
      );
      expect(await parseClaudeTranscriptToolCounts(filePath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ClaudeAdapter.transcriptToolCounts - three input-path branches, mirroring
// ClaudeAdapter.transcriptUsage's branch coverage.
//
// (a) explicit transcriptPath provided -> reads that file directly
// (b) no transcriptPath but agentSessionId + cwd provided -> derives the
//     canonical ~/.claude/projects/<slug>/<id>.jsonl path via
//     locateClaudeTranscriptFile and reads it
// (c) neither transcriptPath nor agentSessionId+cwd -> returns null
//     without touching the filesystem
// ---------------------------------------------------------------------------

describe('ClaudeAdapter.transcriptToolCounts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(branch a) reads and parses tool counts from an explicit transcriptPath', async () => {
    const adapter = new ClaudeAdapter();
    const counts = await adapter.transcriptToolCounts({ transcriptPath: FIXTURE_PATH });

    expect(counts).not.toBeNull();
    expect(counts!.toolCallCount).toBe(6);
  });

  it('(branch b) derives the path from agentSessionId + cwd and reads it when the file exists', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-adapter-tool-counts-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);

    try {
      const agentSessionId = 'branch-b-session';
      const cwd = '/mock/project';
      const slug = claudeProjectSlug(cwd);
      const transcriptDir = path.join(tempHome, '.claude', 'projects', slug);
      const transcriptFile = path.join(transcriptDir, `${agentSessionId}.jsonl`);
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.copyFileSync(FIXTURE_PATH, transcriptFile);

      const adapter = new ClaudeAdapter();
      const counts = await adapter.transcriptToolCounts({ agentSessionId, cwd });

      expect(counts).not.toBeNull();
      expect(counts!.toolCallCount).toBe(6);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('(branch c) returns null when neither transcriptPath nor agentSessionId+cwd is provided', async () => {
    const adapter = new ClaudeAdapter();

    expect(await adapter.transcriptToolCounts({})).toBeNull();
    expect(await adapter.transcriptToolCounts({ agentSessionId: 'some-id', cwd: null })).toBeNull();
    expect(await adapter.transcriptToolCounts({ agentSessionId: null, cwd: '/some/path' })).toBeNull();
  });
});
