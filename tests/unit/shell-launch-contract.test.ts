/**
 * The shell launches that go through node-pty's spawn-helper on macOS
 * (src/main/pty/spawn/shell-launch.ts), run for real through a stand-in helper.
 *
 * The real helper is Mach code and only runs on macOS, where
 * build/install-spawn-helper.js --self-test proves it clears the exception
 * port. What that self-test cannot show is that the CALLERS still behave once a
 * helper sits between them and the shell: the exit code still comes back, the
 * output is still captured, the spawn's cwd still applies, and a process-group
 * kill still reaches what the script started. Those depend only on the helper's
 * argv contract (`[helper, cwd, file, ...args]`, empty cwd means stay put, then
 * exec in place), so a POSIX script that honors the same contract stands in for
 * it here, with darwin forced so the callers take the helper path.
 *
 * Skipped on Windows, which has no POSIX shell to run the stand-in.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { Task } from '../../src/shared/types';

const { helperCandidatesMock } = vi.hoisted(() => ({
  helperCandidatesMock: vi.fn((): string[] => []),
}));

vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: helperCandidatesMock,
}));

import { runInitScript } from '../../src/main/git/run-init-script';
import { runScriptAdapter } from '../../src/main/automations/adapters/run-script';
import { AutomationTimeoutError } from '../../src/main/automations/shared/automation-errors';

/**
 * Upstream's helper in shell: change into argv[1] unless it is empty, then exec
 * argv[2] with the rest, so the pid stays the target's. It also leaves a mark,
 * so a test can tell the launch really went through it.
 */
const STAND_IN_HELPER = [
  '#!/bin/sh',
  'if [ -n "$KANGENTIC_TEST_HELPER_MARK" ]; then : > "$KANGENTIC_TEST_HELPER_MARK"; fi',
  'if [ -n "$1" ]; then cd "$1" || exit 1; fi',
  'shift',
  'exec "$@"',
  '',
].join('\n');

describe.skipIf(process.platform === 'win32')('shell launches through a spawn-helper', () => {
  const originalPlatform = process.platform;
  let workDirectory = '';
  let helperMark = '';

  beforeAll(() => {
    workDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-shell-launch-')));
    const helperPath = path.join(workDirectory, 'spawn-helper');
    fs.writeFileSync(helperPath, STAND_IN_HELPER, { mode: 0o755 });
    helperCandidatesMock.mockReturnValue([helperPath]);
  });

  afterAll(() => {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    helperMark = path.join(workDirectory, `helper-ran-${Date.now()}-${Math.random()}`);
    process.env.KANGENTIC_TEST_HELPER_MARK = helperMark;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    delete process.env.KANGENTIC_TEST_HELPER_MARK;
  });

  describe('the post-worktree init script', () => {
    it('captures output from the spawn\'s own cwd', async () => {
      const result = await runInitScript('echo hello; pwd -P', workDirectory, { timeoutMs: 20_000 });

      expect(result.stdout.split('\n').map((line) => line.trim())).toEqual(['hello', workDirectory, '']);
      expect(fs.existsSync(helperMark)).toBe(true);
    });

    it('still reports the script\'s own exit code and output', async () => {
      await expect(
        runInitScript('echo broken >&2; exit 7', workDirectory, { timeoutMs: 20_000 }),
      ).rejects.toThrow(/exited with code 7: broken/);
      expect(fs.existsSync(helperMark)).toBe(true);
    });
  });

  describe('a run-script automation', () => {
    function makeContext(): AutomationContext {
      return {
        task: { id: 'task-1', title: 'A task' } as Task,
        column: { name: 'Executing' },
        trigger: 'enter',
        cwd: workDirectory,
        projectId: 'project-1',
        templateVars: { title: 'A task' },
        sessionHost: { getShell: async () => '/bin/sh' },
        signal: new AbortController().signal,
        runId: 'run-1',
        // The adapter reads none of the rest; the cast keeps the fake to what it uses.
      } as unknown as AutomationContext;
    }

    it('still reports the script\'s exit code', async () => {
      await expect(
        runScriptAdapter.execute({ script: 'exit 7', timeoutMinutes: 1 }, makeContext()),
      ).rejects.toThrow('Script exited with code 7.');
      expect(fs.existsSync(helperMark)).toBe(true);
    });

    it('still kills everything the script started when its budget runs out', async () => {
      // The budget kill signals the process GROUP of the pid it spawned. That
      // only reaches the script's children if the helper exec'd the shell in
      // place, keeping the pid. The background job would touch the marker 2 s
      // in; the 300 ms budget kills it first, and the wait below outlasts it.
      const survivorMark = path.join(workDirectory, `survivor-${Date.now()}`);
      const script = `(sleep 2; : > "${survivorMark}") & wait`;

      await expect(
        runScriptAdapter.execute({ script, timeoutMinutes: 0.005 }, makeContext()),
      ).rejects.toBeInstanceOf(AutomationTimeoutError);
      expect(fs.existsSync(helperMark)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(fs.existsSync(survivorMark)).toBe(false);
    }, 20_000);
  });
});
