#!/usr/bin/env node
/**
 * MANUAL MEASUREMENT SCRIPT - not wired to CI or any npm script.
 *
 * Measures what a pre-installed spare worktree would save a new task, for the
 * decision recorded in docs/audits/spare-worktree-audit.md. A spare is a
 * worktree created ahead of time with the project's init script already run;
 * a task would take it instead of creating and installing its own.
 *
 * PROBES (run in this order, because P1 decides whether a spare can be moved)
 *   p1  Move: build a spare at the base, `git worktree move` it to a new name,
 *       then run the install again with no TTY. Records the exit code, the
 *       first matching output lines, the duration, and whether a sample package
 *       link still resolves before and after. When the install fails, or the
 *       sampled link is still broken, and --repair-install is given, that
 *       command runs next and is timed too.
 *   p2  Cold baseline: `git worktree add --detach` at the base, the sparse
 *       exclusion and per-worktree config Kangentic writes, the copy files,
 *       then a cold install. Each phase is timed apart, and so is the removal.
 *       The first run also records the idle cost (p5).
 *   p3  Claim of a current spare: the spare is built at the last commit that
 *       changed the lockfile, so its lockfile matches the base. The claim then
 *       times a branch, a fetch, a fast-forward, the copy files, the
 *       per-worktree config and the install, which should be a no-op.
 *   p4  Claim of a spare that missed a lockfile change: the spare is built at
 *       the parent of the last lockfile change. The claim fast-forwards it and
 *       times the install that has to catch up. Skipped, with the reason in
 *       the report, when the lockfile has no history or was added by the root
 *       commit.
 *   p5  Idle cost, reported by the first p2 run (not a --probes value). It
 *       records the volume's free space
 *       before the add and after the install (summing file sizes would
 *       overcount a package manager's hardlinks), the file and link count
 *       under every node_modules, and the checkout's size without them.
 *
 * WHERE IT WRITES
 * Probe worktrees go under <repo>/.kangentic/probe-spare/, on the same volume
 * and under the same path depth as real task worktrees. Kangentic's orphan
 * sweep reads only .kangentic/worktrees/, so it never touches them. Each probe
 * removes its worktree, prunes, and deletes its probe-claim-* branch. At the
 * end, even after a probe threw, the probe directory is removed and this run's
 * probe-claim-* branches are deleted. A run that is killed midway can leave a
 * worktree or a branch behind, which `git worktree list` and
 * `git branch --list "probe-claim-*"` show.
 *
 * The install runs through the native shell with stdin closed, as Kangentic
 * runs a Post-Worktree Script (src/main/git/run-init-script.ts). Make sure no
 * other install is running in the same project first: a busy disk inflates
 * every number here.
 *
 * Usage:
 *   node scripts/measure-spare-worktree.mjs --repo <path> --install "pnpm install --frozen-lockfile"
 *   node scripts/measure-spare-worktree.mjs --repo <path> --install none --link-node-modules --probes p2,p3
 *
 * Flags:
 *   --repo <path>             repository to probe (required)
 *   --install <cmd|none>      the project's init script; "none" skips installs
 *   --repair-install <cmd>    run after a failed post-move install in p1
 *   --base <remote/branch>    base ref, default origin/main
 *   --lockfile <path>         lockfile path in the repo, default pnpm-lock.yaml
 *   --copy <a,b>              copy files, relative to the repo root
 *   --link-node-modules       link the root node_modules instead of installing
 *   --runs <n>                runs per probe, default 3
 *   --probes <list>           comma list of p1,p2,p3,p4, default all four
 *   --out <path>              write the JSON report here
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SPARSE_PATTERNS = ['/*', '!/.claude/commands/'];
const MESSAGE_LINES_KEPT = 6;
const PROBE_NAMES = ['p1', 'p2', 'p3', 'p4'];

function parseArguments(argv) {
  const options = {
    repo: null,
    install: 'none',
    repairInstall: null,
    base: 'origin/main',
    lockfile: 'pnpm-lock.yaml',
    copy: [],
    linkNodeModules: false,
    runs: 3,
    probes: [...PROBE_NAMES],
    out: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    if (flag === '--repo') options.repo = path.resolve(nextValue());
    else if (flag === '--install') options.install = nextValue();
    else if (flag === '--repair-install') options.repairInstall = nextValue();
    else if (flag === '--base') options.base = nextValue();
    else if (flag === '--lockfile') options.lockfile = nextValue();
    else if (flag === '--copy') options.copy = nextValue().split(',').filter(Boolean);
    else if (flag === '--link-node-modules') options.linkNodeModules = true;
    else if (flag === '--runs') options.runs = Number(nextValue());
    else if (flag === '--probes') options.probes = nextValue().split(',').filter(Boolean);
    else if (flag === '--out') options.out = path.resolve(nextValue());
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!options.repo) throw new Error('--repo is required');
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs must be a positive integer');
  if (!/^[^/]+\/.+$/.test(options.base)) throw new Error('--base must be <remote>/<branch>, for example origin/main');
  const unknownProbes = options.probes.filter((probeName) => !PROBE_NAMES.includes(probeName));
  if (unknownProbes.length > 0) throw new Error(`Unknown probe ${unknownProbes.join(', ')}; expected some of ${PROBE_NAMES.join(', ')}`);
  return options;
}

const options = parseArguments(process.argv.slice(2));
const installEnabled = options.install !== 'none';
const [baseRemote, ...baseBranchParts] = options.base.split('/');
const baseBranch = baseBranchParts.join('/');
const probeRoot = path.join(options.repo, '.kangentic', 'probe-spare');
const longPathsConfig = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
const checkoutWorkersConfig = ['-c', `checkout.workers=${Math.min(os.availableParallelism(), 8)}`];

function git(cwd, args) {
  return execFileSync('git', [...longPathsConfig, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function timed(action) {
  const startedAt = performance.now();
  const result = action();
  return { milliseconds: Math.round(performance.now() - startedAt), result };
}

function runInstallCommand(command, cwd) {
  const startedAt = performance.now();
  const completed = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  const milliseconds = Math.round(performance.now() - startedAt);
  const outputLines = `${completed.stderr ?? ''}\n${completed.stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // The words match pnpm's messages. A failed install whose output matches none
  // of them keeps its first lines, so a non-zero exit never reports no messages.
  const matchingLines = outputLines.filter((line) => /err|warn|abort|remove|reinstall|purge/i.test(line));
  const relevantLines = matchingLines.length > 0 || completed.status === 0 ? matchingLines : outputLines;
  return { milliseconds, exitCode: completed.status, messages: relevantLines.slice(0, MESSAGE_LINES_KEPT) };
}

/** The result recorded for a step that ran no install command. */
function noInstallResult(milliseconds = 0) {
  return { milliseconds, exitCode: 0, messages: [] };
}

function freeBytes(target) {
  const stats = fs.statfsSync(target);
  return stats.bavail * stats.bsize;
}

/** Create a detached worktree the way Kangentic's git phase does, timed per step. */
function addWorktree(worktreePath, startPoint) {
  const add = timed(() => git(options.repo, [...checkoutWorkersConfig, 'worktree', 'add', '--detach', worktreePath, startPoint]));
  const configure = timed(() => {
    git(worktreePath, ['sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS]);
    git(worktreePath, ['config', '--worktree', 'kangentic.baseBranch', baseBranch]);
  });
  return { addMs: add.milliseconds, configureMs: configure.milliseconds };
}

function copyFiles(worktreePath) {
  return timed(() => {
    for (const relativePath of options.copy) {
      const source = path.join(options.repo, relativePath);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(worktreePath, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, force: true });
    }
  }).milliseconds;
}

/** The init script, or the node_modules link that replaces it in the default config. */
function setUp(worktreePath) {
  if (installEnabled) return runInstallCommand(options.install, worktreePath);
  if (options.linkNodeModules) {
    const link = timed(() => fs.symlinkSync(path.join(options.repo, 'node_modules'), path.join(worktreePath, 'node_modules'), 'junction'));
    return noInstallResult(link.milliseconds);
  }
  return noInstallResult();
}

/**
 * Remove <worktree>/node_modules without ever following a link out of it. A
 * recursive rm traverses a Windows junction and deletes the TARGET's contents,
 * which for a linked node_modules is the main checkout's. Same order as
 * removeNodeModulesPath in src/main/git/node-modules-link.ts.
 */
function removeNodeModules(nodeModules) {
  let stats;
  try {
    stats = fs.lstatSync(nodeModules);
  } catch {
    return;
  }
  let isLink = stats.isSymbolicLink();
  if (process.platform === 'win32' && !isLink) {
    try {
      fs.readlinkSync(nodeModules);
      isLink = true;
    } catch {
      // A real directory.
    }
  }
  if (isLink && process.platform === 'win32') fs.rmdirSync(nodeModules);
  else if (isLink) fs.rmSync(nodeModules, { force: true });
  else fs.rmSync(nodeModules, { recursive: true, force: true, maxRetries: 3 });
}

function removeWorktree(worktreePath, branchName) {
  const removal = timed(() => {
    removeNodeModules(path.join(worktreePath, 'node_modules'));
    try {
      git(options.repo, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
    }
    git(options.repo, ['worktree', 'prune']);
    if (branchName) {
      try {
        git(options.repo, ['branch', '-D', branchName]);
      } catch {
        // The branch was never created.
      }
    }
  });
  return removal.milliseconds;
}

/** Find one package link (a junction on Windows, a symlink elsewhere) in a workspace node_modules. */
function findPackageLink(worktreePath) {
  const queue = [{ directory: worktreePath, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name === 'node_modules' && entry.isDirectory()) {
        for (const packageEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          if (packageEntry.name.startsWith('.')) continue;
          if (packageEntry.isSymbolicLink()) return path.join(entryPath, packageEntry.name);
        }
        continue;
      }
      if (entry.isDirectory() && depth < 2) queue.push({ directory: entryPath, depth: depth + 1 });
    }
  }
  return null;
}

/** Whether a package link resolves, with its target and the error when it does not. */
function inspectLink(linkPath) {
  if (!linkPath) return null;
  let target = null;
  try {
    target = fs.readlinkSync(linkPath);
  } catch (error) {
    target = `unreadable (${error.code})`;
  }
  try {
    fs.statSync(linkPath);
    return { resolves: true, target };
  } catch (error) {
    return { resolves: false, target, error: error.code };
  }
}

/** The virtual store location pnpm recorded, when the worktree has a pnpm install. */
function recordedVirtualStore(worktreePath) {
  const modulesFile = path.join(worktreePath, 'node_modules', '.modules.yaml');
  if (!fs.existsSync(modulesFile)) return null;
  const line = fs.readFileSync(modulesFile, 'utf-8').split(/\r?\n/).find((text) => text.startsWith('virtualStoreDir:'));
  return line ? line.slice('virtualStoreDir:'.length).trim() : null;
}

/** A path made relative to the probe root, so a report carries no absolute paths. */
function relativeToProbe(target) {
  if (!target) return target;
  return path.isAbsolute(target) ? path.relative(probeRoot, target) : target;
}

/** File, directory and link counts under every node_modules, plus the checkout's own bytes. */
function measureTree(worktreePath) {
  const counts = { nodeModulesFiles: 0, nodeModulesDirectories: 0, nodeModulesLinks: 0, checkoutFiles: 0, checkoutBytes: 0 };
  const stack = [{ directory: worktreePath, insideNodeModules: false }];
  while (stack.length > 0) {
    const { directory, insideNodeModules } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' && directory === worktreePath) continue;
      const entryPath = path.join(directory, entry.name);
      const isNodeModules = insideNodeModules || entry.name === 'node_modules';
      if (entry.isSymbolicLink()) {
        if (isNodeModules) counts.nodeModulesLinks++;
        continue;
      }
      if (entry.isDirectory()) {
        if (isNodeModules) counts.nodeModulesDirectories++;
        stack.push({ directory: entryPath, insideNodeModules: isNodeModules });
        continue;
      }
      if (isNodeModules) {
        counts.nodeModulesFiles++;
      } else {
        counts.checkoutFiles++;
        counts.checkoutBytes += fs.statSync(entryPath).size;
      }
    }
  }
  return counts;
}

function summarize(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((first, second) => first - second);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
  return { median, min: sorted[0], max: sorted[sorted.length - 1], runs: sorted.length };
}

function log(message) {
  console.log(`[spare-probe] ${message}`);
}

function probeMove(runIndex, baseCommit) {
  const sparePath = path.join(probeRoot, `move-${runIndex}`);
  const movedPath = path.join(probeRoot, `moved-${runIndex}`);
  addWorktree(sparePath, baseCommit);
  copyFiles(sparePath);
  const build = setUp(sparePath);
  const linkBefore = findPackageLink(sparePath);
  const beforeMove = inspectLink(linkBefore);
  const move = timed(() => git(options.repo, ['worktree', 'move', sparePath, movedPath]));
  const movedLink = linkBefore ? path.join(movedPath, path.relative(sparePath, linkBefore)) : null;
  const afterMove = inspectLink(movedLink);
  const reinstall = installEnabled ? runInstallCommand(options.install, movedPath) : null;
  const afterReinstall = inspectLink(movedLink);
  const virtualStoreAfterReinstall = recordedVirtualStore(movedPath);
  let repair = null;
  let afterRepair = null;
  // A null inspection means no package link was sampled, which is not a broken one.
  if (reinstall && (reinstall.exitCode !== 0 || afterReinstall?.resolves === false) && options.repairInstall) {
    repair = runInstallCommand(options.repairInstall, movedPath);
    afterRepair = inspectLink(movedLink);
  }
  const removeMs = removeWorktree(movedPath, null);
  const forReport = (inspection) => inspection && { ...inspection, target: relativeToProbe(inspection.target) };
  const record = {
    build: { milliseconds: build.milliseconds, exitCode: build.exitCode, messages: build.messages },
    sampleLink: linkBefore ? path.relative(sparePath, linkBefore) : null,
    moveMs: move.milliseconds,
    beforeMove: forReport(beforeMove),
    afterMove: forReport(afterMove),
    reinstall,
    afterReinstall: forReport(afterReinstall),
    virtualStoreAfterReinstall: relativeToProbe(virtualStoreAfterReinstall),
    repair,
    afterRepair: forReport(afterRepair),
    removeMs,
  };
  log(`p1 run ${runIndex}: build exit ${build.exitCode}, link before move ${beforeMove?.resolves}, move ${record.moveMs} ms, after move ${afterMove?.resolves}, reinstall exit ${reinstall?.exitCode} in ${reinstall?.milliseconds} ms, after reinstall ${afterReinstall?.resolves}${repair ? `, repair exit ${repair.exitCode} in ${repair.milliseconds} ms, after repair ${afterRepair?.resolves}` : ''}`);
  return record;
}

function probeCold(runIndex, baseCommit) {
  const worktreePath = path.join(probeRoot, `cold-${runIndex}`);
  const freeBefore = runIndex === 1 ? freeBytes(options.repo) : null;
  const gitPhase = addWorktree(worktreePath, baseCommit);
  const copyMs = copyFiles(worktreePath);
  const install = setUp(worktreePath);
  let idleCost = null;
  if (runIndex === 1) {
    const freeAfter = freeBytes(options.repo);
    idleCost = { freeSpaceLostBytes: freeBefore - freeAfter, ...measureTree(worktreePath) };
  }
  const removeMs = removeWorktree(worktreePath, null);
  const record = { ...gitPhase, copyMs, install, removeMs, idleCost };
  log(`p2 run ${runIndex}: add ${record.addMs} ms, configure ${record.configureMs} ms, install ${install.milliseconds} ms (exit ${install.exitCode}), remove ${removeMs} ms`);
  return record;
}

function probeClaim(runIndex, spareCommit, probeName) {
  const worktreePath = path.join(probeRoot, `${probeName}-${runIndex}`);
  const branchName = `probe-claim-${probeName}-${runIndex}-${process.pid}`;
  addWorktree(worktreePath, spareCommit);
  copyFiles(worktreePath);
  const build = setUp(worktreePath);
  const commitsBehind = Number(git(worktreePath, ['rev-list', '--count', `HEAD..${options.base}`]));
  const branch = timed(() => git(worktreePath, ['switch', '-c', branchName]));
  const fetch = timed(() => git(worktreePath, ['fetch', '--no-auto-gc', baseRemote, baseBranch]));
  const fastForward = timed(() => git(worktreePath, ['merge', '--ff-only', options.base]));
  const copyMs = copyFiles(worktreePath);
  const record = timed(() => {
    git(worktreePath, ['config', '--worktree', 'kangentic.baseBranch', baseBranch]);
    git(worktreePath, ['rev-parse', 'HEAD']);
  });
  const install = installEnabled ? runInstallCommand(options.install, worktreePath) : noInstallResult();
  const claimMs = branch.milliseconds + fetch.milliseconds + fastForward.milliseconds + copyMs + record.milliseconds + install.milliseconds;
  const removeMs = removeWorktree(worktreePath, branchName);
  const result = {
    buildInstallMs: build.milliseconds,
    buildExitCode: build.exitCode,
    buildMessages: build.messages,
    commitsBehind,
    branchMs: branch.milliseconds,
    fetchMs: fetch.milliseconds,
    fastForwardMs: fastForward.milliseconds,
    copyMs,
    recordMs: record.milliseconds,
    install,
    claimMs,
    removeMs,
  };
  log(`${probeName} run ${runIndex}: ${commitsBehind} commits behind, branch ${result.branchMs} ms, fetch ${result.fetchMs} ms, ff ${result.fastForwardMs} ms, install ${install.milliseconds} ms (exit ${install.exitCode}), claim ${claimMs} ms`);
  return result;
}

function hasParent(commit) {
  try {
    git(options.repo, ['rev-parse', '--verify', '--quiet', `${commit}^`]);
    return true;
  } catch {
    return false;
  }
}

/** Why p4 cannot run against this lockfile history, or null when it can. */
function lockfileCatchUpSkipReason(lockfileCommit) {
  if (!lockfileCommit) return `${options.lockfile} has no history on ${options.base}`;
  if (!hasParent(lockfileCommit)) return `${options.lockfile} was last changed by the root commit`;
  return null;
}

/**
 * Remove what the probes left behind, including after a throw. Each step logs
 * its own failure instead of throwing, so a cleanup error never replaces the
 * probe's own error. The recursive rm runs only after every leftover
 * node_modules link was removed, because it would follow a Windows junction
 * into the main checkout's node_modules.
 */
function cleanUpProbes() {
  let linksRemoved = false;
  try {
    for (const leftover of fs.existsSync(probeRoot) ? fs.readdirSync(probeRoot) : []) {
      removeNodeModules(path.join(probeRoot, leftover, 'node_modules'));
    }
    linksRemoved = true;
  } catch (error) {
    log(`cleanup kept ${probeRoot} because a node_modules link could not be removed (${error.message})`);
  }
  if (linksRemoved) {
    try {
      fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      log(`cleanup could not remove ${probeRoot} (${error.message})`);
    }
  }
  try {
    git(options.repo, ['worktree', 'prune']);
  } catch (error) {
    log(`cleanup could not prune worktrees (${error.message})`);
  }
  try {
    const branchNames = git(options.repo, ['branch', '--list', `probe-claim-*-${process.pid}`, '--format=%(refname:short)']);
    for (const branchName of branchNames.split(/\r?\n/).filter(Boolean)) git(options.repo, ['branch', '-D', branchName]);
  } catch (error) {
    log(`cleanup could not delete this run's probe-claim branches (${error.message})`);
  }
}

function main() {
  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    install: options.install,
    linkNodeModules: options.linkNodeModules,
    runs: options.runs,
    commitsSinceLockfileChange: null,
    skippedProbes: {},
    probes: {},
  };

  try {
    fs.mkdirSync(probeRoot, { recursive: true });
    log(`fetching ${options.base}`);
    git(options.repo, ['fetch', '--no-auto-gc', baseRemote, baseBranch]);
    const baseCommit = git(options.repo, ['rev-parse', options.base]);
    const lockfileCommit = git(options.repo, ['log', '-1', '--format=%H', options.base, '--', options.lockfile]);
    const lockCommit = lockfileCommit || baseCommit;
    if (lockfileCommit) {
      report.commitsSinceLockfileChange = Number(git(options.repo, ['rev-list', '--count', `${lockfileCommit}..${options.base}`]));
    }
    const probeRunners = {
      p1: (runIndex) => probeMove(runIndex, baseCommit),
      p2: (runIndex) => probeCold(runIndex, baseCommit),
      p3: (runIndex) => probeClaim(runIndex, lockCommit, 'p3'),
      p4: (runIndex) => probeClaim(runIndex, `${lockCommit}^`, 'p4'),
    };
    const skipReasons = { p4: lockfileCatchUpSkipReason(lockfileCommit) };
    for (const probeName of PROBE_NAMES) {
      if (!options.probes.includes(probeName)) continue;
      if (skipReasons[probeName]) {
        report.skippedProbes[probeName] = skipReasons[probeName];
        log(`${probeName} skipped: ${skipReasons[probeName]}`);
        continue;
      }
      report.probes[probeName] = [];
      for (let runIndex = 1; runIndex <= options.runs; runIndex++) report.probes[probeName].push(probeRunners[probeName](runIndex));
    }
  } finally {
    cleanUpProbes();
  }

  const summary = {};
  if (report.probes.p1) {
    summary.p1 = {
      moveMs: summarize(report.probes.p1.map((run) => run.moveMs)),
      reinstallMs: summarize(report.probes.p1.map((run) => run.reinstall?.milliseconds)),
      repairMs: summarize(report.probes.p1.map((run) => run.repair?.milliseconds)),
      linkResolvesAfterMove: report.probes.p1.map((run) => run.afterMove?.resolves),
      linkResolvesAfterReinstall: report.probes.p1.map((run) => run.afterReinstall?.resolves),
      linkResolvesAfterRepair: report.probes.p1.map((run) => run.afterRepair?.resolves),
      reinstallExitCodes: report.probes.p1.map((run) => run.reinstall?.exitCode),
    };
  }
  if (report.probes.p2) {
    summary.p2 = {
      addMs: summarize(report.probes.p2.map((run) => run.addMs)),
      configureMs: summarize(report.probes.p2.map((run) => run.configureMs)),
      copyMs: summarize(report.probes.p2.map((run) => run.copyMs)),
      installMs: summarize(report.probes.p2.map((run) => run.install.milliseconds)),
      removeMs: summarize(report.probes.p2.map((run) => run.removeMs)),
      idleCost: report.probes.p2[0].idleCost,
    };
  }
  for (const probeName of ['p3', 'p4']) {
    const runs = report.probes[probeName];
    if (!runs) continue;
    summary[probeName] = {
      commitsBehind: runs.map((run) => run.commitsBehind),
      buildInstallMs: summarize(runs.map((run) => run.buildInstallMs)),
      branchMs: summarize(runs.map((run) => run.branchMs)),
      fetchMs: summarize(runs.map((run) => run.fetchMs)),
      fastForwardMs: summarize(runs.map((run) => run.fastForwardMs)),
      installMs: summarize(runs.map((run) => run.install.milliseconds)),
      claimMs: summarize(runs.map((run) => run.claimMs)),
    };
  }
  report.summary = summary;
  console.log(JSON.stringify(summary, null, 2));
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
}

main();
