import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord, TranscriptEntry } from '../../src/shared/types';

/**
 * `resolveSessionTranscript` is the shared service backing both the
 * `TRANSCRIPT_GET` IPC handler and the (future) MCP `get_transcript` command.
 * It has zero direct test coverage today: the UI conversation-viewer spec
 * only exercises the RENDERING of a pre-seeded response, and the one E2E spec
 * only exercises the 'live' happy path indirectly through search indexing.
 * This file covers the branching the service itself owns:
 *   - no session record found -> null
 *   - live parse success -> source 'live', with per-span truncation applied
 *   - live parse throws -> caught, falls through to the index fallback
 *   - live parse returns zero entries -> index fallback, else 'none'
 *   - no structured parser (or no agent_session_id yet) -> index fallback,
 *     else 'none' with the correct unavailableReason for each sub-case
 *   - entriesFromIndex's per-role reconstruction (user/tool_result/system/
 *     assistant+mixed) when rebuilding from indexed chunks
 *   - taskTitle / agentName fallbacks when the task row or adapter is missing
 *
 * A hand-rolled fake `Database` stands in for better-sqlite3 (as in
 * conversation-indexer-decisions.test.ts): it answers the three SQL shapes
 * `resolveSessionTranscript` touches directly or via SessionRepository /
 * RetrievalStore (`sessions`, `tasks`, `memory_chunks`).
 */

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { resolveSessionTranscript } from '../../src/main/agent/transcript-service';
import { agentRegistry } from '../../src/main/agent/agent-registry';

interface MemoryChunkRow {
  id: number;
  corpus: string;
  doc_id: string;
  seq: number;
  session_id: string | null;
  task_id: string | null;
  agent_session_id: string | null;
  role: string;
  text: string;
  content_hash: string;
  token_estimate: number;
  ts_start: number | null;
  ts_end: number | null;
  turn_uuid_start: string | null;
  turn_uuid_end: string | null;
  embedded_model: string | null;
}

function makeChunkRow(overrides: Partial<MemoryChunkRow> = {}): MemoryChunkRow {
  return {
    id: 1,
    corpus: 'conversation',
    doc_id: 'agent-abc',
    seq: 0,
    session_id: 'session-1',
    task_id: 'task-1',
    agent_session_id: 'agent-abc',
    role: 'user',
    text: 'indexed text',
    content_hash: 'hash-0',
    token_estimate: 2,
    ts_start: 10,
    ts_end: 10,
    turn_uuid_start: 'chunk-uuid-1',
    turn_uuid_end: 'chunk-uuid-1',
    embedded_model: null,
    ...overrides,
  };
}

function makeFakeDb(options: {
  sessionRecord: SessionRecord | undefined;
  taskRow?: { title: string } | undefined;
  chunkRows?: MemoryChunkRow[];
}): Database.Database {
  const chunkRows = options.chunkRows ?? [];
  return {
    prepare(sql: string) {
      return {
        get: (..._args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ? OR agent_session_id = ?')) {
            return options.sessionRecord;
          }
          if (sql.includes('SELECT title FROM tasks WHERE id = ?')) {
            return options.taskRow;
          }
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: (...args: unknown[]) => {
          if (sql.includes('FROM memory_chunks WHERE corpus = ? AND doc_id = ?')) {
            // Key on the ACTUAL bound doc_id argument, mirroring the real
            // `WHERE corpus = ? AND doc_id = ?` filter, so a wrong doc_id
            // (e.g. the session id instead of the agent_session_id) yields no
            // rows rather than always returning the whole fixture.
            const [, boundDocId] = args;
            return chunkRows.filter((row) => row.doc_id === boundDocId);
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  } as unknown as Database.Database;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-abc',
    cwd: '/work/project',
    started_at: '2026-06-01T12:00:00Z',
    status: 'exited',
    ...overrides,
  } as unknown as SessionRecord;
}

const getBySessionType = vi.mocked(agentRegistry.getBySessionType);

describe('resolveSessionTranscript', () => {
  it('returns null when no session record matches the id', async () => {
    const db = makeFakeDb({ sessionRecord: undefined });
    getBySessionType.mockReturnValue(undefined);

    const result = await resolveSessionTranscript(db, 'no-such-session');

    expect(result).toBeNull();
  });

  it("source 'live': returns the adapter's parsed entries, truncating any span over the 20k clamp", async () => {
    const db = makeFakeDb({ sessionRecord: makeRecord(), taskRow: { title: 'Wire the auth flow' } });
    const longText = 'x'.repeat(20_005);
    const entries: TranscriptEntry[] = [{ kind: 'user', uuid: 'u1', ts: 10, text: longText }];
    const parseTranscript = vi.fn(async () => ({ entries, sourcePath: '/history/session-1.jsonl' }));
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('live');
    expect(result!.degraded).toBe(false);
    expect(result!.sourcePath).toBe('/history/session-1.jsonl');
    expect(result!.taskTitle).toBe('Wire the auth flow');
    expect(result!.agentName).toBe('Claude Code');
    expect(parseTranscript).toHaveBeenCalledWith('agent-abc', '/work/project');
    const [entry] = result!.entries;
    expect(entry.kind).toBe('user');
    // The clamp caps the span and appends a truncation marker rather than
    // shipping the full 20k+ chars over IPC.
    if (entry.kind === 'user') {
      expect(entry.text).not.toBe(longText);
      expect(entry.text).toContain('[truncated 5 chars]');
      expect(entry.text.startsWith('x'.repeat(20_000))).toBe(true);
      // The clamped body itself never exceeds MAX_SPAN_CHARS; only the
      // appended marker pushes the total string past that.
      expect(entry.text.split('\n[truncated')[0].length).toBe(20_000);
    }
  });

  it("falls back to the index when the live parser throws, and reconstructs entries per chunk role", async () => {
    const db = makeFakeDb({
      sessionRecord: makeRecord(),
      taskRow: { title: 'Wire the auth flow' },
      chunkRows: [
        makeChunkRow({ id: 1, seq: 0, role: 'user', text: 'user turn', turn_uuid_start: 'u-1', ts_start: 1 }),
        makeChunkRow({ id: 2, seq: 1, role: 'assistant', text: 'assistant turn', turn_uuid_start: 'a-1', ts_start: 2 }),
        makeChunkRow({ id: 3, seq: 2, role: 'tool_result', text: 'tool output', turn_uuid_start: null, ts_start: null }),
        makeChunkRow({ id: 4, seq: 3, role: 'system', text: 'system note', turn_uuid_start: 's-1', ts_start: 3 }),
        makeChunkRow({ id: 5, seq: 4, role: 'mixed', text: 'mixed turn', turn_uuid_start: 'm-1', ts_start: 4 }),
      ],
    });
    const parseTranscript = vi.fn(async () => {
      throw new Error('native history file is corrupt');
    });
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('index');
    expect(result!.degraded).toBe(true);
    expect(result!.entries).toHaveLength(5);

    const [user, assistant, toolResult, system, mixed] = result!.entries;
    expect(user).toMatchObject({ kind: 'user', uuid: 'u-1', ts: 1, text: 'user turn' });
    expect(assistant).toMatchObject({
      kind: 'assistant',
      uuid: 'a-1',
      ts: 2,
      blocks: [{ type: 'text', text: 'assistant turn' }],
    });
    // No recorded uuid falls back to a synthetic 'chunk-<id>' identifier, and a
    // missing ts_start defaults to 0.
    expect(toolResult).toMatchObject({
      kind: 'tool_result',
      uuid: 'chunk-3',
      ts: 0,
      toolUseId: '',
      content: 'tool output',
    });
    expect(system).toMatchObject({ kind: 'system', uuid: 's-1', ts: 3, subtype: 'command', text: 'system note' });
    // A 'mixed' chunk role (no single-block equivalent) renders as assistant text.
    expect(mixed).toMatchObject({
      kind: 'assistant',
      uuid: 'm-1',
      ts: 4,
      blocks: [{ type: 'text', text: 'mixed turn' }],
    });
  });

  it("source 'none' with reason 'file_missing' when the live parser returns zero entries and the index is empty", async () => {
    const db = makeFakeDb({ sessionRecord: makeRecord(), taskRow: { title: 'Wire the auth flow' }, chunkRows: [] });
    const parseTranscript = vi.fn(async () => ({ entries: [], sourcePath: '/history/session-1.jsonl' }));
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('none');
    expect(result!.degraded).toBe(false);
    expect(result!.unavailableReason).toBe('file_missing');
    expect(result!.sourcePath).toBe('/history/session-1.jsonl');
    expect(result!.entries).toEqual([]);
  });

  it("source 'none' with reason 'no_agent_session_id' when the adapter can parse but no agent_session_id exists yet, and the index is empty", async () => {
    const db = makeFakeDb({
      sessionRecord: makeRecord({ agent_session_id: null }),
      taskRow: { title: 'Wire the auth flow' },
      chunkRows: [],
    });
    const parseTranscript = vi.fn();
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('none');
    expect(result!.unavailableReason).toBe('no_agent_session_id');
    // The parser must never run without an agent_session_id to feed it.
    expect(parseTranscript).not.toHaveBeenCalled();
  });

  it("source 'none' with reason 'unsupported_agent' when the adapter has no structured parser and the index is empty", async () => {
    const db = makeFakeDb({
      sessionRecord: makeRecord({ session_type: 'raw_agent' }),
      taskRow: { title: 'Wire the auth flow' },
      chunkRows: [],
    });
    getBySessionType.mockReturnValue({ displayName: 'Raw Agent' } as unknown as ReturnType<
      typeof agentRegistry.getBySessionType
    >);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('none');
    expect(result!.unavailableReason).toBe('unsupported_agent');
    expect(result!.agentName).toBe('Raw Agent');
  });

  it("source 'none' with reason 'unsupported_agent' when the session type resolves to no adapter at all", async () => {
    const db = makeFakeDb({
      sessionRecord: makeRecord({ session_type: 'unknown_agent' }),
      taskRow: { title: 'Wire the auth flow' },
      chunkRows: [],
    });
    getBySessionType.mockReturnValue(undefined);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.unavailableReason).toBe('unsupported_agent');
    // No adapter means the display name falls back to the raw session_type.
    expect(result!.agentName).toBe('unknown_agent');
  });

  it("falls back to the index when the adapter has a parser but the transcript is missing/pruned (empty live parse, non-empty index)", async () => {
    const db = makeFakeDb({
      sessionRecord: makeRecord(),
      taskRow: { title: 'Wire the auth flow' },
      chunkRows: [makeChunkRow({ id: 9, role: 'user', text: 'still indexed', turn_uuid_start: 'u-9', ts_start: 5 })],
    });
    const parseTranscript = vi.fn(async () => ({ entries: [], sourcePath: '/history/session-1.jsonl' }));
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result!.source).toBe('index');
    expect(result!.degraded).toBe(true);
    expect(result!.sourcePath).toBe('/history/session-1.jsonl');
    expect(result!.entries).toEqual([
      { kind: 'user', uuid: 'u-9', ts: 5, text: 'still indexed' },
    ]);
  });

  it('resolves the index fallback by the agent_session_id, not the Kangentic session id, when they differ', async () => {
    // Chunks are indexed by the indexer under doc_id = agent_session_id (the
    // native transcript's uuid), which is a DIFFERENT value from the
    // Kangentic session record's own `id`. The fallback must query with
    // agent_session_id, or every pruned/empty-history session degrades
    // straight to 'none' even though its conversation is indexed.
    const db = makeFakeDb({
      sessionRecord: makeRecord({ id: 'kangentic-session-1', agent_session_id: 'native-agent-xyz' }),
      taskRow: { title: 'Wire the auth flow' },
      chunkRows: [
        makeChunkRow({
          id: 42,
          doc_id: 'native-agent-xyz',
          role: 'user',
          text: 'indexed via native id',
          turn_uuid_start: 'u-42',
          ts_start: 7,
        }),
      ],
    });
    const parseTranscript = vi.fn(async () => ({ entries: [], sourcePath: '/history/native-agent-xyz.jsonl' }));
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);

    const result = await resolveSessionTranscript(db, 'kangentic-session-1');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('index');
    expect(result!.degraded).toBe(true);
    expect(result!.entries).toEqual([
      { kind: 'user', uuid: 'u-42', ts: 7, text: 'indexed via native id' },
    ]);
  });

  it("taskTitle falls back to '(unknown task)' when the task row no longer exists", async () => {
    const db = makeFakeDb({ sessionRecord: makeRecord(), taskRow: undefined, chunkRows: [] });
    getBySessionType.mockReturnValue({ displayName: 'Raw Agent' } as unknown as ReturnType<
      typeof agentRegistry.getBySessionType
    >);

    const result = await resolveSessionTranscript(db, 'session-1');

    expect(result!.taskTitle).toBe('(unknown task)');
  });
});

/**
 * `truncateEntries` (private to transcript-service.ts) applies the 20k-char
 * `clampSpan` to assistant text/thinking blocks, tool_result.content, and
 * system.text - but deliberately leaves assistant tool_use blocks untouched
 * (a tool call's `input` must survive intact for the diff/tool-use renderer).
 * The 'live' source path is the only one that runs truncateEntries (the index
 * fallback path clamps once, up front, inside entriesFromIndex), so these
 * cases are driven through resolveSessionTranscript's live-parse branch.
 */
describe("truncateEntries clamp coverage (via resolveSessionTranscript's 'live' source)", () => {
  async function resolveWithLiveEntries(entries: TranscriptEntry[]) {
    const db = makeFakeDb({ sessionRecord: makeRecord(), taskRow: { title: 'Wire the auth flow' } });
    const parseTranscript = vi.fn(async () => ({ entries, sourcePath: '/history/session-1.jsonl' }));
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);
    return resolveSessionTranscript(db, 'session-1');
  }

  it('clamps an oversize assistant text block AND an oversize thinking block, each carrying the truncation marker', async () => {
    const longText = 'A'.repeat(20_010);
    const longThinking = 'B'.repeat(20_020);
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 10,
        blocks: [
          { type: 'text', text: longText },
          { type: 'thinking', text: longThinking },
        ],
      },
    ];

    const result = await resolveWithLiveEntries(entries);

    expect(result).not.toBeNull();
    const [entry] = result!.entries;
    expect(entry.kind).toBe('assistant');
    if (entry.kind !== 'assistant') return;
    const [textBlock, thinkingBlock] = entry.blocks;
    expect(textBlock.type).toBe('text');
    expect(thinkingBlock.type).toBe('thinking');
    if (textBlock.type === 'text') {
      expect(textBlock.text).not.toBe(longText);
      expect(textBlock.text).toContain('[truncated 10 chars]');
      expect(textBlock.text.split('\n[truncated')[0].length).toBe(20_000);
    }
    if (thinkingBlock.type === 'thinking') {
      expect(thinkingBlock.text).not.toBe(longThinking);
      expect(thinkingBlock.text).toContain('[truncated 20 chars]');
    }
  });

  it('leaves an oversize assistant tool_use block completely UNCLAMPED (input passes through unchanged)', async () => {
    const largeInput = { command: 'X'.repeat(30_000) };
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 10,
        blocks: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: largeInput }],
      },
    ];

    const result = await resolveWithLiveEntries(entries);

    expect(result).not.toBeNull();
    const [entry] = result!.entries;
    expect(entry.kind).toBe('assistant');
    if (entry.kind !== 'assistant') return;
    const [block] = entry.blocks;
    expect(block.type).toBe('tool_use');
    if (block.type === 'tool_use') {
      // Passed through by identity: the full 30k-char command survives,
      // unlike text/thinking blocks which would have been clamped at 20k.
      expect(block.input).toEqual(largeInput);
      expect((block.input as { command: string }).command.length).toBe(30_000);
    }
  });

  it('clamps an oversize tool_result.content span', async () => {
    const longContent = 'C'.repeat(20_050);
    const entries: TranscriptEntry[] = [
      { kind: 'tool_result', uuid: 't1', ts: 10, toolUseId: 'tu-1', content: longContent },
    ];

    const result = await resolveWithLiveEntries(entries);

    expect(result).not.toBeNull();
    const [entry] = result!.entries;
    expect(entry.kind).toBe('tool_result');
    if (entry.kind === 'tool_result') {
      expect(entry.content).not.toBe(longContent);
      expect(entry.content).toContain('[truncated 50 chars]');
      expect(entry.content.split('\n[truncated')[0].length).toBe(20_000);
    }
  });

  it('clamps an oversize system.text span', async () => {
    const longSystemText = 'D'.repeat(20_100);
    const entries: TranscriptEntry[] = [
      { kind: 'system', uuid: 's1', ts: 10, subtype: 'command', text: longSystemText },
    ];

    const result = await resolveWithLiveEntries(entries);

    expect(result).not.toBeNull();
    const [entry] = result!.entries;
    expect(entry.kind).toBe('system');
    if (entry.kind === 'system') {
      expect(entry.text).not.toBe(longSystemText);
      expect(entry.text).toContain('[truncated 100 chars]');
      expect(entry.text.split('\n[truncated')[0].length).toBe(20_000);
    }
  });
});
