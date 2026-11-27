/**
 * The client half of the #1227 update rig (`node scripts/ssh-link-rig.mjs --client update --work <dir>`): an app
 * update replacing an older program on a real host, through the real updater (`program-update.ts`), the real
 * `RemoteHostService` gate, the real link, helper and `ssh`. The unit tier runs the updater against a fake host;
 * this is what proves the stop, the relay starting the new version, and the agent coming back on it.
 *
 * Two phases, each from a host running the old version:
 *
 * 1. **Idle.** The old daemon holds nothing. A link with the new version's relay joins it, and the updater must
 *    swap it at once.
 * 2. **Busy.** A stub agent on the old daemon is in a turn when the new link takes it back. The updater must wait
 *    for the turn to end, stop the agent, stop the daemon, and resume the agent on the new daemon with its
 *    conversation (a file it appends to) intact.
 *
 * The agent is a stub, not Claude: the rig image has no CLI and no account. It runs as a child of a shell, as an
 * agent does under its login shell, so the hangup and the wait for its exit are the real ones. It records the time
 * from each first connection to the agents back.
 *
 * Not product code, and `tsconfig.json` covers `src/` only, so `npm run typecheck` does not see it.
 */

import { randomUUID } from 'node:crypto';
import { RemoteLink, type RemoteLinkState } from '../src/main/remote/link/remote-link';
import { openSshStream } from '../src/main/remote/link/ssh-connection';
import { createSshRunner } from '../src/main/remote/link/ssh-run';
import { installHost, type HostAsset } from '../src/main/remote/link/host-installer';
import { RemoteHostService } from '../src/main/remote/remote-host-service';
import { createProgramUpdater, type HeldRemoteSession, type ProgramUpdater } from '../src/main/remote/program-update';
import { STOP_DAEMON_SCRIPT } from '../src/main/remote/program-update-scripts';
import type { RemoteHostRequest } from '../src/main/remote/protocol/messages';
import { check, finishChecks, sleep, waitFor } from './ssh-rig-checks';

interface Options {
  sshPath: string;
  sshArgs: string[];
  workDirectory: string;
  assets: { old: HostAsset; current: HostAsset };
  /** A real Claude staged on the host (`--claude-binary`), for the third phase. */
  claude?: { binary: string; portFile: string; cwd: string };
}

const options = JSON.parse(process.argv[2]) as Options;
const HOST_ID = 'update-rig-host';
const HOME = '/home/dev';
const CONVERSATION = `${HOME}/update-rig/conversation.log`;
const TURN_SECONDS = 6;
const log = (line: string): void => { process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`); };

/**
 * The stub agent. Started, it takes one turn (`working`, a pause, `ready>`); resumed, it says how much of its
 * conversation it found and adds to it. Either way it then waits at its prompt as a child of the shell.
 */
const AGENT_SCRIPT = [
  'conversation=$1; mode=$2; turn=$3',
  'mkdir -p "$(dirname "$conversation")"',
  'if [ "$mode" = resume ]; then',
  '  echo "resumed with $(wc -l < "$conversation") lines"',
  '  echo "turn: resumed" >> "$conversation"',
  'else',
  '  echo "turn: first" >> "$conversation"',
  '  echo working',
  '  sleep "$turn"',
  'fi',
  "echo 'ready>'",
  // Not the last command, so bash does not exec it: the agent stays the shell's child.
  'sleep 100000; true',
].join('\n');

let currentLink: RemoteLink | null = null;
let linkState: RemoteLinkState = 'connecting';
let updater: ProgramUpdater | null = null;
let nextPtyId = 1;

/** This app's one agent, as the updater sees it. */
let agent: { sessionId: string; ptyId: number; live: boolean } | null = null;
/** Whether the agent's screen ends at its prompt, read from its scrollback on a timer. */
let agentAtPrompt = false;
let readyAt = 0;
/** When the busy phase's swap took its hold, which must come after the turn ended. */
let heldAt = 0;

function openLink(label: string, remoteCommand: string): RemoteLink {
  const link = new RemoteLink({
    identity: { installId: 'ssh-update-rig', bootId: randomUUID(), label },
    connect: async () => openSshStream({ sshPath: options.sshPath, args: options.sshArgs, remoteCommand }),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    endpoint: { heartbeatMs: 1000, deadAfterMs: 6000 },
    log: (line) => process.stderr.write(`[link ${label}] ${line}\n`),
  });
  link.setHandlers({
    onStateChanged: (next) => {
      if (link !== currentLink) return;
      linkState = next;
      log(`link ${label}: ${next}`);
      updater?.onLinkState(HOST_ID, next);
    },
  });
  return link;
}

/** The real service, over the rig's link instead of the pty host's router. */
const hostService = new RemoteHostService({
  sshPath: options.sshPath,
  hosts: { getById: () => ({ id: HOST_ID, name: 'update rig', destination: 'rig', key_path: null, key_created: false, created_at: '' }), list: () => [] },
  send: async (request: RemoteHostRequest) => {
    if (request.op !== 'helper' || !currentLink) throw new Error(`the rig sends only helper requests, not ${request.op}`);
    return currentLink.requestHelper(request.method, request.params as never, request.timeoutMs);
  },
  asset: () => null,
  identity: { installId: 'ssh-update-rig', label: 'update rig' },
});

/** What an agent runs: a shell that starts the agent as its child, as a login shell starts one. */
interface AgentLaunch {
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

const stubLaunch = (mode: 'start' | 'resume'): AgentLaunch => ({ args: ['-c', AGENT_SCRIPT, 'agent', CONVERSATION, mode, String(TURN_SECONDS)] });

async function spawnAgent(launch: AgentLaunch): Promise<void> {
  if (!currentLink) throw new Error('no link');
  const sessionId = `update-rig-${randomUUID().slice(0, 8)}`;
  const ptyId = nextPtyId;
  nextPtyId += 1;
  const result = await currentLink.request('spawn', {
    sessionId, ptyId, sentAtMs: Date.now(), projectId: 'update-rig-project', agentName: null, transient: false,
    file: '/bin/bash', args: launch.args, cwd: launch.cwd ?? HOME,
    env: { PATH: `${HOME}/bin:/usr/local/bin:/usr/bin:/bin`, HOME, TERM: 'xterm-256color', ...launch.env }, cols: 120, rows: 30,
    carryoverFromSessionId: null, agentSessionIdKnown: false, taskId: 'update-rig-task',
  });
  if (!result.ok) throw new Error(`the agent did not start: ${result.error.message}`);
  agent = { sessionId, ptyId, live: true };
  agentAtPrompt = false;
}

/** How the poller tells the agent is at its prompt. The stub prints one; Claude's transcript says its turn ended. */
let idleProbe: (sessionId: string) => Promise<boolean> = async (sessionId) => {
  const text = await scrollbackOf(sessionId);
  return text.lastIndexOf('ready>') > text.lastIndexOf('working');
};

async function scrollbackOf(sessionId: string): Promise<string> {
  if (!currentLink) return '';
  try {
    return await currentLink.request('getScrollback', { sessionId, settle: false });
  } catch {
    return '';
  }
}

/** Read the agent's screen every 250 ms, and tell the updater when that can change its answer. */
let changeListener: (() => void) | null = null;
const poller = setInterval(() => {
  const current = agent;
  if (!current?.live || linkState !== 'connected') return;
  void idleProbe(current.sessionId).then((atPrompt) => {
    // The first prompt only: the resumed agent prints its own later.
    if (atPrompt && !agentAtPrompt && readyAt === 0) readyAt = Date.now();
    if (atPrompt !== agentAtPrompt) {
      agentAtPrompt = atPrompt;
      changeListener?.();
    }
  });
}, 250);

function makeUpdater(appVersion: string, resumed: () => void, resumeLaunch: AgentLaunch = stubLaunch('resume')): ProgramUpdater {
  return createProgramUpdater({
    appVersion: () => appVersion,
    programInfo: (hostId) => hostService.programInfo(hostId),
    snapshot: (hostId) => hostService.snapshot(hostId),
    runCommand: (hostId, request) => hostService.runCommand(hostId, request),
    supports: (hostId, method) => hostService.supports(hostId, method),
    retireIfIdle: (hostId, daemonPid) => hostService.retireIfIdle(hostId, daemonPid),
    liveRemotePtys: () => (agent?.live ? [{ sessionId: agent.sessionId, ptyId: agent.ptyId }] : []),
    heldSessions: (): HeldRemoteSession[] => (agent?.live ? [{ sessionId: agent.sessionId, taskId: 'update-rig-task', projectId: 'update-rig-project', kind: 'task' }] : []),
    isAtSafePoint: () => agentAtPrompt,
    hasStartInFlight: () => false,
    hasFreshDraft: async () => false,
    suspendTask: async (_session, stillEligible) => {
      if (!agent?.live || !currentLink) return 'not-live';
      if (!stillEligible()) return 'declined';
      // The hangup a suspend sends a Claude on Linux: the PTY's kill, nothing typed.
      currentLink.post({ type: 'kill', ptyId: agent.ptyId });
      agent.live = false;
      log('suspended the agent');
      return 'paused';
    },
    terminalRestartability: () => 'restart',
    endTerminal: () => 'failed',
    endUnusedTerminal: () => undefined,
    resumeTasks: async () => {
      await spawnAgent(resumeLaunch);
      resumed();
    },
    holdStarts: () => {
      if (heldAt === 0) heldAt = Date.now();
      log('starts held');
      return () => log('starts released');
    },
    onSessionChange: (listener) => {
      changeListener = listener;
      return () => { changeListener = null; };
    },
    stageReporter: { report: (error, stage) => { log(`REPORTED stage ${stage}: ${error instanceof Error ? error.message : String(error)}`); } },
    log,
  });
}

async function connect(label: string, remoteCommand: string): Promise<number> {
  currentLink?.stop();
  linkState = 'connecting';
  const link = openLink(label, remoteCommand);
  currentLink = link;
  hostService.forgetProgram(HOST_ID);
  link.start();
  await waitFor(`${label} to connect`, () => linkState === 'connected', 30_000);
  return Date.now();
}

async function programVersionAndPid(): Promise<{ version: string | null; pid: number }> {
  const info = await hostService.programInfo(HOST_ID);
  const snapshot = await hostService.snapshot(HOST_ID);
  return { version: info.version, pid: snapshot.daemonPid };
}

async function main(): Promise<void> {
  const run = createSshRunner({ sshPath: options.sshPath, args: options.sshArgs });
  const oldRelay = (await installHost(run, options.assets.old)).relayCommand;
  const currentRelay = (await installHost(run, options.assets.current)).relayCommand;
  const oldVersion = options.assets.old.version;
  const appVersion = options.assets.current.version;
  log(`installed ${oldVersion} and ${appVersion}`);

  // Phase 1: an old daemon holding nothing.
  await connect('old app', oldRelay);
  const before = await programVersionAndPid();
  check('the old app started the old program', before.version === oldVersion, `${before.version}`);
  currentLink?.stop();
  currentLink = null;
  await sleep(1_000);

  let idleDone = false;
  updater = makeUpdater(appVersion, () => undefined);
  const idleConnectedAt = await connect('updated app (idle)', currentRelay);
  const joined = await programVersionAndPid();
  check('the updated app first joined the old program', joined.version === oldVersion && joined.pid === before.pid, `${joined.version} pid ${joined.pid}`);
  void updater.consider(HOST_ID);
  await waitFor('the idle swap', async () => {
    if (linkState !== 'connected') return false;
    try {
      const now = await programVersionAndPid();
      idleDone = now.version === appVersion;
      return idleDone;
    } catch {
      return false;
    }
  }, 90_000);
  const idleSwapMs = Date.now() - idleConnectedAt;
  const afterIdle = await programVersionAndPid();
  check('the idle swap left the new program running under a new pid', afterIdle.version === appVersion && afterIdle.pid !== before.pid, `${afterIdle.version} pid ${afterIdle.pid}`);
  // A stop the link resent to the new program must not end it too.
  await sleep(2_000);
  const settledIdle = linkState === 'connected' ? await programVersionAndPid() : null;
  check('and the new program is still the same one two seconds later', settledIdle?.pid === afterIdle.pid, `pid ${settledIdle?.pid ?? 'none'}`);
  const presence = await hostService.pathPresence(HOST_ID, [`${HOME}/.kangentic/host/${oldVersion}`]);
  check('the old version stays on disk until the prune', presence[0] === 'present');
  updater.dispose();

  // Back to an old daemon for phase 2: stop the new one with the same script, letting go of the link first so
  // it does not dial the new version straight back, then start the old one.
  await hostService.runCommand(HOST_ID, { file: 'sh', args: ['-c', STOP_DAEMON_SCRIPT, 'kangentic-stop', String(afterIdle.pid), appVersion], timeoutMs: 20_000 });
  currentLink?.stop();
  currentLink = null;
  await sleep(3_000);
  await connect('old app again', oldRelay);
  const oldAgain = await programVersionAndPid();
  check('the old program runs again for the busy phase', oldAgain.version === oldVersion, `${oldAgain.version}`);
  await spawnAgent(stubLaunch('start'));
  const startedAgent = agent;
  await waitFor('the agent to be in its turn', async () => startedAgent !== null && (await scrollbackOf(startedAgent.sessionId)).includes('working'), 15_000);
  const shellPid = (await hostService.snapshot(HOST_ID)).sessions.find((record) => record.sessionId === startedAgent?.sessionId)?.pid;
  // The quit: the link lets go, the agent keeps running.
  currentLink?.stop();
  currentLink = null;
  linkState = 'connecting';

  // Phase 2: the updated app takes the agent back mid-turn.
  let resumedAt = 0;
  readyAt = 0;
  heldAt = 0;
  updater = makeUpdater(appVersion, () => { resumedAt = Date.now(); });
  const busyConnectedAt = await connect('updated app (busy)', currentRelay);
  if (!startedAgent) throw new Error('no agent');
  const rejoinPtyId = nextPtyId;
  nextPtyId += 1;
  const outcome = await currentLink!.rejoinSessions([{ sessionId: startedAgent.sessionId, ptyId: rejoinPtyId }]);
  check('the updated app took the agent back from the old program', outcome[0]?.rejoined === true);
  agent = { sessionId: startedAgent.sessionId, ptyId: rejoinPtyId, live: true };
  agentAtPrompt = false;
  void updater.consider(HOST_ID);
  await waitFor('the agent to come back on the new program', async () => {
    if (!resumedAt || !agent?.live) return false;
    return (await scrollbackOf(agent.sessionId)).includes('resumed with');
  }, 120_000);
  const backAt = Date.now();
  const busySwapMs = backAt - busyConnectedAt;
  const afterBusy = await programVersionAndPid();
  check('the busy swap left the new program running', afterBusy.version === appVersion && afterBusy.pid !== oldAgain.pid, `${afterBusy.version} pid ${afterBusy.pid}`);
  await sleep(2_000);
  const settledBusy = linkState === 'connected' ? await programVersionAndPid() : null;
  check('and it still runs the resumed agent two seconds later', settledBusy?.pid === afterBusy.pid
    && (await hostService.snapshot(HOST_ID)).sessions.some((record) => record.sessionId === agent?.sessionId && record.alive), `pid ${settledBusy?.pid ?? 'none'}`);
  check('the swap waited for the turn to end', readyAt > 0 && heldAt >= readyAt && resumedAt > heldAt,
    `turn ended at +${readyAt - busyConnectedAt} ms, swap held starts at +${heldAt - busyConnectedAt} ms, resumed at +${resumedAt - busyConnectedAt} ms`);
  const resumedScreen = agent ? await scrollbackOf(agent.sessionId) : '';
  check('the resumed agent found its conversation whole', /resumed with 1 lines/.test(resumedScreen), resumedScreen.split('\n').find((line) => line.includes('resumed')));
  const conversation = await hostService.readFile(HOST_ID, CONVERSATION);
  check('and adds to it on the new program', conversation.content === 'turn: first\nturn: resumed\n', JSON.stringify(conversation.content));
  if (shellPid) {
    const leftovers = await hostService.runCommand(HOST_ID, { file: 'sh', args: ['-c', 'kill -0 "$1" 2>/dev/null && echo alive || echo gone', 'rig', String(shellPid)], timeoutMs: 5_000 });
    check("the old agent's shell is gone", leftovers.stdout.trim() === 'gone');
  }
  const stillOld = await hostService.pathPresence(HOST_ID, [`${HOME}/.kangentic/host/${oldVersion}`]);
  check('the old version is still on disk', stillOld[0] === 'present');

  process.stderr.write(`MEASURED idle swap ${idleSwapMs} ms from first connection to the new program; busy swap ${busySwapMs} ms from first connection to the agent back (turn ${TURN_SECONDS} s of it)\n`);
  check(`measured: idle ${idleSwapMs} ms, busy ${busySwapMs} ms`, true);

  if (options.claude) {
    if (agent?.live && currentLink) currentLink.post({ type: 'kill', ptyId: agent.ptyId });
    agent = null;
    updater.dispose();
    await claudePhase(options.claude, oldRelay, currentRelay, oldVersion, appVersion);
  }

  // Clean up the stub so the next run starts clean.
  if (agent?.live && currentLink) currentLink.post({ type: 'kill', ptyId: agent.ptyId });
  await sleep(500);
  updater.dispose();
  clearInterval(poller);
  currentLink?.stop();
  finishChecks();
}

const CLAUDE_PROMPT = 'Reply with the single word OK';

/** What a Claude transcript holds: the rig's prompts, whether the last turn ended with a reply, and whether every line parses. */
async function claudeTranscript(transcriptPath: string): Promise<{ prompts: number; turnEnded: boolean; whole: boolean; firstLine: string | null }> {
  const file = await hostService.readFile(HOST_ID, transcriptPath).catch(() => ({ exists: false, content: null }));
  if (!file.content) return { prompts: 0, turnEnded: false, whole: true, firstLine: null };
  const lines = file.content.split('\n').filter((line) => line.trim() !== '');
  let prompts = 0;
  let lastKind: 'user' | 'assistant' | null = null;
  let whole = true;
  for (const line of lines) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      whole = false;
      continue;
    }
    if (entry.type === 'user' && typeof entry.message?.content === 'string' && entry.message.content.includes(CLAUDE_PROMPT)) {
      prompts += 1;
      lastKind = 'user';
    } else if (entry.type === 'assistant') {
      lastKind = 'assistant';
    }
  }
  return { prompts, turnEnded: lastKind === 'assistant', whole, firstLine: lines[0] ?? null };
}

/**
 * The third phase: a real Claude on the old program, idle after one turn, taken back by the updated app,
 * suspended with the hangup a suspend sends it on Linux, and resumed on the new program with `--resume`.
 */
async function claudePhase(claude: NonNullable<Options['claude']>, oldRelay: string, currentRelay: string, oldVersion: string, appVersion: string): Promise<void> {
  // Back to the old program.
  const running = await programVersionAndPid();
  await hostService.runCommand(HOST_ID, { file: 'sh', args: ['-c', STOP_DAEMON_SCRIPT, 'kangentic-stop', String(running.pid), appVersion], timeoutMs: 20_000 });
  currentLink?.stop();
  currentLink = null;
  await sleep(3_000);
  await connect('old app (Claude)', oldRelay);
  check('the old program runs again for the Claude phase', (await programVersionAndPid()).version === oldVersion);

  const port = (await hostService.readFile(HOST_ID, claude.portFile)).content?.trim();
  if (!port) throw new Error('the Messages stand-in wrote no port');
  const conversationId = randomUUID();
  const transcriptPath = `${HOME}/.claude/projects/${claude.cwd.replaceAll('/', '-')}/${conversationId}.jsonl`;
  // As Kangentic starts Claude on a host: no flicker renderer, no autoupdate, the agent a child of the shell.
  const claudeEnv = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'update-rig-placeholder',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_NO_FLICKER: '1',
    COLORTERM: 'truecolor',
  };
  const claudeLaunch = (flag: '--session-id' | '--resume'): AgentLaunch => ({
    args: ['-c', `cd "$1" && "$2" ${flag} "$3" "$4"; true`, 'agent', claude.cwd, claude.binary, conversationId, CLAUDE_PROMPT],
    env: claudeEnv,
    cwd: claude.cwd,
  });
  let expectedPrompts = 1;
  idleProbe = async () => {
    const transcript = await claudeTranscript(transcriptPath);
    return transcript.prompts >= expectedPrompts && transcript.turnEnded;
  };

  await spawnAgent(claudeLaunch('--session-id'));
  const claudeAgent = agent;
  try {
    await waitFor('Claude to answer its first prompt on the old program', async () => (await claudeTranscript(transcriptPath)).turnEnded, 90_000);
  } catch (error) {
    const screen = claudeAgent ? await scrollbackOf(claudeAgent.sessionId) : '';
    log(`Claude's screen:\n${screen.slice(-3000)}`);
    throw error;
  }
  const firstTranscript = await claudeTranscript(transcriptPath);
  check('a real Claude answered on the old program', firstTranscript.prompts === 1 && firstTranscript.turnEnded);
  // The quit: the link lets go, Claude keeps running at its prompt.
  currentLink?.stop();
  currentLink = null;
  linkState = 'connecting';

  let resumedAt = 0;
  readyAt = 0;
  heldAt = 0;
  expectedPrompts = 2;
  updater = makeUpdater(appVersion, () => { resumedAt = Date.now(); }, claudeLaunch('--resume'));
  const connectedAt = await connect('updated app (Claude)', currentRelay);
  if (!claudeAgent) throw new Error('no Claude');
  const rejoinPtyId = nextPtyId;
  nextPtyId += 1;
  const outcome = await currentLink!.rejoinSessions([{ sessionId: claudeAgent.sessionId, ptyId: rejoinPtyId }]);
  check('the updated app took Claude back from the old program', outcome[0]?.rejoined === true);
  agent = { sessionId: claudeAgent.sessionId, ptyId: rejoinPtyId, live: true };
  agentAtPrompt = false;
  // Idle at its prompt with one prompt answered: the probe reads two only after the resume.
  expectedPrompts = 1;
  void updater.consider(HOST_ID);
  await waitFor('the swap to resume Claude', () => resumedAt > 0, 120_000);
  expectedPrompts = 2;
  try {
    await waitFor('the resumed Claude to answer its second prompt', async () => {
      const transcript = await claudeTranscript(transcriptPath);
      return transcript.prompts === 2 && transcript.turnEnded;
    }, 90_000);
  } catch (error) {
    const screen = agent ? await scrollbackOf(agent.sessionId) : '';
    log(`resumed Claude's screen:\n${screen.slice(-3000)}`);
    throw error;
  }
  const backMs = Date.now() - connectedAt;
  const after = await programVersionAndPid();
  check('Claude came back on the new program', after.version === appVersion, `${after.version}`);
  const resumedTranscript = await claudeTranscript(transcriptPath);
  check('in the same conversation, its first turn kept', resumedTranscript.prompts === 2 && resumedTranscript.firstLine === firstTranscript.firstLine);
  check('and every transcript line whole after the hangup', resumedTranscript.whole);
  process.stderr.write(`MEASURED Claude swap ${backMs} ms from first connection to Claude resumed and answering\n`);
  check(`measured: Claude ${backMs} ms`, true);
  if (agent?.live && currentLink) currentLink.post({ type: 'kill', ptyId: agent.ptyId });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
});
