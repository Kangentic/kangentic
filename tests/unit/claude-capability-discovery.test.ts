/**
 * Capability discovery for Claude Code: parses the live `claude --help`
 * output to extract effort levels and detect `--model` flag presence.
 *
 * The parser is the core of self-discovery - Kangentic holds no hardcoded
 * model or effort lists. These tests pin the regex against representative
 * help-output snippets so future Claude CLI changes that break the parser
 * surface as test failures, not as silent capability loss.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing the module under test, since the
// module captures references at load time.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

// The session-history walk now goes through the shared async primitives in
// history-scan. Mock the I/O primitives (listing + head read) but keep
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

// The /model picker probe spawns a real PTY - always mocked here. Its own
// behavior is covered by tests/unit/claude-model-picker-probe.test.ts.
// Non-forced discovery reads the non-blocking cache accessor (sync); a forced
// rescan (a dropdown opening) awaits the TTL-bypassing probe instead.
vi.mock('../../src/main/agent/adapters/claude/model-picker-probe', () => ({
  getCachedModelPickerModels: vi.fn(),
  probeModelPickerModels: vi.fn(),
}));

import { execFile, exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverClaudeCapabilities } from '../../src/main/agent/adapters/claude/capability-discovery';
import { getCachedModelPickerModels, probeModelPickerModels } from '../../src/main/agent/adapters/claude/model-picker-probe';
import { listMostRecentDirs, listMostRecentFiles, readHeadBytes } from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const probeMock = getCachedModelPickerModels as unknown as ReturnType<typeof vi.fn>;
const probeFreshMock = probeModelPickerModels as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const listFilesMock = listMostRecentFiles as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;

function setHelpOutput(stdout: string): void {
  // Both code paths (Windows exec and Unix execFile) just need to resolve
  // with `{ stdout }`. promisify is mocked to identity so we hand back the
  // resolved promise directly.
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

/**
 * Wire up the history-scan primitives that `discoverHistoricalModels` walks: a
 * map of `<projectDir>` to a list of session JSONL files, each with a
 * head-of-file payload. `listMostRecentDirs` returns the project dirs,
 * `listMostRecentFiles` returns each project's session files, and
 * `readHeadBytes` returns a file's contents. Setting the store to null makes
 * ~/.claude/projects appear missing entirely (empty listings).
 */
function setSessionStore(
  store: Record<string, Record<string, string>> | null,
): void {
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
    // Descending mtime so scan order is deterministic; the adapter dedupes by Set.
    return projectNames.map((name, index) => ({
      fullPath: path.join(PROJECTS_ROOT, name),
      mtimeMs: projectNames.length - index,
    }));
  });

  listFilesMock.mockImplementation(async (directory: string, predicate: (name: string) => boolean) => {
    for (const projectName of projectNames) {
      const projectFullPath = path.join(PROJECTS_ROOT, projectName);
      if (directory === projectFullPath) {
        const fileNames = Object.keys(store[projectName]).filter(predicate);
        return fileNames.map((sessionName, index) => ({
          fullPath: path.join(projectFullPath, sessionName),
          mtimeMs: fileNames.length - index,
        }));
      }
    }
    return [];
  });

  readHeadMock.mockImplementation(async (filePath: string) => {
    for (const [projectName, sessions] of Object.entries(store)) {
      for (const [sessionName, contents] of Object.entries(sessions)) {
        if (filePath === path.join(PROJECTS_ROOT, projectName, sessionName)) return contents;
      }
    }
    return '';
  });
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  // Default: no Claude session store - discovery falls through and the
  // renderer would render a free-form input.
  setSessionStore(null);
  // Default: the /model picker cache is empty, keeping the historical tests
  // focused on the transcript walk alone.
  probeMock.mockReset();
  probeMock.mockReturnValue(undefined);
  // Default: the forced (TTL-bypassing) probe resolves empty; only the
  // forceRefresh tests wire a result into it.
  probeFreshMock.mockReset();
  probeFreshMock.mockResolvedValue(undefined);
});

describe('discoverClaudeCapabilities', () => {
  it('extracts effort levels from the --effort line in help output', async () => {
    setHelpOutput(`
  --debug-file <path>                               Write debug logs to a specific file path
  --effort <level>                                  Effort level for the current session (low, medium, high, xhigh, max)
  --fallback-model <model>                          Enable automatic fallback to specified model
`);

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('extracts effort levels when the choice list wraps onto a continuation line', async () => {
    // At real terminal widths the description is long enough that Claude's
    // help wraps the choice list onto an indented continuation line. The
    // parser must span that wrap - a newline-excluding gap silently drops the
    // levels, which hides the effort picker in the ContextBar.
    setHelpOutput(`
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --fallback-model <model>              Enable automatic fallback (only works with --print)
`);

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('detects --model flag presence', async () => {
    setHelpOutput(`
  --include-partial-messages                        Include partial message chunks
  --model <model>                                   Model for the current session.
  -n, --name <name>                                 Set a display name
`);

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('discovers both --effort and --model from the same help output', async () => {
    setHelpOutput(`
  --effort <level>                                  Effort level for the current session (low, medium, high, max)
  --model <model>                                   Model for the current session.
`);

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'max']);
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('returns an empty object when help text has neither flag', async () => {
    setHelpOutput('Usage: claude [options]\n  -h, --help    Show help\n');

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
    expect(capabilities.effortLevels).toBeUndefined();
    expect(capabilities.supportsModelOverride).toBeUndefined();
  });

  it('returns an empty object when the CLI invocation throws', async () => {
    // Only the platform-relevant code path runs; pre-attach a .catch on the
    // unused side so vitest does not report an unhandled rejection.
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverClaudeCapabilities('/missing/claude');
    expect(capabilities).toEqual({});
  });

  it('tolerates extra whitespace and irrelevant lines', async () => {
    setHelpOutput(`
Usage: claude [options]

Options:
  -h, --help                                        Display help
  --some-other-flag <value>                         Foo bar (a, b, c)
  --effort <level>                                  Effort level for the current session    (low,  medium , high)

Commands:
  doctor   Health check
`);

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high']);
  });

  describe('historical model discovery', () => {
    function assistantLine(model: string): string {
      return JSON.stringify({ type: 'assistant', message: { model, content: [] } });
    }

    it('extracts distinct models from recent session JSONLs', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      setSessionStore({
        '-Users-dev-projectA': {
          'session-1.jsonl': `${assistantLine('claude-opus-4-7')}\n`,
          'session-2.jsonl': `${assistantLine('claude-sonnet-4-6')}\n`,
        },
        '-Users-dev-projectB': {
          'session-3.jsonl': `${assistantLine('claude-opus-4-7')}\n`, // duplicate
          'session-4.jsonl': `${assistantLine('claude-haiku-4-5')}\n`,
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.supportsModelOverride).toBe(true);
      // Ascending alphabetical groups by family naturally (the shared
      // `claude-` prefix puts haiku, opus, sonnet in that order) and
      // keeps versions within a family in increasing order. Order is
      // consistent across all agent adapters.
      expect(capabilities.models).toEqual([
        'claude-haiku-4-5',
        'claude-opus-4-7',
        'claude-sonnet-4-6',
      ]);
    });

    it('scans past summary and user records to find the assistant model', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      const summaryLine = JSON.stringify({ type: 'summary', summary: 'hi' });
      const userLine = JSON.stringify({ type: 'user', message: { content: 'hello' } });
      setSessionStore({
        '-Users-dev-projectA': {
          'session.jsonl': `${summaryLine}\n${userLine}\n${assistantLine('claude-opus-4-7')}\n`,
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.models).toEqual(['claude-opus-4-7']);
    });

    it('preserves dated and unsuffixed forms as distinct entries', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      setSessionStore({
        '-Users-dev-projectA': {
          'session-1.jsonl': assistantLine('claude-haiku-4-5-20251001') + '\n',
          'session-2.jsonl': assistantLine('claude-haiku-4-5') + '\n',
          'session-3.jsonl': assistantLine('claude-opus-4-7-20251022') + '\n',
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      // Both forms work for --model but address different builds (dated =
      // pinned, unsuffixed = roll-forward latest). They must surface as
      // separate picker entries so users can choose reproducibility.
      // Ascending alphabetical: haiku family clusters first, with the
      // unsuffixed alias before its dated build (alphabetically).
      expect(capabilities.models).toEqual([
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-7-20251022',
      ]);
    });

    it('filters Claude Code sentinel values like <synthetic>', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      setSessionStore({
        '-Users-dev-projectA': {
          'session.jsonl': [
            assistantLine('<synthetic>'),
            assistantLine('claude-opus-4-7'),
            assistantLine('<unknown>'),
          ].join('\n') + '\n',
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      // Only the real model survives; anything wrapped in <...> is dropped.
      expect(capabilities.models).toEqual(['claude-opus-4-7']);
    });

    it('drops the truncated trailing line so a partial JSON does not throw', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      const fullLine = assistantLine('claude-opus-4-7');
      // Simulate a head buffer that ended mid-record (no terminating newline).
      setSessionStore({
        '-Users-dev-projectA': {
          'session.jsonl': `${fullLine}\n{"type":"assistant","message":{"mod`,
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.models).toEqual(['claude-opus-4-7']);
    });

    it('returns undefined when ~/.claude/projects does not exist', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      setSessionStore(null);

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.supportsModelOverride).toBe(true);
      expect(capabilities.models).toBeUndefined();
    });

    it('returns undefined when no session files contain a model', async () => {
      setHelpOutput('  --model <model>  Model for the current session.\n');
      setSessionStore({
        '-Users-dev-projectA': {
          'empty.jsonl': '',
          'malformed.jsonl': '{ not json\n',
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.models).toBeUndefined();
    });

    it('does not scan sessions when --model flag is absent', async () => {
      setHelpOutput('  --some-other-flag <x>  No model flag here.\n');
      setSessionStore({
        '-Users-dev-projectA': {
          'session.jsonl': `${assistantLine('claude-opus-4-7')}\n`,
        },
      });

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.supportsModelOverride).toBeUndefined();
      expect(capabilities.models).toBeUndefined();
      // We never even tried to walk the directory.
      expect(listDirsMock).not.toHaveBeenCalled();
    });
  });

  describe('/model picker cache merge', () => {
    const MODEL_HELP = '  --model <model>  Model for the current session.\n';

    function assistantLine(model: string): string {
      return JSON.stringify({ type: 'assistant', message: { model, content: [] } });
    }

    it('merges cached picker model ids with transcript models, sorted and deduped', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore({
        '-Users-dev-projectA': {
          'session.jsonl': `${assistantLine('claude-opus-4-7')}\n`,
        },
      });
      // Overlap on opus collapses in the union; the rest sorts alphabetically.
      probeMock.mockReturnValue(['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-fable-5']);

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.models).toEqual([
        'claude-fable-5',
        'claude-opus-4-7',
        'claude-sonnet-4-6',
      ]);
    });

    it('returns cached picker models alone when the transcript walk finds nothing', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore(null);
      probeMock.mockReturnValue(['claude-sonnet-4-6', 'claude-opus-4-8']);

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    });

    it('falls back silently to transcript models when the cache is empty', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore({
        '-Users-dev-projectA': {
          'session.jsonl': `${assistantLine('claude-opus-4-7')}\n`,
        },
      });
      probeMock.mockReturnValue(undefined);

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(capabilities.models).toEqual(['claude-opus-4-7']);
    });

    it('passes the CLI path through to the cache accessor', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore(null);
      probeMock.mockReturnValue(['claude-opus-4-8']);

      await discoverClaudeCapabilities('/opt/claude/bin/claude');
      expect(probeMock).toHaveBeenCalledWith('/opt/claude/bin/claude');
    });

    it('does not touch the picker when the --model flag is absent', async () => {
      setHelpOutput('  --some-other-flag <x>  No model flag here.\n');

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(probeMock).not.toHaveBeenCalled();
      expect(capabilities.models).toBeUndefined();
    });

    it('awaits the TTL-bypassing probe on a forced rescan, surfacing a newly shipped model', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore(null);
      // The stale cache does not know the new model; only a fresh forced probe
      // reports it. The forced path must await that probe, not read the cache.
      probeMock.mockReturnValue(['claude-opus-4-8']);
      probeFreshMock.mockResolvedValue(['claude-opus-4-8', 'claude-sonnet-5']);

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude', true);
      expect(probeFreshMock).toHaveBeenCalledWith('/usr/bin/claude', true);
      expect(probeMock).not.toHaveBeenCalled();
      // The just-shipped model appears without a restart.
      expect(capabilities.models).toEqual(['claude-opus-4-8', 'claude-sonnet-5']);
    });

    it('reads the background-warmed cache (never the fresh probe) when not forced', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore(null);
      probeMock.mockReturnValue(['claude-opus-4-8']);

      const capabilities = await discoverClaudeCapabilities('/usr/bin/claude');
      expect(probeMock).toHaveBeenCalledWith('/usr/bin/claude');
      expect(probeFreshMock).not.toHaveBeenCalled();
      expect(capabilities.models).toEqual(['claude-opus-4-8']);
    });
  });
});
