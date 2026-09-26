/**
 * Capability discovery for GitHub Copilot CLI: parses `copilot --help` for
 * `--model` and `--reasoning-effort` support, plus walks
 * `~/.copilot/session-state/<sessionId>/events.jsonl` for the models the user
 * selected.
 *
 * The effort-level parser handles commander.js's `(choices: "low",
 * "medium", ...)` shape (not the bare `(low, medium, ...)` Claude uses);
 * the historical scan reads only `session.start`'s `selectedModel`, never the
 * models a session ran on, which `--model` can refuse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

// The session-history walk goes through the shared async primitives in
// history-scan. Copilot reads the head of a fixed `events.jsonl` per session
// dir, so we mock listMostRecentDirs + readHeadBytes only. parseJsonlRecords
// stays real so the adapter's record-extraction logic is exercised.
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
import { discoverCopilotCapabilities } from '../../src/main/agent/adapters/copilot/capability-discovery';
import {
  listMostRecentDirs,
  readHeadBytes,
} from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;

/** Copilot's real `session.start` line, with the model the user selected. */
function startLine(selectedModel: string): string {
  return JSON.stringify({
    type: 'session.start',
    data: { sessionId: '685c7a29', version: 1, producer: 'copilot-agent', selectedModel },
    id: 'evt-0',
    timestamp: '2026-04-12T19:02:18.075Z',
  });
}

const SESSIONS_ROOT = path.join(os.homedir(), '.copilot', 'session-state');

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/**
 * Wire up the history-scan primitives for Copilot's session store.
 * Layout: `<root>/<sessionId>/events.jsonl`
 * listMostRecentDirs returns the session dirs; readTailBytes returns the
 * contents of the fixed `events.jsonl` path inside each session dir.
 * Setting the store to null makes ~/.copilot/session-state appear missing
 * (empty listing).
 */
type SessionTree = Record<string, string>;

function setSessionStore(store: SessionTree | null): void {
  listDirsMock.mockReset();
  readHeadMock.mockReset();

  if (store === null) {
    listDirsMock.mockResolvedValue([]);
    readHeadMock.mockResolvedValue('');
    return;
  }

  const sessionIds = Object.keys(store);

  listDirsMock.mockImplementation(async (parent: string) => {
    if (parent !== SESSIONS_ROOT) return [];
    // Descending mtime so scan order is deterministic.
    return sessionIds.map((sessionId, index) => ({
      fullPath: path.join(SESSIONS_ROOT, sessionId),
      mtimeMs: sessionIds.length - index,
    }));
  });

  // Copilot reads the FIXED `events.jsonl` inside each session dir via readHeadBytes.
  readHeadMock.mockImplementation(async (filePath: string) => {
    for (const [sessionId, contents] of Object.entries(store)) {
      const eventsPath = path.join(SESSIONS_ROOT, sessionId, 'events.jsonl');
      if (filePath === eventsPath) return contents;
    }
    return '';
  });
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  setSessionStore(null);
});

describe('discoverCopilotCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  --model <model>      Set the AI model to use
  -p, --prompt <text>  Execute a prompt
`);
    const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('parses commander.js-style effort choices `(choices: "low", "medium", "high", "xhigh")`', async () => {
    setHelpOutput(`
  --effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
                                        "low", "medium", "high", "xhigh")
`);
    const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('rejects bogus tokens like `choices:` from the effort list', async () => {
    setHelpOutput(`
  --reasoning-effort <level>  Set effort (choices: "low", "high")
`);
    const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
    // The pre-fix bug would have produced ['choices: "low"', '"high"'].
    expect(capabilities.effortLevels).toEqual(['low', 'high']);
  });

  it('returns conservative defaults when help invocation throws', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverCopilotCapabilities('/missing/copilot');
    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('does not invoke the session history scan when --help lacks --model', async () => {
    // When supportsModelOverride is false the adapter returns early before
    // calling scanCopilotSessionHistory(), so readHeadBytes must never be invoked.
    // Seed a non-empty session store so that, absent the early return, the scan
    // WOULD reach readHeadBytes - this is what makes the assertion load-bearing
    // (and red if the supportsModelOverride guard is ever removed).
    setSessionStore({
      'session-uuid-1': `${startLine('gpt-5')}\n`,
    });
    setHelpOutput('Usage: copilot\n  -h, --help  Show help\n');
    await discoverCopilotCapabilities('/usr/bin/copilot');
    expect(readHeadMock).not.toHaveBeenCalled();
  });

  describe('model discovery', () => {
    /** Copilot's real `--model` help line. */
    const MODEL_HELP = `
      --model <model>
          Set the AI model to use (use 'auto' to let Copilot pick
          automatically)
`;

    it('offers auto first, because the help names it', async () => {
      setHelpOutput(MODEL_HELP);
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toEqual(['auto']);
    });

    it('adds the models the user selected, from session.start', async () => {
      setHelpOutput(MODEL_HELP);
      setSessionStore({
        'session-uuid-1': `${startLine('gpt-5')}\n`,
        'session-uuid-2': `${startLine('auto')}\n`,
      });
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toEqual(['auto', 'gpt-5']);
    });

    it('never offers a model a session merely RAN on', async () => {
      // The reported case: `auto` routed to models the account cannot select,
      // and background work ran on helper models. `--model` refused all of them.
      setHelpOutput(MODEL_HELP);
      setSessionStore({
        'session-uuid-1': [
          startLine('auto'),
          JSON.stringify({ type: 'model.turn_started', data: { model: 'helper-nano-1' } }),
          JSON.stringify({ type: 'assistant.message', data: { model: 'routed-luna-2' } }),
          JSON.stringify({
            type: 'session.shutdown',
            data: { currentModel: 'routed-luna-2', modelMetrics: { 'routed-luna-2': {}, 'helper-nano-1': {} } },
          }),
        ].join('\n') + '\n',
      });
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toEqual(['auto']);
    });

    it('returns models=undefined when nothing names a model', async () => {
      setHelpOutput('  --model <model> Set model\n');
      setSessionStore({
        'session-uuid-1': JSON.stringify({ type: 'session.start', data: { sessionId: 'a' } }) + '\n',
      });
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toBeUndefined();
    });

    it('skips when sessions root is missing', async () => {
      setHelpOutput('  --model <model> Set model\n');
      // setSessionStore(null) -> listMostRecentDirs returns []
      const capabilities = await discoverCopilotCapabilities('/usr/bin/copilot');
      expect(capabilities.models).toBeUndefined();
    });
  });
});