#!/usr/bin/env node
// Builds the host program Kangentic installs on an SSH host (the "host asset"): one tarball per CPU holding a
// pinned Node, the helper bundle and node-pty's Linux prebuild. The app uploads the one that matches a host over
// the connection the user already made, and the host checks its SHA-256 before it unpacks anything.
//
// Usage:
//   npm run build:host                      both CPUs, into dist/host
//   node scripts/build-host.mjs --arch x64  one CPU
//   node scripts/build-host.mjs --out <dir> somewhere else
//   node scripts/build-host.mjs --url-base https://github.com/<owner>/<repo>/releases/download/v<version> \
//        --manifest-out <dir>               also write the manifest ALONE (with a download address per
//                                           archive) to <dir>, for a build that fetches the archives on first use
//
// It works on any OS, because node-pty ships the Linux prebuilds and Node is downloaded, not run. The only
// network access is nodejs.org, for the Node tarball and its published checksums, and a mismatch stops the build.
// A tarball is cached under node_modules/.cache so a second build is offline.
//
// Output (dist/host by default):
//   manifest.json                                       { version, node, assets: [{ arch, file, sha256, size }] }
//   kangentic-host-<version>-linux-<arch>.tar.gz
//
// The app reads manifest.json (src/main/remote/host-assets.ts) and refuses a manifest whose version is not its own.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Pinned. Raise it deliberately: the helper runs on this Node on every host. */
export const NODE_VERSION = 'v24.22.2';
const NODE_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;
const ARCHES = { x64: 'x64', arm64: 'arm64' };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// By full path on Windows: a bare `tar` can find Git's GNU tar, which reads "C:" as a remote host.
const tarPath = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function parseArguments(argumentList) {
  const parsed = { arches: Object.keys(ARCHES), out: path.join(repoRoot, 'dist', 'host'), urlBase: null, manifestOut: null };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--arch') {
      parsed.arches = String(argumentList[(index += 1)]).split(',').map((arch) => arch.trim()).filter(Boolean);
      const unknown = parsed.arches.filter((arch) => !(arch in ARCHES));
      if (unknown.length > 0) throw new Error(`Unknown --arch ${unknown.join(', ')}. Known: ${Object.keys(ARCHES).join(', ')}`);
    } else if (argument === '--out') parsed.out = path.resolve(String(argumentList[(index += 1)]));
    else if (argument === '--url-base') parsed.urlBase = String(argumentList[(index += 1)]).replace(/\/+$/, '');
    else if (argument === '--manifest-out') parsed.manifestOut = path.resolve(String(argumentList[(index += 1)]));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (parsed.arches.length === 0) throw new Error('--arch names no CPU');
  if (parsed.manifestOut && !parsed.urlBase) throw new Error('--manifest-out writes a manifest with download addresses, so it needs --url-base.');
  if (parsed.urlBase && !parsed.urlBase.startsWith('https://')) throw new Error('--url-base must be an https:// address: the app refuses any other.');
  return parsed;
}

function say(line) {
  process.stdout.write(`[build-host] ${line}\n`);
}

function execute(command, args, { timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const partial = `${destination}.part`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, destination);
}

/** The pinned Node tarball for a CPU, checked against the checksum nodejs.org publishes. */
async function fetchNode(arch, cacheDirectory) {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const tarballName = `node-${NODE_VERSION}-linux-${arch}.tar.xz`;
  const tarball = path.join(cacheDirectory, tarballName);
  const sums = path.join(cacheDirectory, `SHASUMS256-${NODE_VERSION}.txt`);
  if (!fs.existsSync(sums)) await download(`${NODE_BASE_URL}/SHASUMS256.txt`, sums);
  if (!fs.existsSync(tarball)) await download(`${NODE_BASE_URL}/${tarballName}`, tarball);
  const expected = fs.readFileSync(sums, 'utf8').split('\n').find((line) => line.endsWith(`  ${tarballName}`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  if (!expected || expected !== actual) {
    fs.rmSync(tarball, { force: true });
    throw new Error(`SHA-256 mismatch for ${tarballName}: nodejs.org publishes ${expected ?? 'nothing'}, got ${actual}. The cached file was removed.`);
  }
  say(`verified ${tarballName}`);
  return tarball;
}

/** The helper bundle, and node-pty without the platforms this asset does not run on. */
async function stageApp(stageDirectory, arch) {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const esbuild = require('esbuild');
  fs.rmSync(stageDirectory, { recursive: true, force: true });
  fs.mkdirSync(stageDirectory, { recursive: true });
  await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers', 'font-list', 'koffi'],
    conditions: ['require'],
    define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''), MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'), __KANGENTIC_DEV__: 'false' },
    logLevel: 'warning',
    minify: true,
    entryPoints: [path.join(repoRoot, 'src/main/remote/helper/host-main.ts')],
    outfile: path.join(stageDirectory, 'host.js'),
  });
  const nodePtySource = fs.realpathSync(path.join(repoRoot, 'node_modules/node-pty'));
  const nodePtyTarget = path.join(stageDirectory, 'node_modules/node-pty');
  const prebuild = path.join(nodePtySource, 'prebuilds', `linux-${arch}`);
  if (!fs.existsSync(prebuild)) throw new Error(`node-pty ships no prebuild for linux-${arch}: ${prebuild}`);
  fs.mkdirSync(nodePtyTarget, { recursive: true });
  fs.copyFileSync(path.join(nodePtySource, 'package.json'), path.join(nodePtyTarget, 'package.json'));
  fs.cpSync(path.join(nodePtySource, 'lib'), path.join(nodePtyTarget, 'lib'), { recursive: true });
  fs.cpSync(prebuild, path.join(nodePtyTarget, 'prebuilds', `linux-${arch}`), { recursive: true });
}

/**
 * One archive: Node without npm, headers or docs and without its symlinks (an NTFS checkout cannot make
 * them), and the staged app. The host's installer sets the execute bits, so the archive need not carry them.
 */
async function buildArchive({ arch, version, outDirectory, workDirectory, nodeTarball }) {
  const assetRoot = path.join(workDirectory, `asset-root-${arch}`);
  fs.rmSync(assetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(assetRoot, 'node'), { recursive: true });
  const excludes = ['*/lib/node_modules', '*/bin/npm', '*/bin/npx', '*/bin/corepack', '*/include', '*/share'].flatMap((pattern) => ['--exclude', pattern]);
  const extracted = await execute(tarPath, ['-xJf', nodeTarball, '-C', path.join(assetRoot, 'node'), '--strip-components=1', ...excludes]);
  if (extracted.code !== 0) throw new Error(`could not unpack the Node tarball: ${extracted.stderr}`);

  const stage = path.join(workDirectory, `stage-${arch}`);
  await stageApp(stage, arch);
  fs.cpSync(stage, path.join(assetRoot, 'app'), { recursive: true });

  const file = `kangentic-host-${version}-linux-${arch}.tar.gz`;
  const filePath = path.join(outDirectory, file);
  fs.rmSync(filePath, { force: true });
  const packed = await execute(tarPath, ['-czf', filePath, '-C', assetRoot, '.']);
  if (packed.code !== 0) throw new Error(`could not pack ${file}: ${packed.stderr}`);
  const bytes = fs.readFileSync(filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  say(`${file}: ${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}`);
  return { arch, file, sha256, size: bytes.length };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  fs.rmSync(options.out, { recursive: true, force: true });
  fs.mkdirSync(options.out, { recursive: true });
  const cacheDirectory = path.join(repoRoot, 'node_modules', '.cache', 'kangentic-host', NODE_VERSION);
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-build-host-'));
  try {
    const assets = [];
    for (const arch of options.arches) {
      const nodeTarball = await fetchNode(arch, cacheDirectory);
      assets.push(await buildArchive({ arch, version, outDirectory: options.out, workDirectory, nodeTarball }));
    }
    const withUrls = options.urlBase ? assets.map((asset) => ({ ...asset, url: `${options.urlBase}/${asset.file}` })) : assets;
    fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify({ version, node: NODE_VERSION, assets: withUrls }, null, 2)}\n`);
    say(`wrote ${path.relative(repoRoot, options.out) || options.out}${path.sep}manifest.json`);
    if (options.manifestOut) {
      // The manifest alone, for a build that downloads the archives on first use: its installer carries
      // a few hundred bytes of checksums instead of about 90 MB of archives.
      fs.mkdirSync(options.manifestOut, { recursive: true });
      fs.writeFileSync(path.join(options.manifestOut, 'manifest.json'), `${JSON.stringify({ version, node: NODE_VERSION, assets: withUrls }, null, 2)}\n`);
      say(`wrote the manifest alone to ${options.manifestOut}`);
    }
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[build-host] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
