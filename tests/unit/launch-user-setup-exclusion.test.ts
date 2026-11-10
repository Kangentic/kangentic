/**
 * Sentry stays a list of bugs we can fix. A launch that failed because of the
 * user's own setup stays out, and only a cause identified positively does: an
 * unknown failure from an installed CLI is reported, because it may be our bug.
 *
 * Runs the REAL `reportHandledError` with only the Sentry SDK standing in, since
 * that early return is the one place this is decided. A mock of it would pass
 * whatever the filter did. Both directions are pinned here, for the report and
 * for the retry: what a second launch cannot fix gets none, and what may be ours
 * still does. A wrong exclusion hides a real bug, so each case names its opposite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((callback: (scope: Record<string, () => void>) => void) => {
    callback({ setTag: () => undefined, setContext: () => undefined, setFingerprint: () => undefined });
  }),
}));
const trackEvent = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/mock', getVersion: () => '0.0.0' } }));
vi.mock('@sentry/electron/main', () => sentry);
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent,
  sanitizeErrorMessage: (message: string) => message,
}));

import { initErrorReporting } from '../../src/main/analytics/error-reporting';
import {
  reportPreflightFailure,
  reportSessionLaunchFailure,
  resetLaunchReports,
} from '../../src/main/pty/agent-launch-report';
import { AgentCliNotFoundError } from '../../src/main/agent/shared/agent-cli-not-found';
import { GitUserStateError } from '../../src/main/git/worktree-errors';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { AgentParser } from '../../src/shared/types';
import type { UserSetupMatch } from '../../src/shared/user-configuration-error';

/** An adapter that knows two of its CLI's own failures, as a real one would. */
const ADAPTER = {
  identifyUserSetupFailure: (output: string): UserSetupMatch | null => {
    if (output.includes('Not logged in')) return { failure: 'login_required', line: output };
    if (output.includes('Invalid settings file')) return { failure: 'bad_configuration', line: output };
    return null;
  },
} as unknown as AgentParser;

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'session-1-long-id',
    taskId: 'task-1',
    projectId: 'project-1',
    pty: null,
    status: 'running',
    shell: '/bin/zsh',
    cwd: '/mock/project',
    commandCwd: '/mock/project',
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    exitSequence: ['\x03'],
    reportsAgentStart: true,
    agentName: 'claude',
    agentParser: ADAPTER,
    startPath: 'board',
    ...overrides,
  };
}

async function report(output: string, overrides: Partial<ManagedSession> = {}): Promise<ManagedSession> {
  const target = session(overrides);
  reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: async () => output });
  await target.launchOutputRead;
  return target;
}

const originalSwitch = process.env.KANGENTIC_ERROR_REPORTING;

beforeEach(() => {
  process.env.KANGENTIC_ERROR_REPORTING = '1';
  initErrorReporting();
  sentry.captureException.mockClear();
  trackEvent.mockClear();
  resetLaunchReports();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSwitch === undefined) delete process.env.KANGENTIC_ERROR_REPORTING;
  else process.env.KANGENTIC_ERROR_REPORTING = originalSwitch;
});

describe('what stays out of Sentry', () => {
  it.each([
    ['a failed login', 'Not logged in. Please run /login', 'login_required'],
    ['a bad configuration', 'Invalid settings file', 'bad_configuration'],
  ])('sends no event for %s, and counts it in Aptabase', async (_label, output, reason) => {
    await report(output);

    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('spawn_failed', { agent: 'claude', reason });
  });

  it('sends none of the CLI\'s line anywhere it reports', async () => {
    await report('Not logged in, session of person@example.test');
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain('person@example.test');
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).not.toContain('person@example.test');
  });

  it('keeps the local line, so a person can still see it in the log', async () => {
    await report('Not logged in. Please run /login');
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('output_class=login_required');
  });

  it('keeps a missing CLI out, which never reached a PTY', () => {
    reportPreflightFailure({ cause: 'agent_start', error: new AgentCliNotFoundError('codex', 'Codex CLI'), startPath: 'board', keepMessage: true });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps a repository state out and counts it, with no text of git\'s', () => {
    const error = new GitUserStateError("fatal: 'fix-acme-billing' is already checked out at '/mock/other'");
    reportPreflightFailure({ cause: 'worktree', error, agent: 'claude', startPath: 'board' });

    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('spawn_failed', { agent: 'claude', reason: 'worktree' });
  });

  it('leaves a real failure of the same cause its one event', () => {
    reportPreflightFailure({ cause: 'agent_start', error: new AgentCliNotFoundError('codex', 'Codex CLI'), startPath: 'board', keepMessage: true });
    reportPreflightFailure({ cause: 'agent_start', error: new Error('spawn broke'), startPath: 'board', keepMessage: true });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect((sentry.captureException.mock.calls[0][0] as Error).message).toBe('spawn broke');
  });

  it('does not count twice a failure its caller counted', () => {
    reportPreflightFailure({
      cause: 'agent_start',
      error: new AgentCliNotFoundError('codex', 'Codex CLI'),
      startPath: 'board',
      alreadyCounted: true,
    });
    expect(trackEvent).not.toHaveBeenCalled();
  });
});

describe('what still reaches Sentry', () => {
  it.each([
    ['an unknown failure from an installed CLI', 'panic: runtime error: index out of range', 'other'],
    ['a crash of an installed CLI', 'Segmentation fault', 'crashed'],
    ['nothing at all', '', 'other'],
    // Detection found it and the shell did not, so they disagreed.
    ['an installed CLI that reads as command not found', 'zsh: command not found: claude', 'command_not_found'],
    // We built the command.
    ['an option we passed that the CLI rejected', "error: unknown option '--session-id'", 'unknown_option'],
  ])('sends one event for %s', async (_label, output, cause) => {
    await report(output);

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect((sentry.captureException.mock.calls[0][0] as Error).message).toContain(`(${cause})`);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('reports what an adapter with no recognizer cannot identify, whatever it says', async () => {
    await report('Not logged in. Please run /login', { agentParser: {} as unknown as AgentParser });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('sends none of the output of a failure it does report', async () => {
    await report("Segmentation fault in 'ship the Acme migration' at /Users/dev/secret-project");
    const sent = JSON.stringify(sentry.captureException.mock.calls[0].map((value) => (value as Error).message));
    expect(sent).not.toContain('Acme');
    expect(sent).not.toContain('/Users/dev');
  });
});
