#!/usr/bin/env node
/**
 * The mechanical half of /upgrade-deps. Reads every npm dependency the repo declares, asks the
 * registry what exists now, and says per lockstep group what can move and whether earlier research
 * still answers it.
 *
 * Why a script: `npm install <package>@latest` is a downgrade for anything on a prerelease line.
 * npm's `latest` for node-pty is 1.1.0 and we run 1.2.0-beta.18 for the ConPTY lock, and the same
 * holds for every @xterm package, so following `npm outdated` brings back a crash. Whether a move is
 * a downgrade, a major or a peer conflict is a function of version numbers and is never left to a
 * reading of the output.
 *
 * It runs as often as anyone likes. Nothing here depends on the date: a target is the newest release,
 * and research is reused while the versions match, however old it is.
 *
 * Usage: node scripts/upgrade-deps.mjs inventory [--refresh]
 *        node scripts/upgrade-deps.mjs record-blocker <group> --reason <text> --recheck <text>
 *                                                [--blocked-on <package>=<version>]...
 *        node scripts/upgrade-deps.mjs lockdiff [<package>@<version>]...
 *        node scripts/upgrade-deps.mjs cache-dir
 *   inventory       prints JSON: the groups that can move and audit counts. The registry is read
 *                   on every run. Only research is cached.
 *                   --refresh   marks every group for fresh research, ignoring the cache.
 *   record-blocker  marks a group's brief blocked, so the next run does not file it again. A task
 *                   agent runs this from its worktree, which cannot write the root checkout's
 *                   cache unattended with a file tool but can run this.
 *   lockdiff        prints what the working package-lock.json changed against HEAD, the checks
 *                   apply.md asks of every phase, and whether each named package resolved to the
 *                   version given. Exit 1 when one did not, when a package lost its install script
 *                   flag, or when a workspace version drifted.
 *   cache-dir       prints the folder that holds the research.
 *
 * The cache is one JSON brief per group at <root checkout>/.upgrade-deps/briefs/<group>.json. It is
 * gitignored and sits in the ROOT checkout, so every worktree of a clone reaches the same folder. It
 * has its own folder because `.kangentic/` is the app's (a project delete removes it, and a worktree's
 * copy goes with a preview exit) and `.claude/` is a protected path that background agents cannot
 * write to unattended. Losing it costs a research pass and nothing else. The brief's shape is in
 * .claude/agents/upgrade-researcher.md.
 *
 * Exit 0 with a report, including one that lists registry errors. Exit 2 for a usage error.
 */
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_URL = 'https://registry.npmjs.org';
const REGISTRY_CONCURRENCY = 8;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** The research cache's folder in the root checkout. Must stay gitignored: briefs are not for the public repo. */
export const CACHE_FOLDER = '.upgrade-deps';

/**
 * Packages that release together or must match exactly, so they move in one commit. Tooling that
 * merely peers on another package stays apart: a blocked TypeScript major must not hold eslint's
 * patch, and the peer check below reports the conflict when two do collide.
 *
 * `agree` says what members' targets must share: `version` for a set published under one number,
 * `minor` for a package and a types package that tracks its minors. A group without it may hold
 * different numbers, as xterm's betas do, and other `@types` packages follow their own numbering.
 */
const LOCKSTEP_GROUPS = [
  { group: 'lingui', pattern: /^@lingui\//, agree: 'version' },
  { group: 'xterm', pattern: /^@xterm\// },
  { group: 'tailwind', pattern: /^(tailwindcss|@tailwindcss\/.+)$/, agree: 'version' },
  { group: 'playwright', pattern: /^(playwright|@playwright\/test)$/, agree: 'version' },
  { group: 'sentry-build-plugins', pattern: /^@sentry\/(esbuild|vite)-plugin$/, agree: 'version' },
  { group: 'react', pattern: /^(react|react-dom|@types\/react|@types\/react-dom)$/ },
  { group: 'three', pattern: /^(three|@types\/three)$/, agree: 'minor' },
  { group: 'dnd-kit', pattern: /^@dnd-kit\// },
  { group: 'commitlint', pattern: /^@commitlint\//, agree: 'version' },
  { group: 'noble', pattern: /^@noble\// },
  { group: 'eslint', pattern: /^(eslint|@eslint\/js|typescript-eslint|eslint-plugin-react-hooks)$/ },
  { group: 'electron-builder', pattern: /^electron-(builder|updater)$/ },
];

/** The group a package moves with. A `@types/x` package moves with `x`. */
export function groupOf(packageName) {
  for (const { group, pattern } of LOCKSTEP_GROUPS) {
    if (pattern.test(packageName)) return group;
  }
  const typesMatch = /^@types\/(.+)$/.exec(packageName);
  const baseName = typesMatch ? typesMatch[1] : packageName;
  return baseName.replace(/^@/, '').replace(/\//g, '-');
}

/**
 * The highest release worth moving to. Nothing at or below `installed` ever qualifies, which is the
 * guard for a package whose `latest` sits behind the prerelease we run. A stable install never
 * crosses its ceiling or takes a prerelease. The ceiling is `latest`, or a stable dist-tag on the
 * installed major when that is higher: electron-builder publishes 26.x under a `v26` tag, so `latest`
 * trails it. A tag for another major is ignored, so an old line's tag never pulls us across a major.
 * A prerelease install takes another prerelease only of the same major.minor.patch, so once the
 * stable release ships it moves there and not on to the next line's beta. Renovate's `ignoreUnstable`
 * draws the same line.
 *
 * @returns {string | null} the version to move to, or null when nothing qualifies
 */
export function chooseTarget({ installed, distTags, versions }) {
  const installedBase = semver.prerelease(installed) ? semver.coerce(installed).version : null;
  const installedMajor = semver.major(installed);
  const ceiling = Object.entries(distTags)
    .filter(([tag, version]) => semver.valid(version) && !semver.prerelease(version)
      && (tag === 'latest' || semver.major(version) === installedMajor))
    .map(([, version]) => version)
    .sort(semver.rcompare)[0];

  const candidates = Object.keys(versions)
    .filter((version) => {
      if (!semver.valid(version) || !semver.gt(version, installed)) return false;
      if (versions[version].deprecated) return false;
      if (semver.prerelease(version)) return semver.coerce(version).version === installedBase;
      return ceiling === undefined || semver.lte(version, ceiling);
    })
    .sort(semver.rcompare);

  return candidates[0] ?? null;
}

/**
 * What changed between two versions that the 2026 npm attacks changed. A compromised axios release
 * differed from the last good one only by a new dependency and a publish with no provenance, and
 * Phantom Gyp ran code through a `binding.gyp` with no install script at all. Each one is a reason
 * to look, not a verdict: TypeScript 7 adds 20 platform packages and a new publisher legitimately.
 *
 * @returns {string[]} one line per signal
 */
export function supplyChainSignals(from, to) {
  if (!from || !to) return [];
  const signals = [];
  const added = Object.keys(to.dependencies ?? {}).filter((name) => !(name in (from.dependencies ?? {})));
  if (added.length > 0) signals.push(`new dependencies (${added.length}): ${added.slice(0, 5).join(', ')}`);
  const scripts = (to.installScripts ?? []).filter((script) => !(from.installScripts ?? []).includes(script));
  if (scripts.length > 0) signals.push(`new install scripts: ${scripts.join(', ')}`);
  if (to.gypfile && !from.gypfile) signals.push('a binding.gyp build appeared');
  if (from.attested && !to.attested) signals.push('provenance dropped');
  if (from.publisher && to.publisher && from.publisher !== to.publisher) {
    signals.push(`publisher changed: ${from.publisher} to ${to.publisher}`);
  }
  return signals;
}

/** Whether a group's targets share what its `agree` asks for. Only moving members are compared. */
export function targetsAgree(group, members) {
  const agree = LOCKSTEP_GROUPS.find((entry) => entry.group === group)?.agree;
  if (!agree) return true;
  const keyOf = agree === 'minor'
    ? ({ target }) => `${semver.major(target)}.${semver.minor(target)}`
    : ({ target }) => target;
  return new Set(members.map(keyOf)).size === 1;
}

/** `major` also covers a `^0.x` minor and a `0.0.x` patch, which semver treats as breaking. */
export function changeKind(installed, target) {
  const installedParts = semver.parse(installed);
  const targetParts = semver.parse(target);
  if (installedParts.major !== targetParts.major) return 'major';
  if (installedParts.major === 0 && installedParts.minor !== targetParts.minor) return 'major';
  if (installedParts.major === 0 && installedParts.minor === 0 && installedParts.patch !== targetParts.patch) {
    return 'major';
  }
  const difference = semver.diff(installed, target);
  if (difference === 'prerelease') return 'prerelease';
  return difference !== null && difference.includes('minor') ? 'minor' : 'patch';
}

/**
 * Every registry dependency the manifests declare, one record per package name. A workspace link or
 * a non-registry spec has nothing to upgrade. A name declared in two places reports the lowest
 * installed version, so the older copy is what the move is measured from.
 *
 * @param {Array<{ location: string, manifest: Record<string, unknown> }>} manifests `location` is
 *   the manifest's folder relative to the root, empty for the root
 * @param {Record<string, { version?: string, link?: boolean }>} lockPackages `package-lock.json`'s
 *   `packages` map
 */
export function collectDeclared(manifests, lockPackages) {
  const declared = new Map();
  for (const { location, manifest } of manifests) {
    for (const block of DEPENDENCY_BLOCKS) {
      for (const [name, spec] of Object.entries(manifest[block] ?? {})) {
        const lockEntry = lockPackages[location ? `${location}/node_modules/${name}` : `node_modules/${name}`]
          ?? lockPackages[`node_modules/${name}`];
        if (!lockEntry || lockEntry.link || !lockEntry.version || !semver.validRange(spec)) continue;
        const record = declared.get(name) ?? {
          name, installed: lockEntry.version, pinned: false, runtime: false, locations: [],
        };
        if (semver.lt(lockEntry.version, record.installed)) record.installed = lockEntry.version;
        record.pinned = record.pinned || semver.valid(spec) !== null;
        record.runtime = record.runtime || (location === '' && block === 'dependencies');
        record.locations.push(location || '.');
        declared.set(name, record);
      }
    }
  }
  return [...declared.values()];
}

/** Each conflict's `requirement` leaves out the peer's version, so one the tree has stays one when the peer moves. */
function peerConflicts(plan, peersOf) {
  const conflicts = [];
  for (const [name, version] of Object.entries(plan)) {
    for (const [peer, range] of Object.entries(peersOf(name, version))) {
      if (plan[peer] === undefined || !semver.validRange(range)) continue;
      if (!semver.satisfies(plan[peer], range, { includePrerelease: true })) {
        conflicts.push({ requirement: `${name}@${version} needs ${peer} ${range}`, planned: plan[peer] });
      }
    }
  }
  return conflicts;
}

/**
 * The peer conflicts moving ONE group would add. Each group is checked alone against what is
 * installed, so a blocked major reports against its own group and not against a neighbor's patch,
 * and a conflict the tree already has is not news.
 *
 * @param {Record<string, string>} installed package name to installed version
 * @param {Record<string, string>} groupTargets package name to target version
 * @param {(name: string, version: string) => Record<string, string>} peersOf
 */
export function newPeerConflicts(installed, groupTargets, peersOf) {
  const baseline = new Set(peerConflicts(installed, peersOf).map(({ requirement }) => requirement));
  return peerConflicts({ ...installed, ...groupTargets }, peersOf)
    .filter(({ requirement }) => !baseline.has(requirement))
    .map(({ requirement, planned }) => `${requirement}, planned ${planned}`);
}

function sameVersions(left, right) {
  const leftNames = Object.keys(left);
  return leftNames.length === Object.keys(right).length
    && leftNames.every((name) => left[name] === right[name]);
}

function isBrief(candidate) {
  return typeof candidate === 'object' && candidate !== null
    && candidate.draft !== true
    && typeof candidate.targets === 'object' && candidate.targets !== null
    && typeof candidate.evaluatedAt === 'string' && !Number.isNaN(Date.parse(candidate.evaluatedAt))
    && (candidate.verdict === 'ready' || candidate.verdict === 'blocked');
}

/**
 * What earlier research is worth for a group, given what the registry says today. Research for a
 * version never expires: the release notes for a published version do not change, so only a version
 * moving, or `--refresh`, sends a group back to an agent. A second run costs one inventory.
 *
 *   research  no usable brief: full research.
 *   delta     a brief exists for other versions: read it and cover only the new releases.
 *   recheck   blocked, and what it was waiting on has moved: test the blocker alone.
 *   reuse     same versions: no research.
 *   blocked   same versions, same blocker: no research, reported as blocked.
 *   filed     a board task already carries this brief: confirm it is open.
 */
export function researchState({ brief, targets, watchedVersions, refresh }) {
  if (!isBrief(brief) || refresh) return 'research';
  if (!sameVersions(brief.targets, targets)) return 'delta';
  if (brief.task) return 'filed';
  if (brief.verdict !== 'blocked') return 'reuse';
  const watched = Object.entries(brief.blocker?.blockedOn ?? {});
  return watched.every(([name, version]) => watchedVersions[name] === version) ? 'blocked' : 'recheck';
}

/**
 * What a blocker compares against: the newest release on the line it recorded. Reading `latest` alone
 * misses a fix on a prerelease line, because `latest` for @xterm/addon-webgl sits behind the beta we
 * run, so a recorded beta stays on its beta line.
 */
export function watchedVersion(recorded, { distTags, versions }) {
  if (!semver.valid(recorded)) return distTags.latest;
  return chooseTarget({ installed: recorded, distTags, versions }) ?? recorded;
}

/** A brief marked blocked by a task agent that could not land the group. */
export function withBlocker(brief, { reason, recheck, blockedOn }, now) {
  return {
    ...brief,
    verdict: 'blocked',
    task: null,
    evaluatedAt: new Date(now).toISOString(),
    blocker: { reason, recheck, blockedOn },
  };
}

const KIND_ORDER = ['prerelease', 'patch', 'minor', 'major', 'deprecated'];

function widestKind(members) {
  return members.reduce((widest, member) => (
    KIND_ORDER.indexOf(member.kind) > KIND_ORDER.indexOf(widest) ? member.kind : widest
  ), 'prerelease');
}

/**
 * The report. `declared` comes from collectDeclared, `packuments` maps a name to the registry's
 * { distTags, versions, times }, and `briefs` maps a group to its parsed brief. `advisories` maps a
 * name to the severity of an advisory against that package itself. `inheritedAdvisories` is the same
 * for one that reaches a direct dependency from below it, which moving that package may or may not
 * clear.
 *
 * `packuments` may also hold packages nothing declares, read because a brief's blocker waits on
 * them. Those only supply the blocker check.
 *
 * A group moves whole. Publishing a set takes minutes, and a `@types` package can lag its library,
 * so a run can catch members on different numbers. `targetsDisagree` flags that, and research picks
 * a set that matches.
 *
 * A package whose installed or latest version is deprecated with nothing to move to is reported as
 * a group of kind `deprecated`, targeted at what is installed so its brief still caches. Counting it
 * as current would hide the one case with no upgrade: `@types/uuid` is a stub now, and the fix is to
 * remove it.
 */
export function buildInventory({
  declared, packuments, advisories, inheritedAdvisories = {}, briefs, now, refresh,
}) {
  const installedVersions = Object.fromEntries(declared.map(({ name, installed }) => [name, installed]));
  const peersOf = (name, version) => packuments[name]?.versions[version]?.peerDependencies ?? {};
  const watchedVersions = (brief) => Object.fromEntries(
    Object.entries(brief?.blocker?.blockedOn ?? {}).flatMap(([name, recorded]) => (
      packuments[name] ? [[name, watchedVersion(recorded, packuments[name])]] : []
    )),
  );
  const movable = new Map();
  let currentCount = 0;

  for (const record of declared) {
    const packument = packuments[record.name];
    if (!packument) continue;
    const found = chooseTarget({
      installed: record.installed,
      distTags: packument.distTags,
      versions: packument.versions,
    });
    const deprecated = packument.versions[record.installed]?.deprecated
      ?? packument.versions[packument.distTags.latest]?.deprecated
      ?? null;
    if (found === null && !deprecated) {
      currentCount += 1;
      continue;
    }
    const target = found ?? record.installed;
    const group = groupOf(record.name);
    movable.set(group, [...(movable.get(group) ?? []), {
      ...record,
      target,
      kind: found === null ? 'deprecated' : changeKind(record.installed, found),
      published: packument.times[target] ?? null,
      advisory: advisories[record.name] ?? null,
      inheritedAdvisory: inheritedAdvisories[record.name] ?? null,
      deprecated: deprecated ? String(deprecated).slice(0, 200) : null,
      signals: supplyChainSignals(packument.versions[record.installed], packument.versions[target]),
    }]);
  }

  const groups = [...movable.entries()].map(([group, members]) => {
    const targets = Object.fromEntries(members.map(({ name, target }) => [name, target]));
    const brief = briefs[group];
    return {
      group,
      kind: widestKind(members),
      runtime: members.some(({ runtime }) => runtime),
      pinned: members.some(({ pinned }) => pinned),
      advisory: members.some(({ advisory }) => advisory !== null),
      signals: members.some(({ signals }) => signals.length > 0),
      targetsDisagree: !targetsAgree(group, members),
      research: researchState({ brief, targets, watchedVersions: watchedVersions(brief), refresh }),
      hasBrief: brief !== undefined,
      peerConflicts: newPeerConflicts(installedVersions, targets, peersOf),
      blocker: brief?.blocker ?? null,
      task: brief?.task ?? null,
      members,
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    groups: groups.sort((left, right) => left.group.localeCompare(right.group)),
    currentCount,
  };
}

/**
 * What moved between two lockfiles' `packages` maps. With 29 phases nobody reads 29 lockfile diffs, so
 * this reports the things `apply.md` asks of each one: an unplanned package, a lost install script
 * flag, and a workspace version that drifted.
 */
export function diffLockfile(before, after) {
  const shortName = (key) => key.replace(/^node_modules\//, '');
  const changed = [];
  const added = [];
  const installScriptFlips = [];
  for (const [key, entry] of Object.entries(after)) {
    const previous = before[key];
    if (!previous) {
      added.push({ name: shortName(key), version: entry.version, hasInstallScript: Boolean(entry.hasInstallScript) });
      continue;
    }
    if (previous.version !== entry.version) {
      changed.push({ name: shortName(key), from: previous.version, to: entry.version });
    }
    if (Boolean(previous.hasInstallScript) !== Boolean(entry.hasInstallScript)) {
      installScriptFlips.push({ name: shortName(key), had: Boolean(previous.hasInstallScript) });
    }
  }
  const removed = Object.entries(before)
    .filter(([key]) => !after[key])
    .map(([key, entry]) => ({ name: shortName(key), version: entry.version }));
  const workspaceDrift = Object.keys(after)
    .filter((key) => key.startsWith('packages/') && before[key]?.version !== after[key]?.version);
  return { changed, added, removed, installScriptFlips, workspaceDrift };
}

async function readPackument(name) {
  const response = await fetch(`${REGISTRY_URL}/${name.replace('/', '%2F')}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const document = await response.json();
  const versions = {};
  for (const [version, manifest] of Object.entries(document.versions ?? {})) {
    versions[version] = {
      deprecated: manifest.deprecated,
      peerDependencies: manifest.peerDependencies,
      dependencies: manifest.dependencies,
      installScripts: INSTALL_SCRIPTS.filter((script) => manifest.scripts?.[script]),
      gypfile: manifest.gypfile === true,
      attested: Boolean(manifest.dist?.attestations),
      publisher: manifest._npmUser?.name,
    };
  }
  return { distTags: document['dist-tags'] ?? {}, versions, times: document.time ?? {} };
}

async function readPackuments(names) {
  const packuments = {};
  const errors = [];
  const queue = [...names];
  async function work() {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      try {
        packuments[name] = await readPackument(name);
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: REGISTRY_CONCURRENCY }, work));
  return { packuments, errors };
}

/**
 * Splits `npm audit` for the report. A `via` entry that is an object is an advisory against the
 * package itself. A string names the dependency it reached this package through, and `isDirect`
 * is true for that package all the same, so `isDirect` alone would blame a build plugin for an issue
 * deep below it.
 *
 * @param {{ vulnerabilities?: Record<string, { name: string, severity: string, isDirect: boolean, via: unknown[] }> }} report
 */
export function splitAudit(report) {
  const advisories = {};
  const inheritedAdvisories = {};
  let transitiveCount = 0;
  for (const { name, severity, isDirect, via } of Object.values(report.vulnerabilities ?? {})) {
    if (!isDirect) transitiveCount += 1;
    else if (via.some((entry) => typeof entry === 'object')) advisories[name] = severity;
    else inheritedAdvisories[name] = severity;
  }
  return { advisories, inheritedAdvisories, transitiveCount };
}

/** npm audit exits 1 when it finds anything, so its report is read from either outcome. */
async function readAudit() {
  let output;
  try {
    ({ stdout: output } = await execAsync('npm audit --json', {
      cwd: REPOSITORY_ROOT,
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
    }));
  } catch (error) {
    output = error.stdout;
  }
  try {
    return splitAudit(JSON.parse(output));
  } catch {
    return { advisories: {}, inheritedAdvisories: {}, transitiveCount: null };
  }
}

async function cacheDirectory() {
  const { stdout } = await execFileAsync(
    'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPOSITORY_ROOT },
  );
  return path.join(path.dirname(stdout.trim()), CACHE_FOLDER);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readBriefs(briefsDirectory) {
  const briefs = {};
  if (!fs.existsSync(briefsDirectory)) return briefs;
  for (const fileName of fs.readdirSync(briefsDirectory)) {
    if (!fileName.endsWith('.json')) continue;
    try {
      briefs[fileName.slice(0, -'.json'.length)] = readJson(path.join(briefsDirectory, fileName));
    } catch {
      // An unreadable brief is the same as no brief: the group gets researched again.
    }
  }
  return briefs;
}

function readManifests() {
  const rootManifest = readJson(path.join(REPOSITORY_ROOT, 'package.json'));
  return [
    { location: '', manifest: rootManifest },
    ...(rootManifest.workspaces ?? []).map((location) => ({
      location,
      manifest: readJson(path.join(REPOSITORY_ROOT, location, 'package.json')),
    })),
  ];
}

async function runInventory(args) {
  const lockfile = readJson(path.join(REPOSITORY_ROOT, 'package-lock.json'));
  const declared = collectDeclared(readManifests(), lockfile.packages);
  const cacheDir = await cacheDirectory();
  const briefs = readBriefs(path.join(cacheDir, 'briefs'));
  const watchedNames = Object.values(briefs).flatMap((brief) => Object.keys(brief?.blocker?.blockedOn ?? {}));
  const [{ packuments, errors }, { advisories, inheritedAdvisories, transitiveCount }] = await Promise.all([
    readPackuments([...new Set([...declared.map(({ name }) => name), ...watchedNames])]),
    readAudit(),
  ]);
  const inventory = buildInventory({
    declared,
    packuments,
    advisories,
    inheritedAdvisories,
    briefs,
    now: Date.now(),
    refresh: args.includes('--refresh'),
  });
  // Absent means no: a null, false or empty field is dropped, so the report stays small in a transcript.
  const dropEmpty = (key, value) => (
    value === null || value === false || (Array.isArray(value) && value.length === 0) ? undefined : value
  );
  console.log(JSON.stringify({ cacheDir, ...inventory, transitiveAdvisories: transitiveCount, errors }, dropEmpty));
}

function readTextOption(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function runRecordBlocker([group, ...args]) {
  const reason = readTextOption(args, '--reason');
  const recheck = readTextOption(args, '--recheck');
  if (!group || !reason || !recheck) {
    console.error('usage: node scripts/upgrade-deps.mjs record-blocker <group> --reason <text> --recheck <text>');
    process.exit(2);
  }
  const blockedOn = {};
  args.forEach((argument, index) => {
    if (argument !== '--blocked-on') return;
    const pair = args[index + 1] ?? '';
    const separator = pair.lastIndexOf('=');
    if (separator > 0) blockedOn[pair.slice(0, separator)] = pair.slice(separator + 1);
  });
  const briefPath = path.join(await cacheDirectory(), 'briefs', `${group}.json`);
  if (!fs.existsSync(briefPath)) {
    console.error(`No brief for ${group} at ${briefPath}. Put the blocker in your report instead.`);
    process.exit(2);
  }
  const blocked = withBlocker(readJson(briefPath), { reason, recheck, blockedOn }, Date.now());
  fs.writeFileSync(briefPath, `${JSON.stringify(blocked, null, 2)}\n`);
  console.log(`Recorded ${group} as blocked.`);
}

async function runLockdiff(expected) {
  const { stdout } = await execFileAsync('git', ['show', 'HEAD:package-lock.json'], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
  });
  const before = JSON.parse(stdout).packages;
  const after = readJson(path.join(REPOSITORY_ROOT, 'package-lock.json')).packages;
  const diff = diffLockfile(before, after);
  const print = (label, lines) => {
    console.log(`${label} (${lines.length})`);
    for (const line of lines) console.log(`  ${line}`);
  };
  print('changed', diff.changed.map(({ name, from, to }) => `${name} ${from} -> ${to}`));
  print('added', diff.added.map(({ name, version, hasInstallScript }) => (
    `${name}@${version}${hasInstallScript ? ' HAS INSTALL SCRIPT' : ''}`
  )));
  print('removed', diff.removed.map(({ name, version }) => `${name}@${version}`));
  print('install script flag changed', diff.installScriptFlips.map(({ name, had }) => (
    `${name}: ${had ? 'lost it' : 'gained it'}`
  )));
  print('workspace version drift', diff.workspaceDrift);
  const mismatches = expected.filter((pair) => {
    const separator = pair.lastIndexOf('@');
    const resolved = after[`node_modules/${pair.slice(0, separator)}`]?.version;
    const wanted = pair.slice(separator + 1);
    console.log(`${resolved === wanted ? 'OK ' : 'BAD'} ${pair.slice(0, separator)}: wanted ${wanted}, resolved ${resolved}`);
    return resolved !== wanted;
  });
  const lostFlag = diff.installScriptFlips.some(({ had }) => had);
  if (mismatches.length > 0 || lostFlag || diff.workspaceDrift.length > 0) process.exitCode = 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'inventory') {
    await runInventory(args);
  } else if (command === 'record-blocker') {
    await runRecordBlocker(args);
  } else if (command === 'lockdiff') {
    await runLockdiff(args);
  } else if (command === 'cache-dir') {
    console.log(await cacheDirectory());
  } else {
    console.error('usage: node scripts/upgrade-deps.mjs inventory|record-blocker|lockdiff|cache-dir');
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
