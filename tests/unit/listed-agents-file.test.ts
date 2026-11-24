/**
 * The saved list of agents the Accounts tab answers from before this run's CLI check lands
 * (task #1202). Real fs under a temp dir; safe-write's Sentry reporting is stubbed. Tier: Unit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: vi.fn(),
}));

import { listedAgentsPath, readListedAgentsFile, writeListedAgentsFile } from '../../src/main/accounts/listed-agents-file';

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-listed-agents-'));
  filePath = listedAgentsPath(directory);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeRaw(text: string): void {
  fs.writeFileSync(filePath, text);
}

describe('listed agents file', () => {
  it('lives in the config folder', () => {
    expect(path.dirname(filePath)).toBe(directory);
  });

  it('round-trips what was written, and the write reports success', () => {
    const agents = [
      { agent: 'claude', unsupportedTarget: false },
      { agent: 'codex', unsupportedTarget: true },
    ];
    expect(writeListedAgentsFile(filePath, agents)).toBe(true);
    expect(readListedAgentsFile(filePath)).toEqual(agents);
  });

  it('round-trips an empty list as an empty list, not as missing', () => {
    expect(writeListedAgentsFile(filePath, [])).toBe(true);
    expect(readListedAgentsFile(filePath)).toEqual([]);
  });

  it('reads a missing file as null', () => {
    expect(readListedAgentsFile(filePath)).toBeNull();
  });

  it('reads invalid JSON as null', () => {
    writeRaw('{ not json');
    expect(readListedAgentsFile(filePath)).toBeNull();
  });

  it.each([
    ['a bare array', '[{"agent":"claude"}]'],
    ['a null document', 'null'],
    ['agents that is not an array', '{"agents":{"agent":"claude"}}'],
    ['no agents key', '{}'],
  ])('reads %s as null', (_name, text) => {
    writeRaw(text);
    expect(readListedAgentsFile(filePath)).toBeNull();
  });

  it('drops entries without a string agent and takes unsupportedTarget only when exactly true', () => {
    writeRaw(JSON.stringify({
      agents: [
        null,
        'claude',
        { unsupportedTarget: true },
        { agent: 7, unsupportedTarget: true },
        { agent: 'a', unsupportedTarget: true },
        { agent: 'b', unsupportedTarget: 'true' },
        { agent: 'c', unsupportedTarget: 1 },
        { agent: 'd' },
      ],
    }));
    expect(readListedAgentsFile(filePath)).toEqual([
      { agent: 'a', unsupportedTarget: true },
      { agent: 'b', unsupportedTarget: false },
      { agent: 'c', unsupportedTarget: false },
      { agent: 'd', unsupportedTarget: false },
    ]);
  });
});
