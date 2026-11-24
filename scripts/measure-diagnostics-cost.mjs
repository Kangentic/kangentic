#!/usr/bin/env node

/**
 * measure-diagnostics-cost.mjs - what the Developer diagnostics cost a running
 * dev instance, checked against their budget.
 *
 * MANUAL MEASUREMENT SCRIPT - not wired to CI. The budget itself is checked by
 * the app on every read of the lag report (`src/devtools/main/diagnostics-budget.ts`,
 * unit-tested in `tests/unit/diagnostics-budget.test.ts`). This prints that
 * verdict for a person, and adds the two things the report cannot hold:
 * main's CPU share over a stretch of time, and a look at a previous launch.
 *
 * Every diagnostic times its own main-thread work under a `diag:<name>` label,
 * so the numbers come from the real workload of the instance it is pointed
 * at, not from a benchmark.
 *
 * Usage:
 *   node scripts/measure-diagnostics-cost.mjs [options]
 *
 *   --instance=<path>   The checkout whose dev instance to read (its
 *                       .kangentic/preview.lock names the port). Default: the
 *                       checkout this script is in.
 *   --port=<n>          Skip the lockfile and use this bridge port.
 *   --watch=<minutes>   Also sample main's CPU share every 10 s for this long,
 *                       and report what the diagnostics cost in that window.
 *                       Run it once with the stall profiler on and once off to
 *                       compare: the profiler's sampler thread holds no
 *                       JavaScript, so no span sees it.
 *   --launch=<which>    Print a launch from the on-disk journal instead:
 *                       previous, current, or an id.
 *   --json              Print the raw verdict (or launch) as JSON. With
 *                       --watch, the sampling lines go to stderr.
 *
 * Exit code: 0 when the budget holds, 1 on a violation, 2 when no instance
 * answered or an option is wrong.
 *
 * Requires Settings > Developer > Inspection bridge on (the default in a dev
 * build).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCH_SAMPLE_MS = 10_000;

const VALUE_OPTIONS = ['--instance', '--port', '--watch', '--launch'];

function readOptions(argv) {
  const options = { instance: null, port: null, watchMinutes: 0, launch: null, json: false };
  for (const argument of argv) {
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    // Split at the first `=` only: a path may hold one of its own.
    const separatorIndex = argument.indexOf('=');
    const name = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? '' : argument.slice(separatorIndex + 1);
    if (!VALUE_OPTIONS.includes(name)) throw new Error(`Unknown option: ${argument}`);
    // A value that is missing or unreadable is an error. Left to pass, the
    // script printed the plain verdict as if the option had not been given.
    if (value === '') throw new Error(`${name} needs a value: ${name}=<value>`);
    if (name === '--instance') options.instance = value;
    else if (name === '--launch') options.launch = value;
    else if (name === '--port') {
      options.port = Number.parseInt(value, 10);
      if (!Number.isInteger(options.port) || options.port <= 0) throw new Error(`--port needs a port number, got "${value}"`);
    } else {
      options.watchMinutes = Number.parseFloat(value);
      if (!(options.watchMinutes > 0)) throw new Error(`--watch needs a number of minutes above zero, got "${value}"`);
    }
  }
  return options;
}

function resolvePort(options) {
  if (Number.isInteger(options.port) && options.port > 0) return options.port;
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const instance = options.instance ?? path.resolve(scriptDirectory, '..');
  const lockfilePath = path.join(instance, '.kangentic', 'preview.lock');
  let lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'));
  } catch {
    throw new Error(`No dev instance found: ${lockfilePath} is missing. Start one, or pass --instance or --port.`);
  }
  return lockfile.port;
}

async function getJson(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  const body = await response.json();
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padLeft(value, width) {
  return String(value).padStart(width);
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.round(milliseconds / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  return `${(milliseconds / 3_600_000).toFixed(1)} h`;
}

function printVerdict(report) {
  const verdict = report.diagnostics;
  const uptimeMs = report.main.monitoringForMs ?? 0;
  console.log(`Main monitored for ${formatDuration(uptimeMs)}. Stall profiler ${report.stallProfiler.running ? 'on' : 'off'}, ${report.stallProfiler.profiles.length} stall(s) kept, ${report.main.spikeCount} spike(s) of ${report.main.spikeThresholdMs} ms or more.`);
  console.log('');
  console.log(`${pad('Diagnostic', 18)}${padLeft('Count', 10)}${padLeft('Total ms', 11)}${padLeft('Worst ms', 10)}${padLeft('Mean microsec', 15)}${padLeft('Share %', 10)}`);
  for (const cost of verdict.byDiagnostic) {
    const meanMicroseconds = cost.count > 0 ? Math.round((cost.totalMs / cost.count) * 1000) : 0;
    console.log(`${pad(cost.name, 18)}${padLeft(cost.count, 10)}${padLeft(cost.totalMs, 11)}${padLeft(cost.maxMs, 10)}${padLeft(meanMicroseconds, 15)}${padLeft(cost.sharePercent, 10)}`);
  }
  if (verdict.byDiagnostic.length === 0) console.log('(no diagnostic has recorded any work yet)');
  console.log('');
  console.log(`All diagnostics: ${verdict.totalMs} ms, ${verdict.sharePercent}% of main's time. Budget: under ${verdict.budget.maxSharePercent}%, no hold of ${verdict.budget.maxHoldMs} ms or more.`);
  if (!verdict.shareJudged) {
    console.log(`The share is not judged yet: the run is younger than ${formatDuration(verdict.budget.shareAfterMs)}, and a launch's burst would skew it.`);
  }
  console.log(`Profiler cold starts: ${verdict.coldStart.count}, worst ${verdict.coldStart.maxMs} ms (exempt).`);
  console.log(`Windows marked by a save: ${verdict.markedWindows.count}, ${verdict.markedWindows.overSpikeLine} over ${verdict.budget.spikeMs} ms, ${verdict.markedWindows.unchecked} too old to check.`);
  console.log('');
  if (verdict.pass) {
    console.log('PASS');
    return;
  }
  console.log('FAIL');
  for (const violation of verdict.violations) console.log(`  [${violation.rule}] ${violation.detail}`);
}

function mainCpuPercent(metrics) {
  const browserProcess = metrics.processes.find((entry) => entry.type === 'Browser');
  return browserProcess ? browserProcess.cpu.percentCPUUsage : null;
}

async function watch(port, minutes, json) {
  // With --json, stdout holds the JSON and nothing else, so it can be piped.
  const say = json ? console.error : console.log;
  const samples = [];
  const before = await getJson(port, '/event-loop-lag');
  const endAt = Date.now() + minutes * 60_000;
  say(`Sampling main's CPU every ${WATCH_SAMPLE_MS / 1000} s for ${minutes} min...`);
  while (Date.now() < endAt) {
    await new Promise((resolve) => setTimeout(resolve, WATCH_SAMPLE_MS));
    const cpuPercent = mainCpuPercent(await getJson(port, '/process-metrics'));
    if (cpuPercent !== null) samples.push(cpuPercent);
  }
  const after = await getJson(port, '/event-loop-lag');
  const meanCpu = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const windowMs = (after.main.monitoringForMs ?? 0) - (before.main.monitoringForMs ?? 0);
  const diagnosticsMs = after.diagnostics.totalMs - before.diagnostics.totalMs;
  const spikes = after.main.spikeCount - before.main.spikeCount;
  say(`Main CPU: mean ${meanCpu.toFixed(3)}%, max ${Math.max(0, ...samples).toFixed(3)}% of one core, over ${samples.length} samples.`);
  say(`In that window: diagnostics used ${diagnosticsMs} ms of ${formatDuration(windowMs)} (${windowMs > 0 ? ((diagnosticsMs / windowMs) * 100).toFixed(3) : 0}%), and main had ${spikes} spike(s).`);
  say('');
  return after;
}

function printLaunch(launch) {
  console.log(`Launch ${launch.launchId}`);
  if (launch.launch) {
    console.log(`  Kangentic ${launch.launch.versions.kangentic}, Electron ${launch.launch.versions.electron}, ${launch.launch.platform} ${launch.launch.arch}${launch.launch.ephemeralPreview ? ', preview' : ''}`);
  }
  console.log(`  Records from ${launch.firstRecordAt ?? '(none)'} to ${launch.lastRecordAt ?? '(none)'}`);
  console.log(`  Exit: ${launch.exit ? `${launch.exit.reason} at ${launch.exit.at}` : 'no clean exit recorded'}`);
  console.log(`  Counts: ${JSON.stringify(launch.counts)}${launch.truncated ? ' (lists capped at their newest)' : ''}`);
  if (launch.startup) {
    console.log('  Startup timeline:');
    for (const mark of launch.startup) console.log(`    ${padLeft(`${mark.elapsedMs} ms`, 10)}  ${mark.label}`);
  }
  if (launch.stalls.length > 0) {
    console.log('  Stalls:');
    for (const stall of launch.stalls) {
      const topFrame = stall.topFrames[0] ? `${stall.topFrames[0].functionName} (${stall.topFrames[0].selfMs} ms)` : 'no frame';
      // The frames that called it, nearest last: the native leaf alone (`spawn`) names no caller.
      const callers = stall.heaviestStack.slice(-4, -1).join(' > ');
      console.log(`    ${stall.detectedAt}  ${padLeft(`${stall.maxDelayMs} ms`, 10)}  ${topFrame}${callers ? `, under ${callers}` : ''}`);
    }
  }
  const worstSpikes = [...launch.spikes].sort((left, right) => right.lagMs - left.lagMs).slice(0, 10);
  if (worstSpikes.length > 0) {
    console.log('  Worst spikes:');
    for (const spike of worstSpikes) console.log(`    ${spike.at}  ${padLeft(`${spike.lagMs} ms`, 10)}  ${spike.process}`);
  }
}

async function run() {
  const options = readOptions(process.argv.slice(2));
  const port = resolvePort(options);
  if (options.launch) {
    const launch = await getJson(port, `/event-loop-lag?launch=${encodeURIComponent(options.launch)}`);
    if (options.json) console.log(JSON.stringify(launch, null, 2));
    else printLaunch(launch);
    return 0;
  }
  const report = options.watchMinutes > 0
    ? await watch(port, options.watchMinutes, options.json)
    : await getJson(port, '/event-loop-lag');
  if (options.json) console.log(JSON.stringify(report.diagnostics, null, 2));
  else printVerdict(report);
  return report.diagnostics.pass ? 0 : 1;
}

/**
 * Leave once stdout has drained. `process.exit()` right after a large `--json`
 * print can cut the output short when it is piped to another program.
 */
function exitWhenFlushed(exitCode) {
  process.exitCode = exitCode;
  process.stdout.write('', () => process.exit(exitCode));
}

run().then(
  exitWhenFlushed,
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    exitWhenFlushed(2);
  },
);
