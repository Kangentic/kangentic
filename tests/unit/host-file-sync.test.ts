/**
 * How the files an agent CLI edits on a remote host stay in step with the adapter code that edits them
 * here (#913). An adapter merges its entry into the user's `~/.gemini/trustedFolders.json` or
 * `<project>/.cursor/mcp.json` and strips it again; the sync pulls those files from the host first, pushes
 * the change after, and restores them when the session ends.
 *
 * What a user loses if it breaks: a host's trust file overwritten with an empty-folder version (their own
 * entries gone), a settings file written over one the user changed meanwhile, hooks left in a project
 * after the session, or a config file showing in `git status` where the agent runs.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { HostFileChangedError, HostFileSync, HostFileTooLargeError, HostFileUnreadableError, pullHostFilesFor, pushHostFilesForSpawn, rememberHostFileSync, resetHostFileSyncState, settleHostFiles, withHostFilePull } from '../../src/main/remote/host-file-sync';
import { FakeSshHost } from './helpers/fake-ssh-host';

let workspace: string;
let projectFolder: string;
let mirrorHome: string;
let host: FakeSshHost;
let place: SshCliPlace;

beforeEach(async () => {
  resetHostFileSyncState();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kangentic-host-sync-'));
  projectFolder = path.join(workspace, 'shell');
  mirrorHome = path.join(workspace, 'mirror');
  await fs.mkdir(projectFolder, { recursive: true });
  await fs.mkdir(mirrorHome, { recursive: true });
  host = new FakeSshHost();
  place = {
    kind: 'ssh',
    hostId: 'host-1',
    home: '/home/dev',
    shellName: 'bash',
    localHome: mirrorHome,
    roots: [{ local: projectFolder, host: '/home/dev/app' }],
    files: host.api,
  };
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const GEMINI_TRUST = '.gemini/trustedFolders.json';
const CURSOR_MCP = '.cursor/mcp.json';

async function localHomeFile(relative: string): Promise<string | null> {
  return fs.readFile(path.join(mirrorHome, ...relative.split('/')), 'utf8').catch(() => null);
}

async function localProjectFile(relative: string): Promise<string | null> {
  return fs.readFile(path.join(projectFolder, ...relative.split('/')), 'utf8').catch(() => null);
}

describe('pulling the host\'s files for the adapter to edit', () => {
  it('writes the host\'s copies where the adapter code reads them, so it merges into the user\'s own entries', async () => {
    host.files.set('/home/dev/.gemini/trustedFolders.json', '{"/home/dev/other":"TRUST_FOLDER"}');
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"mcpServers":{"mine":{}}}');

    await HostFileSync.pull({ home: [GEMINI_TRUST], project: [CURSOR_MCP] }, projectFolder, place);

    expect(await localHomeFile(GEMINI_TRUST)).toBe('{"/home/dev/other":"TRUST_FOLDER"}');
    expect(await localProjectFile(CURSOR_MCP)).toBe('{"mcpServers":{"mine":{}}}');
  });

  it('removes a stale local copy when the host has no such file, so an old file is never pushed back', async () => {
    await fs.mkdir(path.join(projectFolder, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), 'left over from another host');

    await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);

    expect(await localProjectFile(CURSOR_MCP)).toBeNull();
  });

  it('refuses a file larger than the helper reads whole, rather than edit and push back a cut-off copy', async () => {
    host.files.set('/home/dev/.gemini/trustedFolders.json', 'x'.repeat(1_000_001));

    await expect(HostFileSync.pull({ home: [GEMINI_TRUST], project: [] }, projectFolder, place)).rejects.toBeInstanceOf(HostFileTooLargeError);
  });

  it('refuses a declared path that climbs out of its folder or is absolute', async () => {
    for (const bad of ['../outside.json', '/etc/passwd', 'a//b', 'a\\b', '']) {
      await expect(HostFileSync.pull({ home: [bad], project: [] }, projectFolder, place)).rejects.toThrow(/not a plain relative path/);
    }
  });

  it('asks the host for nothing when the adapter declares nothing or the spawn is not on a host', async () => {
    expect(await pullHostFilesFor({}, projectFolder, place)).toBeNull();
    expect(await pullHostFilesFor({ remoteFiles: () => ({ home: [], project: [] }) }, projectFolder, place)).toBeNull();
    expect(await pullHostFilesFor({ remoteFiles: () => ({ home: [GEMINI_TRUST], project: [] }) }, projectFolder, null)).toBeNull();
    expect(await pullHostFilesFor({ remoteFiles: () => ({ home: [GEMINI_TRUST], project: [] }) }, projectFolder, { kind: 'wsl' })).toBeNull();
  });
});

describe('pushing what the adapter changed', () => {
  it('writes a changed file to the host and leaves an unchanged one alone', async () => {
    host.files.set('/home/dev/.gemini/trustedFolders.json', '{"a":"TRUST_FOLDER"}');
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"mcpServers":{}}');
    const sync = await HostFileSync.pull({ home: [GEMINI_TRUST], project: [CURSOR_MCP] }, projectFolder, place);

    await fs.writeFile(path.join(mirrorHome, '.gemini', 'trustedFolders.json'), '{"a":"TRUST_FOLDER","/home/dev/app":"TRUST_FOLDER"}');
    await sync.push();

    expect(host.files.get('/home/dev/.gemini/trustedFolders.json')).toBe('{"a":"TRUST_FOLDER","/home/dev/app":"TRUST_FOLDER"}');
    expect(host.writes).toEqual(['/home/dev/.gemini/trustedFolders.json']);
  });

  it('writes a script executable, a home file owner-only and a project file readable', async () => {
    const sync = await HostFileSync.pull({ home: [GEMINI_TRUST], project: [CURSOR_MCP, '.kangentic/gemini-wsl-hook.sh'] }, projectFolder, place);
    await fs.mkdir(path.join(mirrorHome, '.gemini'), { recursive: true });
    await fs.writeFile(path.join(mirrorHome, '.gemini', 'trustedFolders.json'), '{}');
    await fs.mkdir(path.join(projectFolder, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{}');
    await fs.mkdir(path.join(projectFolder, '.kangentic'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.kangentic', 'gemini-wsl-hook.sh'), '#!/bin/sh\n');

    await sync.push();

    expect(host.modes.get('/home/dev/.gemini/trustedFolders.json')).toBe(0o600);
    expect(host.modes.get('/home/dev/app/.cursor/mcp.json')).toBe(0o644);
    expect(host.modes.get('/home/dev/app/.kangentic/gemini-wsl-hook.sh')).toBe(0o755);
  });

  it('writes a file the adapter marks private owner-only, and refuses to mark a file it did not declare', async () => {
    const sync = await HostFileSync.pull({ home: [], project: ['.agents/plugins/kangentic/mcp_config.json', CURSOR_MCP], private: ['.agents/plugins/kangentic/mcp_config.json'] }, projectFolder, place);
    await fs.mkdir(path.join(projectFolder, '.agents', 'plugins', 'kangentic'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.agents', 'plugins', 'kangentic', 'mcp_config.json'), '{"token":"secret"}');
    await fs.mkdir(path.join(projectFolder, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{}');

    await sync.push();

    expect(host.modes.get('/home/dev/app/.agents/plugins/kangentic/mcp_config.json')).toBe(0o600);
    expect(host.modes.get('/home/dev/app/.cursor/mcp.json')).toBe(0o644);
    await expect(HostFileSync.pull({ home: [], project: [CURSOR_MCP], private: ['.not/declared.json'] }, projectFolder, place)).rejects.toThrow(/not a declared host file/);
  });

  it('does not overwrite a file the user changed on the host while the session was being prepared', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"v":1,"kangentic":true}');
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":2}');

    await expect(sync.push()).rejects.toBeInstanceOf(HostFileChangedError);
    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"v":2}');
  });

  it('keeps a project file Kangentic created out of the host\'s git status, once, and never a file the user already had', async () => {
    host.directories.add('/home/dev/app/.git/info');
    host.files.set('/home/dev/app/.git/info/exclude', '# existing\nbuild/\n');
    host.files.set('/home/dev/app/.gemini/settings.json', '{"theirs":true}');
    const sync = await HostFileSync.pull({ home: [], project: ['.gemini/settings.json', '.cursor/mcp.json'] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.gemini', 'settings.json'), '{"theirs":true,"hooks":{}}');
    await fs.mkdir(path.join(projectFolder, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"mcpServers":{}}');

    await sync.push();

    const exclude = host.files.get('/home/dev/app/.git/info/exclude') ?? '';
    expect(exclude).toContain('# existing\nbuild/\n');
    expect(exclude).toContain('/.cursor/mcp.json');
    expect(exclude).not.toContain('settings.json');
    expect(exclude.match(/# kangentic:/g)).toHaveLength(1);
  });

  it('adds nothing to the exclude file of a folder that is not a git checkout, and does not create .git', async () => {
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.mkdir(path.join(projectFolder, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{}');

    await sync.push();

    expect([...host.files.keys()].some((key) => key.includes('.git'))).toBe(false);
  });
});

describe('two spawns on one host at once', () => {
  it('does not delete or rewrite the folder copy another spawn is still editing', async () => {
    // The host has no such file yet. The first spawn pulls, then its adapter writes the file.
    const first = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.mkdir(path.join(projectFolder, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"first":1}');

    // The second spawn pulls before the first has pushed. It must not remove the first's file.
    const second = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    expect(await localProjectFile(CURSOR_MCP)).toBe('{"first":1}');

    await first.push();
    await second.push();

    // The first's entry reached the host, and the second, which changed nothing, did not undo it.
    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"first":1}');
  });

  it('refreshes the folder from the host again once the first spawn has pushed', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    const first = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await first.push();
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":2}');

    await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);

    expect(await localProjectFile(CURSOR_MCP)).toBe('{"v":2}');
  });
});

describe('a host JSON file that is not plain JSON', () => {
  const SETTINGS = '.gemini/settings.json';
  const WITH_COMMENT = '{\n  // my own notes\n  "theme": "dark"\n}\n';

  it('is never replaced by the fresh file an adapter built from an empty one', async () => {
    host.files.set('/home/dev/app/.gemini/settings.json', WITH_COMMENT);
    const sync = await HostFileSync.pull({ home: [], project: [SETTINGS] }, projectFolder, place);
    // The adapter could not parse it, started from nothing, and wrote only its own entries.
    await fs.writeFile(path.join(projectFolder, '.gemini', 'settings.json'), '{"hooks":{}}');

    await expect(sync.push()).rejects.toBeInstanceOf(HostFileUnreadableError);
    expect(host.files.get('/home/dev/app/.gemini/settings.json')).toBe(WITH_COMMENT);
  });

  it('is left alone by a release, which never throws', async () => {
    host.files.set('/home/dev/app/.gemini/settings.json', WITH_COMMENT);
    const sync = await HostFileSync.pull({ home: [], project: [SETTINGS] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.gemini', 'settings.json'), '{"hooks":{}}');

    await expect(sync.settle()).resolves.toBeUndefined();
    expect(host.files.get('/home/dev/app/.gemini/settings.json')).toBe(WITH_COMMENT);
  });

  it('does not stop a file with a byte order mark, or an empty one', async () => {
    host.files.set('/home/dev/app/.gemini/settings.json', `${String.fromCharCode(0xfeff)}{"a":1}`);
    const sync = await HostFileSync.pull({ home: [], project: [SETTINGS] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.gemini', 'settings.json'), '{"a":1,"hooks":{}}');

    await sync.push();

    expect(host.files.get('/home/dev/app/.gemini/settings.json')).toBe('{"a":1,"hooks":{}}');
  });
});

describe('a change that lands in the instant before the write', () => {
  it('is refused by the host and left as it is', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"ours":1}');
    // The user saves the file after the push's own read and before the host swaps ours in.
    const realRead = host.api.readFile;
    host.api.readFile = async (hostPath) => {
      const answer = await realRead(hostPath);
      host.files.set(hostPath, '{"user":"edit"}');
      return answer;
    };

    await expect(sync.push()).rejects.toBeInstanceOf(HostFileChangedError);
    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"user":"edit"}');
  });
});

describe('restoring the host\'s files when the session ends', () => {
  it('removes a file the adapter removed and rewrites one it stripped, putting the host back as the user had it', async () => {
    host.directories.add('/home/dev/app/.git/info');
    host.files.set('/home/dev/app/.gemini/settings.json', '{"theirs":true}');
    const sync = await HostFileSync.pull({ home: [], project: ['.gemini/settings.json', '.agents/hooks.json'] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.gemini', 'settings.json'), '{"theirs":true,"hooks":{}}');
    await fs.mkdir(path.join(projectFolder, '.agents'), { recursive: true });
    await fs.writeFile(path.join(projectFolder, '.agents', 'hooks.json'), '{}');
    await sync.push();
    rememberHostFileSync('session-1', sync);

    // The adapter's removeHooks, run on the local copies.
    await fs.writeFile(path.join(projectFolder, '.gemini', 'settings.json'), '{"theirs":true}');
    await fs.rm(path.join(projectFolder, '.agents', 'hooks.json'));
    await settleHostFiles('session-1');

    expect(host.files.get('/home/dev/app/.gemini/settings.json')).toBe('{"theirs":true}');
    expect(host.files.has('/home/dev/app/.agents/hooks.json')).toBe(false);
  });

  it('leaves a file alone that another session already put right, without calling it a conflict', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{}');
    const first = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"k":1}');
    await first.push();
    const second = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    rememberHostFileSync('first', first);
    rememberHostFileSync('second', second);

    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{}');
    await settleHostFiles('first');
    await settleHostFiles('second');

    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{}');
  });

  it('skips a file the user changed on the host meanwhile, and never throws from a release', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"k":1}');
    await sync.push();
    rememberHostFileSync('s', sync);
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"user":"edit"}');
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{}');

    await expect(settleHostFiles('s')).resolves.toBeUndefined();
    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"user":"edit"}');
  });

  it('strips the entries of every session on the host when the last one ends, not only its own', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"theirs":1}');
    const first = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"theirs":1,"a":1}');
    await first.push();
    const second = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"theirs":1,"a":1,"b":1}');
    await second.push();
    rememberHostFileSync('first', first);
    rememberHostFileSync('second', second);

    // The second ends while the first still holds the file: nothing changes locally, so nothing is sent.
    await settleHostFiles('second');
    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"theirs":1,"a":1,"b":1}');
    // The first ends last and strips everything Kangentic put there. Its own pull never saw "b".
    await fs.writeFile(path.join(projectFolder, '.cursor', 'mcp.json'), '{"theirs":1}');
    await settleHostFiles('first');

    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"theirs":1}');
  });

  it('forgets the session after one release, so a second is a no-op', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    rememberHostFileSync('once', sync);

    await settleHostFiles('once');
    const writesAfterFirst = host.writes.length;
    await settleHostFiles('once');

    expect(host.writes).toHaveLength(writesAfterFirst);
  });
});

async function writeProjectFile(relative: string, content: string): Promise<void> {
  const target = path.join(projectFolder, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

describe('a pull where one read fails', () => {
  it('clears every mark, even for a read that finishes after the failure, so a later pull refreshes from the host', async () => {
    host.files.set('/home/dev/app/b.json', '{"v":1}');
    const realRead = host.api.readFile;
    let finishSlowRead: () => void = () => undefined;
    const slowReadGate = new Promise<void>((resolve) => { finishSlowRead = resolve; });
    host.api.readFile = async (hostPath) => {
      if (hostPath === '/home/dev/app/a.json') throw new Error('link dropped');
      await slowReadGate;
      return realRead(hostPath);
    };

    const failedPull = HostFileSync.pull({ home: [], project: ['a.json', 'b.json'] }, projectFolder, place);
    const outcome = expect(failedPull).rejects.toThrow('link dropped');
    // The slow read finishes only after the failed one has been seen.
    await new Promise((resolve) => setImmediate(resolve));
    finishSlowRead();
    await outcome;
    await expect.poll(() => localProjectFile('b.json')).toBe('{"v":1}');
    // Intentional fixed wait: a read that finishes late marks its file a few ticks after its local write, and nothing observable says it is done.
    await new Promise((resolve) => setTimeout(resolve, 50));

    host.api.readFile = realRead;
    host.files.set('/home/dev/app/b.json', '{"v":2}');
    await HostFileSync.pull({ home: [], project: ['b.json'] }, projectFolder, place);

    expect(await localProjectFile('b.json')).toBe('{"v":2}');
  });
});

describe('a spawn that throws after its pull', () => {
  const declaration = { home: [], project: [CURSOR_MCP] };

  /** A spawn whose adapter edits the folder copy and then fails, as a trust step that throws does. */
  async function failedSpawn(adapterOutput: string): Promise<void> {
    await expect(withHostFilePull(async (pull) => {
      pull.sync = await HostFileSync.pull(declaration, projectFolder, place);
      await writeProjectFile(CURSOR_MCP, adapterOutput);
      throw new Error('trust failed');
    })).rejects.toThrow('trust failed');
  }

  it('abandons the pull, so a retry inside the edit window refreshes the file from the host', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    await failedSpawn('{"v":1,"adapter":1}');
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":2}');

    await HostFileSync.pull(declaration, projectFolder, place);

    expect(await localProjectFile(CURSOR_MCP)).toBe('{"v":2}');
  });

  it('pushes a retry whose local copy already equals the adapter output', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    const adapterOutput = '{"v":1,"adapter":1}';
    await failedSpawn(adapterOutput);

    const retry = await HostFileSync.pull(declaration, projectFolder, place);
    await writeProjectFile(CURSOR_MCP, adapterOutput);
    await retry.push();

    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe(adapterOutput);
  });

  it('returns the callback result and leaves the pull for its push when nothing throws', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    const result = await withHostFilePull(async (pull) => {
      pull.sync = await HostFileSync.pull(declaration, projectFolder, place);
      await writeProjectFile(CURSOR_MCP, '{"v":1,"adapter":1}');
      return 'built';
    });
    expect(result).toBe('built');

    // Another spawn pulling now must not overwrite the first one's unpushed edit.
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":2}');
    await HostFileSync.pull(declaration, projectFolder, place);
    expect(await localProjectFile(CURSOR_MCP)).toBe('{"v":1,"adapter":1}');
  });
});

describe('the last step of a spawn sync', () => {
  it('does nothing for a spawn with no sync', async () => {
    const onFailure = vi.fn();

    await expect(pushHostFilesForSpawn(null, 'session-none', onFailure)).resolves.toBeUndefined();
    await settleHostFiles('session-none');

    expect(onFailure).not.toHaveBeenCalled();
    expect(host.writes).toEqual([]);
  });

  it('pushes the change and does not call onFailure when the push works', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await writeProjectFile(CURSOR_MCP, '{"k":1}');
    const onFailure = vi.fn();

    await pushHostFilesForSpawn(sync, 'session-ok', onFailure);

    expect(host.files.get('/home/dev/app/.cursor/mcp.json')).toBe('{"k":1}');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('runs onFailure and rethrows the push error when the push fails', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":1}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    await writeProjectFile(CURSOR_MCP, '{"v":1,"k":1}');
    host.files.set('/home/dev/app/.cursor/mcp.json', '{"v":2}');
    const onFailure = vi.fn();

    await expect(pushHostFilesForSpawn(sync, 'session-fail', onFailure)).rejects.toBeInstanceOf(HostFileChangedError);

    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('remembers the sync before the push, so a push that fails partway is still stripped on release', async () => {
    host.files.set('/home/dev/app/.cursor/mcp.json', '{}');
    const sync = await HostFileSync.pull({ home: [], project: [CURSOR_MCP] }, projectFolder, place);
    const settle = vi.spyOn(sync, 'settle').mockResolvedValue(undefined);
    vi.spyOn(sync, 'push').mockImplementation(async () => {
      // The release that follows a failed spawn, run while the push is still going.
      await settleHostFiles('session-order');
      throw new Error('push failed partway');
    });

    await expect(pushHostFilesForSpawn(sync, 'session-order', () => undefined)).rejects.toThrow('push failed partway');

    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe('pushing several changed files', () => {
  it('asks the host for all of their current content before any answer comes back', async () => {
    host.files.set('/home/dev/app/a.json', '{}');
    host.files.set('/home/dev/app/b.json', '{}');
    host.files.set('/home/dev/app/c.json', '{}');
    const sync = await HostFileSync.pull({ home: [], project: ['a.json', 'b.json', 'c.json'] }, projectFolder, place);
    for (const name of ['a.json', 'b.json', 'c.json']) await writeProjectFile(name, '{"k":1}');

    const realRead = host.api.readFile;
    const requested: string[] = [];
    const answers: Array<() => void> = [];
    host.api.readFile = (hostPath) => {
      requested.push(hostPath);
      return new Promise((resolve) => { answers.push(() => resolve(realRead(hostPath))); });
    };

    const pushing = sync.push();
    // Sequential reads would request one file and wait on it, so this poll would stop at one.
    await expect.poll(() => requested.length, { timeout: 1000 }).toBe(3);
    for (const answer of answers) answer();
    await pushing;

    expect(host.files.get('/home/dev/app/b.json')).toBe('{"k":1}');
  });
});
