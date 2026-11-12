/**
 * The file jobs of the helper, asked over the real link (#913): large single files by the frame's raw
 * part, the guard that keeps an oversize request from ending the connection, empty folders, a JSON
 * patch, and a session's hook files reaching the app before that session's exit. Real timers, real
 * files, the real client, link and helper over an in-memory stream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import { dialHelper, makeHelperRig, spawnParams, type HelperRig } from './helpers/remote-link-rig';

let home: string;
const teardown: Array<() => void> = [];

interface Rig {
  helperRig: HelperRig;
  link: RemoteLink;
  events: PtyHostEvent[];
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeRig(): Promise<Rig> {
  const helperRig = makeHelperRig(1, { homeDirectory: home, baseEnv: { SHELL: '/bin/bash' } });
  const link = new RemoteLink({
    identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
    connect: async () => dialHelper(helperRig),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  const events: PtyHostEvent[] = [];
  link.setEventListener((event) => events.push(event));
  link.start();
  teardown.push(() => link.stop(), () => helperRig.helper.dispose());
  await link.requestHelper('hostInfo', {});
  return { helperRig, link, events };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-hook-relay-'));
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a file too large for the JSON body', () => {
  it('rides the raw part and arrives whole', async () => {
    const rig = await makeRig();
    const target = path.join(home, 'answer.res');
    const content = JSON.stringify({ result: 'x'.repeat(600_000) });

    const answer = await rig.link.requestHelperRaw('writeFileRaw', { path: target }, Buffer.from(content, 'utf8'));

    expect(answer).toEqual({ written: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
  });

  it('is refused above the raw cap, with a sentence, and the link goes on working', async () => {
    const rig = await makeRig();

    await expect(rig.link.requestHelperRaw('writeFileRaw', { path: path.join(home, 'big') }, Buffer.alloc(1_100_000, 97)))
      .rejects.toThrow('carries too much data');

    expect(await rig.link.requestHelper('hostInfo', {})).toMatchObject({ shellName: 'bash' });
  });
});

describe('a request too large for one frame', () => {
  it('is refused before it is sent, so it cannot end the connection or be replayed into the same failure', async () => {
    const rig = await makeRig();

    await expect(rig.link.requestHelper('writeFiles', { files: [{ path: path.join(home, 'big.json'), content: 'x'.repeat(300_000) }] }))
      .rejects.toThrow('too large to send');

    expect(await rig.link.requestHelper('hostInfo', {})).toMatchObject({ shellName: 'bash' });
    expect(fs.existsSync(path.join(home, 'big.json'))).toBe(false);
  });
});

describe('writeFiles directories', () => {
  it('makes a folder that holds no file of its own, such as the hook folder a script publishes into', async () => {
    const rig = await makeRig();
    const hooks = path.join(home, 'project', '.kangentic', 'sessions', 's1', 'wsl-hooks');

    await rig.link.requestHelper('writeFiles', {
      files: [{ path: path.join(hooks, 'wsl-hook.sh'), content: '#!/bin/sh\n', mode: 0o755 }],
      directories: [path.join(hooks, 'inbox'), path.join(hooks, 'requests'), path.join(hooks, 'responses')],
    });

    for (const folder of ['inbox', 'requests', 'responses']) expect(fs.statSync(path.join(hooks, folder)).isDirectory()).toBe(true);
  });

  it('refuses a folder outside home before making any of them', async () => {
    const rig = await makeRig();
    const outside = path.join(os.tmpdir(), `kangentic-outside-dir-${process.pid}`);

    await expect(rig.link.requestHelper('writeFiles', {
      files: [{ path: path.join(home, 'ok.txt'), content: 'x' }],
      directories: [path.join(home, 'fine'), outside],
    })).rejects.toThrow('not inside the home folder');

    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(home, 'fine'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'ok.txt'))).toBe(false);
  });
});

describe('jsonPatch', () => {
  it('edits a file under home through the link, and refuses one outside it', async () => {
    const rig = await makeRig();
    const target = path.join(home, '.claude.json');

    const result = await rig.link.requestHelper('jsonPatch', { path: target, ops: [{ op: 'set', at: ['diffSidebarOpen'], value: false }] });

    expect(result).toEqual({ applied: true, changed: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ diffSidebarOpen: false });
    await expect(rig.link.requestHelper('jsonPatch', { path: path.join(os.tmpdir(), 'x.json'), ops: [] })).rejects.toThrow('not inside the home folder');
  });
});

describe('a session\'s hook files', () => {
  async function startSession(rig: Rig) {
    const hooks = path.join(home, 'project', '.kangentic', 'sessions', 's1', 'wsl-hooks');
    await rig.link.requestHelper('writeFiles', { files: [], directories: [path.join(hooks, 'inbox'), path.join(hooks, 'requests')] });
    await rig.link.requestHelper('watchHooks', { sessionId: 's1', directory: hooks });
    await rig.link.request('spawn', { ...spawnParams('s1', 'task-1'), ptyId: 1, sentAtMs: Date.now() });
    return hooks;
  }

  it('arrive as events, once, as the CLI publishes them', async () => {
    const rig = await makeRig();
    const hooks = await startSession(rig);

    fs.writeFileSync(path.join(hooks, 'inbox', '1000000000000000000-10.rec'), 'K1\ntool_start\n\n{"tool_name":"Read"}');
    await waitFor(() => rig.events.some((event) => event.type === 'hookFile'));

    const files = rig.events.filter((event): event is Extract<PtyHostEvent, { type: 'hookFile' }> => event.type === 'hookFile');
    // Marked for claiming: it stays on the host until Kangentic has stored it and says so.
    expect(files).toEqual([{ type: 'hookFile', sessionId: 's1', folder: 'inbox', name: '1000000000000000000-10.rec', content: 'K1\ntool_start\n\n{"tool_name":"Read"}', claim: true }]);
  });

  it('are all delivered before the session\'s exit, including one published as the CLI exited', async () => {
    const rig = await makeRig();
    const hooks = await startSession(rig);

    fs.writeFileSync(path.join(hooks, 'inbox', '1000000000000000000-10.rec'), 'K1\nsession_end\n\n{}');
    rig.helperRig.fakes[0].exit(0);
    await waitFor(() => rig.events.some((event) => event.type === 'exit'));

    const order = rig.events.filter((event) => event.type === 'hookFile' || event.type === 'exit').map((event) => event.type);
    expect(order).toEqual(['hookFile', 'exit']);
  });

  it('stop being watched when asked, after sending what is published', async () => {
    const rig = await makeRig();
    const hooks = await startSession(rig);
    fs.writeFileSync(path.join(hooks, 'requests', '1000000000000000000-11.req'), 'K1\nplan-approval\nspec\n{}');

    const answer = await rig.link.requestHelper('unwatchHooks', { sessionId: 's1' });

    expect(answer).toEqual({ watching: false });
    await waitFor(() => rig.events.some((event) => event.type === 'hookFile'));
    fs.writeFileSync(path.join(hooks, 'inbox', '1000000000000000000-12.rec'), 'K1\nlate\n\n{}');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rig.events.filter((event) => event.type === 'hookFile')).toHaveLength(1);
  });
});
