/**
 * Which agent CLIs a remote project has (#913): the probe that asks the host, the inventory built from
 * its answers, and the refusal a spawn makes when the CLI is not installed there.
 *
 * What a user loses if it breaks: a remote project's pickers listing this computer's CLIs (an agent
 * offered that the host does not have, or one hidden that it does), a host that could not be asked
 * reading as "not installed", or an agent started on a host that lacks it, ending in the host shell's
 * own "command not found" inside a terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { probeAgentOnHost, versionFromOutput, type HostAgentProbe } from '../../src/main/remote/host-agent-probe';
import { invalidateHostAgentList, listAgentsOnHost, resetAgentListForTests } from '../../src/main/agent/agent-list';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import {
  RemoteAgentMissingError,
  createRemoteLaunchResolver,
  type RemoteLaunchResolverDeps,
} from '../../src/main/remote/remote-launch';
import { UserConfigurationError } from '../../src/shared/user-configuration-error';
import type { HostCommandResult } from '../../src/main/remote/protocol/messages';

function result(overrides: Partial<HostCommandResult>): HostCommandResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...overrides };
}

describe('asking a host whether a CLI is installed', () => {
  it('runs the CLI by name with --version on that host, and reads the version out of what it prints', async () => {
    const runCommand = vi.fn(async () => result({ stdout: 'claude 2.1.304 (build 9)\n' }));

    const answer = await probeAgentOnHost(runCommand, 'host-a', 'claude');

    expect(answer).toEqual({ status: 'found', version: '2.1.304', detail: null });
    expect(runCommand).toHaveBeenCalledWith('host-a', expect.objectContaining({ file: 'claude', args: ['--version'] }));
  });

  it('finds the version in a CLI that prints it on stderr, and still finds the CLI when no version reads out', async () => {
    expect((await probeAgentOnHost(async () => result({ stderr: 'v0.9.1-beta.2' }), 'h', 'aider')).version).toBe('0.9.1-beta.2');
    expect(await probeAgentOnHost(async () => result({ stdout: 'ok' }), 'h', 'aider')).toEqual({ status: 'found', version: null, detail: null });
  });

  it('reads the helper\'s "could not start" and the shell\'s 127 as not installed', async () => {
    expect((await probeAgentOnHost(async () => result({ code: null, error: 'spawn claude ENOENT' }), 'h', 'claude')).status).toBe('missing');
    expect((await probeAgentOnHost(async () => result({ code: 127, stderr: 'claude: command not found' }), 'h', 'claude')).status).toBe('missing');
  });

  it('never reads a failed ask as an absence: a dropped link, a timeout and a refusal are unknown, with the reason', async () => {
    const dropped = await probeAgentOnHost(async () => { throw new Error('Host Lab is not connected'); }, 'h', 'claude');
    expect(dropped).toEqual({ status: 'unknown', version: null, detail: 'Host Lab is not connected' });

    const slow = await probeAgentOnHost(async () => result({ code: null, timedOut: true }), 'h', 'claude');
    expect(slow.status).toBe('unknown');
    expect(slow.detail).toContain('did not answer in time');

    const refused = await probeAgentOnHost(async () => result({ code: 2, stderr: 'unrecognized option --version\nusage: ...' }), 'h', 'claude');
    expect(refused).toEqual({ status: 'unknown', version: null, detail: 'unrecognized option --version' });
  });

  it('reads a version with a prerelease tag whole, and none out of text without one', () => {
    expect(versionFromOutput('Codex CLI 0.46.0-rc.1')).toBe('0.46.0-rc.1');
    expect(versionFromOutput('no digits here')).toBeNull();
  });
});

describe('the inventory for a remote project', () => {
  const claudeAdapter = () => agentRegistry.getOrThrow('claude');
  const found: HostAgentProbe = { status: 'found', version: '2.1.80', detail: null };
  const missing: HostAgentProbe = { status: 'missing', version: null, detail: null };

  beforeEach(() => resetAgentListForTests());
  afterEach(() => {
    resetAgentListForTests();
    vi.restoreAllMocks();
  });

  it('looks for each agent\'s CLI on the host by its name there, and never detects on this computer', async () => {
    const detect = vi.spyOn(claudeAdapter(), 'detect');
    const probe = vi.fn(async (cliName: string) => (cliName === 'claude' ? found : missing));

    const agents = await listAgentsOnHost('host-a', probe);

    const claude = agents.find((entry) => entry.name === 'claude');
    expect(claude).toMatchObject({ found: true, hostId: 'host-a', hostStatus: 'found', path: 'claude', version: '2.1.80' });
    // The model list and auth come from running the CLI here, so a host's agents carry none.
    expect(claude?.capabilities).toBeUndefined();
    expect(agents.filter((entry) => entry.name !== 'claude').every((entry) => entry.found === false && entry.hostStatus === 'missing')).toBe(true);
    expect(agents.every((entry) => entry.hostId === 'host-a')).toBe(true);
    expect(probe).toHaveBeenCalledTimes(agentRegistry.list().length);
    expect(detect).not.toHaveBeenCalled();
  });

  it('keeps a whole answer, so the pickers do not ask the host on every open', async () => {
    const probe = vi.fn(async () => missing);
    await listAgentsOnHost('host-a', probe);
    const asked = probe.mock.calls.length;

    await listAgentsOnHost('host-a', probe);

    expect(probe).toHaveBeenCalledTimes(asked);
  });

  it('keeps no answer that holds an agent the host could not be asked about, and says why', async () => {
    const unreachable: HostAgentProbe = { status: 'unknown', version: null, detail: 'ssh: connect to host lab port 22: Connection timed out' };
    const probe = vi.fn(async () => unreachable);

    const first = await listAgentsOnHost('host-a', probe);
    expect(first[0]).toMatchObject({ found: false, hostStatus: 'unknown', detectionError: unreachable.detail });
    const asked = probe.mock.calls.length;

    await listAgentsOnHost('host-a', probe);

    expect(probe.mock.calls.length).toBe(asked * 2);
  });

  it('asks again after the link comes back, after a forced refresh, and for another host', async () => {
    const probe = vi.fn(async () => missing);
    await listAgentsOnHost('host-a', probe);
    const asked = probe.mock.calls.length;

    invalidateHostAgentList('host-a');
    await listAgentsOnHost('host-a', probe);
    expect(probe.mock.calls.length).toBe(asked * 2);

    await listAgentsOnHost('host-a', probe, true);
    expect(probe.mock.calls.length).toBe(asked * 3);

    await listAgentsOnHost('host-b', probe);
    expect(probe.mock.calls.length).toBe(asked * 4);
  });
});

describe('a spawn on a host without the CLI', () => {
  const devHome = path.join(os.tmpdir(), 'dev');
  const shellFolder = path.join(devHome, 'remote-projects', 'p1');
  const claude = { name: 'claude', displayName: 'Claude Code', remoteCliName: 'claude' };

  function resolverWith(probe: HostAgentProbe | Error) {
    const hostInfo = vi.fn(async () => ({ home: '/home/dev', shellPath: '/bin/bash', shellName: 'bash' }));
    const deps = {
      remoteOfProjectPath: (projectPath: string) => (projectPath === shellFolder ? { hostId: 'host-a', path: '/home/dev/api' } : null),
      hostInfo,
      homeMirror: (hostId: string) => path.join(devHome, 'remote-homes', hostId),
      probeAgent: vi.fn(async () => { if (probe instanceof Error) throw probe; return probe; }),
      hostName: () => 'Build server',
    } as unknown as RemoteLaunchResolverDeps;
    return { resolver: createRemoteLaunchResolver(deps), hostInfo };
  }

  it('is refused with the host and the CLI named, before anything else is asked of the host', async () => {
    const { resolver, hostInfo } = resolverWith({ status: 'missing', version: null, detail: null });

    const refusal = resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude });

    await expect(refusal).rejects.toBeInstanceOf(RemoteAgentMissingError);
    await expect(refusal).rejects.toThrow('Claude Code (claude) was not found on Build server. Install it there, or choose another agent for this project.');
    expect(hostInfo).not.toHaveBeenCalled();
  });

  it('is a user error, so it stays out of error reporting as a missing local CLI does', async () => {
    const { resolver } = resolverWith({ status: 'missing', version: null, detail: null });

    await expect(resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude })).rejects.toBeInstanceOf(UserConfigurationError);
  });

  it('goes on when the host could not be asked: only the host proves a CLI absent', async () => {
    const { resolver } = resolverWith({ status: 'unknown', version: null, detail: 'timed out' });

    const launch = await resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude });

    expect(launch?.remote.hostId).toBe('host-a');
  });

  it('goes on when the CLI is there', async () => {
    const { resolver } = resolverWith({ status: 'found', version: '2.1.80', detail: null });

    expect((await resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude }))?.place.linuxCliPath).toBe('claude');
  });
});
