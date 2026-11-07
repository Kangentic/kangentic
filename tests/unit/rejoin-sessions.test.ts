/**
 * Which of the agents a quit left on a host come back (#913): `rejoinRunningRemoteSessions` decides, per
 * running record, between taken back, still waiting for its host, and gone. And what the adopter hands the
 * session manager to take one back.
 *
 * What a user loses if it breaks: "could not ask" read as "gone" resumes a second agent beside a live one,
 * and a record read as live when its agent is gone leaves a card running that nothing runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { serializeCliTarget } from '../../src/main/agent/shared/cli-target';
import { setRemoteLaunchResolver } from '../../src/main/remote/remote-launch';
import { hostOfRecord } from '../../src/main/remote/record-host';
import { createRecordAdopter, rejoinRunningRemoteSessions } from '../../src/main/remote/rejoin-sessions';
import type { SessionRecord } from '../../src/shared/types';

const sshTarget = (hostId: string): string => serializeCliTarget({
  kind: 'ssh', hostId, home: '/home/dev', shellName: 'zsh', roots: [{ local: '/shell', host: '/home/dev/api' }],
} as never) as string;

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    task_id: `task-${id}`,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: `agent-${id}`,
    cwd: '/shell/.kangentic/worktrees/api-1',
    permission_mode: 'default',
    cli_target: sshTarget('host-1'),
    last_pty_cols: null,
    last_pty_rows: null,
    ...overrides,
  } as SessionRecord;
}

afterEach(() => {
  setRemoteLaunchResolver(null);
});

describe('hostOfRecord', () => {
  it('names the host of a record whose agent ran on one, and nothing for a record from this computer', () => {
    expect(hostOfRecord({ cli_target: sshTarget('host-9') })).toBe('host-9');
    expect(hostOfRecord({ cli_target: null })).toBeNull();
    expect(hostOfRecord({ cli_target: '{"kind":"wsl","distro":"Ubuntu"}' })).toBeNull();
    expect(hostOfRecord({ cli_target: 'not json' })).toBeNull();
  });
});

describe('rejoinRunningRemoteSessions', () => {
  const alive = (...sessionIds: string[]) => async () => ({ sessions: sessionIds.map((sessionId) => ({ sessionId, alive: true })) as never });

  it('takes back an agent the host holds alive', async () => {
    const adopt = vi.fn(async (rec: SessionRecord) => ({ id: rec.id }) as never);

    const outcomes = await rejoinRunningRemoteSessions([record('a')], { snapshot: alive('a'), adopt });

    expect(outcomes.get('a')).toBe('rejoined');
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it('says gone for an agent the host lists as exited, and for one it does not list', async () => {
    const adopt = vi.fn();
    const snapshot = async () => ({ sessions: [{ sessionId: 'dead', alive: false }] as never });

    const outcomes = await rejoinRunningRemoteSessions([record('dead'), record('unknown')], { snapshot, adopt });

    expect(outcomes.get('dead')).toBe('gone');
    expect(outcomes.get('unknown')).toBe('gone');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('says pending for every record of a host that could not be asked, and adopts none', async () => {
    const adopt = vi.fn();
    const log = vi.fn();

    const outcomes = await rejoinRunningRemoteSessions([record('a'), record('b')], {
      snapshot: async () => { throw new Error('the host is not connected'); },
      adopt,
      log,
    });

    expect(outcomes.get('a')).toBe('pending');
    expect(outcomes.get('b')).toBe('pending');
    expect(adopt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the host is not connected'));
  });

  it('says pending, not gone, when the agent is alive but taking it back failed', async () => {
    const outcomes = await rejoinRunningRemoteSessions([record('a')], {
      snapshot: alive('a'),
      adopt: async () => { throw new Error('the link dropped'); },
    });

    expect(outcomes.get('a')).toBe('pending');
  });

  it('says gone when the host lost the agent between its list and the rejoin', async () => {
    const outcomes = await rejoinRunningRemoteSessions([record('a')], { snapshot: alive('a'), adopt: async () => null });

    expect(outcomes.get('a')).toBe('gone');
  });

  it('asks each host separately, so one host being down does not hold back another', async () => {
    const snapshot = vi.fn(async (hostId: string) => {
      if (hostId === 'host-down') throw new Error('unreachable');
      return { sessions: [{ sessionId: 'up', alive: true }] as never };
    });

    const outcomes = await rejoinRunningRemoteSessions(
      [record('up', { cli_target: sshTarget('host-up') }), record('down', { cli_target: sshTarget('host-down') })],
      { snapshot, adopt: async (rec) => ({ id: rec.id }) as never },
    );

    expect(outcomes.get('up')).toBe('rejoined');
    expect(outcomes.get('down')).toBe('pending');
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('asks a host once for all of its records', async () => {
    const snapshot = vi.fn(alive('a', 'b'));

    await rejoinRunningRemoteSessions([record('a'), record('b')], { snapshot, adopt: async (rec) => ({ id: rec.id }) as never });

    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('leaves a record from this computer out of the answer', async () => {
    const snapshot = vi.fn(alive());

    const outcomes = await rejoinRunningRemoteSessions([record('local', { cli_target: null })], { snapshot, adopt: vi.fn() });

    expect(outcomes.size).toBe(0);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('createRecordAdopter', () => {
  const place = { kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'zsh', localHome: '/mirror', roots: [{ local: '/shell', host: '/home/dev/api' }], linuxCliPath: 'claude' };
  const remote = { hostId: 'host-1', cwd: '/home/dev/api/.kangentic/worktrees/api-1', shellName: 'zsh' };

  it('hands the session manager the record under its own id, with its files, and no command to run', async () => {
    setRemoteLaunchResolver({ resolve: async () => ({ place, remote }) } as never);
    const adoptRemoteSession = vi.fn(async () => null);
    const sessionType = agentRegistry.get('claude')!.sessionType;

    await createRecordAdopter({ sessionManager: { adoptRemoteSession } as never, projectId: 'proj-1', projectPath: '/shell' })(
      record('rec-1', { session_type: sessionType, last_pty_cols: 140, last_pty_rows: 40 }),
    );

    expect(adoptRemoteSession).toHaveBeenCalledTimes(1);
    const input = (adoptRemoteSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      id: 'rec-1',
      taskId: 'task-rec-1',
      projectId: 'proj-1',
      command: '',
      agentSessionId: 'agent-rec-1',
      agentName: 'claude',
      startPath: 'startup_recovery',
      remote,
      restoredGrid: { cols: 140, rows: 40 },
      cliTarget: expect.objectContaining({ kind: 'ssh', hostId: 'host-1' }),
    });
    expect(String(input.statusOutputPath).replace(/\\/g, '/')).toBe('/shell/.kangentic/sessions/rec-1/status.json');
    expect(String(input.eventsOutputPath).replace(/\\/g, '/')).toBe('/shell/.kangentic/sessions/rec-1/events.jsonl');
  });

  it('takes nothing back for an agent this build does not know', async () => {
    setRemoteLaunchResolver({ resolve: async () => ({ place, remote }) } as never);
    const adoptRemoteSession = vi.fn();

    const result = await createRecordAdopter({ sessionManager: { adoptRemoteSession } as never, projectId: 'proj-1', projectPath: '/shell' })(
      record('rec-1', { session_type: 'an_agent_from_the_future' }),
    );

    expect(result).toBeNull();
    expect(adoptRemoteSession).not.toHaveBeenCalled();
  });
});
