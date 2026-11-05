/**
 * A remote agent's session folder kept in step with this computer's (#913), end to end without a real
 * host: the real helper and link over an in-memory stream, the real relay, and the real hook inbox
 * (the WSL transport's reader) on this side. Where a POSIX `sh` exists the host's hook script is the
 * real one, run by it, so a hook publishes, the helper carries the file, the inbox turns it into an
 * event, and an answer travels back to the script that waits for it.
 *
 * What a user loses if it breaks: an agent on a host that shows no activity, a plan approval that
 * never reaches the agent, MCP tools that time out, or a host able to write where it should not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { RemoteSessionRelay, type RemoteSessionFiles } from '../../src/main/remote/remote-session-relay';
import { WslHookInbox } from '../../src/main/pty/readers/wsl-hook-inbox';
import { prepareWslHookTransport, wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { dialHelper, makeHelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let scratch: string;
let shellFolder: string;
let hostHome: string;
let hostProject: string;

const hasSh = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface Rig {
  relay: RemoteSessionRelay;
  link: RemoteLink;
  place: SshCliPlace;
  localSession: string;
  hostSession: string;
  eventsPath: string;
  statusPath: string;
  inbox: WslHookInbox;
  mcpCalls: string[];
}

async function makeRig(options: { extraFiles?: Record<string, string>; declareExtra?: string[]; bare?: boolean; failWatch?: boolean; transcriptFiles?: string[] } = {}): Promise<Rig> {
  const helperRig = makeHelperRig(1, { homeDirectory: hostHome, baseEnv: { SHELL: '/bin/sh' } });
  const link = new RemoteLink({
    identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
    connect: async () => dialHelper(helperRig),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  link.start();
  await link.requestHelper('hostInfo', {});

  const files: RemoteSessionFiles = {
    writeFiles: (_hostId, fileList, directories) => link.requestHelper('writeFiles', { files: fileList, ...(directories ? { directories } : {}) }),
    writeFileRaw: (_hostId, filePath, content, mode) => link.requestHelperRaw('writeFileRaw', { path: filePath, ...(mode === undefined ? {} : { mode }) }, Buffer.from(content, 'utf8')),
    watchHooks: (_hostId, sessionId, directory, statusFile) => (options.failWatch
      ? Promise.reject(new Error('the host could not watch the folder'))
      : link.requestHelper('watchHooks', { sessionId, directory, ...(statusFile ? { statusFile } : {}) })),
    unwatchHooks: (_hostId, sessionId) => link.requestHelper('unwatchHooks', { sessionId }),
    watchFiles: (_hostId, sessionId, tailed) => link.requestHelper('watchFiles', { sessionId, files: tailed }),
    unwatchFiles: (_hostId, sessionId) => link.requestHelper('unwatchFiles', { sessionId }),
    removeFiles: (_hostId, paths) => link.requestHelper('removeFiles', { paths }),
    removeEmptyDirectories: (_hostId, paths) => link.requestHelper('removeEmptyDirectories', { paths }),
  };
  const relay = new RemoteSessionRelay({ files });
  link.setEventListener((event) => {
    if (event.type === 'hookFile') relay.deliver(event);
    if (event.type === 'fileChunk') relay.deliverChunk(event);
  });

  const place: SshCliPlace = {
    kind: 'ssh',
    hostId: 'host-a',
    home: hostHome,
    shellName: 'sh',
    localHome: path.join(scratch, 'mirror'),
    roots: [{ local: shellFolder, host: hostProject.replace(/\\/g, '/') }],
  };
  const localSession = path.join(shellFolder, '.kangentic', 'sessions', 's1');
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  fs.writeFileSync(path.join(localSession, 'settings.json'), '{"hooks":{}}');
  fs.writeFileSync(path.join(localSession, 'mcp.json'), '{"mcpServers":{}}');
  const eventsPath = path.join(localSession, 'events.jsonl');
  const statusPath = path.join(localSession, 'status.json');
  fs.writeFileSync(eventsPath, '');

  const mcpCalls: string[] = [];
  const inbox = new WslHookInbox({
    sessionDirectory: localSession,
    eventsOutputPath: eventsPath,
    onAppended: () => undefined,
    relayMcp: async (input) => {
      mcpCalls.push(`${input.argument}|${input.body}`);
      return '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
    },
  });
  inbox.start();

  if (options.bare) {
    // An agent with no settings, no MCP config and no hook script: nothing to push, but the hook folders are still made.
    fs.rmSync(path.join(localSession, 'settings.json'));
    fs.rmSync(path.join(localSession, 'mcp.json'));
    fs.rmSync(wslHookPaths(localSession).script);
  }
  for (const [relative, content] of Object.entries(options.extraFiles ?? {})) {
    const target = path.join(localSession, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  teardown.push(() => inbox.close(), () => relay.dispose(), () => link.stop(), () => helperRig.helper.dispose());
  await relay.register({
    hostId: 'host-a',
    sessionId: 's1',
    place,
    localSessionDirectory: localSession,
    statusOutputPath: statusPath,
    ...(options.declareExtra ? { extraFiles: options.declareExtra } : {}),
    ...(options.transcriptFiles ? { transcriptFiles: options.transcriptFiles } : {}),
  });
  const hostSession = path.join(hostProject, '.kangentic', 'sessions', 's1');
  return { relay, link, place, localSession, hostSession, eventsPath, statusPath, inbox, mcpCalls };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-session-relay-'));
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

describe('registering a session', () => {
  it('pushes what the builder wrote to the matching folder on the host, and makes the hook folders there', async () => {
    const rig = await makeRig();

    expect(fs.readFileSync(path.join(rig.hostSession, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    expect(fs.readFileSync(path.join(rig.hostSession, 'mcp.json'), 'utf8')).toBe('{"mcpServers":{}}');
    expect(fs.readFileSync(path.join(rig.hostSession, 'wsl-hooks', 'wsl-hook.sh'), 'utf8')).toBe(fs.readFileSync(wslHookPaths(rig.localSession).script, 'utf8'));
    for (const folder of ['inbox', 'requests', 'responses']) expect(fs.statSync(path.join(rig.hostSession, 'wsl-hooks', folder)).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(rig.hostSession, 'wsl-hooks', 'wsl-hook.sh')).mode & 0o777).toBe(0o755);
  });

  it('also sends the extra session files an agent names, such as Copilot\'s config folder, and skips one it did not write', async () => {
    const rig = await makeRig({
      extraFiles: { 'copilot-config/config.json': '{"account":1}', 'copilot-config/hooks/kangentic.json': '{"hooks":[]}' },
      declareExtra: ['copilot-config/config.json', 'copilot-config/hooks/kangentic.json', 'copilot-mcp.json'],
    });

    expect(fs.readFileSync(path.join(rig.hostSession, 'copilot-config', 'config.json'), 'utf8')).toBe('{"account":1}');
    expect(fs.readFileSync(path.join(rig.hostSession, 'copilot-config', 'hooks', 'kangentic.json'), 'utf8')).toBe('{"hooks":[]}');
    expect(fs.existsSync(path.join(rig.hostSession, 'copilot-mcp.json'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(rig.hostSession, 'copilot-config', 'config.json')).mode & 0o777).toBe(0o600);
  });

  it.each(['../escape.json', '/etc/passwd', 'a\\b', 'a//b', ''])('refuses an extra file named %j, so an agent cannot reach outside the session folder', async (name) => {
    await expect(makeRig({ declareExtra: [name] })).rejects.toThrow(/not a plain path/);
    expect(fs.existsSync(path.join(hostProject, '..', 'escape.json'))).toBe(false);
  });

  it('takes back what it pushed when the host cannot start watching, so the MCP config with the token is not left behind', async () => {
    await expect(makeRig({ failWatch: true })).rejects.toThrow(/could not watch/);

    const hostSession = path.join(hostProject, '.kangentic', 'sessions', 's1');
    expect(fs.existsSync(path.join(hostSession, 'mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(hostSession, 'settings.json'))).toBe(false);
  });

  it('writes nothing outside the host project\'s folder and the home', async () => {
    await makeRig();
    expect(fs.readdirSync(hostHome).sort()).toEqual(['projects']);
  });
});

describe('what the host publishes', () => {
  it('becomes an event in this session\'s events file, through the real inbox', async () => {
    const rig = await makeRig();

    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox', '1700000000000000000-4242.rec'), 'K1\nidle\n\n{}');

    await waitFor(() => fs.readFileSync(rig.eventsPath, 'utf8').trim().length > 0);
    expect(fs.readFileSync(rig.eventsPath, 'utf8')).toContain('"idle"');
    // Taken from the inbox here, and removed from the host once sent.
    await waitFor(() => fs.readdirSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox')).length === 0);
  });

  it('updates the status file when the status line writes it', async () => {
    const rig = await makeRig();

    fs.writeFileSync(path.join(rig.hostSession, 'status.json'), '{"model":{"id":"m"}}');

    await waitFor(() => fs.existsSync(rig.statusPath));
    expect(fs.readFileSync(rig.statusPath, 'utf8')).toBe('{"model":{"id":"m"}}');
  });

  it('refuses a file whose name is not one the hook script writes, so a host picks no path on this disk', async () => {
    const rig = await makeRig();

    await rig.relay.deliver({ type: 'hookFile', sessionId: 's1', folder: 'inbox', name: '..\\..\\evil.rec', content: 'x' });
    await rig.relay.deliver({ type: 'hookFile', sessionId: 's1', folder: 'inbox', name: '../evil.rec', content: 'x' });
    await rig.relay.deliver({ type: 'hookFile', sessionId: 's1', folder: 'requests', name: 'evil.req', content: 'x' });
    await rig.relay.deliver({ type: 'hookFile', sessionId: 's1', folder: 'status', name: 'other.json', content: 'x' });
    await rig.relay.deliver({ type: 'hookFile', sessionId: 'unknown-session', folder: 'inbox', name: '1700000000000000000-1.rec', content: 'x' });

    expect(fs.readdirSync(wslHookPaths(rig.localSession).inbox)).toEqual([]);
    expect(fs.readdirSync(wslHookPaths(rig.localSession).requests)).toEqual([]);
    expect(fs.existsSync(path.join(shellFolder, 'evil.rec'))).toBe(false);
    expect(fs.existsSync(rig.statusPath)).toBe(false);
  });
});

describe('an MCP message from the host', () => {
  it('is relayed here, with the token and URL from this computer, and its answer returns to the host', async () => {
    const rig = await makeRig();
    const request = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'requests', '1700000000000000000-77.req'), `K1\nmcp\ntoken-from-env http://127.0.0.1:1/mcp\n${request}`);

    await waitFor(() => fs.existsSync(path.join(rig.hostSession, 'wsl-hooks', 'responses', '1700000000000000000-77.res')));
    expect(fs.readFileSync(path.join(rig.hostSession, 'wsl-hooks', 'responses', '1700000000000000000-77.res'), 'utf8')).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(rig.mcpCalls).toEqual([`token-from-env http://127.0.0.1:1/mcp|${request}`]);
    // The answer is removed here once the host has it.
    await waitFor(() => fs.readdirSync(wslHookPaths(rig.localSession).responses).length === 0);
  });

  it('sends an answer too large for a request body by the frame\'s raw part', async () => {
    const rig = await makeRig();
    const big = JSON.stringify({ result: 'z'.repeat(400_000) });
    fs.writeFileSync(path.join(wslHookPaths(rig.localSession).responses, '1700000000000000000-88.res'), big);

    await waitFor(() => fs.existsSync(path.join(rig.hostSession, 'wsl-hooks', 'responses', '1700000000000000000-88.res')));
    await waitFor(() => fs.statSync(path.join(rig.hostSession, 'wsl-hooks', 'responses', '1700000000000000000-88.res')).size === big.length);
    expect(fs.readFileSync(path.join(rig.hostSession, 'wsl-hooks', 'responses', '1700000000000000000-88.res'), 'utf8')).toBe(big);
  });
});

describe('releasing a session', () => {
  it('stops the host\'s watching, after the records already published reached this computer', async () => {
    const rig = await makeRig();
    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox', '1700000000000000000-5.rec'), 'K1\nidle\n\n{}');

    await rig.relay.release('s1');

    await waitFor(() => fs.readFileSync(rig.eventsPath, 'utf8').includes('"idle"'));
    expect(rig.relay.has('s1')).toBe(false);
    // A hook that runs after the release finds the folder gone, so the folder is made again to publish into it.
    fs.mkdirSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox', '1700000000000000000-6.rec'), 'K1\nlate\n\n{}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.readFileSync(rig.eventsPath, 'utf8')).not.toContain('late');
  });

  it('takes the files it pushed off the host, the MCP config that holds the token included, and leaves the host\'s own', async () => {
    const rig = await makeRig({
      extraFiles: { 'copilot-config/config.json': '{}' },
      declareExtra: ['copilot-config/config.json'],
    });
    const hostOwn = path.join(hostProject, 'package.json');
    fs.writeFileSync(hostOwn, '{}');
    expect(fs.existsSync(path.join(rig.hostSession, 'mcp.json'))).toBe(true);

    await rig.relay.release('s1');

    for (const name of ['settings.json', 'mcp.json', path.join('copilot-config', 'config.json'), path.join('wsl-hooks', 'wsl-hook.sh')]) {
      expect(fs.existsSync(path.join(rig.hostSession, name))).toBe(false);
    }
    expect(fs.existsSync(hostOwn)).toBe(true);
  });

  it('removes the hook folders of a session that pushed no files at all, as an agent with no hook script does', async () => {
    const rig = await makeRig({ bare: true });
    expect(fs.existsSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox'))).toBe(true);

    await rig.relay.release('s1');

    expect(fs.existsSync(path.join(rig.hostSession, 'wsl-hooks'))).toBe(false);
  });

  it('leaves no folder behind for the session either, but never a folder with something of the host\'s in it', async () => {
    const rig = await makeRig({
      extraFiles: { 'copilot-config/config.json': '{}' },
      declareExtra: ['copilot-config/config.json'],
    });
    // The hook script's own marker, which the relay did not push.
    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'signal'), 'x');
    await rig.relay.release('s1');
    expect(fs.existsSync(rig.hostSession)).toBe(false);

    const second = await makeRig();
    const keep = path.join(second.hostSession, 'notes.txt');
    fs.writeFileSync(keep, 'the host\'s own');
    await second.relay.release('s1');
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(path.join(second.hostSession, 'wsl-hooks'))).toBe(false);
  });
});

describe.runIf(hasSh)('with the real hook script, run by sh on the host', () => {
  function runScript(rig: Rig, args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
    const script = path.join(rig.hostSession, 'wsl-hooks', 'wsl-hook.sh');
    return new Promise((resolve, reject) => {
      const child = spawn('sh', [script, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(stdin);
    });
  }

  it('turns a hook call into an event on this side', async () => {
    const rig = await makeRig();

    const result = await runScript(rig, ['event', 'idle'], '{}');

    expect(result.code).toBe(0);
    await waitFor(() => fs.readFileSync(rig.eventsPath, 'utf8').includes('"idle"'));
  });

  it('answers an MCP message the script is waiting on, through this computer\'s server', async () => {
    const rig = await makeRig();

    const result = await runScript(rig, ['mcp', 'http://127.0.0.1:1/mcp'], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(rig.mcpCalls).toHaveLength(1);
  });

  it('carries the status line over the host\'s status file', async () => {
    const rig = await makeRig();
    const target = path.join(rig.hostSession, 'status.json').replace(/\\/g, '/');

    await runScript(rig, ['status', target], '{"context":{"used":10}}');

    await waitFor(() => fs.existsSync(rig.statusPath));
    expect(fs.readFileSync(rig.statusPath, 'utf8')).toBe('{"context":{"used":10}}');
  });
});

/** An in-memory host behind the relay's file jobs, whose calls a test can hold open to line up a race. */
function makeFakeHost() {
  const written = new Map<string, string>();
  const watching = new Set<string>();
  const rawWrites: Array<{ path: string; content: string }> = [];
  const jsonWrites: string[] = [];
  const writeGates: Array<{ release(): void; promise: Promise<void> }> = [];
  const gate = (): { release(): void; promise: Promise<void> } => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { release, promise };
  };
  const state = {
    holdWrites: false,
    holdUnwatch: null as null | { release(): void; promise: Promise<void> },
    writeCalls: 0,
    /** The next `watchFiles` rejects, as when the host started tailing but its answer was lost. */
    rejectNextWatchFiles: false,
    unwatchFilesCalls: 0,
  };
  const files: RemoteSessionFiles = {
    writeFiles: async (_hostId, fileList) => {
      state.writeCalls += 1;
      const contents = fileList.map((file) => ({ path: file.path, content: file.content }));
      if (state.holdWrites) {
        const held = gate();
        writeGates.push(held);
        await held.promise;
      }
      for (const file of contents) {
        written.set(file.path, file.content);
        jsonWrites.push(file.path);
      }
    },
    writeFileRaw: async (_hostId, filePath, content) => { rawWrites.push({ path: filePath, content }); },
    watchHooks: async (_hostId, sessionId) => { watching.add(sessionId); },
    unwatchHooks: async (_hostId, sessionId) => {
      if (state.holdUnwatch) await state.holdUnwatch.promise;
      watching.delete(sessionId);
    },
    watchFiles: async () => {
      if (state.rejectNextWatchFiles) {
        state.rejectNextWatchFiles = false;
        throw new Error('the answer was lost');
      }
      return { watching: true };
    },
    unwatchFiles: async () => {
      state.unwatchFilesCalls += 1;
      return { watching: false };
    },
    removeFiles: async (_hostId, paths) => { for (const removed of paths) written.delete(removed); },
    removeEmptyDirectories: async () => undefined,
  };
  return { files, written, watching, rawWrites, jsonWrites, writeGates, state, gate };
}

describe('a session registered and released while another operation on its id is running', () => {
  function registrationFor(): { registration: Parameters<RemoteSessionRelay['register']>[0]; settingsPath: string } {
    const localSession = path.join(shellFolder, '.kangentic', 'sessions', 's1');
    fs.mkdirSync(localSession, { recursive: true });
    prepareWslHookTransport(localSession);
    fs.writeFileSync(path.join(localSession, 'settings.json'), '{"version":1}');
    const place: SshCliPlace = {
      kind: 'ssh',
      hostId: 'host-a',
      home: '/home/dev',
      shellName: 'sh',
      localHome: path.join(scratch, 'mirror'),
      roots: [{ local: shellFolder, host: '/home/dev/project' }],
    };
    return {
      registration: { hostId: 'host-a', sessionId: 's1', place, localSessionDirectory: localSession, statusOutputPath: path.join(localSession, 'status.json') },
      settingsPath: '/home/dev/project/.kangentic/sessions/s1/settings.json',
    };
  }

  function makeRelay() {
    const host = makeFakeHost();
    const relay = new RemoteSessionRelay({ files: host.files });
    teardown.push(() => relay.dispose());
    return { host, relay };
  }

  it('makes a register of the same id wait for a slow release, and keeps the files the register pushed', async () => {
    const { host, relay } = makeRelay();
    const { registration, settingsPath } = registrationFor();
    await relay.register(registration);
    expect(host.written.has(settingsPath)).toBe(true);

    const slowUnwatch = host.gate();
    host.state.holdUnwatch = slowUnwatch;
    const writesBefore = host.state.writeCalls;
    const firstRelease = relay.release('s1');
    const repeatRelease = relay.release('s1');
    const reRegister = relay.register(registration);
    // Negative assertion: nothing can be polled for. Give a wrongly eager register time to push.
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The release is still waiting on the host, so the register has pushed nothing yet.
    expect(host.state.writeCalls).toBe(writesBefore);

    slowUnwatch.release();
    await Promise.all([firstRelease, repeatRelease, reRegister]);
    expect(host.state.writeCalls).toBe(writesBefore + 1);
    expect(host.written.get(settingsPath)).toBe('{"version":1}');
    expect(host.watching.has('s1')).toBe(true);
    expect(relay.has('s1')).toBe(true);
  });

  it('leaves nothing on the host, no watcher and no timer when a release arrives during the push', async () => {
    const { host, relay } = makeRelay();
    const { registration } = registrationFor();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      host.state.holdWrites = true;
      const registering = relay.register(registration);
      await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));

      await relay.release('s1');
      host.writeGates[0].release();
      await registering;

      expect(host.written.size).toBe(0);
      expect(host.watching.size).toBe(0);
      expect(relay.has('s1')).toBe(false);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
    }
  });

  it('makes the second of two overlapping registers wait for the first, so its newer files land last', async () => {
    const { host, relay } = makeRelay();
    const { registration, settingsPath } = registrationFor();
    host.state.holdWrites = true;
    const first = relay.register(registration);
    await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));
    fs.writeFileSync(path.join(registration.localSessionDirectory, 'settings.json'), '{"version":2}');
    const second = relay.register(registration);
    // Negative assertion: nothing can be polled for. Give a wrongly eager register time to write.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(host.writeGates).toHaveLength(1);

    // The first's write lands and its cleanup runs, and only then does the second push.
    host.writeGates[0].release();
    await first;
    await vi.waitFor(() => expect(host.writeGates).toHaveLength(2));
    host.writeGates[1].release();
    await second;

    expect(host.written.get(settingsPath)).toBe('{"version":2}');
    expect(host.watching.has('s1')).toBe(true);
    expect(relay.has('s1')).toBe(true);
  });

  it('still sees a release that arrives during the second register push', async () => {
    const { host, relay } = makeRelay();
    const { registration } = registrationFor();
    host.state.holdWrites = true;
    const first = relay.register(registration);
    await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));
    const second = relay.register(registration);

    host.writeGates[0].release();
    await first;
    await vi.waitFor(() => expect(host.writeGates).toHaveLength(2));
    await relay.release('s1');
    host.writeGates[1].release();
    await second;

    expect(relay.has('s1')).toBe(false);
    expect(host.written.size).toBe(0);
    expect(host.watching.size).toBe(0);
  });

  it('lets the newer of two registers started in one tick win: the older never pushes, so its files cannot land last', async () => {
    const { host, relay } = makeRelay();
    const { registration, settingsPath } = registrationFor();
    fs.writeFileSync(path.join(registration.localSessionDirectory, 'older.json'), '{"which":"older"}');
    fs.writeFileSync(path.join(registration.localSessionDirectory, 'newer.json'), '{"which":"newer"}');
    const olderPath = '/home/dev/project/.kangentic/sessions/s1/older.json';
    const newerPath = '/home/dev/project/.kangentic/sessions/s1/newer.json';

    const older = relay.register({ ...registration, extraFiles: ['older.json'] });
    const newer = relay.register({ ...registration, extraFiles: ['newer.json'] });
    await Promise.all([older, newer]);

    expect(host.state.writeCalls).toBe(1);
    expect(host.written.has(olderPath)).toBe(false);
    expect(host.written.has(newerPath)).toBe(true);
    expect(host.written.has(settingsPath)).toBe(true);
    expect(relay.has('s1')).toBe(true);
  });

  it('honors a release that arrives while the newer of two same-tick registers is pushing', async () => {
    const { host, relay } = makeRelay();
    const { registration } = registrationFor();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      host.state.holdWrites = true;
      const older = relay.register(registration);
      const newer = relay.register(registration);
      await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));

      await relay.release('s1');
      host.writeGates[0].release();
      await Promise.all([older, newer]);

      expect(host.state.writeCalls).toBe(1);
      expect(host.written.size).toBe(0);
      expect(host.watching.size).toBe(0);
      expect(relay.has('s1')).toBe(false);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
    }
  });

  it('ends a register without a push when a release arrives while it waits for an earlier one', async () => {
    const { host, relay } = makeRelay();
    const { registration } = registrationFor();
    host.state.holdWrites = true;
    const earlier = relay.register(registration);
    await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));
    host.state.holdWrites = false;
    const waiting = relay.register(registration);

    await relay.release('s1');
    host.writeGates[0].release();
    await Promise.all([earlier, waiting]);

    expect(host.state.writeCalls).toBe(1);
    expect(host.written.size).toBe(0);
    expect(host.watching.size).toBe(0);
    expect(relay.has('s1')).toBe(false);
  });

  it('leaves no session and no timer when dispose runs while a register is pushing', async () => {
    const { host, relay } = makeRelay();
    const { registration } = registrationFor();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      host.state.holdWrites = true;
      const registering = relay.register(registration);
      await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));

      relay.dispose();
      host.writeGates[0].release();
      await registering;

      expect(relay.has('s1')).toBe(false);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
    }
  });

  describe('with a transcript to tail', () => {
    const transcriptFor = (): string => path.join(scratch, 'mirror', '.claude', 'projects', 'p', 'abc.jsonl');

    it('still registers when the host fails to start tailing, writes no chunk, and asks the host to stop tailing once', async () => {
      const { host, relay } = makeRelay();
      const { registration } = registrationFor();
      host.state.rejectNextWatchFiles = true;

      await relay.register({ ...registration, transcriptFiles: [transcriptFor()] });

      expect(relay.has('s1')).toBe(true);
      relay.deliverChunk({ type: 'fileChunk', sessionId: 's1', key: '0', offset: 0, reset: false, data: Buffer.from('x').toString('base64') });
      expect(fs.existsSync(transcriptFor())).toBe(false);
      // The host may have started before its answer was lost, and no release would stop it with no tails.
      await vi.waitFor(() => expect(host.state.unwatchFilesCalls).toBe(1));
    });

    it('stops the host tailing when a release arrives during the push', async () => {
      const { host, relay } = makeRelay();
      const { registration } = registrationFor();
      host.state.holdWrites = true;
      const registering = relay.register({ ...registration, transcriptFiles: [transcriptFor()] });
      await vi.waitFor(() => expect(host.writeGates).toHaveLength(1));

      await relay.release('s1');
      host.writeGates[0].release();
      await registering;

      expect(host.state.unwatchFilesCalls).toBe(1);
      expect(relay.has('s1')).toBe(false);
      expect(host.watching.size).toBe(0);
    });
  });

  it('counts the size of an answer in bytes, so about 90,000 CJK characters go in the raw part and arrive intact', async () => {
    const { host, relay } = makeRelay();
    const { registration } = registrationFor();
    await relay.register(registration);
    const answer = '界'.repeat(90_000);
    // Fewer than 100,000 characters once JSON-encoded, about 270 KB as UTF-8.
    expect(JSON.stringify(answer).length).toBeLessThan(100_000);
    const responseName = '1700000000000000000-99.res';
    fs.writeFileSync(path.join(wslHookPaths(registration.localSessionDirectory).responses, responseName), answer, 'utf8');

    await vi.waitFor(() => expect(host.rawWrites).toHaveLength(1), { timeout: 4000 });

    expect(host.rawWrites[0].path).toBe(`/home/dev/project/.kangentic/sessions/s1/wsl-hooks/responses/${responseName}`);
    expect(host.rawWrites[0].content).toBe(answer);
    expect(host.jsonWrites.some((written) => written.endsWith(responseName))).toBe(false);
  });
});

describe('a session\'s transcript', () => {
  const RELATIVE = ['.claude', 'projects', '-home-dev-api', 'abc.jsonl'];
  const localTranscript = (): string => path.join(scratch, 'mirror', ...RELATIVE);
  const hostTranscript = (): string => path.join(hostHome, ...RELATIVE);

  function writeOnHost(content: string): void {
    fs.mkdirSync(path.dirname(hostTranscript()), { recursive: true });
    fs.writeFileSync(hostTranscript(), content);
  }

  it('is copied from the host into this computer\'s mirror, backfill first, then as it grows', async () => {
    const lines = ['{"type":"user","n":1}', '{"type":"assistant","n":2}'];
    writeOnHost(`${lines[0]}\n`);
    await makeRig({ transcriptFiles: [localTranscript()] });

    await waitFor(() => fs.existsSync(localTranscript()) && fs.readFileSync(localTranscript(), 'utf8') === `${lines[0]}\n`);

    fs.appendFileSync(hostTranscript(), `${lines[1]}\n`);
    await waitFor(() => fs.readFileSync(localTranscript(), 'utf8') === `${lines.join('\n')}\n`);
  });

  it('starts once the agent creates the file, and carries multi-byte text whole across a chunk edge', async () => {
    await makeRig({ transcriptFiles: [localTranscript()] });
    expect(fs.existsSync(localTranscript())).toBe(false);

    const text = `${JSON.stringify({ message: '界'.repeat(120_000) })}\n`;
    writeOnHost(text);
    await waitFor(() => fs.existsSync(localTranscript()) && fs.readFileSync(localTranscript(), 'utf8') === text, 8000);
  });

  it('is emptied and copied again when the host replaces the file with a shorter one', async () => {
    writeOnHost('{"first":"a long first conversation line to be replaced"}\n');
    await makeRig({ transcriptFiles: [localTranscript()] });
    await waitFor(() => fs.existsSync(localTranscript()) && fs.statSync(localTranscript()).size > 40);

    fs.rmSync(hostTranscript());
    fs.writeFileSync(hostTranscript(), '{"b":1}\n');
    await waitFor(() => fs.readFileSync(localTranscript(), 'utf8') === '{"b":1}\n');
  });

  it('has its last bytes in the copy by the time the release finishes', async () => {
    writeOnHost('{"n":1}\n');
    const rig = await makeRig({ transcriptFiles: [localTranscript()] });
    await waitFor(() => fs.existsSync(localTranscript()));

    fs.appendFileSync(hostTranscript(), '{"n":2}\n');
    await rig.relay.release('s1');

    expect(fs.readFileSync(localTranscript(), 'utf8')).toBe('{"n":1}\n{"n":2}\n');
  });

  it('is not tailed from a path outside the mirror, and a chunk for a key nobody asked for writes nothing', async () => {
    const outside = path.join(scratch, 'elsewhere', 'abc.jsonl');
    const rig = await makeRig({ transcriptFiles: [outside] });

    rig.relay.deliverChunk({ type: 'fileChunk', sessionId: 's1', key: '0', offset: 0, reset: false, data: Buffer.from('x').toString('base64') });
    rig.relay.deliverChunk({ type: 'fileChunk', sessionId: 's1', key: '9', offset: 0, reset: false, data: Buffer.from('x').toString('base64') });

    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'elsewhere'))).toBe(false);
  });

  it('writes at the offset it was sent, so a chunk delivered twice leaves the file as it was', async () => {
    const rig = await makeRig({ transcriptFiles: [localTranscript()] });
    const chunk = (offset: number, text: string, reset = false) => ({
      type: 'fileChunk' as const, sessionId: 's1', key: '0', offset, reset, data: Buffer.from(text).toString('base64'),
    });

    rig.relay.deliverChunk(chunk(0, 'abc'));
    rig.relay.deliverChunk(chunk(3, 'def'));
    rig.relay.deliverChunk(chunk(3, 'def'));
    expect(fs.readFileSync(localTranscript(), 'utf8')).toBe('abcdef');

    rig.relay.deliverChunk(chunk(0, 'z', true));
    expect(fs.readFileSync(localTranscript(), 'utf8')).toBe('z');
  });
});
