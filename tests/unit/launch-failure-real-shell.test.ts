/**
 * A launch through a REAL shell on a real PTY, all the way to the report: the
 * real SessionManager, the real spawn flow and the real host core in this
 * process, with only `electron` and the Sentry call standing in.
 *
 * What only this can catch is the wiring a unit test mocks away. A shell's exit
 * code and signal come out of node-pty and cross the host's `exit` event to the
 * spawn flow's listener, and a signal death reads as code 0 unless every hop
 * carries it. And a slow shell must not read as a launch that failed, which is
 * the one judgement here that a real startup file can get wrong.
 *
 * Where it runs: bash in CI's unit tier on Linux, and zsh in macos-spawn-helper.yml,
 * which sets KANGENTIC_TYPED_LAUNCH_REQUIRE_SHELLS so a missing shell fails rather
 * than skips. Nothing here runs on Windows, whose shells have no startup file a
 * test can point at this way, and where the unit tests cover the same decisions.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const reportHandledError = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0.0.0', on: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  utilityProcess: { fork: () => undefined },
}));
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import { resetLaunchReports } from '../../src/main/pty/agent-launch-report';
import type { AgentParser } from '../../src/shared/types';

interface ProbeShell {
  program: string;
  /** Write the startup file holding `body`, which the shell runs before its prompt. */
  writeStartup(home: string, body: string): void;
}

const PROBE_SHELLS: readonly ProbeShell[] = [
  { program: 'bash', writeStartup: (home, body) => fs.writeFileSync(path.join(home, '.bash_profile'), `${body}\n`) },
  { program: 'zsh', writeStartup: (home, body) => fs.writeFileSync(path.join(home, '.zshrc'), `${body}\n`) },
];

const requiredShells = (process.env.KANGENTIC_TYPED_LAUNCH_REQUIRE_SHELLS ?? '').split(',').filter(Boolean);

function isInstalled(program: string): boolean {
  if (process.platform === 'win32') return false;
  return spawnSync(program, ['--version'], { timeout: 15_000 }).status === 0;
}

for (const program of requiredShells) {
  if (!isInstalled(program)) throw new Error(`${program} is not on PATH, and KANGENTIC_TYPED_LAUNCH_REQUIRE_SHELLS requires it`);
}

/** The workflow names its shell. Anywhere else, bash. */
const shellsUnderTest = PROBE_SHELLS.filter((shell) => (
  requiredShells.length > 0 ? requiredShells.includes(shell.program) : shell.program === 'bash' && isInstalled('bash')
));

const STUB_DEADLINE_MS = 20_000;
/** Past the wait above: the default 5 s would fail a loaded runner before it ran out. */
const TEST_TIMEOUT_MS = 30_000;

/** A parser with what the spawn path reads, reporting its start as Claude's does. */
const STUB_AGENT = {
  reportsAgentStart: true,
  detectFirstOutput: () => false,
  runtime: {},
} as unknown as AgentParser;

describe('a launch through a real shell', () => {
  it.skipIf(shellsUnderTest.length > 0)('has no shell to run on this machine', () => undefined);

  for (const shell of shellsUnderTest) describeLaunchThrough(shell);
});

function describeLaunchThrough(shell: ProbeShell): void {
  describe(`real ${shell.program}`, () => {
    let home: string;
    let manager: SessionManager;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-failure-'));
      reportHandledError.mockClear();
      resetLaunchReports();
      manager = new SessionManager();
    });

    afterEach(() => {
      manager.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    });

    async function launch(startup: string, command = 'true'): Promise<string> {
      shell.writeStartup(home, startup);
      const session = await manager.spawn({
        taskId: 'task-1',
        projectId: 'project-1',
        command,
        cwd: home,
        startPath: 'board',
        agentCliVersion: '1.2.3 (Stub)',
        env: { HOME: home, ZDOTDIR: home },
        agentParser: STUB_AGENT,
        agentName: 'stub',
        shell: shell.program,
      });
      return session.id;
    }

    async function reportedTags(): Promise<Record<string, string>> {
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled(), { timeout: STUB_DEADLINE_MS, interval: 25 });
      return reportHandledError.mock.calls[0][1] as Record<string, string>;
    }

    it('reports a shell that exits in its startup file, with its code, and never its command', async () => {
      await launch('exit 3', "stub-agent 'ship the Acme migration'");

      const tags = await reportedTags();
      expect(tags).toMatchObject({
        source: 'agent_launch',
        stage: 'shell_exit',
        agent: 'stub',
        agent_cli_version: '1.2.3',
        start_path: 'board',
        shell: shell.program,
        exit_code: '3',
        exit_signal: 'none',
        shell_printed: expect.stringMatching(/^(none|before_launch)$/),
      });
      const sent = JSON.stringify([reportHandledError.mock.calls[0][0], tags]);
      expect(sent).not.toContain('Acme');
      expect(sent).not.toContain(home);
    }, TEST_TIMEOUT_MS);

    it('reports the signal that killed a shell, which alone reads as exit code 0', async () => {
      await launch('kill -9 $$');

      const tags = await reportedTags();
      expect(tags).toMatchObject({ stage: 'shell_exit', exit_signal: '9' });
    }, TEST_TIMEOUT_MS);

    it('does not read a slow shell as a failed launch once its agent draws', async () => {
      const reached = path.join(home, 'reached');
      const stub = path.join(home, 'stub-agent');
      // The alt screen entry is what no shell does, so it is the agent's first frame.
      fs.writeFileSync(stub, `#!/bin/sh\ntouch "${reached}"\nprintf '\\033[?1049h'\nexit 0\n`, { mode: 0o755 });

      const sessionId = await launch('sleep 1.5', stub);

      await vi.waitFor(() => expect(fs.existsSync(reached)).toBe(true), { timeout: STUB_DEADLINE_MS, interval: 25 });
      await vi.waitFor(() => expect(manager.getSession(sessionId)).toBeDefined(), { timeout: 1_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      manager.kill(sessionId, { immediate: true });
      await manager.awaitExit(sessionId);

      expect(reportHandledError).not.toHaveBeenCalled();
    }, TEST_TIMEOUT_MS);
  });
}
