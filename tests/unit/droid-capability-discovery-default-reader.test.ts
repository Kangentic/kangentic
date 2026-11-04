/**
 * Droid's default help reader (the one `discoverCapabilities` uses when no test
 * reader is injected) asks `droid exec --help`, because the model blocks exist
 * only in the exec help: the interactive `droid --help` lists no models, so a
 * reader that dropped `exec` would report an empty picker with no error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HELP_TEXT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'droid-exec-help-0.218.0.txt'), 'utf-8');

const exec = vi.hoisted(() => ({ calls: [] as string[], fail: false }));

vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  const respond = (description: string): Promise<{ stdout: string; stderr: string }> => {
    exec.calls.push(description);
    return exec.fail ? Promise.reject(new Error('spawn ENOENT')) : Promise.resolve({ stdout: HELP_TEXT, stderr: '' });
  };
  return {
    ...actual,
    // Windows runs the head through the shell as one string, POSIX runs the file with an argument list.
    execAsync: (command: string) => respond(command),
    execFileAsync: (file: string, args: readonly string[]) => respond([file, ...args].join(' ')),
  };
});

import { clearDroidCapabilityCache, discoverDroidCapabilities } from '../../src/main/agent/adapters/droid/capability-discovery';

beforeEach(() => {
  clearDroidCapabilityCache();
  exec.calls.length = 0;
  exec.fail = false;
});

describe('discoverDroidCapabilities default reader', () => {
  it('runs the CLI as `exec --help` and parses the models and levels from its output', async () => {
    const capabilities = await discoverDroidCapabilities('/usr/local/bin/droid', true);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toContain('exec --help');
    expect(exec.calls[0]).toContain('droid');
    expect(capabilities.models).toContain('claude-opus-5');
    expect(capabilities.effortLevelsByModel?.['claude-opus-5']).toContain('max');
  });

  it('reports no models, without throwing, when the CLI cannot be run', async () => {
    exec.fail = true;
    const capabilities = await discoverDroidCapabilities('/usr/local/bin/droid', true);
    expect(capabilities).toEqual({ supportsModelOverride: false, effortLevels: [] });
  });
});
