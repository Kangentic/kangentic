/**
 * The client half of the #913 Phase 1 rig gate (scripts/ssh-link-rig.mjs): the real RemoteLink and
 * PtyHostClient dialing a real helper over a real `ssh`, with a PTY ticking on the host while the
 * connection is killed again and again. Not product code, and `tsconfig.json` covers `src/` only, so
 * `npm run typecheck` does not see it: esbuild strips the types.
 *
 *   node client.js '<json>'   { sshPath, sshArgs, remoteCommand, drops }
 *
 * Each round kills the `ssh` process (its tree, by pid), waits for the link to be connected again, and
 * checks what the plan's gate asks: the same PTY pid is still alive on the host, the owner epoch moved
 * on by one, and the ticks in its scrollback run without a gap. Then a transcript export crosses a drop of
 * its own, and must arrive whole.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { remoteExportPath, type SshCliPlace } from '../src/main/agent/shared/cli-target';
import { prepareWslHookTransport } from '../src/main/agent/shared/wsl-hook-transport';
import { PtyHostClient } from '../src/main/pty/host/pty-host-client';
import type { RendererPort } from '../src/main/pty/host/protocol';
import type { FromPtyHostPortMessage } from '../src/shared/pty-port-protocol';
import { RemoteLink, type RemoteLinkState } from '../src/main/remote/link/remote-link';
import { openSshStream } from '../src/main/remote/link/ssh-connection';
import { createSshRunner } from '../src/main/remote/link/ssh-run';
import { installHost, type HostAsset } from '../src/main/remote/link/host-installer';
import { RemoteSessionRelay, type RemoteSessionFiles } from '../src/main/remote/remote-session-relay';

interface Options {
  sshPath: string;
  sshArgs: string[];
  /** The host asset the installer sends. The rig builds it from the staged bundle and a pinned Node. */
  asset: HostAsset;
  drops: number;
}

const options = JSON.parse(process.argv[2]) as Options;
/** Set once the installer has said how to start the relay. */
let remoteCommand = '';
const streams: Duplex[] = [];
const received: string[] = [];
let state: RemoteLinkState = 'connecting';
let stateDetail: string | null = null;

const rendererPort: RendererPort = {
  postMessage(message: FromPtyHostPortMessage) {
    if (message.type === 'data') received.push(message.data);
  },
  on: () => rendererPort,
  start() {},
  close() {},
};

const link = new RemoteLink({
  identity: { installId: 'ssh-link-rig', bootId: randomUUID(), label: 'the rig client' },
  connect: async () => {
    const stream = openSshStream({ sshPath: options.sshPath, args: options.sshArgs, remoteCommand });
    streams.push(stream);
    return stream;
  },
  reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  endpoint: { heartbeatMs: 1000, deadAfterMs: 6000 },
  log: (line) => process.stderr.write(`[link] ${line}\n`),
});
link.setHandlers({
  onStateChanged: (next, detail) => {
    state = next;
    stateDetail = detail;
  },
});
const client = new PtyHostClient(link);
link.attachRendererPort(1, rendererPort);

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description: string, condition: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description} (link ${state}${stateDetail ? `: ${stateDetail}` : ''})`);
    await sleep(20);
  }
  return Date.now() - started;
}

function ticks(text: string): number[] {
  return [...text.matchAll(/tick (\d+)/g)].map((match) => Number(match[1]));
}

function contiguous(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

/**
 * A session's export on the host, through the built helper and a real `ssh`, with the connection killed while the
 * export is still arriving. An export past a reply's 256 KiB cap has to arrive by the tail, and the copy must end
 * up whole, with nothing left on the host. It is one document, so a stray byte would be a conversation lost.
 */
async function exportAcrossADrop(): Promise<{ bytes: number; part: boolean; whole: boolean; hostFileGone: boolean }> {
  const bytes = 2_400_000;
  const hostProject = '/home/dev/rig-transcript';
  const fakeCli = `${hostProject}/fake-export.sh`;
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-link-rig-'));
  const shellFolder = path.join(localRoot, 'shell');
  const localSession = path.join(shellFolder, '.kangentic', 'sessions', 'export');
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  const place: SshCliPlace = { kind: 'ssh', hostId: 'rig', home: '/home/dev', shellName: 'bash', localHome: path.join(localRoot, 'mirror'), roots: [{ local: shellFolder, host: hostProject }] };
  const copy = remoteExportPath(place, 'rig', 'conversation');

  const files: RemoteSessionFiles = {
    writeFiles: (_hostId, fileList, directories) => link.requestHelper('writeFiles', { files: fileList, ...(directories ? { directories } : {}) }),
    writeFileRaw: async () => undefined,
    watchHooks: (_hostId, sessionId, directory, statusFile) => link.requestHelper('watchHooks', { sessionId, directory, ...(statusFile ? { statusFile } : {}) }),
    unwatchHooks: (_hostId, sessionId) => link.requestHelper('unwatchHooks', { sessionId }),
    watchFiles: (_hostId, sessionId, tailed) => link.requestHelper('watchFiles', { sessionId, files: tailed }),
    unwatchFiles: (_hostId, sessionId) => link.requestHelper('unwatchFiles', { sessionId }),
    removeFiles: (_hostId, paths) => link.requestHelper('removeFiles', { paths }),
    removeEmptyDirectories: (_hostId, paths) => link.requestHelper('removeEmptyDirectories', { paths }),
    runCommand: (_hostId, request) => link.requestHelper('runCommand', request),
  };
  const relay = new RemoteSessionRelay({ files, log: (line) => process.stderr.write(`[relay] ${line}\n`) });
  client.setEventHandler((event) => {
    if (event.type === 'fileChunk') relay.deliverChunk(event);
  });
  await link.requestHelper('writeFiles', { files: [{ path: fakeCli, content: `#!/bin/sh\nhead -c ${bytes} /dev/zero | tr '\\0' x\n`, mode: 0o755 }] });

  await relay.register({
    hostId: 'rig',
    sessionId: 'export',
    place,
    localSessionDirectory: localSession,
    statusOutputPath: path.join(localSession, 'status.json'),
    agentSessionId: 'conversation',
    transcripts: { files: () => [], snapshot: async () => ({ file: fakeCli, args: [], cwd: hostProject, localPath: copy }) },
  });

  // The first export runs a few seconds in. Killed once its first chunk lands, with most of it still to come.
  await waitFor('the export to start arriving', () => fs.existsSync(`${copy}.part`), 20_000);
  const part = !fs.existsSync(copy);
  streams.at(-1)?.destroy();
  await waitFor('the drop to be seen', () => state !== 'connected', 10_000);
  await waitFor('the reconnect', () => state === 'connected', 30_000);
  await waitFor('the export to be whole', () => fs.existsSync(copy), 30_000);

  const content = fs.readFileSync(copy);
  const whole = content.length === bytes && content.every((byte) => byte === 0x78);
  await relay.release('export');
  const hostFile = `/home/dev/.kangentic/transcripts/rig/conversation.json`;
  const [presence] = await link.requestHelper('pathPresence', { paths: [hostFile] });
  fs.rmSync(localRoot, { recursive: true, force: true });
  return { bytes, part, whole, hostFileGone: presence === 'absent' };
}

async function main(): Promise<void> {
  // The installer first, as the add-host flow runs it: nothing is on the host yet. A second call must find the
  // version complete and send nothing.
  const run = createSshRunner({ sshPath: options.sshPath, args: options.sshArgs });
  const installStarted = Date.now();
  const first = await installHost(run, options.asset);
  const installMs = Date.now() - installStarted;
  const second = await installHost(run, options.asset, () => { throw new Error('the second install must not open the asset'); });
  if (!first.installed || second.installed) throw new Error(`install was not idempotent: first ${first.installed}, second ${second.installed}`);
  remoteCommand = first.relayCommand;
  process.stderr.write(`[install] ${first.directory} in ${installMs} ms, second call sent nothing\n`);

  link.start();
  await waitFor('the first connection', () => state === 'connected', 30_000);
  client.post({ type: 'setRendererFocus', rendererId: 1, sessionIds: ['s1'] });

  const outcome = await client.spawn({
    sessionId: 's1',
    projectId: 'rig',
    agentName: null,
    transient: false,
    file: '/bin/sh',
    args: ['-c', 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.2; done'],
    cwd: '/home/dev',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/dev', TERM: 'xterm-256color' },
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    taskId: randomUUID(),
  });
  if (!outcome.ok) throw outcome.error;
  const pid = outcome.pty.pid;
  await waitFor('ten ticks on the renderer', () => ticks(received.join('')).length >= 10, 15_000);

  const rounds: Array<Record<string, unknown>> = [];
  const reconnectMs: number[] = [];
  let previousEpoch = (await link.requestHelper('snapshot', {})).ownerEpoch;
  let previousLastTick = ticks(received.join('')).at(-1) ?? 0;
  for (let round = 1; round <= options.drops; round += 1) {
    // Timed from the kill to a connected link, the whole of what a user would wait through.
    const killedAt = Date.now();
    streams.at(-1)?.destroy();
    await waitFor('the drop to be seen', () => state !== 'connected', 10_000);
    await waitFor('the reconnect', () => state === 'connected', 30_000);
    const elapsed = Date.now() - killedAt;
    reconnectMs.push(elapsed);
    const snapshot = await link.requestHelper('snapshot', {});
    const session = snapshot.sessions.find((entry) => entry.sessionId === 's1');
    const scrollback = ticks(await client.getScrollback('s1', false));
    const lastTick = scrollback.at(-1) ?? 0;
    const row = {
      round,
      reconnectMs: elapsed,
      alive: session?.alive === true,
      samePid: session?.pid === pid,
      epochAdvancedByOne: snapshot.ownerEpoch === previousEpoch + 1,
      scrollbackContiguous: contiguous(scrollback),
      progressed: lastTick > previousLastTick,
    };
    rounds.push(row);
    previousEpoch = snapshot.ownerEpoch;
    previousLastTick = lastTick;
  }

  const transcript = await exportAcrossADrop();
  const allPassed = transcript.whole && transcript.hostFileGone && rounds.every((row) => row.alive && row.samePid && row.epochAdvancedByOne && row.scrollbackContiguous && row.progressed);
  const summary = {
    drops: options.drops,
    passed: rounds.filter((row) => row.alive && row.samePid && row.epochAdvancedByOne && row.scrollbackContiguous && row.progressed).length,
    allPassed,
    transcript,
    reconnectMs: { p50: percentile(reconnectMs, 0.5), p95: percentile(reconnectMs, 0.95), max: Math.max(...reconnectMs) },
    hostPid: pid,
    finalTick: previousLastTick,
    failures: rounds.filter((row) => !(row.alive && row.samePid && row.epochAdvancedByOne && row.scrollbackContiguous && row.progressed)),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  link.stop();
  process.exit(allPassed ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  link.stop();
  process.exit(2);
});
