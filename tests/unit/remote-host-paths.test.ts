/**
 * The map between what this computer records and what an agent on a host sees. Every tool and prompt reads a
 * remote project's paths through it, so a slip here hands an agent a path that names nothing where it works.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentPathsForProject, agentPathsForProjectPath, setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { serializeCliTarget } from '../../src/main/agent/shared/cli-target';

const SHELL = path.resolve('/mock/config/remote-projects/p1');
const MIRROR = path.resolve('/mock/config/remote-homes/h1');
const remote = { hostId: 'h1', path: '/home/dev/proj' };
const paths = agentPathsForProject({ path: SHELL, remote });

afterEach(() => setRemoteProjectLookup(null));

describe('a remote project', () => {
  it('maps the stand-in and everything under it to the host, and back', () => {
    const standIn = path.join(SHELL, '.kangentic', 'worktrees', '12');
    expect(paths.toAgent(SHELL)).toBe('/home/dev/proj');
    expect(paths.toAgent(standIn)).toBe('/home/dev/proj/.kangentic/worktrees/12');
    expect(paths.fromAgent('/home/dev/proj/.kangentic/worktrees/12')).toBe(standIn);
    expect(paths.fromAgent('/home/dev/proj')).toBe(SHELL);
  });

  it('leaves a value already on the right side alone, so mapping twice is mapping once', () => {
    expect(paths.toAgent('/home/dev/proj/.kangentic/worktrees/12')).toBe('/home/dev/proj/.kangentic/worktrees/12');
    const standIn = path.join(SHELL, 'src');
    expect(paths.fromAgent(standIn)).toBe(standIn);
    expect(paths.fromAgent(paths.fromAgent('/home/dev/proj/src'))).toBe(standIn);
  });

  it('does not treat a sibling folder as inside the project', () => {
    expect(paths.isHostPath('/home/dev/proj-other/a.txt')).toBe(false);
    expect(paths.fromAgent('/home/dev/proj-other/a.txt')).toBe('/home/dev/proj-other/a.txt');
    expect(paths.toAgent(`${SHELL}-other`)).toBe(`${SHELL}-other`);
  });

  it('does not let a host path climb out of the project', () => {
    expect(paths.isHostPath('/home/dev/proj/../other')).toBe(false);
  });

  it('keeps null, undefined and empty values as they are', () => {
    expect(paths.toAgent(null)).toBeNull();
    expect(paths.toAgent(undefined)).toBeUndefined();
    expect(paths.fromAgent('')).toBe('');
  });

  it('names the sides', () => {
    expect(paths).toMatchObject({ location: 'host', hostId: 'h1', shellFolder: SHELL, projectFolder: '/home/dev/proj' });
    expect(paths.isHostPath('/home/dev/proj/src/a.ts')).toBe(true);
  });

  it('maps a mirror path to the host from the session row alone, and nothing else', () => {
    const record = {
      cli_target: serializeCliTarget({ kind: 'ssh', hostId: 'h1', home: '/home/dev', shellName: 'bash', localHome: MIRROR, roots: paths.roots }),
    };
    const copy = path.join(MIRROR, '.claude', 'projects', 'proj', 'a.jsonl');
    expect(paths.mirrorToAgent(copy, record)).toBe('/home/dev/.claude/projects/proj/a.jsonl');
    expect(paths.mirrorToAgent(path.join(SHELL, 'a.jsonl'), record)).toBeNull();
    expect(paths.mirrorToAgent(copy, { cli_target: null })).toBeNull();
  });
});

describe('a project on this computer', () => {
  const local = agentPathsForProject({ path: SHELL, remote: null });

  it('is the identity', () => {
    const inside = path.join(SHELL, '.kangentic', 'worktrees', '12');
    expect(local).toMatchObject({ location: 'local', hostId: null, shellFolder: SHELL, projectFolder: SHELL });
    expect(local.toAgent(inside)).toBe(inside);
    expect(local.fromAgent('/home/dev/proj')).toBe('/home/dev/proj');
    expect(local.isHostPath('/home/dev/proj')).toBe(false);
    expect(local.mirrorToAgent(inside, { cli_target: null })).toBeNull();
  });
});

describe('a project known only by its path', () => {
  it('reads as local until the SSH feature has started, and as remote once the lookup knows it', () => {
    expect(agentPathsForProjectPath(SHELL).location).toBe('local');
    setRemoteProjectLookup((projectPath) => (projectPath === SHELL ? remote : null));
    expect(agentPathsForProjectPath(SHELL).toAgent(SHELL)).toBe('/home/dev/proj');
    expect(agentPathsForProjectPath(path.resolve('/mock/other')).location).toBe('local');
  });
});
