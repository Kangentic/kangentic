/**
 * Capability discovery for Cursor (the `agent` CLI): parses `agent --help`
 * for `--model` support, and walks `~/.cursor/sessions/<dated-dir>/*.jsonl`
 * for models on `system / init` NDJSON events.
 *
 * On Windows, the CLI is a `.CMD` shim that cannot be invoked via execFile
 * (Node CVE-2024-27980 mitigation). The discovery code uses `exec` with a
 * shell on win32 and `execFile` elsewhere - tests cover both paths via the
 * promisify identity mock.
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
import { discoverCursorCapabilities } from '../../src/main/agent/adapters/cursor/capability-discovery';
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

const SESSIONS_ROOT = path.join(os.homedir(), '.cursor', 'sessions');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout, stderr: '' });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the history-scan primitives for Cursor's session store.
 * Layout: `<root>/<dated-dir>/<chatId>.jsonl`
 * listMostRecentDirs returns the dated dirs from the sessions root, then
 * listMostRecentFiles returns the .jsonl files within each dated dir, and
 * readHeadBytes returns file contents. Setting the store to null makes
 * ~/.cursor/sessions appear missing (empty listings).
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

  const datedDirs = Object.keys(store);

  listDirsMock.mockImplementation(async (parent: string) => {
    if (parent !== SESSIONS_ROOT) return [];
    // Descending mtime so scan order is deterministic.
    return datedDirs.map((name, index) => ({
      fullPath: path.join(SESSIONS_ROOT, name),
      mtimeMs: datedDirs.length - index,
    }));
  });

  listFilesMock.mockImplementation(async (directory: string, predicate: (name: string) => boolean) => {
    for (const datedDir of datedDirs) {
      const datedPath = path.join(SESSIONS_ROOT, datedDir);
      if (directory === datedPath) {
        const fileNames = Object.keys(store[datedDir]).filter(predicate);
        return fileNames.map((fileName, index) => ({
          fullPath: path.join(datedPath, fileName),
          mtimeMs: fileNames.length - index,
        }));
      }
    }
    return [];
  });

  readHeadMock.mockImplementation(async (filePath: string) => {
    for (const [datedDir, files] of Object.entries(store)) {
      for (const [fileName, contents] of Object.entries(files)) {
        if (filePath === path.join(SESSIONS_ROOT, datedDir, fileName)) return contents;
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

describe('discoverCursorCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  --model <model>           Model to use (e.g., gpt-5, sonnet-4, sonnet-4-thinking)
  --list-models             List available models and exit
`);
    const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model when help text omits the flag', async () => {
    setHelpOutput('Usage: agent\n  -h, --help    Display help\n');
    const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
    expect(capabilities.supportsModelOverride).toBe(false);
  });

  it('returns empty effortLevels (Cursor encodes effort in model names)', async () => {
    setHelpOutput('  --model <model> Model to use\n');
    const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('falls back to hardcoded common models when help fails', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverCursorCapabilities('/missing/agent');
    expect(capabilities.supportsModelOverride).toBe(false);
    // Cursor always returns its hardcoded fallback list regardless of detection
    expect(capabilities.models).toBeDefined();
    expect(capabilities.models?.length).toBeGreaterThan(0);
  });

  describe('historical model discovery', () => {
    /** Real Cursor NDJSON init event shape (verified empirically). */
    function initLine(model: string, sessionId = 'sess-1'): string {
      return JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model,
        permissionMode: 'default',
      });
    }

    function userLine(): string {
      return JSON.stringify({ type: 'user', content: [{ text: 'hello' }] });
    }

    it('extracts models from `system / init` events', async () => {
      setHelpOutput('  --model <model> Model to use\n');
      setSessionStore({
        '2026-04-28': {
          'chat-1.jsonl': `${initLine('Claude 4.1 Sonnet')}\n${userLine()}\n`,
        },
      });

      const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
      // Discovered model + the hardcoded common list, deduped
      expect(capabilities.models).toContain('Claude 4.1 Sonnet');
    });

    it('dedupes against the hardcoded common-models fallback', async () => {
      setHelpOutput('  --model <model> Model to use\n');
      setSessionStore({
        '2026-04-28': {
          // 'Claude 4.1 Sonnet' is already in CURSOR_COMMON_MODELS
          'chat-1.jsonl': initLine('Claude 4.1 Sonnet') + '\n',
        },
      });

      const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
      const occurrences = capabilities.models?.filter((m) => m === 'Claude 4.1 Sonnet').length ?? 0;
      expect(occurrences).toBe(1);
    });

    it('skips events that are not `system / init`', async () => {
      setHelpOutput('  --model <model> Model to use\n');
      setSessionStore({
        '2026-04-28': {
          'chat-1.jsonl': `${userLine()}\n${JSON.stringify({ type: 'system', subtype: 'other', model: 'should-not-appear' })}\n`,
        },
      });

      const capabilities = await discoverCursorCapabilities('/usr/bin/agent');
      expect(capabilities.models).not.toContain('should-not-appear');
    });
  });
});
