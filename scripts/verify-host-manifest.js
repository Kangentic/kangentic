#!/usr/bin/env node
/**
 * Fails when the host program's manifest is missing or wrong, in a place where it must be right.
 *
 * Two callers, one rule (.claude/rules/release-gates-fail-loudly.md):
 *
 *   node scripts/verify-host-manifest.js --packaged <matrix.platform>
 *       In each release leg after electron-builder: the packaged app's resources/host/manifest.json
 *       must be there and complete. electron-builder only warns when an extraResources source is
 *       missing, so without this a leg that lost the manifest would ship an installer whose Add
 *       host says "no host program", with every job green.
 *
 *   node scripts/verify-host-manifest.js --file <path> [--archives <folder>]
 *       In the build-host job: the manifest it just wrote, and, with --archives, that every archive
 *       it names is in the folder with the size and SHA-256 it claims.
 *
 * The reader this mirrors is src/main/remote/host-assets.ts, which is lenient by design (a bad entry
 * is left out and logged). A release is not allowed to be lenient: both CPUs, the exact file names,
 * and a download address on this repository's release for this version.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARCHES = ['x64', 'arm64'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @param {unknown} manifest Parsed manifest.json.
 * @param {{ version: string }} expected
 * @returns {string[]} What is wrong with it; empty when it is whole.
 */
function manifestProblems(manifest, expected) {
  if (typeof manifest !== 'object' || manifest === null) return ['the manifest is not an object'];
  const problems = [];
  if (manifest.version !== expected.version) {
    problems.push(`the manifest is for version ${String(manifest.version)}, and this release is ${expected.version}`);
  }
  if (typeof manifest.node !== 'string' || manifest.node.length === 0) problems.push('the manifest does not name the Node version it carries');
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (assets.length !== ARCHES.length) problems.push(`the manifest lists ${assets.length} archives, and a release carries ${ARCHES.length} (${ARCHES.join(', ')})`);
  for (const arch of ARCHES) {
    const entry = assets.find((candidate) => candidate && candidate.arch === arch);
    if (!entry) {
      problems.push(`the manifest has no ${arch} archive`);
      continue;
    }
    const file = `kangentic-host-${expected.version}-linux-${arch}.tar.gz`;
    if (entry.file !== file) problems.push(`the ${arch} archive is named ${String(entry.file)}, not ${file}`);
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) problems.push(`the ${arch} checksum is not a lowercase SHA-256`);
    if (!Number.isInteger(entry.size) || entry.size <= 0) problems.push(`the ${arch} size is not a positive whole number`);
    if (typeof entry.url !== 'string' || !entry.url.startsWith('https://') || !entry.url.endsWith(`/v${expected.version}/${file}`)) {
      problems.push(`the ${arch} download address is not an https address ending /v${expected.version}/${file}`);
    }
  }
  return problems;
}

/**
 * @param {unknown} manifest A manifest that already passed manifestProblems.
 * @param {string} folder Where the archives are.
 * @returns {string[]}
 */
function archiveProblems(manifest, folder) {
  const problems = [];
  for (const entry of manifest.assets) {
    const filePath = path.join(folder, entry.file);
    if (!fs.existsSync(filePath)) {
      problems.push(`${entry.file} is in the manifest but not in ${folder}`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== entry.size) problems.push(`${entry.file} is ${bytes.length} bytes and the manifest says ${entry.size}`);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) problems.push(`${entry.file} hashes to ${actual} and the manifest says ${entry.sha256}`);
  }
  return problems;
}

/**
 * Where electron-builder puts a platform's resources folder, as the release legs' other verify steps
 * already assume: out/mac*\/Kangentic.app/Contents/Resources, out/win-unpacked/resources and
 * out/<linux-unpacked|linux-arm64-unpacked>/resources.
 *
 * @param {string} platform A release matrix platform.
 * @param {string} outDirectory electron-builder's output folder.
 * @returns {string[]} Every resources folder that platform's leg produced.
 */
function packagedResourceFolders(platform, outDirectory) {
  if (platform.startsWith('macos')) {
    if (!fs.existsSync(outDirectory)) return [];
    return fs
      .readdirSync(outDirectory)
      .filter((name) => name.startsWith('mac'))
      .map((name) => path.join(outDirectory, name, 'Kangentic.app', 'Contents', 'Resources'))
      .filter((folder) => fs.existsSync(folder));
  }
  if (platform === 'windows') return [path.join(outDirectory, 'win-unpacked', 'resources')];
  if (platform === 'linux') return [path.join(outDirectory, 'linux-unpacked', 'resources')];
  if (platform === 'linux-arm64') return [path.join(outDirectory, 'linux-arm64-unpacked', 'resources')];
  return [];
}

function readManifest(filePath) {
  try {
    return { manifest: JSON.parse(fs.readFileSync(filePath, 'utf8')), problem: null };
  } catch (error) {
    return { manifest: null, problem: `${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`::error::${line}\n`);
  process.exit(1);
}

function main(argv) {
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  const packaged = argumentValue(argv, '--packaged');
  const file = argumentValue(argv, '--file');
  if (packaged) {
    const folders = packagedResourceFolders(packaged, argumentValue(argv, '--out') ?? 'out');
    if (folders.length === 0) fail([`No packaged resources folder found for the ${packaged} leg, so the host manifest cannot be checked.`]);
    for (const folder of folders) {
      const manifestPath = path.join(folder, 'host', 'manifest.json');
      const { manifest, problem } = readManifest(manifestPath);
      if (problem) fail([`${problem} The installer would say it has no host program.`]);
      const problems = manifestProblems(manifest, { version });
      if (problems.length > 0) fail(problems.map((line) => `${manifestPath}: ${line}.`));
      process.stdout.write(`Found ${manifestPath}: version ${version}, ${manifest.assets.length} archives.\n`);
    }
    return;
  }
  if (file) {
    const { manifest, problem } = readManifest(file);
    if (problem) fail([problem]);
    const problems = manifestProblems(manifest, { version });
    const archives = argumentValue(argv, '--archives');
    if (problems.length === 0 && archives) problems.push(...archiveProblems(manifest, archives));
    if (problems.length > 0) fail(problems.map((line) => `${file}: ${line}.`));
    process.stdout.write(`${file} is whole: version ${version}, ${manifest.assets.length} archives${archives ? ', all present and matching' : ''}.\n`);
    return;
  }
  fail(['Usage: verify-host-manifest.js --packaged <platform> [--out <dir>] | --file <manifest.json> [--archives <dir>]']);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { manifestProblems, archiveProblems, packagedResourceFolders };
