/**
 * The client half of the #913 quit rig (`node scripts/ssh-link-rig.mjs --client quit --work <dir>`): what a quit that
 * leaves an agent running, and a later launch that takes it back, do on a real host, through the real link, helper and
 * `ssh`. The unit tier runs the same parts over an in-memory stream; this is what proves them across a real connection
 * and a real new boot.
 *
 * Process A is a link with its own boot id. It starts a stub agent that prints a counter and publishes a hook file
 * every few hundred milliseconds, and a second stub that exits with code 3 by itself. A then lets go WITHOUT a
 * `suspendAll`, as the quit now does. Process B is a second link with a new boot id. It must find the first stub alive
 * with the same pid, rebind it, get the whole scrollback including what printed while nobody was attached, and receive
 * every hook file in order with no gap against what A had already taken. The second stub must come back not rejoined
 * and report its exit code.
 *
 * Not product code, and `tsconfig.json` covers `src/` only, so `npm run typecheck` does not see it.
 */

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { PtyHostClient } from '../src/main/pty/host/pty-host-client';
import { RemoteLink, type RemoteLinkState } from '../src/main/remote/link/remote-link';
import { openSshStream } from '../src/main/remote/link/ssh-connection';
import { createSshRunner } from '../src/main/remote/link/ssh-run';
import { installHost, type HostAsset } from '../src/main/remote/link/host-installer';
import type { PtyHostEvent } from '../src/main/pty/host/protocol';
import { check, finishChecks, sleep, waitFor } from './ssh-rig-checks';

interface Options {
  sshPath: string;
  sshArgs: string[];
  workDirectory: string;
  asset: HostAsset;
}

const options = JSON.parse(process.argv[2]) as Options;
const HOOK_DIRECTORY = '/home/dev/quit-rig-hooks';
const COUNTER_SESSION = 'quit-rig-counter';
const SHORT_SESSION = 'quit-rig-short';
let remoteCommand = '';
function openLink(label: string): { link: RemoteLink; connected: () => boolean; events: PtyHostEvent[] } {
  let state: RemoteLinkState = 'connecting';
  const streams: Duplex[] = [];
  const events: PtyHostEvent[] = [];
  const link = new RemoteLink({
    // The same install, a new boot: what a relaunch of the app is.
    identity: { installId: 'ssh-quit-rig', bootId: randomUUID(), label },
    connect: async () => {
      const stream = openSshStream({ sshPath: options.sshPath, args: options.sshArgs, remoteCommand });
      streams.push(stream);
      return stream;
    },
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    endpoint: { heartbeatMs: 1000, deadAfterMs: 6000 },
    log: (line) => process.stderr.write(`[link ${label}] ${line}\n`),
  });
  link.setHandlers({ onStateChanged: (next) => { state = next; } });
  link.setEventListener((event) => events.push(event));
  return { link, connected: () => state === 'connected', events };
}

/** A counter printed to the terminal, and the same counter published as a hook file named by its sequence number. */
const COUNTER_SCRIPT = [
  `mkdir -p ${HOOK_DIRECTORY}/inbox`,
  'n=0',
  'while true; do',
  '  n=$((n+1))',
  '  echo "tick-$n"',
  `  name=$(printf '%019d' $n)-$n.rec`,
  `  printf 'K1\\ntick\\n\\n{"n":%s}' $n > ${HOOK_DIRECTORY}/inbox/.$name`,
  `  mv ${HOOK_DIRECTORY}/inbox/.$name ${HOOK_DIRECTORY}/inbox/$name`,
  '  sleep 0.3',
  'done',
].join('\n');

function agentSpawn(sessionId: string, script: string) {
  return {
    sessionId,
    projectId: 'quit-rig-project',
    agentName: null,
    transient: false,
    file: '/bin/bash',
    args: ['-c', script],
    cwd: '/home/dev',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/dev', TERM: 'xterm-256color' },
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    taskId: randomUUID(),
  };
}

const hookNumbers = (events: PtyHostEvent[]): number[] => events
  .filter((event): event is Extract<PtyHostEvent, { type: 'hookFile' }> => event.type === 'hookFile' && event.sessionId === COUNTER_SESSION)
  .map((event) => Number(/"n":(\d+)/.exec(event.content)?.[1] ?? Number.NaN));

async function main(): Promise<void> {
  const run = createSshRunner({ sshPath: options.sshPath, args: options.sshArgs });
  remoteCommand = (await installHost(run, options.asset)).relayCommand;

  // Process A: starts the agents, takes some hook files, and lets go without ending anything.
  const first = openLink('process A');
  first.link.start();
  await waitFor('process A to connect', first.connected, 30_000);
  const firstClient = new PtyHostClient(first.link);
  // The client takes over the link's event listener, so what it does not handle itself is collected here.
  firstClient.setEventHandler((event) => first.events.push(event));
  const counterSpawn = await firstClient.spawn(agentSpawn(COUNTER_SESSION, COUNTER_SCRIPT));
  const shortSpawn = await firstClient.spawn(agentSpawn(SHORT_SESSION, 'sleep 2; exit 3'));
  if (!counterSpawn.ok || !shortSpawn.ok) throw new Error('the stub agents did not start');
  await first.link.requestHelper('watchHooks', { sessionId: COUNTER_SESSION, directory: HOOK_DIRECTORY });
  await waitFor('process A to take a few hook files', () => hookNumbers(first.events).length >= 3, 15_000);
  const takenByFirst = hookNumbers(first.events).slice(0, 3);
  // The app stores a record and then has the host drop its copy. Here it gets as far as the first two: the third
  // models a crash between storing and removing, which the host must send again rather than lose.
  const recordPath = (value: number): string => `${HOOK_DIRECTORY}/inbox/${String(value).padStart(19, '0')}-${value}.rec`;
  await first.link.requestHelper('removeFiles', { paths: [recordPath(takenByFirst[0]), recordPath(takenByFirst[1])] });
  const pidBefore = (await first.link.requestHelper('snapshot', {})).sessions.find((record) => record.sessionId === COUNTER_SESSION)?.pid;
  // The quit: the link goes away and nothing is sent to end anything.
  first.link.stop();
  check('process A took hook files in order before it let go', takenByFirst.every((value, index) => index === 0 || value === takenByFirst[index - 1] + 1), takenByFirst.join(','));

  // Nobody is attached for a while. The counter keeps going, the short agent exits.
  await sleep(4_000);

  // Process B: a new boot, a new link.
  const second = openLink('process B');
  second.link.start();
  await waitFor('process B to connect', second.connected, 30_000);
  const snapshot = await second.link.requestHelper('snapshot', {});
  const counterRecord = snapshot.sessions.find((record) => record.sessionId === COUNTER_SESSION);
  const shortRecord = snapshot.sessions.find((record) => record.sessionId === SHORT_SESSION);
  check('the counter agent outlived the quit', counterRecord?.alive === true);
  check('and is the same process', counterRecord?.pid !== undefined && counterRecord.pid === pidBefore, `${pidBefore} then ${counterRecord?.pid}`);
  check('the short agent that exited while nobody was attached is reported dead with its code', shortRecord?.alive === false && shortRecord.exitCode === 3, JSON.stringify(shortRecord));

  const outcomes = await second.link.rejoinSessions([
    { sessionId: COUNTER_SESSION, ptyId: 1 },
    { sessionId: SHORT_SESSION, ptyId: 2 },
  ]);
  check('the live one is rejoined', outcomes.find((outcome) => outcome.sessionId === COUNTER_SESSION)?.rejoined === true);
  check('the dead one is not', outcomes.find((outcome) => outcome.sessionId === SHORT_SESSION)?.rejoined === false);

  // Reattach the hook watch, as the app does for a rejoined session, and take what waited on the host.
  await second.link.requestHelper('watchHooks', { sessionId: COUNTER_SESSION, directory: HOOK_DIRECTORY });
  await waitFor('process B to receive the held hook files', () => hookNumbers(second.events).length >= 12, 20_000);
  const takenBySecond = hookNumbers(second.events);
  const stored = takenByFirst.slice(0, 2);
  const everything = [...stored, ...takenBySecond];
  const contiguous = everything.every((value, index) => index === 0 || value === everything[index - 1] + 1);
  check('B receives the files that waited, in order, with no gap against what A stored', contiguous, `A stored ${stored.join(',')}, B took ${takenBySecond.slice(0, 8).join(',')}...`);
  check('and the one A took but never stored comes again, rather than being lost', takenBySecond[0] === takenByFirst[2], `first of B: ${takenBySecond[0]}`);
  check('and they include files written while nobody was attached', takenBySecond.length > 8, `${takenBySecond.length} files`);

  const scrollback = await second.link.request('getScrollback', { sessionId: COUNTER_SESSION, settle: true });
  const ticksSeen = [...scrollback.matchAll(/tick-(\d+)/g)].map((match) => Number(match[1]));
  check('the scrollback holds the whole counter, including what printed while nobody was attached', ticksSeen.length > 10 && ticksSeen[0] === 1, `first ${ticksSeen[0]}, last ${ticksSeen[ticksSeen.length - 1]}, ${ticksSeen.length} ticks`);

  // The rejoined agent speaks under the new PTY id.
  await second.link.requestHelper('runCommand', { file: 'sh', args: ['-c', 'true'], timeoutMs: 5_000 });
  check('and still runs after B has joined it', ((await second.link.requestHelper('snapshot', {})).sessions.find((record) => record.sessionId === COUNTER_SESSION)?.alive) === true);

  // Clean up the stub so the next run starts clean.
  second.link.post({ type: 'kill', ptyId: 1 });
  await sleep(500);
  second.link.stop();

  finishChecks();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
});
