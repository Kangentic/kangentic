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
import { dialHelper, makeHelperRig, settle, spawnParams, type HelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let home: string;

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-helper-home-'));
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
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
    expect(args).toEqual(['-l']);
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

  it('does not call a path absent when it cannot look, and refuses to look outside home', async () => {
    const rig = makeRig();
    await settle();
    const attempt = rig.link.requestHelper('pathPresence', { paths: [path.join(os.tmpdir(), 'elsewhere')] });
    const rejected = expect(attempt).rejects.toThrow('not inside the home folder');
    await settle();
    await rejected;
  });
});
