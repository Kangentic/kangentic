/**
 * The phone-side trust boundary for desktop-originated payloads: the wire
 * guards in events/payloads.ts + events/event.ts and the read-* response
 * parsers in wire/payloads.ts. Mirrors payloads.test.ts, which covers the
 * opposite direction (desktop validating phone-originated requests).
 */
import { describe, expect, it } from 'vitest';
import {
  isBridgeEvent,
  parseActivityEventPayload,
} from '../../../packages/protocol/src/events/event';
import {
  parseBacklogItemWire,
  parseBoardColumnWire,
  parseBoardTaskWire,
  parseDiffFileContentWire,
  parseDiffFileListWire,
  parseSessionEventWire,
  parseSessionUsageWire,
  parseTranscriptEntriesWire,
  parseTranscriptEventPayload,
} from '../../../packages/protocol/src/events/payloads';
import {
  parseReadBoardResponsePayload,
  parseReadDiffResponsePayload,
  parseReadStreamResponsePayload,
  parseTranscriptWindowResponsePayload,
} from '../../../packages/protocol/src/wire/payloads';
import type { JsonValue } from '../../../packages/protocol/src/wire/messages';

const usageFixture: JsonValue = {
  contextWindow: { usedPercentage: 42, usedTokens: 1000, cacheTokens: 500, totalInputTokens: 1500, totalOutputTokens: 300, contextWindowSize: 200000 },
  cost: { totalCostUsd: 1.25, totalDurationMs: 60000 },
  model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
};

const boardTaskFixture: JsonValue = {
  id: 't-1',
  display_id: 7,
  title: 'Fix the bug',
  description: '',
  swimlane_id: 'lane-1',
  position: 0,
  agent: null,
  session_id: 'sess-1',
  worktree_path: null,
  branch_name: null,
  pr_number: null,
  pr_url: null,
  pr_state: null,
  base_branch: 'main',
  labels: ['bug'],
  priority: 1,
  attachment_count: 0,
  archived_at: null,
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-13T00:00:00.000Z',
};

describe('parseTranscriptEntriesWire', () => {
  it('parses every entry kind', () => {
    const entries: JsonValue = [
      { kind: 'user', uuid: 'u-1', ts: 1, text: 'hello' },
      {
        kind: 'assistant',
        uuid: 'a-1',
        ts: 2,
        model: 'claude-opus-4-8',
        blocks: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', text: 'hmm' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      { kind: 'tool_result', uuid: 'r-1', ts: 3, toolUseId: 'tool-1', content: 'ok', isError: false },
      { kind: 'system', uuid: 's-1', ts: 4, subtype: 'session_boundary', text: 'new session' },
    ];
    expect(parseTranscriptEntriesWire(entries)).toEqual(entries);
  });

  it('rejects a non-array payload', () => {
    expect(() => parseTranscriptEntriesWire({ entries: [] })).toThrow(/array/);
  });

  it('rejects an entry with an unknown kind', () => {
    expect(() => parseTranscriptEntriesWire([{ kind: 'note', uuid: 'x', ts: 1 }])).toThrow(/entry 0/);
  });

  it('rejects an assistant entry with a malformed block', () => {
    expect(() =>
      parseTranscriptEntriesWire([{ kind: 'assistant', uuid: 'a-1', ts: 1, blocks: [{ type: 'tool_use', name: 'Bash' }] }]),
    ).toThrow(/entry 0/);
  });

  it('rejects a system entry with an unknown subtype', () => {
    expect(() => parseTranscriptEntriesWire([{ kind: 'system', uuid: 's-1', ts: 1, subtype: 'banner', text: 'x' }])).toThrow(/entry 0/);
  });
});

describe('parseActivityEventPayload', () => {
  it('parses an activity payload', () => {
    const payload: JsonValue = { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('parses a usage payload', () => {
    expect(parseActivityEventPayload({ type: 'usage', usage: usageFixture })).toEqual({ type: 'usage', usage: usageFixture });
  });

  it('parses a session-event payload and drops unknown extras from the event', () => {
    const parsed = parseActivityEventPayload({ type: 'event', event: { ts: 5, type: 'tool_start', tool: 'Bash', costUsd: 0.1 } });
    expect(parsed).toEqual({ type: 'event', event: { ts: 5, type: 'tool_start', tool: 'Bash' } });
  });

  it('parses a permission payload', () => {
    const payload: JsonValue = { type: 'permission', promptId: 'sess-1:tool-1', pending: true };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('rejects an invalid state', () => {
    expect(() => parseActivityEventPayload({ type: 'activity', state: 'busy', reason: { kind: 'idle' } })).toThrow(/state/);
  });

  it('rejects an unknown payload type', () => {
    expect(() => parseActivityEventPayload({ type: 'telemetry' })).toThrow(/unknown/);
  });
});

describe('parseSessionUsageWire', () => {
  it('parses a full usage snapshot and keeps optional fields', () => {
    const withOptionals: JsonValue = {
      ...(usageFixture as Record<string, JsonValue>),
      toolCallCount: 12,
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'high' },
    };
    expect(parseSessionUsageWire(withOptionals)).toEqual(withOptionals);
  });

  it('strips desktop-internal extras the wire does not carry', () => {
    const parsed = parseSessionUsageWire({ ...(usageFixture as Record<string, JsonValue>), transcriptPath: 'C:/somewhere/session.jsonl' });
    expect(parsed).not.toHaveProperty('transcriptPath');
  });

  it('rejects a missing contextWindow', () => {
    expect(() => parseSessionUsageWire({ cost: { totalCostUsd: 0, totalDurationMs: 0 }, model: { id: 'm', displayName: 'M' } })).toThrow(
      /contextWindow/,
    );
  });
});

describe('parseSessionEventWire', () => {
  it('requires ts and type', () => {
    expect(() => parseSessionEventWire({ type: 'tool_start' })).toThrow(/ts/);
    expect(() => parseSessionEventWire({ ts: 1 })).toThrow(/type/);
  });
});

describe('board row guards', () => {
  it('parses a full task row', () => {
    expect(parseBoardTaskWire(boardTaskFixture)).toEqual(boardTaskFixture);
  });

  it('rejects a task without an id', () => {
    expect(() => parseBoardTaskWire({ title: 'x' })).toThrow(/id/);
  });

  it('parses a column row', () => {
    const column: JsonValue = {
      id: 'lane-1',
      name: 'To Do',
      description: null,
      role: 'todo',
      position: 0,
      color: '#00ff00',
      icon: null,
      is_archived: false,
      is_ghost: false,
    };
    expect(parseBoardColumnWire(column)).toEqual(column);
  });

  it('parses a backlog row', () => {
    const item: JsonValue = {
      id: 'b-1',
      title: 'Later',
      description: '',
      priority: 0,
      labels: [],
      position: 1,
      item_type: null,
      external_url: null,
      attachment_count: 0,
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    };
    expect(parseBacklogItemWire(item)).toEqual(item);
  });
});

describe('diff guards', () => {
  const fileList: JsonValue = {
    files: [
      { path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1, binary: false },
      { path: 'src/b.ts', status: 'R', insertions: 0, deletions: 0, oldPath: 'src/old-b.ts', binary: false },
    ],
    totalInsertions: 3,
    totalDeletions: 1,
  };

  it('parses a file list', () => {
    expect(parseDiffFileListWire(fileList)).toEqual(fileList);
  });

  it('rejects an invalid file status', () => {
    expect(() => parseDiffFileListWire({ files: [{ path: 'x', status: 'Z', insertions: 0, deletions: 0, binary: false }], totalInsertions: 0, totalDeletions: 0 })).toThrow(/status/);
  });

  it('parses file content', () => {
    const content: JsonValue = { original: 'a', modified: 'b', language: 'typescript' };
    expect(parseDiffFileContentWire(content)).toEqual(content);
  });
});

describe('read-* response parsers', () => {
  it('parses a read-stream response with a null activity state', () => {
    const parsed = parseReadStreamResponsePayload({
      scrollback: 'output',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
    });
    expect(parsed).toEqual({ scrollback: 'output', activity: { state: null, reason: null }, usage: null, awaitedPromptId: null });
  });

  it('parses a read-stream response with a pending prompt and usage', () => {
    const parsed = parseReadStreamResponsePayload({
      scrollback: '',
      activity: { state: 'permission', reason: { kind: 'permission' } },
      usage: usageFixture,
      awaitedPromptId: 'sess-1:tool-1',
    });
    expect(parsed.awaitedPromptId).toBe('sess-1:tool-1');
    expect(parsed.activity.state).toBe('permission');
    expect(parsed.usage).toEqual(usageFixture);
  });

  it('rejects a read-stream response without scrollback', () => {
    expect(() => parseReadStreamResponsePayload({ activity: { state: null, reason: null }, usage: null, awaitedPromptId: null })).toThrow(
      /scrollback/,
    );
  });

  it('parses a read-board project list', () => {
    expect(parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha' }] })).toEqual({ projects: [{ id: 'p-1', name: 'Alpha' }] });
  });

  it('parses a read-board snapshot', () => {
    const snapshot: JsonValue = {
      projectId: 'p-1',
      columns: [],
      tasks: [boardTaskFixture],
      backlog: [],
    };
    const parsed = parseReadBoardResponsePayload(snapshot);
    expect(parsed).toEqual(snapshot);
  });

  it('rejects a read-board snapshot missing columns', () => {
    expect(() => parseReadBoardResponsePayload({ projectId: 'p-1', tasks: [], backlog: [] })).toThrow(/columns/);
  });

  it('parses a read-diff response by discriminating on "files"', () => {
    expect(parseReadDiffResponsePayload({ files: [], totalInsertions: 0, totalDeletions: 0 })).toEqual({ files: [], totalInsertions: 0, totalDeletions: 0 });
    expect(parseReadDiffResponsePayload({ original: 'a', modified: 'b', language: 'ts' })).toEqual({ original: 'a', modified: 'b', language: 'ts' });
  });
});

describe('parseTranscriptEventPayload', () => {
  const userEntry = { kind: 'user', uuid: 'u', ts: 1, text: 'x' };

  it('parses a delta payload with indexed upserts', () => {
    const payload: JsonValue = { mode: 'delta', revision: 3, totalEntries: 12, upserts: [{ index: 11, entry: userEntry }] };
    expect(parseTranscriptEventPayload(payload)).toEqual(payload);
  });

  it('parses a reset payload', () => {
    expect(parseTranscriptEventPayload({ mode: 'reset', revision: 4, totalEntries: 0 })).toEqual({ mode: 'reset', revision: 4, totalEntries: 0 });
  });

  it('rejects a legacy whole-array payload, an unknown mode, and malformed upserts', () => {
    expect(() => parseTranscriptEventPayload([userEntry] as unknown as JsonValue)).toThrow(/object/);
    expect(() => parseTranscriptEventPayload({ mode: 'replace', revision: 1, totalEntries: 1 })).toThrow(/mode/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1, totalEntries: 1 })).toThrow(/upserts/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1, totalEntries: 1, upserts: [{ index: -1, entry: userEntry }] })).toThrow(/index/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1, totalEntries: 1, upserts: [{ index: 0, entry: { kind: 'user' } }] })).toThrow(/entry/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1.5, totalEntries: 1, upserts: [] })).toThrow(/revision/);
  });
});

describe('parseTranscriptWindowResponsePayload', () => {
  const userEntry = { kind: 'user', uuid: 'u', ts: 1, text: 'x' };

  it('parses a windowed-history page', () => {
    const payload: JsonValue = { revision: 9, totalEntries: 500, startIndex: 440, entries: [userEntry] };
    expect(parseTranscriptWindowResponsePayload(payload)).toEqual(payload);
  });

  it('rejects malformed windows', () => {
    expect(() => parseTranscriptWindowResponsePayload({ revision: 9, totalEntries: 500, startIndex: -1, entries: [] })).toThrow(/startIndex/);
    expect(() => parseTranscriptWindowResponsePayload({ revision: 9, totalEntries: 500, startIndex: 0, entries: [{ kind: 'user' }] })).toThrow(/malformed/);
    expect(() => parseTranscriptWindowResponsePayload({ revision: 9, startIndex: 0, entries: [] })).toThrow(/totalEntries/);
  });
});

describe('isBridgeEvent', () => {
  it('accepts every well-formed event kind', () => {
    expect(
      isBridgeEvent({
        kind: 'transcript',
        sessionId: 's',
        taskId: 't',
        payload: { mode: 'delta', revision: 1, totalEntries: 1, upserts: [{ index: 0, entry: { kind: 'user', uuid: 'u', ts: 1, text: 'x' } }] },
      }),
    ).toBe(true);
    expect(isBridgeEvent({ kind: 'transcript', sessionId: 's', taskId: 't', payload: { mode: 'reset', revision: 2, totalEntries: 0 } })).toBe(true);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'permission', promptId: 'p', pending: true } })).toBe(true);
    expect(isBridgeEvent({ kind: 'terminal', sessionId: 's', taskId: 't', payload: { data: 'bytes' } })).toBe(true);
    expect(isBridgeEvent({ kind: 'board', projectId: 'p', payload: { change: 'task-updated', ids: ['t-1'] } })).toBe(true);
    expect(isBridgeEvent({ kind: 'diff', taskId: 't', payload: null })).toBe(true);
  });

  it('rejects malformed events', () => {
    expect(isBridgeEvent(null)).toBe(false);
    expect(isBridgeEvent({ kind: 'transcript', sessionId: 's', taskId: 't', payload: 'not-a-delta' })).toBe(false);
    expect(isBridgeEvent({ kind: 'transcript', sessionId: 's', taskId: 't', payload: [{ kind: 'user', uuid: 'u', ts: 1, text: 'x' }] })).toBe(false);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'activity', state: 'busy', reason: { kind: 'idle' } } })).toBe(false);
    expect(isBridgeEvent({ kind: 'terminal', sessionId: 's', taskId: 't', payload: { data: 42 } })).toBe(false);
    expect(isBridgeEvent({ kind: 'board', projectId: 'p', payload: { change: 'exploded', ids: [] } })).toBe(false);
    expect(isBridgeEvent({ kind: 'diff', taskId: 't', payload: { stale: true } })).toBe(false);
    expect(isBridgeEvent({ kind: 'metrics', sessionId: 's', taskId: 't', payload: null })).toBe(false);
  });
});
