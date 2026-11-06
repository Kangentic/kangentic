/**
 * What the helper does for the app on its own host (#913): start a PTY in the host's login shell with the
 * host's environment and never this computer's, and write, read and check files on the host. A path the app
 * names is held beneath the user's home, and a path the helper cannot look at is never called absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import { HOST_LOGIN_SHELL } from '../../src/main/remote/protocol/messages';
import { RemoteHostService } from '../../src/main/remote/remote-host-service';
import { dialHelper, makeHelperRig, settle, spawnParams, type HelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let home: string;
/** Temp homes a test replaced `home` over, still to be removed in teardown. */
const ownedHomes: string[] = [];

interface Rig {
  helperRig: HelperRig;
  link: RemoteLink;
  client: PtyHostClient;
}

function makeRig(baseEnv: NodeJS.ProcessEnv = { HOME: '/home/dev', SHELL: '/bin/zsh', PATH: '/usr/bin' }): Rig {
  const helperRig = makeHelperRig(1, { homeDirectory: home, baseEnv });
  const link = new RemoteLink({
    identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
    connect: async () => dialHelper(helperRig),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  link.start();
  teardown.push(() => link.stop(), () => helperRig.helper.dispose());
  return { helperRig, link, client: new PtyHostClient(link) };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The real path: macOS reaches os.tmpdir() through a link, and a symlink test needs a home with none in it.
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-helper-home-')));
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
  for (const ownedHome of ownedHomes.splice(0)) fs.rmSync(ownedHome, { recursive: true, force: true });
});

async function ask<T>(promise: Promise<T>): Promise<T> {
  await settle();
  return promise;
}

describe('starting a PTY on the host', () => {
  it('runs the host\'s own login shell when the spawn asks for it', async () => {
    const rig = makeRig();
    await settle();
    const spawning = rig.client.spawn({ ...spawnParams('s1', 'task-1', 'host-a'), file: HOST_LOGIN_SHELL, args: [] });
    await settle();
    await spawning;
    const [file, args] = rig.helperRig.spawnPty.mock.calls[0] as [string, string[]];
    expect(file).toBe('/bin/zsh');
    expect(args).toEqual(['--login']);
  });

  it.each([
    ['/usr/bin/bash', ['--login']],
    ['/usr/bin/fish', []],
    ['/usr/bin/nu', []],
    ['/bin/dash', ['-l']],
    ['/bin/ksh', ['-l']],
  ])('asks %s to be a login shell the way this computer asks it', async (shellPath, expectedArgs) => {
    const rig = makeRig({ HOME: '/home/dev', SHELL: shellPath });
    await settle();
    const spawning = rig.client.spawn({ ...spawnParams('s1', 'task-1'), file: HOST_LOGIN_SHELL, args: [] });
    await settle();
    await spawning;
    expect(rig.helperRig.spawnPty.mock.calls[0].slice(0, 2)).toEqual([shellPath, expectedArgs]);
  });

  it('falls back to sh when the host sets no shell', async () => {
    const rig = makeRig({ HOME: '/home/dev' });
    await settle();
    const first = rig.client.spawn({ ...spawnParams('s1', 'task-1'), file: HOST_LOGIN_SHELL, args: ['-i'] });
    await settle();
    await first;
    expect(rig.helperRig.spawnPty.mock.calls[0].slice(0, 2)).toEqual(['/bin/sh', ['-l', '-i']]);
  });

  it('leaves a program the spawn names, and its arguments, exactly as given', async () => {
    const rig = makeRig();
    await settle();
    const spawning = rig.client.spawn({ ...spawnParams('s1', 'task-1'), file: '/usr/bin/env', args: ['-i', 'sh'] });
    await settle();
    await spawning;
    expect(rig.helperRig.spawnPty.mock.calls[0].slice(0, 2)).toEqual(['/usr/bin/env', ['-i', 'sh']]);
  });

  it('starts the PTY from the host\'s environment, never this computer\'s, with the ssh session\'s variables left out', async () => {
    const rig = makeRig({ HOME: '/home/dev', PATH: '/usr/bin', SHELL: '/bin/bash', SSH_CONNECTION: '10.0.0.2 5000 10.0.0.9 22', SSH_AUTH_SOCK: '/tmp/agent', NODE_OPTIONS: '--inspect' });
    await settle();
    const spawning = rig.client.spawn({ ...spawnParams('s1', 'task-1'), file: HOST_LOGIN_SHELL, args: [], env: { KANGENTIC_TASK_ID: 'task-1', TERM: 'xterm-256color' } });
    await settle();
    await spawning;
    const options = rig.helperRig.spawnPty.mock.calls[0][2] as { env: Record<string, string> };
    expect(options.env).toMatchObject({ HOME: '/home/dev', PATH: '/usr/bin', KANGENTIC_TASK_ID: 'task-1', TERM: 'xterm-256color' });
    expect(Object.keys(options.env).filter((name) => name.startsWith('SSH_') || name === 'NODE_OPTIONS')).toEqual([]);
  });

  it('lets the spawn\'s own variables win over the host\'s', async () => {
    const rig = makeRig({ HOME: '/home/dev', TERM: 'dumb' });
    await settle();
    const spawning = rig.client.spawn({ ...spawnParams('s1', 'task-1'), env: { TERM: 'xterm-256color' } });
    await settle();
    await spawning;
    expect((rig.helperRig.spawnPty.mock.calls[0][2] as { env: Record<string, string> }).env.TERM).toBe('xterm-256color');
  });
});

describe('what the helper says of its host', () => {
  it('names the home folder and the shell a login spawn lands in', async () => {
    const rig = makeRig({ SHELL: '/usr/bin/Fish' });
    await settle();
    const info = await ask(rig.link.requestHelper('hostInfo', {}));
    expect(info).toEqual({ home: path.resolve(home), shellPath: '/usr/bin/Fish', shellName: 'fish' });
  });

  it('says sh when the host sets no shell, which is also what a login spawn then runs', async () => {
    const rig = makeRig({});
    await settle();
    const info = await ask(rig.link.requestHelper('hostInfo', {}));
    expect(info.shellPath).toBe('/bin/sh');
    expect(info.shellName).toBe('sh');
  });
});

describe('files on the host', () => {
  it('writes files beneath the home folder, making their folders, with the mode asked', async () => {
    const rig = makeRig();
    await settle();
    const script = path.join(home, '.kangentic', 'sessions', 's1', 'bridge.sh');
    const settings = path.join(home, '.kangentic', 'sessions', 's1', 'settings.json');
    const answer = ask(rig.link.requestHelper('writeFiles', { files: [
      { path: script, content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
      { path: settings, content: '{"hooks":{}}' },
    ] }));
    expect(await answer).toEqual({ written: 2 });
    expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"hooks":{}}');
    if (process.platform !== 'win32') {
      expect(fs.statSync(script).mode & 0o777).toBe(0o755);
      expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(path.dirname(script)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing file whole', async () => {
    const rig = makeRig();
    await settle();
    const target = path.join(home, 'config.json');
    fs.writeFileSync(target, 'old and much longer than the new text');
    await ask(rig.link.requestHelper('writeFiles', { files: [{ path: target, content: 'new' }] }));
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('leaves a file alone whose text is not what the write expected, and says which', async () => {
    const rig = makeRig();
    await settle();
    const changed = path.join(home, 'changed.json');
    const fine = path.join(home, 'fine.json');
    const absent = path.join(home, 'absent.json');
    fs.writeFileSync(changed, '{"user":"edit"}');
    fs.writeFileSync(fine, '{"v":1}');
    fs.writeFileSync(absent, 'someone made this');

    const answer = await ask(rig.link.requestHelper('writeFiles', { files: [
      { path: changed, content: 'ours', expect: '{"v":1}' },
      { path: fine, content: 'ours', expect: '{"v":1}' },
      { path: absent, content: 'ours', expect: null },
    ] }));

    expect(answer).toEqual({ written: 1, conflicts: [changed, absent] });
    expect(fs.readFileSync(changed, 'utf8')).toBe('{"user":"edit"}');
    expect(fs.readFileSync(fine, 'utf8')).toBe('ours');
    expect(fs.readFileSync(absent, 'utf8')).toBe('someone made this');
    expect(fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes a file only while it holds the text the removal expected, and lists one that changed', async () => {
    const rig = makeRig();
    await settle();
    const changed = path.join(home, 'changed.json');
    const unchanged = path.join(home, 'unchanged.json');
    const unguarded = path.join(home, 'unguarded.json');
    fs.writeFileSync(changed, '{"user":"edit"}');
    fs.writeFileSync(unchanged, '{"v":1}');
    fs.writeFileSync(unguarded, 'anything');

    const answer = await ask(rig.link.requestHelper('removeFiles', {
      paths: [changed, unchanged, unguarded],
      expect: { [changed]: '{"v":1}', [unchanged]: '{"v":1}' },
    }));

    expect(answer).toEqual({ removed: 2, conflicts: [changed] });
    expect(fs.readFileSync(changed, 'utf8')).toBe('{"user":"edit"}');
    expect(fs.existsSync(unchanged)).toBe(false);
    expect(fs.existsSync(unguarded)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps the permissions a file had when asked, and a symlink stays a symlink', async () => {
    const rig = makeRig();
    await settle();
    const private_ = path.join(home, 'mine.json');
    fs.writeFileSync(private_, 'old', { mode: 0o600 });
    const real = path.join(home, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, 'old');
    const link = path.join(home, 'settings.json');
    fs.symlinkSync(real, link);

    await ask(rig.link.requestHelper('writeFiles', { files: [
      { path: private_, content: 'new', mode: 0o644, keepExistingMode: true },
      { path: link, content: 'new' },
    ] }));

    expect(fs.statSync(private_).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')('keeps a symlink a symlink when the home itself is reached through a symlinked folder', async () => {
    // The home as named is a link to a real folder, so every real path lies outside it as named.
    const realFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-helper-real-')));
    const linkedHome = path.join(os.tmpdir(), `kangentic-helper-linked-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realFolder, linkedHome, 'dir');
    teardown.push(() => fs.rmSync(realFolder, { recursive: true, force: true }), () => fs.rmSync(linkedHome, { force: true }));
    // The temp home beforeEach made stays removable: afterEach removes `ownedHome`, not the linked one.
    ownedHomes.push(home);
    home = linkedHome;
    const rig = makeRig();
    await settle();
    const target = path.join(realFolder, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old');
    const link = path.join(linkedHome, 'settings.json');
    fs.symlinkSync(path.join(linkedHome, 'dotfiles', 'settings.json'), link);

    await ask(rig.link.requestHelper('writeFiles', { files: [{ path: link, content: 'new' }] }));

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('accepts a child of the home whose name starts with two dots, and still refuses a path that climbs out', async () => {
    const rig = makeRig();
    await settle();
    const dotted = path.join(home, '..cache', 'x');
    expect(await ask(rig.link.requestHelper('writeFiles', { files: [{ path: dotted, content: 'kept' }] }))).toEqual({ written: 1 });
    expect(fs.readFileSync(dotted, 'utf8')).toBe('kept');

    const climb = path.join(home, '..', `kangentic-climb-dots-${process.pid}.txt`);
    const attempt = rig.link.requestHelper('writeFiles', { files: [{ path: climb, content: 'x' }] });
    const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
    await settle();
    await rejected;
    expect(fs.existsSync(climb)).toBe(false);
  });

  it('reads a file, and says so when it is not there', async () => {
    const rig = makeRig();
    await settle();
    const present = path.join(home, 'there.json');
    fs.writeFileSync(present, 'hello');
    expect(await ask(rig.link.requestHelper('readFile', { path: present }))).toEqual({ exists: true, content: 'hello' });
    expect(await ask(rig.link.requestHelper('readFile', { path: path.join(home, 'missing.json') }))).toEqual({ exists: false, content: null });
  });

  it('answers present or absent for each path, in order', async () => {
    const rig = makeRig();
    await settle();
    const present = path.join(home, 'a');
    fs.writeFileSync(present, '');
    const answer = await ask(rig.link.requestHelper('pathPresence', { paths: [present, path.join(home, 'b'), present] }));
    expect(answer).toEqual(['present', 'absent', 'present']);
  });

  it('refuses a path outside the home folder, a relative one, and one that climbs out, touching nothing', async () => {
    const rig = makeRig();
    await settle();
    const outside = path.join(os.tmpdir(), `kangentic-outside-${process.pid}.txt`);
    for (const bad of [outside, 'relative.txt', path.join(home, '..', `kangentic-climb-${process.pid}.txt`)]) {
      const attempt = rig.link.requestHelper('writeFiles', { files: [{ path: bad, content: 'x' }] });
      const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
      await settle();
      await rejected;
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(home, '..', `kangentic-climb-${process.pid}.txt`))).toBe(false);
  });

  it('removes files the app wrote, counts what it removed, and does not mind one that is already gone', async () => {
    const rig = makeRig();
    await settle();
    const first = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, '{}');
    const answer = await ask(rig.link.requestHelper('removeFiles', { paths: [first, path.join(home, 'never-there.json')] }));
    expect(answer).toEqual({ removed: 1 });
    expect(fs.existsSync(first)).toBe(false);
    // Only the file goes: the folder a CLI may have made stays.
    expect(fs.existsSync(path.dirname(first))).toBe(true);
  });

  it('refuses to remove a folder or anything outside the home, removing nothing it was also asked to', async () => {
    const rig = makeRig();
    await settle();
    const keep = path.join(home, 'keep.json');
    fs.writeFileSync(keep, '{}');
    const folder = path.join(home, 'a-folder');
    fs.mkdirSync(folder);
    const outside = path.join(os.tmpdir(), `kangentic-outside-remove-${process.pid}.txt`);
    fs.writeFileSync(outside, 'x');
    try {
      const outsideAttempt = rig.link.requestHelper('removeFiles', { paths: [keep, outside] });
      const outsideRejected = expect(outsideAttempt).rejects.toThrow('not inside the home folder');
      await settle();
      await outsideRejected;
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);

      const folderAttempt = rig.link.requestHelper('removeFiles', { paths: [folder] });
      const folderRejected = expect(folderAttempt).rejects.toThrow('is a folder');
      await settle();
      await folderRejected;
      expect(fs.existsSync(folder)).toBe(true);

      // The folder comes after a file that could be removed: every target is checked before the first unlink.
      const laterFolderAttempt = rig.link.requestHelper('removeFiles', { paths: [keep, folder] });
      const laterFolderRejected = expect(laterFolderAttempt).rejects.toThrow('is a folder');
      await settle();
      await laterFolderRejected;
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.existsSync(folder)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('keeps a file that changed since the app wrote it, and lists it as a conflict, through RemoteHostService', async () => {
    const rig = makeRig();
    await settle();
    const service = new RemoteHostService({
      sshPath: 'ssh',
      hosts: { getById: () => undefined, list: () => [] },
      send: async (request) => {
        if (request.op !== 'helper') throw new Error(`unexpected operation ${request.op}`);
        return rig.link.requestHelper(request.method, request.params as never);
      },
      asset: () => null,
      identity: { installId: 'install-a', label: 'a test computer' },
    });
    const changed = path.join(home, 'changed.json');
    const untouched = path.join(home, 'untouched.json');
    fs.writeFileSync(changed, 'someone else edited this');
    fs.writeFileSync(untouched, 'old');

    const pending = service.removeFiles('host-a', [changed, untouched], { [changed]: 'old', [untouched]: 'old' });
    await settle();
    const answer = await pending;

    expect(answer).toEqual({ removed: 1, conflicts: [changed] });
    expect(fs.readFileSync(changed, 'utf8')).toBe('someone else edited this');
    expect(fs.existsSync(untouched)).toBe(false);
  });

  it('removes folders that hold nothing and leaves one with something in it, or not there, alone', async () => {
    const rig = await makeRig();
    await settle();
    const empty = path.join(home, 'a', 'b');
    const full = path.join(home, 'c');
    fs.mkdirSync(empty, { recursive: true });
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'keep.txt'), 'x');

    const answer = await ask(rig.link.requestHelper('removeEmptyDirectories', { paths: [empty, path.join(home, 'a'), full, path.join(home, 'gone')] }));

    expect(answer).toEqual({ removed: 2 });
    expect(fs.existsSync(path.join(home, 'a'))).toBe(false);
    expect(fs.existsSync(path.join(full, 'keep.txt'))).toBe(true);
  });

  it('refuses to run a program in a folder outside the home', async () => {
    const rig = makeRig();
    await settle();
    const attempt = rig.link.requestHelper('runCommand', { file: 'true', args: [], cwd: os.tmpdir(), timeoutMs: 1000 });
    const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
    await settle();
    await rejected;
  });

  it('does not call a path absent when it cannot look, and refuses to look outside home', async () => {
    const rig = makeRig();
    await settle();
    const attempt = rig.link.requestHelper('pathPresence', { paths: [path.join(os.tmpdir(), 'elsewhere')] });
    const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
    await settle();
    await rejected;
  });

  // The relay reads each file's total from this answer. Without it a watched file whose size the relay
  // cannot learn reads as empty, and a copy that is stale reads as whole.
  it('answers the size of each watched file that exists, and no entry for one that does not', async () => {
    const rig = makeRig();
    await settle();
    const present = path.join(home, 'transcript.jsonl');
    const missing = path.join(home, 'not-yet.jsonl');
    fs.writeFileSync(present, 'twelve bytes');

    const answer = await ask(rig.link.requestHelper('watchFiles', { sessionId: 's1', files: [
      { key: '0', path: present },
      { key: '1', path: missing },
    ] }));

    expect(answer.sizes).toEqual({ '0': 12 });
    expect(Object.keys(answer.sizes ?? {})).not.toContain('1');
  });

  it.each([
    ['a path outside the home', () => '/etc/hostname'],
    ['a path that climbs out of the home', () => path.join(home, '..', 'x')],
  ])('refuses to tail %s, so a host file outside home is never copied', async (_name, makePath) => {
    const rig = makeRig();
    await settle();
    const attempt = rig.link.requestHelper('watchFiles', { sessionId: 's1', files: [{ key: '0', path: makePath() }] });
    const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
    await settle();
    await rejected;
  });

  it('refuses a search whose directory is outside the home, like any other path', async () => {
    const rig = makeRig();
    await settle();
    const attempt = rig.link.requestHelper('watchFiles', {
      sessionId: 's1',
      files: [],
      searches: [{ key: 'found', directory: '/etc', depth: 2, fileName: 'rollout.jsonl' }],
    });
    const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
    await settle();
    await rejected;
  });

  it('accepts a search beneath the home and answers that it is searching', async () => {
    const rig = makeRig();
    await settle();
    const answer = await ask(rig.link.requestHelper('watchFiles', {
      sessionId: 's1',
      files: [],
      searches: [{ key: 'found', directory: home, depth: 2, fileName: 'rollout.jsonl' }],
    }));
    expect(answer.searching).toBe(true);
  });
});
