/**
 * Capability discovery for Codex: parses `codex --help` for static support
 * and walks `~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl` for the model
 * identifiers used in past sessions.
 *
 * The session-history scan dispatches on JSONL field comparisons against
 * the live Codex rollout schema, so a real-shape fixture is the only way
 * to catch schema drift before users notice it (the directory-walk +
 * `payload.model` regression that hid `gpt-5.5` from the picker is the
 * concrete example - this suite locks the scan against that shape).
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
import { discoverCodexCapabilities } from '../../src/main/agent/adapters/codex/capability-discovery';
import { listMostRecentDirs, listMostRecentFiles, readHeadBytes } from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const listFilesMock = listMostRecentFiles as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the fs chain that scanCodexSessionHistory walks. The Codex layout
 * is three nested date dirs: `<root>/<YYYY>/<MM>/<DD>/<file>.jsonl`. The
 * fixture is a 4-level map mirroring that shape.
 */
type SessionTree = Record<string, Record<string, Record<string, Record<string, string>>>>;

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

  const ranked = (parent: string, names: string[]) =>
    names.map((name, index) => ({ fullPath: path.join(parent, name), mtimeMs: names.length - index }));

  listDirsMock.mockImplementation(async (parent: string) => {
    if (parent === SESSIONS_ROOT) return ranked(SESSIONS_ROOT, Object.keys(store));
    for (const year of Object.keys(store)) {
      const yearPath = path.join(SESSIONS_ROOT, year);
      if (parent === yearPath) return ranked(yearPath, Object.keys(store[year]));
      for (const month of Object.keys(store[year])) {
        const monthPath = path.join(yearPath, month);
        if (parent === monthPath) return ranked(monthPath, Object.keys(store[year][month]));
      }
    }
    return [];
  });

  listFilesMock.mockImplementation(async (directory: string, predicate: (name: string) => boolean) => {
    for (const year of Object.keys(store)) {
      for (const month of Object.keys(store[year])) {
        for (const day of Object.keys(store[year][month])) {
          const dayPath = path.join(SESSIONS_ROOT, year, month, day);
          if (directory === dayPath) {
            return ranked(dayPath, Object.keys(store[year][month][day]).filter(predicate));
          }
        }
      }
    }
    return [];
  });

  readHeadMock.mockImplementation(async (filePath: string) => {
    for (const [year, months] of Object.entries(store)) {
      for (const [month, days] of Object.entries(months)) {
        for (const [day, files] of Object.entries(days)) {
          for (const [fileName, contents] of Object.entries(files)) {
            if (filePath === path.join(SESSIONS_ROOT, year, month, day, fileName)) return contents;
          }
        }
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

describe('discoverCodexCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  -m, --model <MODEL>          Model the agent should use
  -s, --sandbox <SANDBOX_MODE> Select the sandbox policy
`);
    const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model support when help text omits the flag', async () => {
    setHelpOutput('Usage: codex [options]\n  -h, --help    Show help\n');
    const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
    expect(capabilities.supportsModelOverride).toBe(false);
  });

  it('returns empty effortLevels (Codex effort is config-only)', async () => {
    setHelpOutput('  -m, --model <MODEL>  Model the agent should use\n');
    const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('returns empty capabilities when help invocation throws', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverCodexCapabilities('/missing/codex');
    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.effortLevels).toEqual([]);
  });

  describe('historical model discovery (YYYY/MM/DD walk)', () => {
    /**
     * Synthetic rollout JSONL line shapes captured from Codex 0.128.0.
     * Two event types carry the model:
     *   - `turn_context.payload.model` - active model for a turn
     *   - (forward-compat) any event with a `payload.model` string
     * `session_meta` does NOT carry the model in current Codex. The parser
     * must skip it gracefully without crashing or returning an empty result.
     */
    function turnContextLine(model: string): string {
      return JSON.stringify({
        timestamp: '2026-05-03T16:38:32.642Z',
        type: 'turn_context',
        payload: {
          turn_id: '019deeb4-aaed-77b2-b04b-029fdafeaceb',
          cwd: 'C:\\test',
          model,
          effort: 'medium',
        },
      });
    }

    function sessionMetaLine(): string {
      return JSON.stringify({
        timestamp: '2026-05-03T16:38:32.639Z',
        type: 'session_meta',
        payload: {
          id: '019deeb4-aa80-79c3-8f56-33bfa92d1779',
          cli_version: '0.128.0',
          source: 'cli',
          // Notably, NO model field on session_meta in current Codex.
        },
      });
    }

    it('extracts models from turn_context events nested 3 levels deep', async () => {
      setHelpOutput('  -m, --model <MODEL>  Model\n');
      setSessionStore({
        '2026': {
          '05': {
            '03': {
              'rollout-A.jsonl': `${sessionMetaLine()}\n${turnContextLine('gpt-5.5')}\n`,
            },
          },
        },
      });

      const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
      expect(capabilities.models).toEqual(['gpt-5.5']);
    });

    it('walks multiple year/month/day combinations and dedupes models', async () => {
      setHelpOutput('  -m, --model <MODEL>  Model\n');
      setSessionStore({
        '2026': {
          '05': {
            '03': { 'rollout-A.jsonl': turnContextLine('gpt-5.5') + '\n' },
            '02': { 'rollout-B.jsonl': turnContextLine('gpt-5.5-mini') + '\n' },
          },
          '04': {
            '15': { 'rollout-C.jsonl': turnContextLine('gpt-5.5') + '\n' /* duplicate */ },
          },
        },
      });

      const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
      expect(capabilities.models?.sort()).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    });

    it('returns models=undefined when sessions exist but none carry model fields', async () => {
      setHelpOutput('  -m, --model <MODEL>  Model\n');
      setSessionStore({
        '2026': {
          '05': {
            '03': {
              // Only session_meta, no turn_context -> no model surfaces
              'rollout-A.jsonl': sessionMetaLine() + '\n',
            },
          },
        },
      });

      const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
      expect(capabilities.models).toBeUndefined();
    });

    it('returns models=undefined when the sessions root is missing entirely', async () => {
      setHelpOutput('  -m, --model <MODEL>  Model\n');
      // setSessionStore(null) above sets existsSync to false
      const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
      expect(capabilities.models).toBeUndefined();
    });

    it('skips unparseable JSONL lines without crashing the scan', async () => {
      setHelpOutput('  -m, --model <MODEL>  Model\n');
      setSessionStore({
        '2026': {
          '05': {
            '03': {
              'rollout-A.jsonl':
                `garbage line, not JSON\n${turnContextLine('gpt-5.5')}\n{"broken":json,}\n`,
            },
          },
        },
      });

      const capabilities = await discoverCodexCapabilities('/usr/bin/codex');
      expect(capabilities.models).toEqual(['gpt-5.5']);
    });
  });
});
