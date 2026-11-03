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
 * on by one, and the ticks in its scrollback run without a gap.
 */

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { PtyHostClient } from '../src/main/pty/host/pty-host-client';
import type { RendererPort } from '../src/main/pty/host/protocol';
import type { FromPtyHostPortMessage } from '../src/shared/pty-port-protocol';
import { RemoteLink, type RemoteLinkState } from '../src/main/remote/link/remote-link';
import { openSshStream } from '../src/main/remote/link/ssh-connection';

interface Options {
  sshPath: string;
  sshArgs: string[];
  remoteCommand: string;
  drops: number;
}

const options = JSON.parse(process.argv[2]) as Options;
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
    const stream = openSshStream({ sshPath: options.sshPath, args: options.sshArgs, remoteCommand: options.remoteCommand });
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

async function main(): Promise<void> {
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

  const allPassed = rounds.every((row) => row.alive && row.samePid && row.epochAdvancedByOne && row.scrollbackContiguous && row.progressed);
  const summary = {
    drops: options.drops,
    passed: rounds.filter((row) => row.alive && row.samePid && row.epochAdvancedByOne && row.scrollbackContiguous && row.progressed).length,
    allPassed,
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
