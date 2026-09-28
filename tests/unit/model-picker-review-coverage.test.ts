/**
 * Coverage added by a red-green review of the model picker offer:
 *
 *  - `newerModelFor` picks the NEWEST newer generation, not the first newer one,
 *    and never reports a floating alias as behind;
 *  - a forced capability rescan carries the picker's alias list into
 *    `capabilities.modelAliases`.
 *
 * The capability-discovery mocks mirror claude-capability-discovery.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('../../src/main/agent/shared/history-scan', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/agent/shared/history-scan')>();
  return {
    ...actual,
    listMostRecentDirs: vi.fn(),
    listMostRecentFiles: vi.fn(),
    readHeadBytes: vi.fn(),
  };
});

vi.mock('../../src/main/agent/adapters/claude/model-picker-probe', () => ({
  getCachedModelPickerModels: vi.fn(),
  probeModelPickerModels: vi.fn(),
}));

import { execFile, exec } from 'node:child_process';
import { newerModelFor } from '../../src/shared/model-id';
import { discoverClaudeCapabilities } from '../../src/main/agent/adapters/claude/capability-discovery';
import { getCachedModelPickerModels, probeModelPickerModels } from '../../src/main/agent/adapters/claude/model-picker-probe';
import { listMostRecentDirs, listMostRecentFiles, readHeadBytes } from '../../src/main/agent/shared/history-scan';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const cachedProbeMock = getCachedModelPickerModels as unknown as ReturnType<typeof vi.fn>;
const forcedProbeMock = probeModelPickerModels as unknown as ReturnType<typeof vi.fn>;
const listDirsMock = listMostRecentDirs as unknown as ReturnType<typeof vi.fn>;
const listFilesMock = listMostRecentFiles as unknown as ReturnType<typeof vi.fn>;
const readHeadMock = readHeadBytes as unknown as ReturnType<typeof vi.fn>;

describe('newerModelFor', () => {
  it('returns the newest newer generation, not the first newer one', () => {
    const ids = ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-6'];
    expect(newerModelFor('claude-sonnet-5', ids)).toBe('claude-sonnet-6');
    // Order of the list does not decide it either.
    expect(newerModelFor('claude-sonnet-5', [...ids].reverse())).toBe('claude-sonnet-6');
  });

  it('returns null for a floating alias, which is never behind', () => {
    const ids = ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-6'];
    expect(newerModelFor('sonnet', ids)).toBeNull();
  });

  it('returns null when the value already is the newest generation', () => {
    expect(newerModelFor('claude-sonnet-6', ['claude-sonnet-5', 'claude-sonnet-6'])).toBeNull();
  });
});

describe('discoverClaudeCapabilities with a forced rescan', () => {
  const MODEL_HELP = '  --model <model>  Model for the current session.\n';

  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    const helpResult = Promise.resolve({ stdout: MODEL_HELP });
    execMock.mockReturnValue(helpResult);
    execFileMock.mockReturnValue(helpResult);
    // No transcript history: the picker is the only model source.
    listDirsMock.mockReset();
    listFilesMock.mockReset();
    readHeadMock.mockReset();
    listDirsMock.mockResolvedValue([]);
    listFilesMock.mockResolvedValue([]);
    readHeadMock.mockResolvedValue('');
    cachedProbeMock.mockReset();
    cachedProbeMock.mockReturnValue(undefined);
    forcedProbeMock.mockReset();
    forcedProbeMock.mockResolvedValue(undefined);
  });

  it('carries the forced probe alias list into capabilities.modelAliases', async () => {
    forcedProbeMock.mockResolvedValue({
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      aliases: [
        { id: 'opus', resolvesTo: 'claude-opus-5-5' },
        { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      ],
    });

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude', true);
    expect(forcedProbeMock).toHaveBeenCalledWith('/usr/bin/claude', true);
    expect(cachedProbeMock).not.toHaveBeenCalled();
    expect(capabilities.modelAliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
    ]);
    expect(capabilities.modelDisplayNames?.opus).toBe('Opus');
  });

  it('leaves modelAliases off when the forced probe found models but no aliases', async () => {
    forcedProbeMock.mockResolvedValue({ models: ['claude-opus-5-5'], aliases: [] });

    const capabilities = await discoverClaudeCapabilities('/usr/bin/claude', true);
    expect(capabilities.models).toEqual(['claude-opus-5-5']);
    expect(capabilities.modelAliases).toBeUndefined();
  });
});
