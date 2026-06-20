/**
 * Capability discovery for Kimi: parses `kimi --help` for `--model` support
 * and walks `~/.kimi/sessions/<workdir-hash>/<session-uuid>/wire.jsonl` for
 * model identifiers (verified empirically against kimi 1.37.0; the wire
 * format is two levels deep, not one).
 *
 * Kimi's wire format does not always carry a model field on every event;
 * this suite asserts the parser handles both populated and bare sessions
 * without crashing.
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
// history-scan. Kimi uses a two-level dir walk (workdir-hash -> session-uuid)
// so listMostRecentDirs branches on `parent`. Mock listMostRecentDirs +
// readHeadBytes; parseJsonlRecords stays real so the adapter's record-extraction
// logic is exercised. The fs walk itself is covered by tests/unit/history-scan.test.ts.
vi.mock('../../src/main/agent/shared/history-scan', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/agent/shared/history-scan')>();
  return {
    ...actual,
    listMostRecentDirs: vi.fn(),
    readHeadBytes: vi.fn(),
  };
});

import { execFile, exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverKimiCapabilities } from '../../src/main/agent/adapters/kimi/capability-discovery';
import { listMostRecentDirs, readHeadBytes } from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;

const SESSIONS_ROOT = path.join(os.homedir(), '.kimi', 'sessions');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the history-scan primitives for Kimi's two-level session store.
 * Layout: `<root>/<workdir-hash>/<session-uuid>/wire.jsonl`
 * listMostRecentDirs is called twice per workdir-hash: once with SESSIONS_ROOT
 * to get workdir dirs, then once with each workdir dir's fullPath to get
 * session-uuid dirs. readHeadBytes is called with the fixed `wire.jsonl` path
 * inside each session-uuid dir.
 * Setting the store to null makes ~/.kimi/sessions appear missing (empty listing).
 */
type SessionTree = Record<string, Record<string, string>>;

function setSessionStore(store: SessionTree | null): void {
  listDirsMock.mockReset();
  readHeadMock.mockReset();

  if (store === null) {
    listDirsMock.mockResolvedValue([]);
    readHeadMock.mockResolvedValue('');
    return;
  }

  const workdirNames = Object.keys(store);

  listDirsMock.mockImplementation(async (parent: string) => {
    // Top-level call: return the workdir-hash directories.
    if (parent === SESSIONS_ROOT) {
      return workdirNames.map((name, index) => ({
        fullPath: path.join(SESSIONS_ROOT, name),
        mtimeMs: workdirNames.length - index,
      }));
    }
    // Second-level call: return the session-uuid directories inside a workdir.
    for (const workdirName of workdirNames) {
      const workdirPath = path.join(SESSIONS_ROOT, workdirName);
      if (parent === workdirPath) {
        const sessionIds = Object.keys(store[workdirName]);
        return sessionIds.map((sessionId, index) => ({
          fullPath: path.join(workdirPath, sessionId),
          mtimeMs: sessionIds.length - index,
        }));
      }
    }
    return [];
  });

  // Kimi reads the FIXED `wire.jsonl` inside each session-uuid dir via readHeadBytes.
  readHeadMock.mockImplementation(async (filePath: string) => {
    for (const [workdirName, sessions] of Object.entries(store)) {
      for (const [sessionId, contents] of Object.entries(sessions)) {
        const wirePath = path.join(SESSIONS_ROOT, workdirName, sessionId, 'wire.jsonl');
        if (filePath === wirePath) return contents;
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

describe('discoverKimiCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
| --model           -m                      TEXT             LLM model to use.
| --thinking               --no-thinking                     Enable thinking mode.
`);
    const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('returns empty effortLevels (Kimi has no effort concept)', async () => {
    setHelpOutput('  --model TEXT LLM model to use\n');
    const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery (workdir-hash/session-uuid layout)', () => {
    /** Real Kimi wire metadata line. */
    function metadataLine(): string {
      return JSON.stringify({ type: 'metadata', protocol_version: '1.9' });
    }

    /** TurnBegin event (no model). */
    function turnBeginLine(): string {
      return JSON.stringify({
        timestamp: 1777232808.515,
        message: { type: 'TurnBegin', payload: { user_input: 'hi' } },
      });
    }

    /** TurnEnd-shaped event with a model in payload. Forward-compat test. */
    function turnEndWithModelLine(model: string): string {
      return JSON.stringify({
        timestamp: 1777232810.0,
        message: { type: 'TurnEnd', payload: { model, finish_reason: 'stop' } },
      });
    }

    /** Top-level model field (older / hypothetical schema). */
    function topLevelModelLine(model: string): string {
      return JSON.stringify({
        timestamp: 1777232815.0,
        type: 'config_update',
        model,
      });
    }

    it('walks the workdir-hash/session-uuid 2-level layout', async () => {
      setHelpOutput('  --model TEXT Model\n');
      setSessionStore({
        '0c26bcf3ad0776977669bf712ae51422': {
          '709fd2c1-8955-4090-8e90-7ba6a52ccfb6':
            `${metadataLine()}\n${turnBeginLine()}\n${turnEndWithModelLine('kimi-k2')}\n`,
        },
      });

      const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
      expect(capabilities.models).toEqual(['kimi-k2']);
    });

    it('extracts model from top-level fields (forward-compat)', async () => {
      setHelpOutput('  --model TEXT Model\n');
      setSessionStore({
        'workdir-hash': {
          'session-uuid': topLevelModelLine('kimi-k2-0905') + '\n',
        },
      });

      const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
      expect(capabilities.models).toEqual(['kimi-k2-0905']);
    });

    it('returns models=undefined for sessions whose events lack model info', async () => {
      setHelpOutput('  --model TEXT Model\n');
      // Kimi's wire format does not always carry the model on every event type.
      setSessionStore({
        'workdir-hash': {
          'session-uuid': `${metadataLine()}\n${turnBeginLine()}\n`,
        },
      });

      const capabilities = await discoverKimiCapabilities('/usr/bin/kimi');
      expect(capabilities.models).toBeUndefined();
    });
  });
});
