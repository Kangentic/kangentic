/**
 * Capability discovery for Cursor (the `cursor-agent` CLI): parses
 * `cursor-agent --help` for `--model` support, then asks the CLI itself for
 * its model list via `--list-models`. Nothing is hardcoded - a CLI that
 * cannot be asked yields no list and the renderer falls back to a free-form
 * model input.
 *
 * On Windows, the CLI is a `.CMD` shim that cannot be invoked via execFile
 * (Node CVE-2024-27980 mitigation). The discovery code uses `exec` with a
 * shell on win32 and `execFile` elsewhere - the helper below answers both
 * call shapes so these tests pass identically on Windows and on CI's Linux.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile, exec } from 'node:child_process';
import {
  discoverCursorCapabilities,
  parseCursorModelsOutput,
  resetCursorCapabilityCacheForTests,
} from '../../src/main/agent/adapters/cursor/capability-discovery';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor/cursor-adapter';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

const HELP_WITH_MODEL = `
  --model <model>           Model to use (e.g., gpt-5, sonnet-4, sonnet-4-thinking)
  --list-models             List available models and exit
`;

/**
 * Captured from `cursor-agent --list-models` on 2026-09-13, trimmed to the
 * shapes that matter. Pinned as a literal rather than shelling out: the
 * `(current)` marker tracks whichever model the running user last selected,
 * so a live call would make this test machine-dependent.
 */
const LIST_MODELS_OUTPUT = `Available models

auto - Auto (default)
gpt-5.3-codex-high - Codex 5.3 High
composer-2.5 - Composer 2.5 (current)
claude-fable-5-high - Claude Fable 5 1M (NO ZDR)
gemini-3.8-flash-low - Gemini 3.8 Flash Low

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
`;

/** True when this invocation is the model listing rather than the help read. */
function isListModelsCall(args: unknown[]): boolean {
  const [first, second] = args;
  if (typeof first === 'string' && first.includes('--list-models')) return true;
  return Array.isArray(second) && second.includes('--list-models');
}

/**
 * Answer both the win32 `exec(commandString)` and the POSIX
 * `execFile(path, args)` shapes. Pass `null` for either response to make that
 * invocation reject, which is how a missing binary or a bad credential
 * presents (the real CLI exits non-zero with a stderr warning).
 */
function setCliResponses(options: { help: string | null; listModels: string | null }): void {
  const respond = (...args: unknown[]): Promise<{ stdout: string; stderr: string }> => {
    const body = isListModelsCall(args) ? options.listModels : options.help;
    if (body === null) {
      const rejected = Promise.reject(new Error('command failed')) as Promise<{
        stdout: string;
        stderr: string;
      }>;
      rejected.catch(() => {});
      return rejected;
    }
    return Promise.resolve({ stdout: body, stderr: '' });
  };
  execMock.mockImplementation(respond);
  execFileMock.mockImplementation(respond);
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  resetCursorCapabilityCacheForTests();
});

describe('parseCursorModelsOutput', () => {
  it('returns ids and display names, skipping the header and the Tip footer', () => {
    const { models, displayNames } = parseCursorModelsOutput(LIST_MODELS_OUTPUT);
    expect(models).toEqual([
      'auto',
      'gpt-5.3-codex-high',
      'composer-2.5',
      'claude-fable-5-high',
      'gemini-3.8-flash-low',
    ]);
    expect(displayNames['gpt-5.3-codex-high']).toBe('Codex 5.3 High');
  });

  it('strips the (default) and (current) state markers from a display name', () => {
    const { displayNames } = parseCursorModelsOutput(LIST_MODELS_OUTPUT);
    // `(current)` tracks the user's last selection and `(default)` marks `auto`.
    // Neither is part of the model's name.
    expect(displayNames['auto']).toBe('Auto');
    expect(displayNames['composer-2.5']).toBe('Composer 2.5');
  });

  it('keeps a trailing parenthetical that IS part of the name', () => {
    const { displayNames } = parseCursorModelsOutput(LIST_MODELS_OUTPUT);
    // The zero-data-retention note is real display text, so the marker strip
    // has to enumerate its two markers rather than dropping any parenthetical.
    expect(displayNames['claude-fable-5-high']).toBe('Claude Fable 5 1M (NO ZDR)');
  });

  it('parses CRLF output identically', () => {
    // A trailing \r makes `(.+)$` unmatchable, which would drop every line of a
    // Windows-emitted list while passing on CI's Linux. Built by replacement so
    // the fixture does not depend on git line-ending normalization.
    const crlf = LIST_MODELS_OUTPUT.replace(/\n/g, '\r\n');
    expect(parseCursorModelsOutput(crlf)).toEqual(parseCursorModelsOutput(LIST_MODELS_OUTPUT));
  });

  it('yields nothing for output with no model lines', () => {
    expect(parseCursorModelsOutput('')).toEqual({ models: [], displayNames: {} });
    expect(parseCursorModelsOutput('Warning: the provided API key is invalid.\n').models).toEqual([]);
  });

  it('dedupes repeated ids and preserves CLI order', () => {
    const { models } = parseCursorModelsOutput('b-2 - Bee\na-1 - Aye\nb-2 - Bee Again\n');
    expect(models).toEqual(['b-2', 'a-1']);
  });

  it('keeps the model id but omits displayNames when the name is blank or strips to empty', () => {
    // Two ways a name can end up empty after the state-marker strip: the text
    // after the dash is whitespace only, or it is nothing but a marker like
    // `(current)` with nothing else to keep.
    const output = ['whitespace-id -   ', 'bare-id - (current)'].join('\n');
    const { models, displayNames } = parseCursorModelsOutput(output);
    expect(models).toEqual(['whitespace-id', 'bare-id']);
    expect(displayNames).not.toHaveProperty('whitespace-id');
    expect(displayNames).not.toHaveProperty('bare-id');
  });
});

describe('discoverCursorCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
    const capabilities = await discoverCursorCapabilities('/usr/bin/cursor-agent');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model when help text omits the flag, and does not ask for models', async () => {
    setCliResponses({ help: 'Usage: agent\n  -h, --help    Display help\n', listModels: LIST_MODELS_OUTPUT });
    const capabilities = await discoverCursorCapabilities('/usr/bin/cursor-agent');
    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.models).toBeUndefined();
    const calls = [...execMock.mock.calls, ...execFileMock.mock.calls];
    expect(calls.some((args) => isListModelsCall(args))).toBe(false);
  });

  it('returns empty effortLevels (Cursor encodes effort in the model id)', async () => {
    setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
    const capabilities = await discoverCursorCapabilities('/usr/bin/cursor-agent');
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('surfaces the CLI list as ids with display names', async () => {
    setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
    const capabilities = await discoverCursorCapabilities('/usr/bin/cursor-agent');
    // Ids, not display names: this is what gets handed to `--model`, so it has
    // to round-trip. The old hardcoded list held 'Claude 4.1 Sonnet' and could not.
    expect(capabilities.models).toContain('gpt-5.3-codex-high');
    expect(capabilities.modelDisplayNames?.['gpt-5.3-codex-high']).toBe('Codex 5.3 High');
  });

  it('invents nothing when help fails (missing binary)', async () => {
    setCliResponses({ help: null, listModels: null });
    const capabilities = await discoverCursorCapabilities('/missing/cursor-agent');
    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.models).toBeUndefined();
    expect(capabilities.modelDisplayNames).toBeUndefined();
  });

  it('keeps model-override support when only the listing fails (bad credential)', async () => {
    // The real CLI exits 1 with a stderr warning when the API key is invalid.
    // supportsModelOverride must stay true: it is what keeps the renderer's
    // free-form model input alive. Deriving it from the listing would take the
    // input away too, so the user could not even type a model id.
    setCliResponses({ help: HELP_WITH_MODEL, listModels: null });
    const capabilities = await discoverCursorCapabilities('/usr/bin/cursor-agent');
    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.models).toBeUndefined();
  });

  describe('caching', () => {
    it('reuses the cached result for the same cliPath', async () => {
      setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
      await discoverCursorCapabilities('/usr/bin/cursor-agent');
      const callsAfterFirst = execMock.mock.calls.length + execFileMock.mock.calls.length;
      await discoverCursorCapabilities('/usr/bin/cursor-agent');
      expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it('re-probes on forceRefresh', async () => {
      setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
      await discoverCursorCapabilities('/usr/bin/cursor-agent');
      const callsAfterFirst = execMock.mock.calls.length + execFileMock.mock.calls.length;
      await discoverCursorCapabilities('/usr/bin/cursor-agent', true);
      expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('re-probes when the cliPath changes', async () => {
      // A Settings save rebuilds the agent list WITHOUT forceRefresh, so an
      // unkeyed memo would keep reporting the old binary's capabilities.
      setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
      await discoverCursorCapabilities('/usr/bin/cursor-agent');
      const callsAfterFirst = execMock.mock.calls.length + execFileMock.mock.calls.length;
      await discoverCursorCapabilities('/opt/other/cursor-agent');
      expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('caches a failed discovery until forceRefresh (pins current behavior)', async () => {
      // This pins the CURRENT implementation: `discoverCursorCapabilities` writes
      // `cache = { cliPath, capabilities }` unconditionally, even when the listing
      // failed, so a later call with the same cliPath and no forceRefresh returns
      // the stale failure without re-probing. If a future change decides failed
      // discoveries should not be cached, update this test deliberately rather
      // than treating a break here as an accidental regression.
      setCliResponses({ help: HELP_WITH_MODEL, listModels: null });
      const firstResult = await discoverCursorCapabilities('/usr/bin/cursor-agent');
      expect(firstResult.models).toBeUndefined();
      const callsAfterFirst = execMock.mock.calls.length + execFileMock.mock.calls.length;

      // The CLI would now succeed, but without forceRefresh the stale failure
      // is returned and the CLI is not re-invoked.
      setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
      const secondResult = await discoverCursorCapabilities('/usr/bin/cursor-agent');
      expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBe(callsAfterFirst);
      expect(secondResult.models).toBeUndefined();

      // forceRefresh bypasses the stale cache and picks up the recovered result.
      const thirdResult = await discoverCursorCapabilities('/usr/bin/cursor-agent', true);
      expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
      expect(thirdResult.models).toContain('gpt-5.3-codex-high');
    });
  });
});

describe('CursorAdapter.discoverCapabilities', () => {
  it('forwards forceRefresh to the shared cached probe', async () => {
    // A one-line pass-through (`return discoverCursorCapabilities(cliPath,
    // forceRefresh)`) has no return-value shape to assert on directly, so this
    // drives it through the observable cache behavior. The plain second call
    // passes either way (a cache hit happens with or without the argument);
    // dropping the second argument from that line only fails the third
    // assertion below, since forceRefresh would then never bypass the cache.
    const adapter = new CursorAdapter();
    setCliResponses({ help: HELP_WITH_MODEL, listModels: LIST_MODELS_OUTPUT });
    await adapter.discoverCapabilities('/usr/bin/cursor-agent');
    const callsAfterFirst = execMock.mock.calls.length + execFileMock.mock.calls.length;

    await adapter.discoverCapabilities('/usr/bin/cursor-agent');
    expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBe(callsAfterFirst);

    await adapter.discoverCapabilities('/usr/bin/cursor-agent', true);
    expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
