/**
 * Capability discovery for Qwen Code: parses `qwen --help` for static
 * support and walks `~/.qwen/projects/<project>/chats/<sessionId>.jsonl`
 * for model identifiers.
 *
 * Qwen ships two model-bearing event shapes:
 *   - assistant messages: top-level `obj.model`
 *   - `systemPayload.uiEvent.model` on `ui_telemetry` events
 * The parser probes both, so a real-shape fixture for each protects
 * against future schema drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

// The session-history walk now goes through the shared async primitives in
// history-scan. Mock the I/O primitives (listing + head read) and keep
// parseJsonlRecords real so the adapter's record-extraction logic is exercised;
// the fs walk itself is covered by tests/unit/history-scan.test.ts.
vi.mock('../../src/main/agent/shared/history-scan', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/agent/shared/history-scan')>();
  return {
    ...actual,
    listMostRecentDirs: vi.fn(),
    listMostRecentFiles: vi.fn(),
    readHeadBytes: vi.fn(),
  };
});

import { execFile, exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverQwenCapabilities } from '../../src/main/agent/adapters/qwen-code/capability-discovery';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
} from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const listFilesMock = listMostRecentFiles as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;

const PROJECTS_ROOT = path.join(os.homedir(), '.qwen', 'projects');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the history-scan primitives for Qwen's session store.
 * Layout: `<root>/<project-hash>/chats/<sessionId>.jsonl`
 * listMostRecentDirs returns project dirs, listMostRecentFiles returns the
 * .jsonl files inside each project's `chats/` dir, and readHeadBytes returns
 * file contents. Setting the store to null makes ~/.qwen/projects appear
 * missing (empty listings).
 */
type SessionTree = Record<string, Record<string, string>>;

function setSessionStore(store: SessionTree | null): void {
  listDirsMock.mockReset();
  listFilesMock.mockReset();
  readHeadMock.mockReset();

  if (store === null) {
    listDirsMock.mockResolvedValue([]);
    listFilesMock.mockResolvedValue([]);
    readHeadMock.mockResolvedValue('');
    return;
  }

  const projectNames = Object.keys(store);

  listDirsMock.mockImplementation(async (parent: string) => {
    if (parent !== PROJECTS_ROOT) return [];
    // Descending mtime so scan order is deterministic.
    return projectNames.map((name, index) => ({
      fullPath: path.join(PROJECTS_ROOT, name),
      mtimeMs: projectNames.length - index,
    }));
  });

  listFilesMock.mockImplementation(async (directory: string, predicate: (name: string) => boolean) => {
    for (const projectName of projectNames) {
      const chatsDir = path.join(PROJECTS_ROOT, projectName, 'chats');
      if (directory === chatsDir) {
        const fileNames = Object.keys(store[projectName]).filter(predicate);
        return fileNames.map((fileName, index) => ({
          fullPath: path.join(chatsDir, fileName),
          mtimeMs: fileNames.length - index,
        }));
      }
    }
    return [];
  });

  readHeadMock.mockImplementation(async (filePath: string) => {
    for (const [projectName, files] of Object.entries(store)) {
      for (const [fileName, contents] of Object.entries(files)) {
        if (filePath === path.join(PROJECTS_ROOT, projectName, 'chats', fileName)) return contents;
      }
    }
    return '';
  });
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  setSessionStore(null);
});

describe('discoverQwenCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  -m, --model              Model  [string]
  -p, --prompt             Prompt
`);
    const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('returns empty effortLevels (Qwen has no effort)', async () => {
    setHelpOutput('  -m, --model Model\n');
    const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery', () => {
    /** Real Qwen JSONL: assistant messages carry top-level `model` */
    function assistantLine(model: string): string {
      return JSON.stringify({
        uuid: 'msg-1',
        sessionId: 'sess-1',
        timestamp: '2026-04-26T20:18:36.836Z',
        type: 'assistant',
        version: '0.15.3',
        model,
        message: { role: 'model', parts: [{ text: 'hi' }] },
      });
    }

    /** ui_telemetry event: model lives at systemPayload.uiEvent.model */
    function uiTelemetryLine(model: string): string {
      return JSON.stringify({
        uuid: 'tel-1',
        sessionId: 'sess-1',
        timestamp: '2026-04-26T20:18:36.721Z',
        type: 'system',
        version: '0.15.3',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            response_id: 'msg_01',
            model,
            status_code: 200,
          },
        },
      });
    }

    function userLine(): string {
      return JSON.stringify({
        uuid: 'u-1',
        sessionId: 'sess-1',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'test' }] },
      });
    }

    it('extracts models from top-level `model` on assistant messages', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-dev-documents-github-kangentic': {
          'sess-1.jsonl': `${userLine()}\n${assistantLine('claude-sonnet-4-6')}\n`,
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toEqual(['claude-sonnet-4-6']);
    });

    it('extracts models from systemPayload.uiEvent.model on ui_telemetry events', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-dev-documents-github-kangentic': {
          'sess-1.jsonl': uiTelemetryLine('qwen3-coder-plus') + '\n',
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toEqual(['qwen3-coder-plus']);
    });

    it('dedupes models that appear in both shapes', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-dev-documents-github-kangentic': {
          'sess-1.jsonl': [
            uiTelemetryLine('claude-sonnet-4-6'),
            assistantLine('claude-sonnet-4-6'),
          ].join('\n') + '\n',
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toEqual(['claude-sonnet-4-6']);
    });

    it('returns models=undefined when sessions exist but lack model fields', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        'c--users-dev-documents-github-kangentic': {
          'sess-1.jsonl': userLine() + '\n',
        },
      });

      const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
