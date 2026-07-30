import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handleGetSessionFiles,
  handleGetSessionEvents,
} from '../../src/main/agent/commands/session-files-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

interface SessionRow {
  id: string;
  task_id: string;
  session_type: string;
  agent_session_id: string | null;
  cwd: string;
  status: string;
  started_at: string;
  exited_at: string | null;
  suspended_at: string | null;
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-uuid-1',
    task_id: 'task-uuid-1',
    session_type: 'claude',
    agent_session_id: 'agent-uuid-aaa',
    cwd: '/tmp/project',
    status: 'running',
    started_at: '2026-04-08T10:00:00Z',
    exited_at: null,
    suspended_at: null,
    ...overrides,
  };
}

function createDb(options: {
  sessionsByTask?: Record<string, SessionRow[]>;
  sessionsById?: Record<string, SessionRow>;
  tasks?: Array<{ id: string; display_id: number; title: string }>;
}) {
  const sessionsByTask = options.sessionsByTask ?? {};
  const sessionsById = options.sessionsById ?? {};
  const tasks = options.tasks ?? [];

  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM sessions') && sql.includes('WHERE id = ?')) {
        return {
          get: vi.fn((sessionId: string) => sessionsById[sessionId]),
          all: vi.fn(() => []),
        };
      }
      if (sql.includes('FROM sessions') && sql.includes('task_id = ?')) {
        return {
          get: vi.fn(() => undefined),
          all: vi.fn((taskId: string) => sessionsByTask[taskId] ?? []),
        };
      }
      if (sql.includes('FROM tasks') && sql.includes('display_id')) {
        return {
          get: vi.fn((displayId: number) => tasks.find((task) => task.display_id === displayId)),
          all: vi.fn(() => tasks),
        };
      }
      if (sql.includes('FROM tasks') && sql.includes('WHERE id')) {
        return {
          get: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId)),
          all: vi.fn(() => tasks),
        };
      }
      return {
        get: vi.fn(() => undefined),
        all: vi.fn(() => []),
      };
    }),
  };
}

function createContext(db: ReturnType<typeof createDb>, projectRoot: string): CommandContext {
  return {
    getProjectDb: () => db as never,
    getProjectPath: () => projectRoot,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kang-session-files-'));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function writeEventsJsonl(sessionId: string, lines: string[]): string {
  const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, lines.join('\n'));
  return eventsPath;
}

describe('handleGetSessionFiles', () => {
  it('returns error when neither taskId nor sessionId given', async () => {
    const db = createDb({});
    const result = await handleGetSessionFiles({}, createContext(db, projectRoot));
    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId or sessionId');
  });

  it('resolves by sessionId and returns paths keyed by sessions.id', async () => {
    const session = makeSession({ id: 'sess-xyz', agent_session_id: 'agent-xyz' });
    const db = createDb({ sessionsById: { 'sess-xyz': session } });
    const result = await handleGetSessionFiles({ sessionId: 'sess-xyz' }, createContext(db, projectRoot));

    expect(result.success).toBe(true);
    const data = result.data as { sessionDir: string; sessionId: string; agentSessionId: string; files: Record<string, { path: string; exists: boolean }> };
    expect(data.sessionId).toBe('sess-xyz');
    expect(data.agentSessionId).toBe('agent-xyz');
    expect(data.sessionDir.replace(/\\/g, '/')).toContain('/.kangentic/sessions/sess-xyz');
    expect(data.files.eventsJsonl.path.replace(/\\/g, '/')).toMatch(/\/sessions\/sess-xyz\/events\.jsonl$/);
    expect(data.files.eventsJsonl.exists).toBe(false);
  });

  it('exists flag flips to true when the file is on disk', async () => {
    const session = makeSession({ id: 'sess-real' });
    writeEventsJsonl('sess-real', ['{"type":"Stop"}']);
    const db = createDb({ sessionsById: { 'sess-real': session } });

    const result = await handleGetSessionFiles({ sessionId: 'sess-real' }, createContext(db, projectRoot));
    const data = result.data as { files: Record<string, { exists: boolean }> };
    expect(data.files.eventsJsonl.exists).toBe(true);
    expect(data.files.statusJson.exists).toBe(false);
  });

  it('resolves by taskId picking the latest session by default', async () => {
    const newer = makeSession({ id: 'sess-new', started_at: '2026-04-08T12:00:00Z' });
    const older = makeSession({ id: 'sess-old', started_at: '2026-04-08T08:00:00Z' });
    const db = createDb({
      tasks: [{ id: 'task-1', display_id: 42, title: 'My task' }],
      sessionsByTask: { 'task-1': [newer, older] },
    });
    const result = await handleGetSessionFiles({ taskId: '42' }, createContext(db, projectRoot));
    expect(result.success).toBe(true);
    expect((result.data as { sessionId: string }).sessionId).toBe('sess-new');
  });

  it('honors sessionIndex to pick older sessions', async () => {
    const newer = makeSession({ id: 'sess-new', started_at: '2026-04-08T12:00:00Z' });
    const older = makeSession({ id: 'sess-old', started_at: '2026-04-08T08:00:00Z' });
    const db = createDb({
      tasks: [{ id: 'task-1', display_id: 42, title: 'My task' }],
      sessionsByTask: { 'task-1': [newer, older] },
    });
    const result = await handleGetSessionFiles({ taskId: '42', sessionIndex: 1 }, createContext(db, projectRoot));
    expect((result.data as { sessionId: string }).sessionId).toBe('sess-old');
  });

  it('errors when sessionIndex is out of range', async () => {
    const db = createDb({
      tasks: [{ id: 'task-1', display_id: 42, title: 'My task' }],
      sessionsByTask: { 'task-1': [makeSession()] },
    });
    const result = await handleGetSessionFiles({ taskId: '42', sessionIndex: 5 }, createContext(db, projectRoot));
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('errors when task has no sessions', async () => {
    const db = createDb({
      tasks: [{ id: 'task-1', display_id: 42, title: 'My task' }],
      sessionsByTask: {},
    });
    const result = await handleGetSessionFiles({ taskId: '42' }, createContext(db, projectRoot));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No sessions');
  });
});

describe('handleGetSessionEvents', () => {
  const sessionId = 'sess-events';
  const session = makeSession({ id: sessionId });

  function ctx() {
    return createContext(createDb({ sessionsById: { [sessionId]: session } }), projectRoot);
  }

  it('returns empty events list when file does not exist', () => {
    const result = handleGetSessionEvents({ sessionId }, ctx());
    expect(result.success).toBe(true);
    const data = result.data as { events: unknown[]; totalLines: number };
    expect(data.events).toEqual([]);
    expect(data.totalLines).toBe(0);
  });

  it('parses valid lines and skips malformed ones', () => {
    writeEventsJsonl(sessionId, [
      '{"hook_event_name":"PreToolUse","timestamp":1000}',
      'not json garbage',
      '{"hook_event_name":"Stop","timestamp":2000}',
      '',
    ]);
    const result = handleGetSessionEvents({ sessionId }, ctx());
    const data = result.data as { events: Array<Record<string, unknown>>; returned: number };
    expect(data.returned).toBe(2);
    expect(data.events.map((event) => event.hook_event_name)).toEqual(['PreToolUse', 'Stop']);
  });

  it('filters by eventTypes (matches hook_event_name and type)', () => {
    writeEventsJsonl(sessionId, [
      '{"hook_event_name":"PreToolUse"}',
      '{"hook_event_name":"PostToolUse"}',
      '{"type":"Stop"}',
      '{"hook_event_name":"Notification"}',
    ]);
    const result = handleGetSessionEvents({ sessionId, eventTypes: ['PreToolUse', 'Stop'] }, ctx());
    const data = result.data as { events: Array<Record<string, unknown>> };
    expect(data.events).toHaveLength(2);
  });

  it('drops events older than since (epoch ms)', () => {
    writeEventsJsonl(sessionId, [
      '{"hook_event_name":"A","timestamp":1000}',
      '{"hook_event_name":"B","timestamp":2000}',
      '{"hook_event_name":"C","timestamp":3000}',
    ]);
    const result = handleGetSessionEvents({ sessionId, since: 2000 }, ctx());
    const data = result.data as { events: Array<Record<string, unknown>> };
    expect(data.events.map((event) => event.hook_event_name)).toEqual(['B', 'C']);
  });

  it('drops events with no timestamp when since is set', () => {
    writeEventsJsonl(sessionId, [
      '{"hook_event_name":"NoTs"}',
      '{"hook_event_name":"WithTs","timestamp":5000}',
    ]);
    const result = handleGetSessionEvents({ sessionId, since: 1000 }, ctx());
    const data = result.data as { events: Array<Record<string, unknown>> };
    expect(data.events.map((event) => event.hook_event_name)).toEqual(['WithTs']);
  });

  it('returns only the last N events when tail is set', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `{"hook_event_name":"E${index}"}`);
    writeEventsJsonl(sessionId, lines);
    const result = handleGetSessionEvents({ sessionId, tail: 3 }, ctx());
    const data = result.data as { events: Array<Record<string, unknown>>; returned: number };
    expect(data.returned).toBe(3);
    expect(data.events.map((event) => event.hook_event_name)).toEqual(['E7', 'E8', 'E9']);
  });

  it('caps tail at the hard maximum', () => {
    const lines = Array.from({ length: 5 }, (_, index) => `{"hook_event_name":"E${index}"}`);
    writeEventsJsonl(sessionId, lines);
    const result = handleGetSessionEvents({ sessionId, tail: 99999 }, ctx());
    const data = result.data as { returned: number };
    expect(data.returned).toBe(5);
  });

  it('reports truncated=false on small files', () => {
    writeEventsJsonl(sessionId, ['{"hook_event_name":"Stop"}']);
    const result = handleGetSessionEvents({ sessionId }, ctx());
    const data = result.data as { truncated: boolean; totalBytes: number };
    expect(data.truncated).toBe(false);
    expect(data.totalBytes).toBeGreaterThan(0);
  });

  it('tail-reads a bounded window from a file over the byte cap', () => {
    // ~4000 lines x ~400B = ~1.6MB, over the 1MB MAX_EVENTS_READ_BYTES cap.
    const padding = 'p'.repeat(370);
    const lines = Array.from(
      { length: 4000 },
      (_, index) => `{"hook_event_name":"E${index}","pad":"${padding}"}`,
    );
    writeEventsJsonl(sessionId, lines);

    const result = handleGetSessionEvents({ sessionId, tail: 50 }, ctx());
    expect(result.success).toBe(true);
    const data = result.data as {
      events: Array<Record<string, unknown>>;
      returned: number;
      truncated: boolean;
      totalBytes: number;
    };
    expect(data.truncated).toBe(true);
    expect(data.totalBytes).toBeGreaterThan(1024 * 1024);
    expect(data.returned).toBe(50);
    // The tail is the END of the file, and the dropped partial first line
    // never corrupts parsing (every returned event parsed cleanly).
    expect(data.events[data.events.length - 1].hook_event_name).toBe('E3999');
    expect(data.events[0].hook_event_name).toBe('E3950');
    expect(result.message).toContain('scanned last');
  });
});
