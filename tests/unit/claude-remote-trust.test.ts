/**
 * Claude on a remote host (#913): the spawn's changes to the host's own files, made by the real helper
 * over the real link. The local equivalents are `ensureClaudeSpawnConfig` and the settings reads of the
 * command builder.
 *
 * What a user loses if it breaks: a trust prompt on the host that no automated session can answer, the
 * host's `~/.claude.json` (its auth and MCP state) damaged, or the project's own hooks and permissions
 * missing from the session's settings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { ensureRemoteClaudeSpawnConfig, remoteClaudeSpawnPatch } from '../../src/main/agent/adapters/claude/remote-trust';
import { applyJsonPatch } from '../../src/main/remote/helper/json-patch';
import type { SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { dialHelper, makeHelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let scratch: string;
let shellFolder: string;
let hostHome: string;
let hostProject: string;

async function makePlace(): Promise<SshCliPlace> {
  const helperRig = makeHelperRig(1, { homeDirectory: hostHome, baseEnv: { SHELL: '/bin/sh' } });
  const link = new RemoteLink({
    identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
    connect: async () => dialHelper(helperRig),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  link.start();
  await link.requestHelper('hostInfo', {});
  teardown.push(() => link.stop(), () => helperRig.helper.dispose());
  return {
    kind: 'ssh',
    hostId: 'host-a',
    home: hostHome.replace(/\\/g, '/'),
    shellName: 'sh',
    localHome: path.join(scratch, 'mirror'),
    roots: [{ local: shellFolder, host: hostProject.replace(/\\/g, '/') }],
    files: {
      readFile: (hostPath) => link.requestHelper('readFile', { path: hostPath }),
      jsonPatch: (request) => link.requestHelper('jsonPatch', request),
    },
  };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-remote-trust-'));
  shellFolder = path.join(scratch, 'shell');
  hostHome = path.join(scratch, 'host-home');
  hostProject = path.join(hostHome, 'projects', 'api');
  fs.mkdirSync(shellFolder, { recursive: true });
  fs.mkdirSync(hostProject, { recursive: true });
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('remoteClaudeSpawnPatch', () => {
  it('leaves a project trusted with the kangentic server enabled and the diff panel closed, as the local write does', () => {
    const data: Record<string, unknown> = {};
    applyJsonPatch(data, remoteClaudeSpawnPatch('/home/dev/projects/api'));
    expect(data).toEqual({
      diffSidebarOpen: false,
      projects: {
        '/home/dev/projects/api': {
          enabledMcpjsonServers: ['kangentic'],
          allowedTools: [],
          disabledMcpjsonServers: [],
          hasTrustDialogAccepted: true,
        },
      },
    });
  });

  it('gives a worktree its repository\'s MCP approvals, and keeps what the entry already holds', () => {
    const worktree = '/home/dev/projects/api/.kangentic/worktrees/fix-login';
    const data: Record<string, unknown> = {
      projects: {
        '/home/dev/projects/api': { enabledMcpjsonServers: ['github'] },
        [worktree]: { allowedTools: ['Bash(git status)'] },
      },
    };
    applyJsonPatch(data, remoteClaudeSpawnPatch(worktree));
    const entry = (data.projects as Record<string, Record<string, unknown>>)[worktree];
    expect(entry.enabledMcpjsonServers).toEqual(['github', 'kangentic']);
    expect(entry.allowedTools).toEqual(['Bash(git status)']);
    expect(entry.hasTrustDialogAccepted).toBe(true);
  });

  it('changes nothing the second time', () => {
    const data: Record<string, unknown> = {};
    applyJsonPatch(data, remoteClaudeSpawnPatch('/home/dev/projects/api'));
    expect(applyJsonPatch(data, remoteClaudeSpawnPatch('/home/dev/projects/api'))).toBe(false);
  });
});

describe('ensureRemoteClaudeSpawnConfig', () => {
  it('trusts the project\'s folder on the host, in the host\'s own ~/.claude.json, keeping the rest of the file', async () => {
    const place = await makePlace();
    fs.writeFileSync(path.join(hostHome, '.claude.json'), JSON.stringify({ oauthAccount: { email: 'user@example.test' }, projects: { '/other': { hasTrustDialogAccepted: true } } }));

    await ensureRemoteClaudeSpawnConfig(shellFolder, place);

    const written = JSON.parse(fs.readFileSync(path.join(hostHome, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.oauthAccount).toEqual({ email: 'user@example.test' });
    const projects = written.projects as Record<string, Record<string, unknown>>;
    expect(projects['/other']).toEqual({ hasTrustDialogAccepted: true });
    expect(projects[hostProject.replace(/\\/g, '/')]).toMatchObject({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ['kangentic'] });
    expect(written.diffSidebarOpen).toBe(false);
    // Nothing was written to this computer's own Claude files.
    expect(fs.existsSync(path.join(shellFolder, '.claude.json'))).toBe(false);
  });

  it('works for a host that has no ~/.claude.json yet', async () => {
    const place = await makePlace();
    await ensureRemoteClaudeSpawnConfig(shellFolder, place);
    expect(fs.existsSync(path.join(hostHome, '.claude.json'))).toBe(true);
  });

  it('leaves a ~/.claude.json that does not parse exactly as it was, and does not fail the spawn', async () => {
    const place = await makePlace();
    fs.writeFileSync(path.join(hostHome, '.claude.json'), '{ torn');

    await expect(ensureRemoteClaudeSpawnConfig(shellFolder, place)).resolves.toBeUndefined();

    expect(fs.readFileSync(path.join(hostHome, '.claude.json'), 'utf8')).toBe('{ torn');
  });

  it('copies the host\'s project settings, local settings and user settings to the folders the builder reads', async () => {
    const place = await makePlace();
    fs.mkdirSync(path.join(hostProject, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(hostHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(hostProject, '.claude', 'settings.json'), '{"hooks":{"Stop":[]}}');
    fs.writeFileSync(path.join(hostProject, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
    fs.writeFileSync(path.join(hostHome, '.claude', 'settings.json'), '{"tui":"default"}');

    await ensureRemoteClaudeSpawnConfig(shellFolder, place);

    expect(fs.readFileSync(path.join(shellFolder, '.claude', 'settings.json'), 'utf8')).toBe('{"hooks":{"Stop":[]}}');
    expect(fs.readFileSync(path.join(shellFolder, '.claude', 'settings.local.json'), 'utf8')).toBe('{"permissions":{"allow":["Bash(ls)"]}}');
    expect(fs.readFileSync(path.join(place.localHome, '.claude', 'settings.json'), 'utf8')).toBe('{"tui":"default"}');
  });

  it('removes a copy the host no longer has, so a deleted setting does not linger', async () => {
    const place = await makePlace();
    fs.mkdirSync(path.join(shellFolder, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(shellFolder, '.claude', 'settings.local.json'), '{"stale":true}');

    await ensureRemoteClaudeSpawnConfig(shellFolder, place);

    expect(fs.existsSync(path.join(shellFolder, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('pulls a worktree\'s own settings.local.json, where its "always allow" grants are written', async () => {
    const place = await makePlace();
    const worktreeLocal = path.join(shellFolder, '.kangentic', 'worktrees', 'fix-login');
    const hostWorktree = path.join(hostProject, '.kangentic', 'worktrees', 'fix-login');
    fs.mkdirSync(path.join(hostWorktree, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(hostWorktree, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Edit"]}}');

    await ensureRemoteClaudeSpawnConfig(worktreeLocal, place);

    expect(fs.readFileSync(path.join(worktreeLocal, '.claude', 'settings.local.json'), 'utf8')).toBe('{"permissions":{"allow":["Edit"]}}');
    const written = JSON.parse(fs.readFileSync(path.join(hostHome, '.claude.json'), 'utf8')) as { projects: Record<string, unknown> };
    expect(Object.keys(written.projects)).toEqual([hostWorktree.replace(/\\/g, '/')]);
  });

  it('refuses when the place has no connection to the host', async () => {
    const place = { ...(await makePlace()), files: undefined };
    await expect(ensureRemoteClaudeSpawnConfig(shellFolder, place)).rejects.toThrow('no connection');
  });
});
