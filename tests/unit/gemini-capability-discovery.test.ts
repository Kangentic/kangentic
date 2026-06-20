/**
 * Capability discovery for Gemini CLI: parses `gemini --help` for static
 * support and walks `~/.gemini/tmp/<project>/chats/session-*.json[l]` for
 * model identifiers used in past sessions.
 *
 * The session-history scan must rank project dirs by their `chats/`
 * subdirectory mtime (not the project root) so test-artifact dirs without
 * `chats/` do not crowd out real sessions. The "real-session.json with
 * messages[].model" parse path locks the schema against drift.
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
// history-scan. Mock the I/O primitives (listing + head/whole-file read) and
// keep parseJsonlRecords real so the adapter's record-extraction logic is
// exercised; the fs walk itself is covered by tests/unit/history-scan.test.ts.
vi.mock('../../src/main/agent/shared/history-scan', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/agent/shared/history-scan')>();
  return {
    ...actual,
    listMostRecentDirs: vi.fn(),
    listMostRecentFiles: vi.fn(),
    readHeadBytes: vi.fn(),
    readWholeFile: vi.fn(),
  };
});

import { execFile, exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverGeminiCapabilities } from '../../src/main/agent/adapters/gemini/capability-discovery';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
  readWholeFile,
} from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const listFilesMock = listMostRecentFiles as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;
const readWholeMock = readWholeFile as unknown as ReturnType<typeof vi.fn>;

const TMP_ROOT = path.join(os.homedir(), '.gemini', 'tmp');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the history-scan primitives for Gemini's session store.
 * Layout: `<tmpRoot>/<project-slug>/chats/<session-file>`
 * The scanner ranks project dirs by `chats/` mtime (listMostRecentDirs options),
 * then lists session files in each `chats/` dir. `.jsonl` files are read via
 * readHeadBytes; `.json` files via readWholeFile.
 * Setting the store to null makes ~/.gemini/tmp appear missing (empty listings).
 */
type SessionTree = Record<string, Record<string, string>>;

function setSessionStore(store: SessionTree | null): void {
  listDirsMock.mockReset();
  listFilesMock.mockReset();
  readHeadMock.mockReset();
  readWholeMock.mockReset();

  if (store === null) {
    listDirsMock.mockResolvedValue([]);
    listFilesMock.mockResolvedValue([]);
    readHeadMock.mockResolvedValue('');
    readWholeMock.mockResolvedValue('');
    return;
  }

  const projectNames = Object.keys(store);

  listDirsMock.mockImplementation(async (parent: string) => {
    if (parent !== TMP_ROOT) return [];
    // Descending mtime so scan order is deterministic.
    return projectNames.map((name, index) => ({
      fullPath: path.join(TMP_ROOT, name),
      mtimeMs: projectNames.length - index,
    }));
  });

  listFilesMock.mockImplementation(async (directory: string, predicate: (name: string) => boolean) => {
    for (const projectName of projectNames) {
      const chatsDir = path.join(TMP_ROOT, projectName, 'chats');
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
        if (filePath === path.join(TMP_ROOT, projectName, 'chats', fileName)) return contents;
      }
    }
    return '';
  });

  readWholeMock.mockImplementation(async (filePath: string) => {
    for (const [projectName, files] of Object.entries(store)) {
      for (const [fileName, contents] of Object.entries(files)) {
        if (filePath === path.join(TMP_ROOT, projectName, 'chats', fileName)) return contents;
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

describe('discoverGeminiCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  -m, --model                     Model  [string]
  -p, --prompt <text>             Run in non-interactive mode
`);
    const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model support when help text omits the flag', async () => {
    setHelpOutput('Usage: gemini\n  -h, --help    Show help\n');
    const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
    expect(capabilities.supportsModelOverride).toBe(false);
  });

  it('returns empty effortLevels (Gemini has no effort concept)', async () => {
    setHelpOutput('  -m, --model Model\n');
    const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery', () => {
    /**
     * Real Gemini session.json shape (verified against gemini 0.40.1).
     * Models live on each gemini-typed assistant message under `.model`.
     */
    function realSessionJson(model: string): string {
      return JSON.stringify({
        sessionId: '08889b8d-c485-4aaa-b91d-ae966fa0ab4a',
        startTime: '2026-04-01T23:38:36.391Z',
        messages: [
          { id: 'a', type: 'user', content: [{ text: 'hello' }] },
          { id: 'b', type: 'gemini', content: 'Hello back!', model },
        ],
        kind: 'main',
      });
    }

    function realSessionJsonl(model: string): string {
      // .jsonl format: each line is its own record; gemini-typed messages
      // carry .model directly at the top level.
      return [
        JSON.stringify({ sessionId: 'abc', kind: 'main', startTime: '2026-04-28T18:52:12Z' }),
        JSON.stringify({ id: 'b', type: 'gemini', content: 'Hi', model }),
      ].join('\n');
    }

    it('extracts models from `messages[].model` in .json sessions', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        kangentic: {
          'session-2026-04-01T23-37.json': realSessionJson('gemini-3-flash-preview'),
        },
      });

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toEqual(['gemini-3-flash-preview']);
    });

    it('extracts models from .jsonl sessions (newer format)', async () => {
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        kangentic: {
          'session-2026-04-28T18-52.jsonl': realSessionJsonl('gemini-2.5-flash'),
        },
      });

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toEqual(['gemini-2.5-flash']);
    });

    it('skips project dirs whose chats/ subdir does not exist', async () => {
      setHelpOutput('  -m, --model Model\n');
      // Two projects in store; the test-artifact has no chats/ session files.
      // With history-scan, a missing chats/ dir means listMostRecentDirs does
      // not include it (requireMtimeSubpath=true filters it). We replicate this
      // by only returning the real project from listDirsMock.
      listDirsMock.mockReset();
      listFilesMock.mockReset();
      readHeadMock.mockReset();
      readWholeMock.mockReset();

      // Only 'kangentic' appears in the listing; 'gemini-test-artifact' is
      // filtered out by the requireMtimeSubpath option in the real scanner.
      listDirsMock.mockImplementation(async (parent: string) => {
        if (parent === TMP_ROOT) {
          return [{ fullPath: path.join(TMP_ROOT, 'kangentic'), mtimeMs: 2 }];
        }
        return [];
      });

      listFilesMock.mockImplementation(async (directory: string, predicate: (name: string) => boolean) => {
        const chatsDir = path.join(TMP_ROOT, 'kangentic', 'chats');
        if (directory === chatsDir) {
          const name = 'session-real.json';
          return predicate(name) ? [{ fullPath: path.join(chatsDir, name), mtimeMs: 1 }] : [];
        }
        return [];
      });

      readWholeMock.mockImplementation(async (filePath: string) => {
        if (filePath === path.join(TMP_ROOT, 'kangentic', 'chats', 'session-real.json')) {
          return realSessionJson('gemini-2.5-pro');
        }
        return '';
      });

      readHeadMock.mockResolvedValue('');

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toEqual(['gemini-2.5-pro']);
    });

    it('harvests models from both .json and .jsonl files in the same project chats dir', async () => {
      // One project directory containing two session files: one .json and one .jsonl.
      // Both file types must be scanned in a single pass so both models appear in
      // the result, regardless of which format Gemini uses in a given session.
      setHelpOutput('  -m, --model Model\n');
      setSessionStore({
        kangentic: {
          'session-2026-04-01T23-37.json': realSessionJson('gemini-pro'),
          'session-2026-04-28T18-52.jsonl': realSessionJsonl('gemini-flash'),
        },
      });

      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      // Order-independent: both models must be present.
      expect(capabilities.models?.sort()).toEqual(['gemini-flash', 'gemini-pro']);
    });

    it('returns models=undefined when sessions root is missing', async () => {
      setHelpOutput('  -m, --model Model\n');
      // setSessionStore(null) -> listMostRecentDirs returns []
      const capabilities = await discoverGeminiCapabilities('/usr/bin/gemini');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
