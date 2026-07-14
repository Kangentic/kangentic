/**
 * Unit tests for handleGetSessionHistory in
 * src/main/agent/commands/analytics-commands.ts.
 *
 * Exercises the native session-history file read:
 *   - a file over MAX_SESSION_HISTORY_BYTES (200_000 bytes) returns a
 *     "[Truncated - showing last 195KB of <Y>KB]" banner followed by the
 *     whole-line tail content (195 = Math.round(200_000 / 1024), fixed
 *     regardless of the source file's actual size);
 *   - a small file returns the raw content, untruncated;
 *   - a filesystem read error (missing file) returns a
 *     `{ success: false, error: 'Failed to read session file at ...' }`
 *     response instead of throwing.
 *
 * Pattern: fake `db.prepare` keyed by SQL substring (mirrors
 * session-files-commands.test.ts), real TaskRepository/resolveTask, mocked
 * agentRegistry (avoids loading every real adapter's native deps), and real
 * file writes under os.tmpdir() so readBoundedTail reads genuine disk state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockGetBySessionType = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getBySessionType: (...args: unknown[]) => mockGetBySessionType(...args),
  },
}));

import { handleGetSessionHistory } from '../../src/main/agent/commands/analytics-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

interface TaskRow {
  id: string;
  title: string;
  labels: string;
}

interface SessionHistoryRecord {
  id: string;
  session_type: string;
  agent_session_id: string;
  cwd: string;
}

function createDb(options: { task?: TaskRow; sessionRecord?: SessionHistoryRecord }) {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM tasks') && sql.includes('t.id = ?')) {
        return {
          get: vi.fn(() => options.task),
          all: vi.fn(() => (options.task ? [options.task] : [])),
        };
      }
      if (sql.includes('FROM sessions') && sql.includes('agent_session_id IS NOT NULL')) {
        return {
          get: vi.fn(() => options.sessionRecord),
          all: vi.fn(() => []),
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
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kang-session-history-'));
  mockGetBySessionType.mockReset();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const TASK: TaskRow = { id: 'task-uuid-1', title: 'History Task', labels: '[]' };
const SESSION_RECORD: SessionHistoryRecord = {
  id: 'session-uuid-1',
  session_type: 'claude',
  agent_session_id: 'agent-session-uuid',
  cwd: '/mock/project',
};

describe('handleGetSessionHistory', () => {
  it('requires a taskId', async () => {
    const db = createDb({});
    const result = await handleGetSessionHistory({}, createContext(db, projectRoot));
    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId');
  });

  it('returns raw, untruncated content for a small session history file', async () => {
    const historyPath = path.join(projectRoot, 'small-history.jsonl');
    const smallContent = '{"type":"message","text":"hello"}\n{"type":"message","text":"world"}';
    fs.writeFileSync(historyPath, smallContent);
    mockGetBySessionType.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      locateSessionHistoryFile: vi.fn(async () => historyPath),
    });
    const db = createDb({ task: TASK, sessionRecord: SESSION_RECORD });

    const result = await handleGetSessionHistory({ taskId: TASK.id }, createContext(db, projectRoot));

    expect(result.success).toBe(true);
    expect(result.message).toBe(smallContent);
    expect(result.message).not.toContain('Truncated');
  });

  it('returns a truncation banner and a whole-line tail for a file over the byte cap', async () => {
    const lineCount = 4000;
    const padding = 'p'.repeat(60);
    const lines = Array.from({ length: lineCount }, (_, index) => `{"idx":${index},"pad":"${padding}"}`);
    const content = lines.join('\n');
    const totalBytes = Buffer.byteLength(content);
    expect(totalBytes).toBeGreaterThan(200_000);
    const expectedKilobytes = Math.round(totalBytes / 1024);

    const historyPath = path.join(projectRoot, 'big-history.jsonl');
    fs.writeFileSync(historyPath, content);
    mockGetBySessionType.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      locateSessionHistoryFile: vi.fn(async () => historyPath),
    });
    const db = createDb({ task: TASK, sessionRecord: SESSION_RECORD });

    const result = await handleGetSessionHistory({ taskId: TASK.id }, createContext(db, projectRoot));

    expect(result.success).toBe(true);
    const message = result.message as string;
    const bannerMatch = message.match(/^\[Truncated - showing last (\d+)KB of (\d+)KB\]\n([\s\S]*)$/);
    expect(bannerMatch).not.toBeNull();
    const [, shownKilobytes, totalKilobytes, tailContent] = bannerMatch!;
    // MAX_SESSION_HISTORY_BYTES (200_000) / 1024, rounded, is always 195 -
    // fixed regardless of the source file's actual size.
    expect(shownKilobytes).toBe('195');
    expect(totalKilobytes).toBe(String(expectedKilobytes));

    // The tail is whole lines from the END of the file, and the leading
    // (possibly partial) line is dropped: the last authored line survives
    // intact, the first never leaks through, and every returned line parses.
    expect(tailContent).toContain(lines[lineCount - 1]);
    expect(tailContent).not.toContain(lines[0]);
    const returnedLines = tailContent.split('\n').filter((line) => line.length > 0);
    expect(returnedLines.length).toBeGreaterThan(0);
    for (const line of returnedLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('returns a read-error response when the located file cannot be read', async () => {
    const missingPath = path.join(projectRoot, 'does-not-exist.jsonl');
    mockGetBySessionType.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      locateSessionHistoryFile: vi.fn(async () => missingPath),
    });
    const db = createDb({ task: TASK, sessionRecord: SESSION_RECORD });

    const result = await handleGetSessionHistory({ taskId: TASK.id }, createContext(db, projectRoot));

    expect(result.success).toBe(false);
    expect(result.error).toContain(`Failed to read session file at ${missingPath}`);
  });
});
