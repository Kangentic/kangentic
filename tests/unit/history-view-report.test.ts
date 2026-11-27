/**
 * The report main sends when an agent's history view is no longer recognized
 * (`history-view-report.ts`): the one signal that a Claude Code update broke the
 * find bar's whole-conversation search, which otherwise falls back without a word.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredCliTarget } from '../../src/shared/types';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { reportUnrecognizedHistoryView, resetHistoryViewReports } = await import('../../src/main/pty/history-view-report');

const localClaude = { agentName: 'claude', agentCliVersion: '2.1.319 (Claude Code)', hostId: null, cliTarget: null, shell: 'pwsh' };

describe('reportUnrecognizedHistoryView', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetHistoryViewReports();
  });

  it('reports once per agent per launch, tagged with the agent, its version and where it ran, and nothing from its screen', () => {
    reportUnrecognizedHistoryView(localClaude);
    reportUnrecognizedHistoryView(localClaude);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(error.message).toBe('Agent history view was not recognized');
    expect(tags).toEqual({ source: 'history_view', agent: 'claude', agent_cli_version: '2.1.319', place: 'local' });
    expect(reportHandledError.mock.calls[0]?.[3]).toEqual(['history-view', 'claude']);

    reportUnrecognizedHistoryView({ ...localClaude, agentName: 'codex' });
    expect(reportHandledError).toHaveBeenCalledTimes(2);
  });

  // Sentry DESKTOP-5K came from an SSH host and named neither the release nor the host.
  it('names a session on an SSH host as one, with its CLI release', () => {
    const hostTarget = { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: '', roots: [] } as unknown as StoredCliTarget;
    reportUnrecognizedHistoryView({ ...localClaude, agentCliVersion: '2.1.330', hostId: 'host-a', cliTarget: hostTarget, shell: '$LOGIN_SHELL' });

    expect(reportHandledError.mock.calls[0]?.[1]).toEqual({ source: 'history_view', agent: 'claude', agent_cli_version: '2.1.330', place: 'ssh' });
  });

  it('reports a session with no agent name or version under unknown', () => {
    reportUnrecognizedHistoryView({ ...localClaude, agentName: undefined, agentCliVersion: null });
    expect(reportHandledError.mock.calls[0]?.[1]).toMatchObject({ source: 'history_view', agent: 'unknown', agent_cli_version: 'unknown' });
  });
});
