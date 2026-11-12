/**
 * Real CLIs, end to end on Linux (#913): a real Kimi Code, Goose, OpenCode, Codex, Gemini, Aider and Droid each
 * hold a real conversation, and the real helper, shell script, tail and relay bring it to this computer, where the
 * adapter's own readers read it. Nothing here is a fixture, so it fails when a CLI changes what the rest of the
 * suite pinned.
 *
 * It needs the CLIs, so it runs only in the rig (`scripts/probe-ssh-rig/transcript-clis.sh`, which sets
 * `KANGENTIC_TRANSCRIPT_RIG`) and is skipped everywhere else, CI included. A model stand-in answers, so a run
 * costs no quota.
 *
 * What a user loses if it breaks: a host conversation that never reaches the viewer, the index or the ledger
 * while every test built on captures stays green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { DroidCommandBuilder } from '../../src/main/agent/adapters/droid/command-builder';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import { forgetDistroOpenCodeVersions } from '../../src/main/agent/adapters/opencode/distro-sessions';
import { localPathToHost, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { RemoteSessionRelay, remoteTranscriptSource, type RemoteSessionFiles } from '../../src/main/remote/remote-session-relay';
import { prepareWslHookTransport, wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { AgentParser, StoredCliTarget } from '../../src/shared/types';
import { dialHelper, makeHelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let scratch: string;
let hostProject: string;
let shellFolder: string;
let place: SshCliPlace;
let stored: StoredCliTarget;
let relay: RemoteSessionRelay;

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function placeFor(linuxCliPath: string): SshCliPlace {
  return { kind: 'ssh', hostId: 'host-a', home: os.homedir(), shellName: 'bash', localHome: path.join(scratch, 'mirror'), roots: [{ local: shellFolder, host: hostProject }], linuxCliPath };
}

/** Run a CLI as the agent of a session on the host, in the project's folder. */
function runAgent(file: string, args: string[]): string {
  const result = spawnSync(file, args, { cwd: hostProject, encoding: 'utf8', timeout: 60_000 });
  expect(result.status, `${file} ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

/** The one file under `root` whose name `pattern` matches, on the host. */
function hostFileUnder(root: string, pattern: RegExp): string {
  const found = (fs.readdirSync(root, { recursive: true, encoding: 'utf8' }))
    .filter((relative) => pattern.test(path.basename(relative)))
    .map((relative) => path.join(root, relative));
  expect(found, `files matching ${String(pattern)}`).toHaveLength(1);
  return found[0];
}

/**
 * The copy a reader opens is the host's file, byte for byte. A reader skips a line it cannot parse, so a text
 * assertion passes over a copy an in-place rewrite has corrupted, and only the bytes show it.
 */
function expectWholeCopy(copy: string | null, hostFile: string): Buffer {
  expect(copy).not.toBeNull();
  const onHost = fs.readFileSync(hostFile);
  expect(fs.readFileSync(copy as string).equals(onHost), `${copy as string} is the bytes of ${hostFile}`).toBe(true);
  return onHost;
}

/** What a tail depends on: a resume only adds to the file, with the same inode and every earlier byte in place. */
function expectAppended(hostFile: string, before: { inode: number; bytes: Buffer }): void {
  const after = fs.readFileSync(hostFile);
  expect(fs.statSync(hostFile).ino, `${hostFile} keeps its inode`).toBe(before.inode);
  expect(after.length).toBeGreaterThan(before.bytes.length);
  expect(after.subarray(0, before.bytes.length).equals(before.bytes), `${hostFile} kept its earlier bytes`).toBe(true);
}

async function register(parser: AgentParser, sessionId: string, agentSessionId: string | null, extraFiles: readonly string[] = []): Promise<void> {
  const localSession = path.join(shellFolder, '.kangentic', 'sessions', sessionId);
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  await relay.register({
    hostId: 'host-a',
    sessionId,
    place,
    localSessionDirectory: localSession,
    statusOutputPath: path.join(localSession, 'status.json'),
    agentSessionId,
    extraFiles,
    transcriptFiles: agentSessionId ? parser.remoteTranscriptFiles?.({ agentSessionId, cwd: shellFolder, cliTarget: stored, sessionDirectory: localSession }) ?? [] : [],
    transcripts: remoteTranscriptSource(parser, shellFolder, stored, localSession),
  });
}

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-real-cli-'));
  // The helper works only beneath the home, as on a real host.
  hostProject = fs.mkdtempSync(path.join(os.homedir(), 'kangentic-real-cli-project-'));
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(shellFolder, { recursive: true });

  const helperRig = makeHelperRig(1, { homeDirectory: os.homedir(), baseEnv: { ...process.env, SHELL: '/bin/bash' } });
  const link = new RemoteLink({
    identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
    connect: async () => dialHelper(helperRig),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  link.start();
  await link.requestHelper('hostInfo', {});
  const files: RemoteSessionFiles = {
    writeFiles: (_hostId, fileList, directories) => link.requestHelper('writeFiles', { files: fileList, ...(directories ? { directories } : {}) }),
    writeFileRaw: async () => undefined,
    watchHooks: (_hostId, sessionId, directory, statusFile) => link.requestHelper('watchHooks', { sessionId, directory, ...(statusFile ? { statusFile } : {}) }),
    unwatchHooks: (_hostId, sessionId) => link.requestHelper('unwatchHooks', { sessionId }),
    watchFiles: (_hostId, sessionId, tailed, searches) => link.requestHelper('watchFiles', { sessionId, files: tailed, ...(searches?.length ? { searches } : {}) }),
    unwatchFiles: (_hostId, sessionId) => link.requestHelper('unwatchFiles', { sessionId }),
    removeFiles: (_hostId, paths) => link.requestHelper('removeFiles', { paths }),
    removeEmptyDirectories: (_hostId, paths) => link.requestHelper('removeEmptyDirectories', { paths }),
    runCommand: (_hostId, request) => link.requestHelper('runCommand', request),
  };
  relay = new RemoteSessionRelay({ files, log: (line) => console.log(`[relay] ${line}`) });
  link.setEventListener((event) => {
    if (event.type === 'fileChunk') relay.deliverChunk(event);
    if (event.type === 'hookFile') relay.deliver(event);
  });
  teardown.push(() => relay.dispose(), () => link.stop(), () => helperRig.helper.dispose());
});

afterEach(() => {
  forgetDistroOpenCodeVersions();
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(hostProject, { recursive: true, force: true });
});

describe.skipIf(process.env.KANGENTIC_TRANSCRIPT_RIG !== '1')('a real CLI on a host', () => {
  it('Kimi: a fresh session is found from the index, and its conversation arrives', async () => {
    const adapter = new KimiAdapter();
    place = placeFor('kimi');
    stored = toStoredCliTarget(place)!;
    const found: string[] = [];
    relay.onSessionIdFound((sessionId, agentSessionId) => {
      found.push(agentSessionId);
      relay.setAgentSessionId(sessionId, agentSessionId);
    });

    await register(adapter, 'kimi-session', null);
    runAgent('kimi', ['-p', 'say hello']);

    await until(() => found.length > 0);
    expect(found[0]).toMatch(/^session_[0-9a-f-]{36}$/);
    await relay.release('kimi-session');

    const parsed = await adapter.parseTranscript(found[0], shellFolder, place);
    expect(JSON.stringify(parsed.entries)).toContain('Stub reply from the probe model.');
    await expect(adapter.transcriptUsage({ agentSessionId: found[0], place })).resolves.toMatchObject({ inputTokens: expect.any(Number) });
  }, 90_000);

  it('Goose: an export arrives, and a resume replaces it with the longer conversation', async () => {
    const adapter = new GooseAdapter();
    place = placeFor('goose');
    stored = toStoredCliTarget(place)!;
    const name = randomUUID();

    await register(adapter, 'goose-one', name);
    runAgent('goose', ['run', '-n', name, '-t', 'say hello']);
    await relay.release('goose-one');

    const first = JSON.stringify((await adapter.parseTranscript(name, shellFolder, place)).entries);
    expect(first).toContain('say hello');
    expect(first).toContain('Stub reply from the probe model.');
    expect(first).not.toContain('again');

    await register(adapter, 'goose-two', name);
    runAgent('goose', ['run', '-r', '-n', name, '-t', 'again']);
    await relay.release('goose-two');

    const second = JSON.stringify((await adapter.parseTranscript(name, shellFolder, place)).entries);
    expect(second).toContain('say hello');
    expect(second).toContain('again');
    const usage = await adapter.transcriptUsage({ agentSessionId: name, place });
    expect(usage?.inputTokens).toBeGreaterThan(0);
    await expect(adapter.transcriptToolCounts({ agentSessionId: name, place })).resolves.toMatchObject({ toolCallCount: 1 });
  }, 90_000);

  it.each([
    { major: 'OpenCode 1', binary: 'OPENCODE1_BIN', runFlags: ['--pure'], listFlag: '--pure' },
    { major: 'OpenCode 2', binary: 'OPENCODE2_BIN', runFlags: ['--standalone'], listFlag: '--standalone' },
  ])('$major: an id that arrives late starts the export, and it arrives', async ({ binary, runFlags, listFlag }) => {
    const adapter = new OpenCodeAdapter();
    const opencode = process.env[binary] as string;
    place = placeFor(opencode);
    stored = toStoredCliTarget(place)!;

    await register(adapter, 'opencode-session', null);
    runAgent(opencode, ['run', ...runFlags, '-m', 'stub/stub-model', 'say hello']);
    const listed = JSON.parse(runAgent(opencode, ['session', 'list', '--format', 'json', '-n', '1', listFlag])) as Array<{ id: string }>;
    const agentSessionId = listed[0].id;
    relay.setAgentSessionId('opencode-session', agentSessionId);
    await relay.release('opencode-session');

    const parsed = await adapter.parseTranscript(agentSessionId, shellFolder, place);
    const text = JSON.stringify(parsed.entries);
    expect(text).toContain('say hello');
    expect(text).toContain('echo probe-tool-output');
    expect(text).toContain('Stub reply from the probe model.');
    const window = await adapter.parseTranscriptWindow(agentSessionId, shellFolder, 0, 1024 * 1024, new Set<string>(), place);
    expect(window.entries.length).toBeGreaterThan(0);
    await expect(adapter.transcriptUsage({ agentSessionId, place })).resolves.toMatchObject({ inputTokens: expect.any(Number) });
    await expect(adapter.transcriptToolCounts({ agentSessionId, place })).resolves.toMatchObject({ toolCallCount: 1 });
    // Nothing of the export is left on the host once the session is over.
    expect(fs.readdirSync(path.join(os.homedir(), '.kangentic', 'transcripts', 'opencode'))).toEqual([]);
  }, 90_000);

  it('Codex: a search finds the rollout when the id arrives late, and a resume extends the same copy', async () => {
    const adapter = new CodexAdapter();
    place = placeFor('codex');
    stored = toStoredCliTarget(place)!;
    const exec = ['--skip-git-repo-check', '--json', '-c', 'check_for_update_on_startup=false', '--dangerously-bypass-approvals-and-sandbox'];

    await register(adapter, 'codex-one', null);
    const output = runAgent('codex', ['exec', ...exec, 'say hello']);
    const agentSessionId = (JSON.parse(output.split('\n').find((line) => line.includes('thread.started')) as string) as { thread_id: string }).thread_id;
    relay.setAgentSessionId('codex-one', agentSessionId);
    await relay.release('codex-one');

    const first = JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder, place)).entries);
    expect(first).toContain('say hello');
    expect(first).toContain('Stub reply from the probe model.');
    await expect(adapter.locateSessionHistoryFile(agentSessionId, shellFolder, place)).resolves.toContain('rollout-copy-');
    const hostFile = hostFileUnder(path.join(os.homedir(), '.codex', 'sessions'), new RegExp(`-${agentSessionId}\\.jsonl$`));
    const copy = await adapter.locateSessionHistoryFile(agentSessionId, shellFolder, place);
    const before = { inode: fs.statSync(hostFile).ino, bytes: expectWholeCopy(copy, hostFile) };

    await register(adapter, 'codex-two', agentSessionId);
    runAgent('codex', ['exec', 'resume', ...exec, agentSessionId, 'again']);
    await relay.release('codex-two');

    expectAppended(hostFile, before);
    expectWholeCopy(copy, hostFile);

    const second = JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder, place)).entries);
    expect(second).toContain('say hello');
    expect(second).toContain('again');
    await expect(adapter.transcriptUsage({ agentSessionId, place })).resolves.toMatchObject({ inputTokens: expect.any(Number) });
  }, 120_000);

  it('Gemini: a search finds the chat under the CLI\'s own folder, with a caller-owned id and a resume', async () => {
    const adapter = new GeminiAdapter();
    place = placeFor('gemini');
    stored = toStoredCliTarget(place)!;
    const agentSessionId = randomUUID();

    await register(adapter, 'gemini-one', agentSessionId);
    runAgent('gemini', ['--skip-trust', '--session-id', agentSessionId, '-m', 'stub-model', '-p', 'say hello']);
    await relay.release('gemini-one');

    const first = JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder, place)).entries);
    expect(first).toContain('say hello');
    expect(first).toContain('Stub reply from the probe model.');
    await expect(adapter.locateSessionHistoryFile(agentSessionId, shellFolder, place)).resolves.toContain('session-copy-');
    const hostFile = hostFileUnder(path.join(os.homedir(), '.gemini', 'tmp'), new RegExp(`^session-.*${agentSessionId.slice(0, 8)}\\.jsonl$`));
    const copy = await adapter.locateSessionHistoryFile(agentSessionId, shellFolder, place);
    const before = { inode: fs.statSync(hostFile).ino, bytes: expectWholeCopy(copy, hostFile) };

    await register(adapter, 'gemini-two', agentSessionId);
    runAgent('gemini', ['--skip-trust', '--resume', agentSessionId, '-m', 'stub-model', '-p', 'again']);
    await relay.release('gemini-two');

    expectAppended(hostFile, before);
    expectWholeCopy(copy, hostFile);

    const second = JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder, place)).entries);
    expect(second).toContain('say hello');
    expect(second).toContain('again');
    await expect(adapter.transcriptUsage({ agentSessionId, cwd: shellFolder, place })).resolves.toMatchObject({ inputTokens: expect.any(Number) });
  }, 120_000);

  it('Aider: the history in the working folder lands in its stand-in here, and a resume restores it', async () => {
    const adapter = new AiderAdapter();
    place = placeFor('aider');
    stored = toStoredCliTarget(place)!;
    const agentSessionId = randomUUID();
    const aider = [
      '--model', 'openai/stub-model', '--openai-api-base', `${process.env.STUB_BASE_URL as string}/v1`, '--openai-api-key', 'stub',
      '--chat-history-file', path.join(hostProject, `.aider.chat.history.${agentSessionId}.md`),
      '--no-git', '--no-auto-commits', '--yes-always', '--no-check-update', '--no-show-model-warnings', '--no-analytics',
    ];

    await register(adapter, 'aider-one', agentSessionId);
    runAgent('aider', [...aider, '--message', 'say hello']);
    await relay.release('aider-one');

    expect(JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder)).entries)).toContain('say hello');
    const hostFile = path.join(hostProject, `.aider.chat.history.${agentSessionId}.md`);
    const copy = await adapter.locateSessionHistoryFile(agentSessionId, shellFolder);
    const before = { inode: fs.statSync(hostFile).ino, bytes: expectWholeCopy(copy, hostFile) };

    await register(adapter, 'aider-two', agentSessionId);
    runAgent('aider', [...aider, '--restore-chat-history', '--message', 'again']);
    await relay.release('aider-two');

    expectAppended(hostFile, before);
    expectWholeCopy(copy, hostFile);

    const second = JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder)).entries);
    expect(second).toContain('say hello');
    expect(second).toContain('again');
    await expect(adapter.transcriptUsage({ agentSessionId, cwd: shellFolder })).resolves.toMatchObject({ inputTokens: expect.any(Number) });
  }, 180_000);

  it('Droid: its SessionStart hook reaches this computer from the host, names the file, and a resume keeps the id', async () => {
    const adapter = new DroidAdapter();
    place = placeFor('droid');
    stored = toStoredCliTarget(place)!;
    const sessionId = 'droid-one';
    const localSession = path.join(shellFolder, '.kangentic', 'sessions', sessionId);
    fs.mkdirSync(localSession, { recursive: true });
    const settings = new DroidCommandBuilder().writeHookSettings({
      droidPath: 'droid',
      taskId: 'task-1',
      cwd: shellFolder,
      permissionMode: 'default',
      eventsOutputPath: path.join(localSession, 'events.jsonl'),
      cliTarget: { ...place, linuxCliPath: 'droid' },
    });
    expect(settings).not.toBeNull();
    const hostSettings = localPathToHost(settings as string, place.roots);
    const exec = ['exec', '--cwd', hostProject, '--settings', hostSettings, '-m', 'custom:stub', '--auto', 'high'];

    await register(adapter, sessionId, null, adapter.remoteSessionFiles());
    runAgent('droid', [...exec, 'say hello']);

    const inbox = wslHookPaths(localSession).inbox;
    const recordedId = (): string | null => {
      for (const name of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
        const match = /"session_id"\s*:\s*\\?"([0-9a-f-]{36})/.exec(fs.readFileSync(path.join(inbox, name), 'utf8'));
        if (match) return match[1];
      }
      return null;
    };
    await until(() => recordedId() !== null);
    const agentSessionId = recordedId() as string;
    relay.setAgentSessionId(sessionId, agentSessionId);
    await relay.release(sessionId);

    const parsed = await adapter.parseTranscript(agentSessionId, shellFolder, place);
    expect(JSON.stringify(parsed.entries)).toContain('say hello');
    await expect(adapter.locateSessionHistoryFile(agentSessionId, shellFolder, place)).resolves.toBe(parsed.sourcePath);
    const hostFile = hostFileUnder(path.join(os.homedir(), '.factory', 'sessions'), new RegExp(`^${agentSessionId}\\.jsonl$`));
    const before = { inode: fs.statSync(hostFile).ino, bytes: expectWholeCopy(parsed.sourcePath, hostFile) };

    // `droid exec` resumes with `-s`, where the interactive TUI this adapter starts takes `--resume`.
    await register(adapter, 'droid-two', agentSessionId);
    runAgent('droid', ['exec', '--cwd', hostProject, '-s', agentSessionId, '-m', 'custom:stub', '--auto', 'high', 'again']);
    await relay.release('droid-two');

    expectAppended(hostFile, before);
    expectWholeCopy(parsed.sourcePath, hostFile);

    const resumed = JSON.stringify((await adapter.parseTranscript(agentSessionId, shellFolder, place)).entries);
    expect(resumed).toContain('say hello');
    expect(resumed).toContain('again');
  }, 120_000);
});
