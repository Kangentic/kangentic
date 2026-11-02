#!/usr/bin/env node
/**
 * #913 Phase 0, quit delivery spike: does one `suspendAll` frame reach the host through an Electron
 * utility process when the app quits? Not shipped and not used by CI.
 *
 * It runs the minimal Electron app in scripts/probe-ssh-rig/quit-app/ with this checkout's Electron
 * binary, against a helper stand-in (quit-host.py) in a Docker sshd container built from
 * scripts/probe-ssh-rig/. Frames are confirmed from the helper's own log, read at the end of a case.
 *
 * Usage, from a clean start (the image built, a scratch key and its .pub beside it):
 *
 *   docker build -t kangentic-ssh-rig scripts/probe-ssh-rig
 *   node scripts/probe-ssh-quit.mjs --key <private key> --out <empty folder> [options] --kangentic-no-activity-hold
 *
 * Options:
 *   --case <name>      one case, or a comma list; `--list` prints the names. Default: every case.
 *   --runs <count>     override a case's run count
 *   --known-hosts <f>  scratch known_hosts file. Default <out>/known_hosts-quit.
 *   --ssh <file>       the ssh program. Default on Windows: the system's OpenSSH under SystemRoot,
 *                      not whatever PATH finds, since Git Bash puts its own ssh first.
 *   --port <port>      the container's published ssh port. Default 2236.
 *   --container <name> Default kangentic-ssh-rig-quit. Started when absent, and left running unless
 *                      --remove-container is given.
 *   --kangentic-no-activity-hold  accepted and ignored, see CLAUDE.md
 *
 * Each case writes <out>/<case>.jsonl (one record per run) and <out>/<case>.summary.json.
 *
 * Paths come from arguments and from this file's location, so nothing here names a machine.
 * Only the pids this script started are ever signalled.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFolder = path.dirname(fileURLToPath(import.meta.url));
const appFolder = path.join(scriptFolder, 'probe-ssh-rig', 'quit-app');
const repositoryRoot = path.dirname(scriptFolder);
const electronBinary = path.join(
  repositoryRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const HOST_FOLDER = '/tmp/quit-host';
const HOST_SCRIPT = `${HOST_FOLDER}/quit-host.py`;
const RUN_WATCHDOG_MS = 40000;
const DRAIN_DEADLINE_MS = 1500;
const EXIT_MARGIN_MS = 200;
const FRAME_BYTES = 4096;
const PARALLEL_WORKERS = 4;

function parseArguments(argv) {
  const parsed = { port: 2236, container: 'kangentic-ssh-rig-quit' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--case') parsed.cases = argv[++index].split(',');
    else if (argument === '--runs') parsed.runs = Number(argv[++index]);
    else if (argument === '--port') parsed.port = Number(argv[++index]);
    else if (argument === '--container') parsed.container = argv[++index];
    else if (argument === '--key') parsed.key = argv[++index];
    else if (argument === '--out') parsed.out = argv[++index];
    else if (argument === '--known-hosts') parsed.knownHosts = argv[++index];
    else if (argument === '--ssh') parsed.ssh = argv[++index];
    else if (argument === '--list') parsed.list = true;
    else if (argument === '--remove-container') parsed.removeContainer = true;
    else if (argument === '--kangentic-no-activity-hold') continue;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return parsed;
}

const options = parseArguments(process.argv.slice(2));

function runCommand(file, commandArguments, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, commandArguments, { windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`${file} ${commandArguments.join(' ')}: ${stderr || error.message}`));
        return;
      }
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function docker(...commandArguments) {
  return runCommand('docker', commandArguments);
}

function dockerExec(...commandArguments) {
  return docker('exec', options.container, ...commandArguments);
}

function dockerExecAllowFailure(...commandArguments) {
  return runCommand('docker', ['exec', options.container, ...commandArguments], { allowFailure: true });
}

async function ensureContainer() {
  const inspected = await runCommand(
    'docker',
    ['inspect', '-f', '{{.State.Running}}', options.container],
    { allowFailure: true },
  );
  if (inspected.stdout.trim() === 'true') return;
  await runCommand('docker', ['rm', '-f', options.container], { allowFailure: true });
  const publicKey = fs.readFileSync(`${options.key}.pub`, 'utf8').trim();
  await docker(
    'run', '-d', '--name', options.container, '--cap-add', 'NET_ADMIN',
    '-p', `127.0.0.1:${options.port}:22`, '-e', `AUTHORIZED_KEY=${publicKey}`, 'kangentic-ssh-rig',
  );
  await delay(2000);
}

async function startHelper() {
  await dockerExecAllowFailure('pkill', '-f', 'quit-host.py');
  await dockerExec('mkdir', '-p', HOST_FOLDER);
  await docker('cp', path.join(appFolder, 'quit-host.py'), `${options.container}:${HOST_SCRIPT}`);
  await dockerExec('chown', '-R', 'dev:dev', HOST_FOLDER);
  await dockerExec('rm', '-f', `${HOST_FOLDER}/frames.log`, `${HOST_FOLDER}/helper.sock`);
  await docker('exec', '-d', '-u', 'dev', options.container, 'python3', HOST_SCRIPT, 'daemon', HOST_FOLDER);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = await dockerExecAllowFailure('test', '-S', `${HOST_FOLDER}/helper.sock`);
    if (probe.code === 0) return;
    await delay(50);
  }
  throw new Error('helper socket never appeared');
}

async function readHelperLog() {
  const { stdout } = await dockerExec('cat', `${HOST_FOLDER}/frames.log`);
  return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function clearNetwork() {
  await dockerExecAllowFailure('tc', 'qdisc', 'del', 'dev', 'eth0', 'root');
  await dockerExecAllowFailure('tc', 'qdisc', 'del', 'dev', 'eth0', 'ingress');
}

async function setRoundTripDelay(milliseconds) {
  await clearNetwork();
  if (milliseconds > 0) {
    await dockerExec('tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'delay', `${milliseconds}ms`);
  }
}

async function setEgressLoss() {
  await dockerExec('tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'loss', '100%');
}

/** netem shapes egress only, so an ingress drop filter makes the blackhole two-way. */
async function setBlackhole() {
  await dockerExec('tc', 'qdisc', 'add', 'dev', 'eth0', 'ingress');
  await dockerExec(
    'tc', 'filter', 'add', 'dev', 'eth0', 'parent', 'ffff:', 'protocol', 'all',
    'prio', '1', 'u32', 'match', 'u32', '0', '0', 'action', 'drop',
  );
  await setEgressLoss();
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function now() {
  return performance.timeOrigin + performance.now();
}

async function waitGone(pid, startedAt, budgetMs) {
  if (!pid) return null;
  while (isAlive(pid)) {
    if (now() - startedAt > budgetMs) return null;
    await delay(5);
  }
  return now() - startedAt;
}

function sshArguments() {
  return [
    '-p', String(options.port),
    '-i', options.key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${options.knownHosts}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ForwardAgent=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'RekeyLimit=default 1h',
    '-F', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-T',
    'dev@127.0.0.1',
    'python3', HOST_SCRIPT, 'relay', HOST_FOLDER,
  ];
}

function baseConfig(runId, caseFolder) {
  return {
    mode: 'quit',
    runId,
    arm: 'drain',
    trigger: 'app-quit',
    reenter: 'exit',
    linkExit: 'ack',
    sshOnExit: 'leave',
    sshDetached: false,
    linkBusyMs: 0,
    frameBytes: FRAME_BYTES,
    deadlineMs: DRAIN_DEADLINE_MS,
    exitMarginMs: EXIT_MARGIN_MS,
    pollMs: 25,
    settleTicks: 4,
    hangMs: 20000,
    userDataPath: path.join(options.out, 'userdata'),
    mainLogPath: path.join(caseFolder, `${runId}.main.json`),
    linkLogPath: path.join(caseFolder, `${runId}.link.jsonl`),
    goFilePath: path.join(caseFolder, `${runId}.go`),
    sshExecutable: options.ssh,
    sshArguments: sshArguments(),
  };
}

function launch(config, onLine) {
  const environment = { ...process.env, QUIT_PROBE_CONFIG: JSON.stringify(config) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [appFolder], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      onLine(buffered.slice(0, newlineIndex).trim());
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
    }
  });
  child.stderr.resume();
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, exitAt: now() }));
  });
  return { child, exited };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readLinkLog(filePath) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  // A link killed mid-write leaves a cut line. The lines before it still say what the link saw.
  const merged = { corruptLines: 0 };
  for (const line of lines) {
    try {
      Object.assign(merged, JSON.parse(line));
    } catch {
      merged.corruptLines += 1;
    }
  }
  return merged;
}

/**
 * One launch through one quit. `beforeTrigger` runs with the link up, `externalTrigger` replaces the
 * go file when the quit comes from outside the app.
 */
async function runOneQuit(config, { beforeTrigger, externalTrigger, leftoverBudgetMs = 3000 } = {}) {
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const { child, exited } = launch(config, (line) => {
    if (line.startsWith('ready ')) resolveReady(JSON.parse(line.slice(6)));
  });
  const watchdog = setTimeout(() => {
    resolveReady(null);
    child.kill();
  }, RUN_WATCHDOG_MS);

  const pids = await ready;
  let timedOut = pids === null;
  let externalTriggerAt = null;
  let linkAliveAtTrigger = null;
  let sshAliveAtTrigger = null;
  if (pids) {
    try {
      if (beforeTrigger) await beforeTrigger(pids);
      linkAliveAtTrigger = isAlive(pids.linkPid);
      sshAliveAtTrigger = isAlive(pids.sshPid);
      if (externalTrigger) {
        externalTriggerAt = now();
        await externalTrigger(pids);
      } else {
        fs.writeFileSync(config.goFilePath, 'go');
      }
    } catch (error) {
      // No quit will follow, so the app and its link end here and not at the watchdog.
      clearTimeout(watchdog);
      child.kill();
      throw error;
    }
  }
  const { code, signal, exitAt } = await exited;
  clearTimeout(watchdog);

  const linkGoneAfterExitMs = pids ? await waitGone(pids.linkPid, exitAt, leftoverBudgetMs) : null;
  const sshGoneAfterExitMs = pids ? await waitGone(pids.sshPid, exitAt, leftoverBudgetMs) : null;

  const main = readJson(config.mainLogPath);
  const link = readLinkLog(config.linkLogPath);
  fs.rmSync(config.mainLogPath, { force: true });
  fs.rmSync(config.linkLogPath, { force: true });
  fs.rmSync(config.goFilePath, { force: true });

  const triggerAt = main?.triggerAt ?? externalTriggerAt;
  if (main?.hardFailsafe) timedOut = true;
  return {
    runId: config.runId,
    arm: config.arm,
    trigger: config.trigger,
    exitCode: code,
    exitSignal: signal,
    timedOut,
    beforeQuitRan: (main?.beforeQuitPasses ?? 0) > 0,
    beforeQuitPasses: main?.beforeQuitPasses ?? 0,
    beforeQuitSyncMicroseconds: main?.beforeQuitSyncMicroseconds ?? null,
    triggerToExitMs: triggerAt === null ? null : exitAt - triggerAt,
    postToExitMs: main?.postAt ? exitAt - main.postAt : null,
    posted: main?.postAt !== undefined && main !== null,
    drainMs: main?.drainMs ?? null,
    drainTimedOut: main?.drainTimedOut ?? null,
    linkFinishReason: link?.finishReason ?? null,
    linkSawMessage: link?.messageAt !== undefined && link !== null,
    postToLinkMs: main?.postAt && link?.messageAt ? link.messageAt - main.postAt : null,
    writeCallbackMs: link?.writeCallbackAt && link?.messageAt ? link.writeCallbackAt - link.messageAt : null,
    ackMs: link?.ackAt && link?.messageAt ? link.ackAt - link.messageAt : null,
    stdinError: link?.stdinError ?? null,
    sshStderr: link?.sshStderr ?? null,
    linkLogCorruptLines: link?.corruptLines ?? null,
    linkGoneAfterExitMs,
    sshGoneAfterExitMs,
    linkPid: pids?.linkPid ?? null,
    sshPid: pids?.sshPid ?? null,
    linkAliveAtTrigger,
    sshAliveAtTrigger,
  };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil(fraction * sortedValues.length) - 1);
  return Math.round(sortedValues[Math.max(0, index)] * 100) / 100;
}

function distribution(values) {
  const present = values.filter((value) => typeof value === 'number').sort((left, right) => left - right);
  return {
    n: present.length,
    min: percentile(present, 0),
    p50: percentile(present, 0.5),
    p95: percentile(present, 0.95),
    p99: percentile(present, 0.99),
    max: present.length ? Math.round(present[present.length - 1] * 100) / 100 : null,
  };
}

function summarizeRecords(records) {
  const count = records.length;
  const countWhere = (predicate) => records.filter(predicate).length;
  return {
    runs: count,
    delivered: countWhere((record) => record.delivered),
    posted: countWhere((record) => record.posted),
    linkSawMessage: countWhere((record) => record.linkSawMessage),
    acked: countWhere((record) => record.ackMs !== null),
    beforeQuitRan: countWhere((record) => record.beforeQuitRan),
    timedOut: countWhere((record) => record.timedOut),
    nonZeroExit: countWhere((record) => record.exitCode !== 0),
    drainDeadlineHit: countWhere((record) => record.drainTimedOut === true),
    linkFinishReasons: records.reduce((counts, record) => {
      const key = String(record.linkFinishReason);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    stdinErrors: countWhere((record) => record.stdinError !== null),
    triggerToExitMs: distribution(records.map((record) => record.triggerToExitMs)),
    drainMs: distribution(records.map((record) => record.drainMs)),
    postToLinkMs: distribution(records.map((record) => record.postToLinkMs)),
    writeCallbackMs: distribution(records.map((record) => record.writeCallbackMs)),
    ackMs: distribution(records.map((record) => record.ackMs)),
    beforeQuitSyncMicroseconds: distribution(records.map((record) => record.beforeQuitSyncMicroseconds)),
    linkStillAliveAfterBudget: countWhere((record) => record.linkPid && record.linkGoneAfterExitMs === null),
    sshStillAliveAfterBudget: countWhere((record) => record.sshPid && record.sshGoneAfterExitMs === null),
    sshGoneAfterExitMs: distribution(records.map((record) => record.sshGoneAfterExitMs)),
    linkGoneAfterExitMs: distribution(records.map((record) => record.linkGoneAfterExitMs)),
  };
}

function caseFolderFor(name) {
  const folder = path.join(options.out, 'runs', name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function writeRecords(name, records, summary) {
  fs.writeFileSync(
    path.join(options.out, `${name}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  fs.writeFileSync(path.join(options.out, `${name}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${name}: ${JSON.stringify(summary)}\n`);
}

async function markDelivery(records) {
  // Let a frame in flight land before the helper's log is read.
  await delay(2500);
  const entries = await readHelperLog();
  const suspendedRuns = new Map(
    entries.filter((entry) => entry.type === 'suspendAll').map((entry) => [entry.run, entry]),
  );
  for (const record of records) {
    const entry = suspendedRuns.get(record.runId);
    record.delivered = entry !== undefined;
    record.deliveredBytes = entry?.bytes ?? null;
  }
  return entries;
}

function splitByArm(records) {
  const groups = {};
  for (const record of records) {
    const key = record.armLabel ?? record.arm;
    (groups[key] ??= []).push(record);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, summarizeRecords(group)]));
}

/**
 * Runs every arm in turn inside each iteration, so drift in the machine lands on all arms alike.
 * An arm is { label, config, hooks }.
 */
async function runArms(name, { roundTripMs = 0, runs, arms, concurrency = 1 }) {
  await setRoundTripDelay(roundTripMs);
  await startHelper();
  const caseFolder = caseFolderFor(name);
  const runCount = options.runs ?? runs;
  const records = [];
  let nextIteration = 0;
  let consecutiveTimeouts = 0;
  const worker = async (workerIndex) => {
    while (nextIteration < runCount) {
      const iteration = nextIteration;
      nextIteration += 1;
      for (const arm of arms) {
        const runId = `${name}-${arm.label}-${iteration}`;
        const config = {
          ...baseConfig(runId, caseFolder),
          userDataPath: path.join(options.out, `userdata-${workerIndex}`),
          ...arm.config,
        };
        const record = await runOneQuit(config, arm.hooks);
        if (arm.hooks?.afterExit) await arm.hooks.afterExit();
        consecutiveTimeouts = record.timedOut ? consecutiveTimeouts + 1 : 0;
        if (consecutiveTimeouts >= 3) throw new Error(`${name}: three runs in a row never came up`);
        record.armLabel = arm.label;
        records.push(record);
      }
      if ((iteration + 1) % 25 === 0) process.stdout.write(`${name}: ${iteration + 1}/${runCount}\n`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, workerIndex) => worker(workerIndex)));
  await markDelivery(records);
  const summary = {
    case: name,
    roundTripMs,
    concurrency,
    frameBytes: FRAME_BYTES,
    arms: splitByArm(records),
  };
  writeRecords(name, records, summary);
  await clearNetwork();
  return summary;
}

function deliveryCase(name, roundTripMs, configOverrides, runs = 200, concurrency = 1) {
  return () => runArms(name, {
    roundTripMs,
    runs,
    concurrency,
    arms: [{ label: 'quit', config: configOverrides }],
  });
}

/** Quits at once on four workers, for rows that count deliveries rather than time a quit. */
function parallelDeliveryCase(name, roundTripMs, configOverrides, runs = 200) {
  return deliveryCase(name, roundTripMs, configOverrides, runs, PARALLEL_WORKERS);
}

function addedTimeCase(name, roundTripMs) {
  return () => runArms(name, {
    roundTripMs,
    runs: 200,
    arms: [
      { label: 'control', config: { arm: 'no-handler', reenter: 'quit' } },
      { label: 'drain', config: { arm: 'drain', reenter: 'quit' } },
    ],
  });
}

async function runBudgetEgress() {
  return runArms('budget-netem-egress', {
    runs: 200,
    arms: [{
      label: 'quit',
      config: { sshOnExit: 'kill' },
      hooks: {
        beforeTrigger: setEgressLoss,
        afterExit: clearNetwork,
      },
    }],
  });
}

/** Blackhole, quit, restore, relaunch, reconcile. The reconnect is modeled by quit-app's reconcile
 *  mode against the stand-in helper: a second launch's link lists what still runs and suspends it. */
async function runUndelivered(name, sshOverrides, runs) {
  await clearNetwork();
  await startHelper();
  const caseFolder = caseFolderFor(name);
  const runCount = options.runs ?? runs;
  const records = [];
  for (let iteration = 0; iteration < runCount; iteration += 1) {
    const runId = `${name}-${iteration}`;
    const config = { ...baseConfig(runId, caseFolder), ...sshOverrides };
    const record = await runOneQuit(config, { beforeTrigger: setBlackhole, leftoverBudgetMs: 500 });
    await clearNetwork();
    const networkRestoredAt = now();
    const reconnectConfig = {
      ...baseConfig(`${runId}-r`, caseFolder),
      mode: 'reconcile',
      goFilePath: null,
      reconcileScope: runId,
    };
    const { child: reconnectChild, exited } = launch(reconnectConfig, () => {});
    const reconnectWatchdog = setTimeout(() => reconnectChild.kill(), RUN_WATCHDOG_MS);
    await exited;
    clearTimeout(reconnectWatchdog);
    const main = readJson(reconnectConfig.mainLogPath);
    const link = readLinkLog(reconnectConfig.linkLogPath);
    fs.rmSync(reconnectConfig.mainLogPath, { force: true });
    fs.rmSync(reconnectConfig.linkLogPath, { force: true });
    record.reconcile = {
      reconciledCount: main?.reconciledCount ?? null,
      connectMs: link?.readyAt && link?.spawnAt ? link.readyAt - link.spawnAt : null,
      spawnToSuspendAckMs: link?.ackAt && link?.spawnAt ? link.ackAt - link.spawnAt : null,
      restoredToSuspendAckMs: link?.ackAt ? link.ackAt - networkRestoredAt : null,
    };
    records.push(record);
    if ((iteration + 1) % 25 === 0) process.stdout.write(`${name}: ${iteration + 1}/${runCount}\n`);
  }
  const entries = await markDelivery(records);
  const suspendEntries = new Map(
    entries.filter((entry) => entry.type === 'suspend').map((entry) => [entry.run, entry]),
  );
  const lateEntries = new Map(
    entries.filter((entry) => entry.type === 'suspendAll').map((entry) => [entry.run, entry]),
  );
  for (const record of records) {
    const suspendEntry = suspendEntries.get(record.runId);
    const lateEntry = lateEntries.get(record.runId);
    record.suspendedByReconcile = suspendEntry !== undefined;
    record.frameAfterReconcileMs = suspendEntry && lateEntry ? lateEntry.t - suspendEntry.t : null;
  }
  const reconcileRecords = records.map((record) => record.reconcile);
  const summary = {
    case: name,
    ...sshOverrides,
    quit: summarizeRecords(records),
    frameArrivedAnyway: records.filter((record) => record.delivered).length,
    suspendedByReconcile: records.filter((record) => record.suspendedByReconcile).length,
    neitherSuspended: records.filter((record) => !record.delivered && !record.suspendedByReconcile).length,
    bothSuspended: records.filter((record) => record.delivered && record.suspendedByReconcile).length,
    frameAfterReconcileMs: distribution(records.map((record) => record.frameAfterReconcileMs)),
    reconcileFound: reconcileRecords.filter((record) => (record.reconciledCount ?? 0) > 0).length,
    connectMs: distribution(reconcileRecords.map((record) => record.connectMs)),
    spawnToSuspendAckMs: distribution(reconcileRecords.map((record) => record.spawnToSuspendAckMs)),
    restoredToSuspendAckMs: distribution(reconcileRecords.map((record) => record.restoredToSuspendAckMs)),
    staleRelaysOnHost: (await dockerExecAllowFailure('pgrep', '-fc', 'quit-host.py relay')).stdout.trim(),
  };
  writeRecords(name, records, summary);
  return summary;
}

/** The driver kills the link pid. Main's utility process `exit` event is timed against that kill. */
async function runCrash(name, sshDetached, roundTripMs = 0) {
  await setRoundTripDelay(roundTripMs);
  await startHelper();
  const caseFolder = caseFolderFor(name);
  const crashIterations = options.runs ?? 200;
  const config = {
    ...baseConfig(name, caseFolder),
    mode: 'crash',
    goFilePath: null,
    crashIterations,
    sshDetached,
  };
  const kills = new Map();
  const pendingSshChecks = [];
  let idleWatchdog = null;
  const { child, exited } = launch(config, (line) => {
    // An app that stops reporting ends here. Every iteration prints, so silence means a stall.
    clearTimeout(idleWatchdog);
    idleWatchdog = setTimeout(() => child.kill(), RUN_WATCHDOG_MS);
    if (line.startsWith('link ')) {
      const report = JSON.parse(line.slice(5));
      // Leave the session a moment, so the kill lands mid-session, not at the ready.
      setTimeout(() => {
        const killAt = now();
        kills.set(report.iteration, { ...report, killAt });
        try {
          process.kill(report.linkPid);
        } catch {
          // The link already died on its own: the app's exit event still ends this iteration.
        }
        pendingSshChecks.push(
          waitGone(report.sshPid, killAt, 5000).then((sshGoneMs) => {
            kills.get(report.iteration).sshGoneAfterKillMs = sshGoneMs;
          }),
        );
      }, 20);
    } else if (line.startsWith('exited ')) {
      const report = JSON.parse(line.slice(7));
      Object.assign(kills.get(report.iteration) ?? {}, { exitEventAt: report.exitEventAt, code: report.code });
    }
  });
  idleWatchdog = setTimeout(() => child.kill(), RUN_WATCHDOG_MS);
  await exited;
  clearTimeout(idleWatchdog);
  await Promise.all(pendingSshChecks);
  const records = [...kills.values()].map((kill) => ({
    ...kill,
    killToExitEventMs: kill.exitEventAt ? kill.exitEventAt - kill.killAt : null,
  }));
  const summary = {
    case: name,
    kills: records.length,
    exitEvents: records.filter((record) => record.killToExitEventMs !== null).length,
    exitCodes: [...new Set(records.map((record) => record.code))],
    killToExitEventMs: distribution(records.map((record) => record.killToExitEventMs)),
    sshGoneAfterKillMs: distribution(records.map((record) => record.sshGoneAfterKillMs)),
    sshOutlivedFiveSeconds: records.filter((record) => record.sshGoneAfterKillMs === null).length,
  };
  writeRecords(name, records, summary);
  await clearNetwork();
  return summary;
}

/** How long ssh outlives its link in a blackhole when left to see EOF. */
async function runOrphanLifetime() {
  await clearNetwork();
  await startHelper();
  const name = 'ssh-orphan-blackhole';
  const caseFolder = caseFolderFor(name);
  const runCount = options.runs ?? 3;
  const records = [];
  for (let iteration = 0; iteration < runCount; iteration += 1) {
    const runId = `${name}-${iteration}`;
    const config = { ...baseConfig(runId, caseFolder), sshDetached: true };
    const record = await runOneQuit(config, { beforeTrigger: setBlackhole, leftoverBudgetMs: 120000 });
    await clearNetwork();
    records.push(record);
  }
  await markDelivery(records);
  const summary = { case: name, quit: summarizeRecords(records) };
  writeRecords(name, records, summary);
  return summary;
}

const caseTable = {
  'baseline-nodrain-0': deliveryCase('baseline-nodrain-0', 0, { arm: 'no-drain' }),
  'baseline-nodrain-50': deliveryCase('baseline-nodrain-50', 50, { arm: 'no-drain' }),
  'baseline-nodrain-200': deliveryCase('baseline-nodrain-200', 200, { arm: 'no-drain' }),
  'baseline-busy-link-50': deliveryCase('baseline-busy-link-50', 50, { arm: 'no-drain', linkBusyMs: 100 }),
  'delivery-busy-link-50': parallelDeliveryCase('delivery-busy-link-50', 50, { linkBusyMs: 100 }),
  'delivery-0': parallelDeliveryCase('delivery-0', 0, {}),
  'delivery-50': parallelDeliveryCase('delivery-50', 50, {}),
  'delivery-200': parallelDeliveryCase('delivery-200', 200, {}),
  'delivery-50-1000': parallelDeliveryCase('delivery-50-1000', 50, {}, 1000),
  'path-app-quit': parallelDeliveryCase('path-app-quit', 0, { trigger: 'app-quit' }),
  'path-window-close': parallelDeliveryCase('path-window-close', 0, { trigger: 'window-close' }),
  'path-taskkill': () => runArms('path-taskkill', {
    runs: 200,
    concurrency: PARALLEL_WORKERS,
    arms: [{
      label: 'quit',
      config: { trigger: 'external' },
      hooks: {
        externalTrigger: async ({ pid }) => {
          await runCommand('taskkill', ['/PID', String(pid)]);
        },
      },
    }],
  }),
  'path-signal-terminate': () => runArms('path-signal-terminate', {
    runs: 200,
    concurrency: PARALLEL_WORKERS,
    arms: [{
      label: 'quit',
      config: { trigger: 'external' },
      hooks: {
        externalTrigger: async ({ pid }) => {
          process.kill(pid, 'SIGTERM');
        },
      },
    }],
  }),
  'path-signal-handler-standin': parallelDeliveryCase(
    'path-signal-handler-standin',
    0,
    { trigger: 'signal-handler-standin' },
  ),
  'added-no-terminal': () => runArms('added-no-terminal', {
    runs: 200,
    arms: [
      { label: 'control', config: { arm: 'no-handler', reenter: 'quit' } },
      { label: 'handler-no-link', config: { arm: 'handler-no-link', reenter: 'quit' } },
      { label: 'idle-link', config: { arm: 'idle-link', reenter: 'quit' } },
    ],
  }),
  'added-sessions-0': addedTimeCase('added-sessions-0', 0),
  'added-sessions-50': addedTimeCase('added-sessions-50', 50),
  'added-sessions-200': addedTimeCase('added-sessions-200', 200),
  'budget-netem-egress': runBudgetEgress,
  'budget-link-hang': deliveryCase('budget-link-hang', 0, { linkExit: 'hang' }, 20),
  'undelivered-ssh-killed': () => runUndelivered('undelivered-ssh-killed', { sshOnExit: 'kill' }, 200),
  'undelivered-ssh-detached': () => runUndelivered('undelivered-ssh-detached', { sshDetached: true }, 50),
  'ssh-orphan-blackhole': runOrphanLifetime,
  'crash-link-kill': () => runCrash('crash-link-kill', false),
  'crash-link-kill-detached': () => runCrash('crash-link-kill-detached', true),
  'crash-link-kill-200': () => runCrash('crash-link-kill-200', false, 200),
  'crash-link-kill-detached-200': () => runCrash('crash-link-kill-detached-200', true, 200),
  'flush-after-write-0': parallelDeliveryCase('flush-after-write-0', 0, { linkExit: 'after-write' }),
  'flush-after-write-50': parallelDeliveryCase('flush-after-write-50', 50, { linkExit: 'after-write' }),
  'flush-after-write-200': parallelDeliveryCase('flush-after-write-200', 200, { linkExit: 'after-write' }),
  'flush-detached-after-write-0': parallelDeliveryCase('flush-detached-after-write-0', 0, { linkExit: 'after-write', sshDetached: true }),
  'flush-detached-after-write-50': parallelDeliveryCase('flush-detached-after-write-50', 50, { linkExit: 'after-write', sshDetached: true }),
  'flush-detached-after-write-200': parallelDeliveryCase('flush-detached-after-write-200', 200, { linkExit: 'after-write', sshDetached: true }),
  'flush-detached-immediate-200': parallelDeliveryCase('flush-detached-immediate-200', 200, { linkExit: 'immediate', sshDetached: true }),
  'flush-immediate-0': parallelDeliveryCase('flush-immediate-0', 0, { linkExit: 'immediate' }),
  'flush-immediate-200': parallelDeliveryCase('flush-immediate-200', 200, { linkExit: 'immediate' }),
  'flush-terminate-200': parallelDeliveryCase('flush-terminate-200', 200, { linkExit: 'after-write-terminate' }),
  'flush-then-ssh-killed-200': parallelDeliveryCase(
    'flush-then-ssh-killed-200',
    200,
    { linkExit: 'after-write', sshOnExit: 'kill' },
  ),
};

async function main() {
  if (options.list) {
    process.stdout.write(`${Object.keys(caseTable).join('\n')}\n`);
    return;
  }
  if (!options.key || !options.out) throw new Error('--key and --out are required');
  fs.mkdirSync(options.out, { recursive: true });
  options.knownHosts ??= path.join(options.out, 'known_hosts-quit');
  options.ssh ??= process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    : 'ssh';
  await ensureContainer();
  const names = options.cases ?? Object.keys(caseTable);
  try {
    for (const name of names) {
      const startedAt = Date.now();
      await caseTable[name]();
      process.stdout.write(`${name}: done in ${Math.round((Date.now() - startedAt) / 1000)} s\n`);
    }
  } finally {
    await clearNetwork();
    if (options.removeContainer) await docker('rm', '-f', options.container);
  }
}

await main();
