/**
 * What `transcript-service.ts` does with a conversation whose agent file is gone.
 *
 * `readSavedConversation(db, agentSessionId)` answers from the structured
 * archive first (`source: 'archive'`), else from the index's text-only chunks
 * (`source: 'index'`), else null. `resolveTaskTranscript` reports the agent of
 * the newest archived session as `archivedAgentName` on every path that can
 * serve a read: the fresh stitch, the unchanged-fingerprint memo and the
 * stat-only fast path. The viewer's banner reads it because `source` describes
 * only the latest session.
 *
 * An archived read is shown like a live one: bounded to the newest
 * `parseWindowBytes()` of source with a leading `truncated` notice when older
 * rows were left out, and with each span clamped to `MAX_SPAN_CHARS`.
 *
 * Real pieces: Claude-format JSONL, the real window parser, Brotli and a
 * migrated better-sqlite3 database. The registry is mocked so each test says
 * what the agent's live parse finds (nothing: the file is gone).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), get: vi.fn() },
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  TranscriptArchive,
  readArchivedConversation,
  resetArchiveReadCacheForTests,
  type ArchiveAdapter,
} from '../../src/main/retrieval/archive/transcript-archive';
import {
  readSavedConversation,
  resolveSessionTranscript,
  resolveTaskTranscript,
  resetForTests as resetTranscriptServiceForTests,
  setIndexedChunkReaderForTests,
  type IndexedChunk,
} from '../../src/main/agent/transcript-service';
import { MAX_SPAN_CHARS } from '../../src/main/agent/transcript-cache';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { parseClaudeTranscript, parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';
import type { AgentAdapter, ParsedTranscript } from '../../src/main/agent/agent-adapter';
import type { TranscriptEntry } from '../../src/shared/types';

const WINDOW_BYTES = 2000;
const PROJECT_ID = 'project-1';
const ARCHIVED_AGENT = 'Archived Agent';
const LIVE_AGENT = 'Live Agent';
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

const readIndexedChunks = vi.fn<(db: DatabaseType.Database, docId: string) => Promise<IndexedChunk[]>>();

beforeEach(() => {
  resetArchiveReadCacheForTests();
  resetTranscriptServiceForTests();
  vi.mocked(agentRegistry.getBySessionType).mockReset();
  readIndexedChunks.mockReset();
  readIndexedChunks.mockResolvedValue([]);
  setIndexedChunkReaderForTests(readIndexedChunks);
});

afterEach(() => {
  setParseWindowBytesForTests();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function transcriptLines(turns: number, label: string): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 12, 0, turn)).toISOString();
    lines.push(JSON.stringify({
      type: 'user', uuid: `${label}-user-${turn}`, timestamp,
      message: { role: 'user', content: `${label} question ${turn}` },
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `${label}-assistant-${turn}`, timestamp,
      message: {
        id: `${label}-message-${turn}`, model: 'claude-test',
        content: [{ type: 'text', text: `${label} answer ${turn}` }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      },
    }));
  }
  return lines;
}

interface SessionSeed {
  id: string;
  agentSessionId: string;
  sessionType: string;
  startedAt: string;
}

interface Fixture {
  database: DatabaseType.Database;
  directory: string;
  /**
   * Writes `<agentSessionId>.jsonl` (three turns, or `lines`) and archives it
   * through the real archive, then moves the file away. Returns the moved copy.
   */
  archiveConversation(sessionId: string, agentSessionId: string, label: string, lines?: string[]): Promise<string>;
}

function fixture(sessions: SessionSeed[] = [], options: { windowBytes?: number } = {}): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-saved-conversation-'));
  temporaryDirectories.push(directory);
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  for (const session of sessions) {
    database.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES (?, 'task-1', ?, ?, 'agent', '/work', 'suspended', ?)`,
    ).run(session.id, session.sessionType, session.agentSessionId, session.startedAt);
  }

  const pathFor = (agentSessionId: string) => path.join(directory, `${agentSessionId}.jsonl`);
  const archiveAdapter: ArchiveAdapter = {
    locateSessionHistoryFile: async (agentSessionId) => (fs.existsSync(pathFor(agentSessionId)) ? pathFor(agentSessionId) : null),
    parseTranscriptWindow: async (agentSessionId, _cwd, startByte, maxBytes, carry) => {
      const window = await parseClaudeTranscriptWindow(pathFor(agentSessionId), startByte, maxBytes, carry);
      return { ...window, sourcePath: pathFor(agentSessionId) };
    },
  };
  const archive = new TranscriptArchive({
    getDb: () => database, getAdapter: () => archiveAdapter, windowBytes: options.windowBytes ?? WINDOW_BYTES,
  });

  return {
    database,
    directory,
    archiveConversation: async (sessionId, agentSessionId, label, lines = transcriptLines(3, label)) => {
      fs.writeFileSync(pathFor(agentSessionId), `${lines.join('\n')}\n`);
      expect(await archive.archiveSession(PROJECT_ID, sessionId)).toBe('archived');
      // The agent then deletes its own file.
      const archivedFrom = pathFor(agentSessionId);
      const copy = path.join(directory, `${agentSessionId}.original`);
      fs.renameSync(archivedFrom, copy);
      return copy;
    },
  };
}

/** The registry answering for two agents: one whose live parse finds nothing, one whose finds a turn. */
function useAgents(options: { archivedSourcePath?: string | null; liveSourcePath?: string } = {}): {
  parseArchivedAgent: ReturnType<typeof vi.fn>;
  parseLiveAgent: ReturnType<typeof vi.fn>;
} {
  const parseArchivedAgent = vi.fn(async (): Promise<ParsedTranscript> => ({
    entries: [],
    sourcePath: options.archivedSourcePath ?? null,
  }));
  const parseLiveAgent = vi.fn(async (): Promise<ParsedTranscript> => ({
    entries: [{ kind: 'user', uuid: 'live-user-0', ts: Date.UTC(2026, 9, 1), text: 'a question the live file holds' }],
    sourcePath: options.liveSourcePath ?? null,
  }));
  vi.mocked(agentRegistry.getBySessionType).mockImplementation((sessionType: string) => {
    if (sessionType === 'archived_agent') return { displayName: ARCHIVED_AGENT, parseTranscript: parseArchivedAgent } as unknown as AgentAdapter;
    if (sessionType === 'live_agent') return { displayName: LIVE_AGENT, parseTranscript: parseLiveAgent } as unknown as AgentAdapter;
    return undefined;
  });
  return { parseArchivedAgent, parseLiveAgent };
}

function uuids(entries: TranscriptEntry[]): string[] {
  return entries.map((entry) => entry.uuid);
}

describe('readSavedConversation', () => {
  it('answers from the archive when it holds the conversation, without consulting the index', async () => {
    const { database, archiveConversation } = fixture([
      { id: 'session-a', agentSessionId: 'agent-archived', sessionType: 'archived_agent', startedAt: '2026-09-30T12:00:00.000Z' },
    ]);
    const original = await archiveConversation('session-a', 'agent-archived', 'archived');
    readIndexedChunks.mockResolvedValue([{ id: 1, role: 'user', text: 'index text that must not win', tsStart: 1, turnUuidStart: 'index-1' }]);

    const saved = await readSavedConversation(database, 'agent-archived');

    expect(saved?.source).toBe('archive');
    expect(uuids(saved!.entries)).toEqual(uuids(await parseClaudeTranscript(original)));
    expect(readIndexedChunks).not.toHaveBeenCalled();
  });

  it('answers from the index\'s chunks when only they hold the conversation', async () => {
    const { database } = fixture();
    readIndexedChunks.mockImplementation(async (_db, docId) => (docId === 'agent-indexed'
      ? [
        { id: 4, role: 'user', text: 'what did we decide', tsStart: 10, turnUuidStart: 'turn-1' },
        { id: 5, role: 'assistant', text: 'we kept the saved copy', tsStart: 11, turnUuidStart: null },
      ]
      : []));

    const saved = await readSavedConversation(database, 'agent-indexed');

    expect(saved).toEqual({
      source: 'index',
      entries: [
        { kind: 'user', uuid: 'turn-1', ts: 10, text: 'what did we decide' },
        { kind: 'assistant', uuid: 'chunk-5', ts: 11, blocks: [{ type: 'text', text: 'we kept the saved copy' }] },
      ],
    });
    expect(readIndexedChunks).toHaveBeenCalledWith(database, 'agent-indexed');
  });

  it('answers null when neither holds it, even while the archive holds another conversation', async () => {
    const { database, archiveConversation } = fixture([
      { id: 'session-a', agentSessionId: 'agent-archived', sessionType: 'archived_agent', startedAt: '2026-09-30T12:00:00.000Z' },
    ]);
    await archiveConversation('session-a', 'agent-archived', 'archived');

    expect(await readSavedConversation(database, 'agent-unknown')).toBeNull();
    expect(readIndexedChunks).toHaveBeenCalledWith(database, 'agent-unknown');
  });
});

describe('resolveTaskTranscript archivedAgentName', () => {
  const ARCHIVED_SESSION: SessionSeed = {
    id: 'session-archived', agentSessionId: 'agent-archived', sessionType: 'archived_agent', startedAt: '2026-09-30T12:00:00.000Z',
  };

  it('names the archived agent on the fresh read and again on the unchanged read that follows', async () => {
    const { database, archiveConversation } = fixture([ARCHIVED_SESSION]);
    const original = await archiveConversation('session-archived', 'agent-archived', 'archived');
    const { parseArchivedAgent } = useAgents();

    const first = await resolveTaskTranscript(database, 'session-archived');
    const second = await resolveTaskTranscript(database, 'session-archived');

    expect(first?.source).toBe('archive');
    expect(first?.degraded).toBe(false);
    expect(uuids(first!.entries)).toEqual(uuids(await parseClaudeTranscript(original)));
    expect(first?.archivedAgentName).toBe(ARCHIVED_AGENT);
    // The second read is the memoized one: same stitch, same revision.
    expect(second?.entries).toBe(first?.entries);
    expect(second?.revision).toBe(first?.revision);
    expect(second?.archivedAgentName).toBe(ARCHIVED_AGENT);
    // The live parse was asked each time: no file signature, so no stat-only shortcut.
    expect(parseArchivedAgent).toHaveBeenCalledTimes(2);
  });

  it('names the archived agent on the stat-only fast path too', async () => {
    const { database, archiveConversation, directory } = fixture([ARCHIVED_SESSION]);
    await archiveConversation('session-archived', 'agent-archived', 'archived');
    // The agent left an empty file behind: the live parse finds a path with no
    // entries, so the read is archived AND carries a file signature to stat.
    const emptyFile = path.join(directory, 'left-behind.jsonl');
    fs.writeFileSync(emptyFile, '');
    const { parseArchivedAgent } = useAgents({ archivedSourcePath: emptyFile });

    const first = await resolveTaskTranscript(database, 'session-archived');
    const second = await resolveTaskTranscript(database, 'session-archived');

    expect(first?.source).toBe('archive');
    expect(first?.archivedAgentName).toBe(ARCHIVED_AGENT);
    // Served by the stat-only fast path: the parser ran once, for the first read.
    expect(parseArchivedAgent).toHaveBeenCalledTimes(1);
    expect(second?.entries).toBe(first?.entries);
    expect(second?.archivedAgentName).toBe(ARCHIVED_AGENT);
  });

  it('names the archived session\'s agent when a newer session is live: source describes only the latest', async () => {
    const { database, archiveConversation, directory } = fixture([
      ARCHIVED_SESSION,
      { id: 'session-live', agentSessionId: 'agent-live', sessionType: 'live_agent', startedAt: '2026-10-01T12:00:00.000Z' },
    ]);
    await archiveConversation('session-archived', 'agent-archived', 'archived');
    const liveFile = path.join(directory, 'agent-live.jsonl');
    fs.writeFileSync(liveFile, '{}');
    useAgents({ liveSourcePath: liveFile });

    const first = await resolveTaskTranscript(database, 'session-live');
    const second = await resolveTaskTranscript(database, 'session-live');

    for (const read of [first, second]) {
      expect(read?.source).toBe('live');
      expect(read?.agentName).toBe(LIVE_AGENT);
      expect(read?.archivedAgentName).toBe(ARCHIVED_AGENT);
    }
  });

  it('contrast: a task read entirely from live files names no archived agent', async () => {
    const { database, directory } = fixture([
      { id: 'session-live', agentSessionId: 'agent-live', sessionType: 'live_agent', startedAt: '2026-10-01T12:00:00.000Z' },
    ]);
    const liveFile = path.join(directory, 'agent-live.jsonl');
    fs.writeFileSync(liveFile, '{}');
    useAgents({ liveSourcePath: liveFile });

    const first = await resolveTaskTranscript(database, 'session-live');
    const second = await resolveTaskTranscript(database, 'session-live');

    expect(first?.source).toBe('live');
    expect(first?.archivedAgentName).toBeNull();
    expect(second?.archivedAgentName).toBeNull();
  });
});

/** A user line and an assistant text line each longer than a span may be, then a short user line. */
function longSpanLines(extraChars: number): string[] {
  const timestamp = new Date(Date.UTC(2026, 8, 30, 12, 0, 0)).toISOString();
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
  return [
    JSON.stringify({
      type: 'user', uuid: 'long-user', timestamp,
      message: { role: 'user', content: 'q'.repeat(MAX_SPAN_CHARS + extraChars) },
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'long-assistant', timestamp,
      message: { id: 'long-message', model: 'claude-test', content: [{ type: 'text', text: 'a'.repeat(MAX_SPAN_CHARS + extraChars) }], usage },
    }),
    JSON.stringify({
      type: 'user', uuid: 'short-user', timestamp,
      message: { role: 'user', content: 'a short question' },
    }),
  ];
}

describe('resolveSessionTranscript on an archived conversation', () => {
  const ARCHIVED_SESSION: SessionSeed = {
    id: 'session-archived', agentSessionId: 'agent-archived', sessionType: 'archived_agent', startedAt: '2026-09-30T12:00:00.000Z',
  };
  const ALL = Number.MAX_SAFE_INTEGER;

  // Red-green: the `prependTruncationMarker(...)` wrapper in `entriesFromArchive`.
  // Drop it (return `truncateEntries(archived.entries)` alone) and the first
  // entry is the conversation's own first line, not the notice.
  it('opens with the truncated notice when the archive holds more than the parse window', async () => {
    const { database, archiveConversation } = fixture([ARCHIVED_SESSION]);
    // Sixteen turns are about four rows at the archive's 2000-byte window.
    const original = await archiveConversation('session-archived', 'agent-archived', 'archived', transcriptLines(16, 'archived'));
    useAgents();
    const whole = await parseClaudeTranscript(original);
    setParseWindowBytesForTests(WINDOW_BYTES);

    const resolved = await resolveSessionTranscript(database, 'session-archived');

    expect(resolved?.source).toBe('archive');
    expect(resolved?.degraded).toBe(false);
    const [notice, ...shown] = resolved!.entries;
    expect(notice).toMatchObject({ kind: 'system', subtype: 'truncated' });
    // Only the newest rows are shown: a proper tail of the whole conversation.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(whole.length);
    expect(uuids(shown)).toEqual(uuids(whole.slice(whole.length - shown.length)));
    // The notice sorts with the first entry that survives, not ahead of everything.
    expect(notice.ts).toBe(shown[0].ts);

    // A repeat read at the same archive revision is the same array, with one notice.
    const again = await resolveSessionTranscript(database, 'session-archived');
    expect(again?.entries).toBe(resolved?.entries);
    expect(again!.entries.filter((entry) => entry.kind === 'system' && entry.subtype === 'truncated')).toHaveLength(1);
    // And the notice went onto a copy: the archive's own read holds none.
    const archived = await readArchivedConversation(database, 'agent-archived', WINDOW_BYTES);
    expect(archived!.omittedBytes).toBeGreaterThan(0);
    expect(archived!.entries.some((entry) => entry.kind === 'system' && entry.subtype === 'truncated')).toBe(false);
  });

  it('opens with no notice when the whole archive fits the parse window', async () => {
    const { database, archiveConversation } = fixture([ARCHIVED_SESSION]);
    const original = await archiveConversation('session-archived', 'agent-archived', 'archived', transcriptLines(16, 'archived'));
    useAgents();

    const resolved = await resolveSessionTranscript(database, 'session-archived');

    expect(resolved?.source).toBe('archive');
    expect(uuids(resolved!.entries)).toEqual(uuids(await parseClaudeTranscript(original)));
    expect(resolved!.entries.some((entry) => entry.kind === 'system' && entry.subtype === 'truncated')).toBe(false);
  });

  // Red-green: the `truncateEntries(...)` inside `entriesFromArchive`. Pass
  // `archived.entries.slice()` to the notice instead and both long spans reach
  // the viewer whole.
  it('clamps a span over the per-span limit and says how much was cut', async () => {
    const extraChars = 5000;
    // One window large enough for the long lines, as the archive's own big-line test does.
    const { database, archiveConversation } = fixture([ARCHIVED_SESSION], { windowBytes: 1024 * 1024 });
    await archiveConversation('session-archived', 'agent-archived', 'archived', longSpanLines(extraChars));
    useAgents();
    // The control: the archive holds the spans whole, so the clamp is the read's.
    const stored = (await readArchivedConversation(database, 'agent-archived', ALL))!.entries;
    const storedUser = stored.find((entry) => entry.uuid === 'long-user');
    expect(storedUser?.kind === 'user' && storedUser.text.length).toBe(MAX_SPAN_CHARS + extraChars);

    const resolved = await resolveSessionTranscript(database, 'session-archived');

    expect(resolved?.source).toBe('archive');
    const user = resolved!.entries.find((entry) => entry.uuid === 'long-user');
    expect(user?.kind).toBe('user');
    const userText = user?.kind === 'user' ? user.text : '';
    // Only the tail is compared, so a failure prints a line and not the span.
    expect(userText.length).toBeLessThan(MAX_SPAN_CHARS + extraChars);
    expect(userText.startsWith('q'.repeat(MAX_SPAN_CHARS))).toBe(true);
    expect(userText.slice(-60)).toContain(`[truncated ${extraChars} chars]`);

    const assistant = resolved!.entries.find((entry) => entry.uuid === 'long-assistant');
    expect(assistant?.kind).toBe('assistant');
    const block = assistant?.kind === 'assistant' ? assistant.blocks[0] : undefined;
    const assistantText = block?.type === 'text' ? block.text : '';
    expect(assistantText.length).toBeLessThan(MAX_SPAN_CHARS + extraChars);
    expect(assistantText.startsWith('a'.repeat(MAX_SPAN_CHARS))).toBe(true);
    expect(assistantText.slice(-60)).toContain(`[truncated ${extraChars} chars]`);

    // A short span is left as it was.
    const short = resolved!.entries.find((entry) => entry.uuid === 'short-user');
    expect(short).toMatchObject({ kind: 'user', text: 'a short question' });
  });
});
