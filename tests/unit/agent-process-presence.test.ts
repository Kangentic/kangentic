/**
 * Whether a session's shell still had an agent under it, read from one listing
 * of the process table. Backs the `agent_process` tag on an abandoned launch
 * report: `present` is a CLI that ran and stayed silent, `absent` a command that
 * already ended, `unknown` a listing that cannot say.
 */
import { describe, it, expect } from 'vitest';
import { agentProcessPresenceOf } from '../../src/main/pty/host/agent-process-presence';
import type { ProcessInfo } from '../../src/main/activity-engine/background-shell/process-tree';

const SHELL_PID = 100;

describe('agentProcessPresenceOf', () => {
  it('reads unknown for an empty listing', () => {
    expect(agentProcessPresenceOf([], SHELL_PID)).toBe('unknown');
  });

  it('reads unknown for a listing that does not hold the shell', () => {
    const rows: ProcessInfo[] = [
      { pid: 1, ppid: 0, comm: 'init' },
      { pid: 200, ppid: 1, comm: 'node' },
    ];

    expect(agentProcessPresenceOf(rows, SHELL_PID)).toBe('unknown');
  });

  it('reads present for a non-console process nested below the shell', () => {
    const rows: ProcessInfo[] = [
      { pid: SHELL_PID, ppid: 1, comm: 'bash' },
      { pid: 110, ppid: SHELL_PID, comm: 'cmd' },
      { pid: 120, ppid: 110, comm: 'node' },
    ];

    expect(agentProcessPresenceOf(rows, SHELL_PID)).toBe('present');
  });

  it('reads absent when only a console host sits under the shell', () => {
    const rows: ProcessInfo[] = [
      { pid: SHELL_PID, ppid: 1, comm: 'pwsh' },
      { pid: 110, ppid: SHELL_PID, comm: 'conhost' },
    ];

    expect(agentProcessPresenceOf(rows, SHELL_PID)).toBe('absent');
  });

  it('reads absent for a shell with no children', () => {
    const rows: ProcessInfo[] = [
      { pid: SHELL_PID, ppid: 1, comm: 'bash' },
      { pid: 300, ppid: 1, comm: 'node' },
    ];

    expect(agentProcessPresenceOf(rows, SHELL_PID)).toBe('absent');
  });
});
