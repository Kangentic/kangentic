/**
 * The report for a launch that never started. Nothing throws in that failure, so
 * this is the only signal it has. `session-manager-agent-absence.test.ts` pins
 * that the sweep's retirement reaches it, and that a real SessionStart stops it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportHandledError = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

import { launchNeverStarted, reportAgentNeverStarted } from '../../src/main/pty/agent-launch-report';
import type { ManagedSession } from '../../src/main/pty/session-registry';

const STARTED_AT = '2026-11-04T12:00:00.000Z';
const NOW = Date.parse(STARTED_AT) + 36_000;

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'session-1-long-id',
    taskId: 'task-1',
    projectId: 'project-1',
    pty: null,
    status: 'running',
    shell: '/bin/zsh',
    cwd: '/mock/project',
    startedAt: STARTED_AT,
    exitCode: null,
    resuming: true,
    transient: false,
    exitSequence: ['\x03'],
    reportsAgentStart: true,
    typedLineBytes: 1024,
    launcherUsed: false,
    ...overrides,
  };
}

describe('launchNeverStarted', () => {
  it('holds for an agent that reports its start and showed none', () => {
    expect(launchNeverStarted(session())).toBe(true);
  });

  it.each([
    { label: 'a SessionStart', overrides: { agentStartObservedAt: NOW } },
    { label: 'an alt-screen entry', overrides: { altScreenEnteredAt: NOW } },
    { label: 'a SessionEnd', overrides: { agentEndSignaledAt: NOW } },
  ])('does not hold after $label', ({ overrides }) => {
    expect(launchNeverStarted(session(overrides))).toBe(false);
  });

  it('leaves out an adapter that reports neither signal, whose silence proves nothing', () => {
    expect(launchNeverStarted(session({ reportsAgentStart: false }))).toBe(false);
    expect(launchNeverStarted(session({ reportsAgentStart: undefined }))).toBe(false);
  });
});

describe('reportAgentNeverStarted', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    reportHandledError.mockClear();
    warn.mockClear();
  });

  afterEach(() => {
    warn.mockClear();
  });

  it('sends one fixed message tagged with the shell, the line and the age', () => {
    reportAgentNeverStarted(session(), NOW);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags] = reportHandledError.mock.calls[0];
    expect((error as Error).message).toBe('Agent launch never started');
    expect(tags).toEqual({
      source: 'agent_launch',
      platform: process.platform,
      shell: 'zsh',
      typed_line_bytes: '1024',
      session_age_s: '36',
      launcher: 'no',
    });
  });

  it('writes one local warning with the same facts', () => {
    reportAgentNeverStarted(session({ launcherUsed: true, typedLineBytes: 180 }), NOW);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('shell=zsh typedLineBytes=180 launcher=yes ageSeconds=36');
  });

  it('sends no path, whatever the shell setting holds', () => {
    reportAgentNeverStarted(session({ shell: '/Users/dev/.nix-profile/bin/zsh', cwd: '/Users/dev/secret-project' }), NOW);

    const [, tags] = reportHandledError.mock.calls[0];
    expect(tags.shell).toBe('zsh');
    expect(JSON.stringify(tags)).not.toContain('/');
  });

  it.each([
    { shell: '/Users/dev/bin/my-custom-shell', label: 'other' },
    { shell: 'wsl -d Private-Distro', label: 'other' },
    { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', label: 'pwsh' },
  ])('reports $shell as $label', ({ shell, label }) => {
    reportAgentNeverStarted(session({ shell }), NOW);

    expect(reportHandledError.mock.calls[0][1].shell).toBe(label);
  });
});
