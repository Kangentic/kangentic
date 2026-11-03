/**
 * The resolver both spawn chokepoints ask (#913): is this spawn on a remote host, and if so what are
 * its place and descriptor. Pure logic over injected lookups.
 *
 * What a user loses if it breaks: a remote project started as a local one (the CLI looked for on this
 * computer), an agent started in a folder the host cannot open, or a path from this computer handed
 * to the host as its working directory.
 */
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  RemoteAgentUnsupportedError,
  RemoteFolderOutsideProjectError,
  createRemoteLaunchResolver,
  resolveRemoteLaunch,
  setRemoteLaunchResolver,
  type RemoteLaunchResolverDeps,
} from '../../src/main/remote/remote-launch';

const shellFolder = path.join('C:\\Users\\dev', 'remote-projects', 'p1');
const claude = { name: 'claude', displayName: 'Claude Code', remoteCliName: 'claude' };
const codex = { name: 'codex', displayName: 'Codex', remoteCliName: undefined };

function makeDeps(overrides: Partial<RemoteLaunchResolverDeps> = {}): RemoteLaunchResolverDeps {
  return {
    remoteOfProjectPath: (projectPath) => (projectPath === shellFolder ? { hostId: 'host-a', path: '/home/dev/api' } : null),
    hostInfo: vi.fn(async () => ({ home: '/home/dev', shellPath: '/usr/bin/fish', shellName: 'fish' })),
    readFile: vi.fn(async () => ({ exists: true, content: '{}' })),
    jsonPatch: vi.fn(async () => ({ applied: true as const, changed: true })),
    homeMirror: (hostId) => path.join('C:\\Users\\dev', 'remote-homes', hostId),
    ...overrides,
  };
}

describe('a project that is not remote', () => {
  it('answers null, and never asks a host anything', async () => {
    const deps = makeDeps();
    const resolver = createRemoteLaunchResolver(deps);

    expect(await resolver.resolve({ projectPath: path.join('C:\\Users\\dev', 'local-project'), cwd: 'x', adapter: claude })).toBeNull();
    expect(await resolver.resolve({ projectPath: null, cwd: 'x', adapter: claude })).toBeNull();
    expect(await resolver.resolve({ projectPath: undefined, cwd: 'x', adapter: claude })).toBeNull();
    expect(deps.hostInfo).not.toHaveBeenCalled();
  });

  it('answers null for an agent with no remote support too: the check is for remote projects only', async () => {
    const resolver = createRemoteLaunchResolver(makeDeps());
    expect(await resolver.resolve({ projectPath: path.join('C:\\Users\\dev', 'local-project'), cwd: 'x', adapter: codex })).toBeNull();
  });
});

describe('a remote project', () => {
  it('builds the host place with its path map, home, shell and the CLI by name', async () => {
    const resolver = createRemoteLaunchResolver(makeDeps());

    const launch = await resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude });

    expect(launch?.place).toMatchObject({
      kind: 'ssh',
      hostId: 'host-a',
      home: '/home/dev',
      shellName: 'fish',
      linuxCliPath: 'claude',
      roots: [{ local: shellFolder, host: '/home/dev/api' }],
      localHome: path.join('C:\\Users\\dev', 'remote-homes', 'host-a'),
    });
    expect(launch?.remote).toEqual({ hostId: 'host-a', cwd: '/home/dev/api', shellName: 'fish' });
  });

  it('maps a worktree under the shell folder onto the host\'s', async () => {
    const resolver = createRemoteLaunchResolver(makeDeps());

    const launch = await resolver.resolve({ projectPath: shellFolder, cwd: path.join(shellFolder, '.kangentic', 'worktrees', 'fix-login'), adapter: claude });

    expect(launch?.remote.cwd).toBe('/home/dev/api/.kangentic/worktrees/fix-login');
  });

  it('refuses a folder outside the project, so a path from this computer never becomes the host\'s working directory', async () => {
    const resolver = createRemoteLaunchResolver(makeDeps());

    await expect(resolver.resolve({ projectPath: shellFolder, cwd: path.join('C:\\Users\\dev', 'elsewhere'), adapter: claude }))
      .rejects.toBeInstanceOf(RemoteFolderOutsideProjectError);
    await expect(resolver.resolve({ projectPath: shellFolder, cwd: `${shellFolder}-copy`, adapter: claude }))
      .rejects.toBeInstanceOf(RemoteFolderOutsideProjectError);
  });

  it('refuses an agent that has not been made to run on a host, with a sentence that names the way out', async () => {
    const resolver = createRemoteLaunchResolver(makeDeps());

    await expect(resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: codex }))
      .rejects.toThrow('Codex cannot run on a remote host yet. Choose another agent for this project');
    await expect(resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: codex }))
      .rejects.toBeInstanceOf(RemoteAgentUnsupportedError);
  });

  it('passes the host\'s own failure up, so an unreachable host fails the spawn in its words', async () => {
    const resolver = createRemoteLaunchResolver(makeDeps({ hostInfo: vi.fn(async () => { throw new Error('Kangentic has no connection set up for host host-a'); }) }));

    await expect(resolver.resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude })).rejects.toThrow('no connection set up');
  });

  it('gives the place the helper\'s file jobs for this host, and only for it', async () => {
    const deps = makeDeps();
    const launch = await createRemoteLaunchResolver(deps).resolve({ projectPath: shellFolder, cwd: shellFolder, adapter: claude });

    await launch?.place.files?.readFile('/home/dev/.claude/settings.json');
    await launch?.place.files?.jsonPatch({ path: '/home/dev/.claude.json', ops: [] });

    expect(deps.readFile).toHaveBeenCalledWith('host-a', '/home/dev/.claude/settings.json');
    expect(deps.jsonPatch).toHaveBeenCalledWith('host-a', { path: '/home/dev/.claude.json', ops: [] });
  });
});

describe('the process-wide resolver', () => {
  it('answers null until one is set, and after it is cleared', async () => {
    setRemoteLaunchResolver(null);
    expect(await resolveRemoteLaunch({ projectPath: shellFolder, cwd: shellFolder, adapter: claude })).toBeNull();

    setRemoteLaunchResolver(createRemoteLaunchResolver(makeDeps()));
    expect(await resolveRemoteLaunch({ projectPath: shellFolder, cwd: shellFolder, adapter: claude })).not.toBeNull();

    setRemoteLaunchResolver(null);
    expect(await resolveRemoteLaunch({ projectPath: shellFolder, cwd: shellFolder, adapter: claude })).toBeNull();
  });
});
