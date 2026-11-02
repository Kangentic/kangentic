#!/usr/bin/env node
// Host half of the #913 Phase 0 mirror spike. Not shipped. scripts/probe-ssh-mirror.mjs copies this
// file into the rig container and starts it; it uses node: built-ins only, so a bare Node 24 runs it.
//
// Modes:
//   generate --files <n> --total-bytes <n> [--seed <n>] [--noise-share <n>]
//                                                         Claude-shaped tree under ~/.claude/projects, rig only
//   agent [--decision-bundle <path>]                      the mirror agent, framed stdio on fd 0 and 1
//   busy --sessions <n> --seconds <n> --status-mode rename|inplace [--rewrite-every <seconds>]
//   counter-stream --bytes <n> --credit <n> --chunk <n>   a counter stream, written the way the agent writes
//   hash-tree                                             sha256 of every mirrored file, as JSON
//   mutate-for-deltas                                     the changes a drop misses, as JSON, rig only
//   inotify-count --dirs <n> --mode per-folder|recursive  watch cost of one mode, one process per mode
//   inotify-race --count <n>                              mkdir then write, per folder against recursive
//   inotify-rename                                        what a watcher does when its folder moves
//   inotify-overflow --events <n>                         events lost while the event loop is held
//   inotify-exhaust --dirs <n>                            run under a low per-namespace watch limit
//
// Frame, local to host: u32 BE length of the rest, u32 BE header length, header JSON, raw bytes.
// Frame, host to local: u32 BE FRAME_MAGIC, then the same fields. Its header JSON also carries `so`, the
// frame's stream offset, and `crc`, the CRC32 of its raw bytes.
//
// scripts/probe-ssh-mirror.mjs imports the fingerprint and the magic from here, and the modes only run
// when this file is the entry, so that import starts nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);
const home = os.homedir();
const wallNow = () => performance.timeOrigin + performance.now();
const CHUNK_BYTES = 256 * 1024;
const PRIORITY_APPEND_LIMIT = 64 * 1024;
const COALESCE_MS = 20;
export const HASH_WINDOW = 4096;
const DEFAULT_NOISE_SHARE = 0.24;
const RIG_MARKER = '/.dockerenv';

/** These modes replace what is under ~/.claude/projects, so they refuse to run outside a container. */
function requireRig(mode) {
  if (fs.existsSync(RIG_MARKER)) return;
  console.error(`${mode} rewrites ~/.claude/projects and runs only inside the rig container`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) options[argv[index].slice(2)] = true;
      else { options[argv[index].slice(2)] = next; index += 1; }
    }
  }
  return options;
}

/** A seeded generator, so a rerun builds the same tree. */
function createRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function uuidFrom(random) {
  const hex = () => Math.floor(random() * 65536).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

const VOCABULARY = ('the file function return const import export async await session terminal worktree agent column task board '
  + 'read write edit test build error warning path config status event handler process thread module result value string '
  + 'number object array type interface class method render update state store hook effect main renderer preload ipc '
  + 'transcript mirror host link resume spawn kill exit signal buffer stream frame offset cursor line token model usage').split(' ');

/**
 * A pool of transcript lines shaped like Claude's: a JSON envelope, prose from a small vocabulary and
 * a share of tool output with little redundancy. The noise share sets the gzip ratio, which the
 * generate mode reports so it can be compared with real transcripts (3.17 at level 1).
 */
function buildLinePool(random, count, noiseShare) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const targetBytes = Math.min(120_000, Math.max(300, Math.exp(7.4 + 1.5 * gaussian(random))));
    let text = '';
    while (text.length < targetBytes) {
      if (random() < noiseShare) {
        text += crypto.randomBytes(48).toString('base64') + ' ';
      } else {
        for (let word = 0; word < 24; word += 1) text += `${VOCABULARY[Math.floor(random() * VOCABULARY.length)]} `;
      }
    }
    lines.push(JSON.stringify({
      parentUuid: uuidFrom(random), isSidechain: false, userType: 'external', cwd: '/home/dev/project', sessionId: 'SESSION',
      version: '2.1.312', gitBranch: 'main', type: random() < 0.5 ? 'assistant' : 'user',
      message: { role: 'assistant', model: 'stand-in', content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 340 } },
      uuid: uuidFrom(random), timestamp: new Date(1_790_000_000_000 + Math.floor(random() * 1e9)).toISOString(),
    }));
  }
  return lines;
}

function gaussian(random) {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function fillTranscript(filePath, targetBytes, pool, random) {
  const descriptor = fs.openSync(filePath, 'w');
  let written = 0;
  const batch = [];
  let batchBytes = 0;
  while (written + batchBytes < targetBytes) {
    const line = pool[Math.floor(random() * pool.length)];
    const trimmed = written + batchBytes + line.length > targetBytes ? `${line.slice(0, Math.max(0, targetBytes - written - batchBytes - 1))}` : line;
    batch.push(trimmed);
    batchBytes += trimmed.length + 1;
    if (batchBytes > 4 * 1024 * 1024) {
      fs.writeSync(descriptor, `${batch.join('\n')}\n`);
      written += batchBytes; batch.length = 0; batchBytes = 0;
    }
  }
  if (batch.length > 0) { fs.writeSync(descriptor, `${batch.join('\n')}\n`); written += batchBytes; }
  fs.closeSync(descriptor);
}

function projectSlugs(random, count) {
  const slugs = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 7 === 3) {
      // A deep host path: Claude keeps 200 characters of the slug and adds a hash.
      slugs.push(`${`-home-dev-work-clients-group-${index}-monorepo-packages-service-${'x'.repeat(40)}-kangentic-worktrees-task`.padEnd(200, '-').slice(0, 200)}-${Math.floor(random() * 1e9).toString(36)}`);
    } else if (index % 3 === 0) {
      slugs.push(`-home-dev-project-${index}--kangentic-worktrees-${index * 37}`);
    } else {
      slugs.push(`-home-dev-project-${index}`);
    }
  }
  return slugs;
}

function generate(options) {
  requireRig('generate');
  const fileCount = Number(options.files ?? 5000);
  const totalBytes = Number(options['total-bytes'] ?? 2 * 1024 ** 3);
  const random = createRandom(Number(options.seed ?? 913));
  const projectsRoot = path.join(home, '.claude', 'projects');
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  const pool = buildLinePool(random, 3000, Number(options['noise-share'] ?? DEFAULT_NOISE_SHARE));
  const hundredMegabyteCount = 6;
  const hundredMegabyte = 100 * 1024 * 1024;

  // Kinds and medians follow a real tree of 20,150 files: 41% jsonl, 13% txt, 32% tiny json, 9% images.
  const plan = [];
  for (let index = 0; index < fileCount; index += 1) {
    const draw = random();
    if (index < hundredMegabyteCount) plan.push({ kind: 'jsonl', bytes: hundredMegabyte, fixed: true });
    else if (draw < 0.41) plan.push({ kind: 'jsonl', bytes: Math.min(30e6, Math.exp(Math.log(220_000) + 2.1 * gaussian(random))) });
    else if (draw < 0.54) plan.push({ kind: 'txt', bytes: Math.min(10e6, Math.exp(Math.log(90_000) + 1.9 * gaussian(random))) });
    else if (draw < 0.86) plan.push({ kind: 'meta', bytes: 253, fixed: true });
    else if (draw < 0.95) plan.push({ kind: 'jpg', bytes: 84_000, fixed: true });
    else plan.push({ kind: 'md', bytes: 2700, fixed: true });
  }
  const fixedBytes = plan.filter((entry) => entry.fixed).reduce((sum, entry) => sum + entry.bytes, 0);
  const scalableBytes = plan.filter((entry) => !entry.fixed).reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= fixedBytes) {
    console.error(`--total-bytes must exceed the ${fixedBytes} bytes of fixed-size files`);
    process.exit(2);
  }
  const scale = (totalBytes - fixedBytes) / scalableBytes;
  for (const entry of plan) if (!entry.fixed) entry.bytes = Math.max(200, Math.floor(entry.bytes * scale));

  const slugs = projectSlugs(random, 60);
  let currentSession = null;
  let sessionsMade = 0;
  let directoriesMade = 1;
  const madeDirectories = new Set();
  const ensureDirectory = (directory) => {
    if (madeDirectories.has(directory)) return;
    fs.mkdirSync(directory, { recursive: true });
    madeDirectories.add(directory);
    directoriesMade += 1;
  };
  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    if (!currentSession || entry.kind === 'jsonl' && random() < 0.55) {
      currentSession = { slug: slugs[Math.floor(random() ** 2 * slugs.length)], id: uuidFrom(random) };
      sessionsMade += 1;
    }
    const slugDirectory = path.join(projectsRoot, currentSession.slug);
    const sessionDirectory = path.join(slugDirectory, currentSession.id);
    ensureDirectory(slugDirectory);
    let filePath;
    if (entry.kind === 'jsonl') {
      if (random() < 0.7) {
        filePath = path.join(slugDirectory, `${uuidFrom(random)}.jsonl`);
      } else {
        ensureDirectory(path.join(sessionDirectory, 'subagents'));
        filePath = path.join(sessionDirectory, 'subagents', `agent-${uuidFrom(random).slice(0, 17)}.jsonl`);
      }
      fillTranscript(filePath, entry.bytes, pool, random);
    } else if (entry.kind === 'txt') {
      ensureDirectory(path.join(sessionDirectory, 'tool-results'));
      filePath = path.join(sessionDirectory, 'tool-results', `toolu_${uuidFrom(random).replaceAll('-', '').slice(0, 24)}.txt`);
      fillTranscript(filePath, entry.bytes, pool, random);
    } else if (entry.kind === 'meta') {
      ensureDirectory(path.join(sessionDirectory, 'subagents'));
      filePath = path.join(sessionDirectory, 'subagents', `agent-${uuidFrom(random).slice(0, 17)}.meta.json`);
      fs.writeFileSync(filePath, JSON.stringify({ agentType: 'general-purpose', description: 'x'.repeat(190), id: uuidFrom(random) }));
    } else if (entry.kind === 'jpg') {
      ensureDirectory(path.join(sessionDirectory, 'tool-results'));
      filePath = path.join(sessionDirectory, 'tool-results', `image-${uuidFrom(random).slice(0, 13)}.jpg`);
      fs.writeFileSync(filePath, crypto.randomBytes(entry.bytes));
    } else {
      ensureDirectory(path.join(slugDirectory, 'memory'));
      filePath = path.join(slugDirectory, 'memory', `note-${uuidFrom(random).slice(0, 13)}.md`);
      fs.writeFileSync(filePath, 'the mirror keeps notes here\n'.repeat(100));
    }
  }

  const sizes = [];
  let longestRelative = 0;
  let largestPath = '';
  let largestSize = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(entryPath); continue; }
      const size = fs.statSync(entryPath).size;
      sizes.push(size);
      longestRelative = Math.max(longestRelative, path.relative(projectsRoot, entryPath).length);
      if (size > largestSize) { largestSize = size; largestPath = entryPath; }
    }
  };
  walk(projectsRoot);
  sizes.sort((left, right) => left - right);
  const sample = fs.readFileSync(largestPath).subarray(0, 20e6);
  const gzipRatio = sample.length / zlib.gzipSync(sample, { level: 1 }).length;
  const quantile = (fraction) => sizes[Math.floor(sizes.length * fraction)];
  console.log(JSON.stringify({
    files: sizes.length, totalBytes: sizes.reduce((sum, value) => sum + value, 0), directories: directoriesMade, sessions: sessionsMade,
    p50: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99), max: sizes.at(-1), longestRelative, gzipRatioLevel1: Number(gzipRatio.toFixed(2)),
  }));
}

function statusPayload(sequence, sessionIndex, agentSessionId, transcriptPath) {
  return JSON.stringify({
    session_id: agentSessionId, transcript_path: transcriptPath, model: { id: 'stand-in', display_name: 'Stand-in' },
    context_window: { used_percentage: 12, context_window_size: 200000, total_input_tokens: 1000 + sequence, total_output_tokens: 300 },
    cost: { total_cost_usd: 0.12 }, workspace: { current_dir: '/home/dev/project', project_dir: '/home/dev/project' },
    probe: { sequence, sessionIndex, writtenAt: wallNow() }, padding: 'x'.repeat(700),
  });
}

/** Live sessions: a status file at 4 Hz, transcript lines at agent cadence, an occasional rewrite. */
async function busy(options) {
  const sessionCount = Number(options.sessions ?? 1);
  const seconds = Number(options.seconds ?? 60);
  const statusMode = options['status-mode'] ?? 'rename';
  const rewriteEverySeconds = Number(options['rewrite-every'] ?? 0);
  const quietTranscripts = options['no-transcripts'] === true;
  const random = createRandom(Number(options.seed ?? 77) + Date.now() % 1000);
  const pool = buildLinePool(random, 400, DEFAULT_NOISE_SHARE);
  const endAt = Date.now() + seconds * 1000;
  const timers = [];
  const writeSamples = [];
  let linesWritten = 0;
  let bytesWritten = 0;
  let rewrites = 0;
  const sessions = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const agentSessionId = uuidFrom(random);
    const slugDirectory = path.join(home, '.claude', 'projects', `-home-dev-live-${index}`);
    const statusDirectory = path.join(home, 'project', '.kangentic', 'sessions', agentSessionId);
    await fsPromises.mkdir(slugDirectory, { recursive: true });
    await fsPromises.mkdir(statusDirectory, { recursive: true });
    sessions.push({ agentSessionId, statusDirectory, transcriptPath: path.join(slugDirectory, `${agentSessionId}.jsonl`) });
  }
  const statusPool = sessions.map((session, sessionIndex) => {
    let sequence = 0;
    const statusPath = path.join(session.statusDirectory, 'status.json');
    const temporaryPath = `${statusPath}.tmp`;
    const tick = () => {
      if (Date.now() >= endAt) return;
      sequence += 1;
      const startedAt = wallNow();
      const payload = statusPayload(sequence, sessionIndex, session.agentSessionId, session.transcriptPath);
      if (statusMode === 'rename') {
        fs.writeFileSync(temporaryPath, payload);
        fs.renameSync(temporaryPath, statusPath);
      } else {
        fs.writeFileSync(statusPath, payload);
      }
      writeSamples.push(wallNow() - startedAt);
    };
    return { tick, offsetMs: (sessionIndex * 250) / sessionCount };
  });
  for (const entry of statusPool) {
    timers.push(setTimeout(() => { entry.tick(); timers.push(setInterval(entry.tick, 250)); }, entry.offsetMs));
  }
  if (!quietTranscripts) {
    for (const session of sessions) {
      const appendLater = () => {
        if (Date.now() >= endAt) return;
        // Measured agent cadence: a call about every 1.1 to 4.4 s, with bursts 42 to 299 ms apart.
        const delayMs = random() < 0.35 ? 42 + random() * 257 : 1100 + random() * 3300;
        const line = `${pool[Math.floor(random() * pool.length)]}\n`;
        fs.appendFileSync(session.transcriptPath, line);
        linesWritten += 1; bytesWritten += line.length;
        timers.push(setTimeout(appendLater, delayMs));
      };
      appendLater();
    }
  }
  if (rewriteEverySeconds > 0 && !quietTranscripts) {
    let nextSession = 0;
    timers.push(setInterval(() => {
      if (Date.now() >= endAt) return;
      const session = sessions[nextSession % sessions.length];
      nextSession += 1;
      const current = fs.readFileSync(session.transcriptPath);
      const temporaryPath = `${session.transcriptPath}.compact`;
      fs.writeFileSync(temporaryPath, current.subarray(Math.floor(current.length / 2)));
      fs.renameSync(temporaryPath, session.transcriptPath);
      rewrites += 1;
    }, rewriteEverySeconds * 1000));
  }
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 300));
  for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
  writeSamples.sort((left, right) => left - right);
  console.log(JSON.stringify({ sessions: sessionCount, statusMode, linesWritten, bytesWritten, rewrites, statusWriteP50Ms: writeSamples[Math.floor(writeSamples.length / 2)], statusWriteP99Ms: writeSamples[Math.floor(writeSamples.length * 0.99)] }));
  process.exit(0);
}

/** Down the link a frame opens with a magic and carries a CRC of its payload, because bytes can go missing. */
export const FRAME_MAGIC = 0x4b4d4631;

export function encodeFrame(header, raw) {
  const payload = raw ?? Buffer.alloc(0);
  const headerBytes = Buffer.from(JSON.stringify({ ...header, crc: zlib.crc32(payload) }));
  const prefix = Buffer.alloc(12);
  prefix.writeUInt32BE(FRAME_MAGIC, 0);
  prefix.writeUInt32BE(4 + headerBytes.length + payload.length, 4);
  prefix.writeUInt32BE(headerBytes.length, 8);
  return { prefix, headerBytes, payload };
}

export class FrameReader {
  constructor(onFrame) { this.onFrame = onFrame; this.buffered = []; this.bufferedBytes = 0; }
  push(chunk) {
    this.buffered.push(chunk); this.bufferedBytes += chunk.length;
    for (;;) {
      if (this.bufferedBytes < 4) return;
      let joined = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered);
      this.buffered = [joined];
      const length = joined.readUInt32BE(0);
      if (joined.length < 4 + length) return;
      const headerLength = joined.readUInt32BE(4);
      const header = JSON.parse(joined.subarray(8, 8 + headerLength).toString('utf8'));
      const raw = joined.subarray(8 + headerLength, 4 + length);
      joined = joined.subarray(4 + length);
      this.buffered = joined.length > 0 ? [joined] : [];
      this.bufferedBytes = joined.length;
      this.onFrame(header, raw);
    }
  }
}

/** Two lanes on one stream. Bulk stops at `credit` unacknowledged bytes, so status never waits behind more. */
class FrameScheduler {
  constructor(output, creditBytes) {
    this.output = output; this.creditBytes = creditBytes; this.priority = []; this.bulkWaiters = [];
    this.bulkInFlight = 0; this.blocked = false; this.bytesWritten = 0;
    output.on('drain', () => { this.blocked = false; this.pump(); });
  }
  writeNow({ header, raw }) {
    // Every frame names its offset in the stream, so a loss is found at the frame it happened in.
    const frame = encodeFrame({ ...header, so: this.bytesWritten }, raw);
    let accepted;
    this.output.write(frame.prefix);
    this.output.write(frame.headerBytes);
    accepted = this.output.write(frame.payload);
    this.bytesWritten += frame.prefix.length + frame.headerBytes.length + frame.payload.length;
    if (!accepted) this.blocked = true;
  }
  sendPriority(header, raw) { this.priority.push({ header, raw }); this.pump(); }
  sendBulk(header, raw) {
    return new Promise((resolve) => { this.bulkWaiters.push({ header, raw, resolve }); this.pump(); });
  }
  pump() {
    while (!this.blocked) {
      if (this.priority.length > 0) {
        const { header, raw } = this.priority.shift();
        // The stage stamp is the moment the frame reaches the socket, not when it was queued.
        if ('sentAt' in header) header.sentAt = wallNow();
        this.writeNow({ header, raw });
        continue;
      }
      const waiter = this.bulkWaiters[0];
      if (!waiter) return;
      const bytes = waiter.raw.length;
      if (this.bulkInFlight > 0 && this.bulkInFlight + bytes > this.creditBytes) return;
      this.bulkWaiters.shift();
      this.bulkInFlight += bytes;
      this.writeNow(waiter);
      waiter.resolve();
    }
  }
  acknowledge(bytes) { this.bulkInFlight = Math.max(0, this.bulkInFlight - bytes); this.pump(); }
}

export function tailRange(size) { return { position: Math.max(0, size - HASH_WINDOW), length: Math.min(size, HASH_WINDOW) }; }

export async function hashRange(handle, position, length) {
  if (length === 0) return '';
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return crypto.createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('base64');
}

async function fingerprint(filePath, size) {
  const handle = await fsPromises.open(filePath, 'r');
  try {
    const tail = tailRange(size);
    return { head: await hashRange(handle, 0, Math.min(size, HASH_WINDOW)), tail: await hashRange(handle, tail.position, tail.length) };
  } finally { await handle.close(); }
}

class MirrorAgent {
  constructor(options) {
    this.roots = [path.join(home, '.claude', 'projects'), path.join(home, 'project', '.kangentic', 'sessions')];
    this.decisionBundlePath = options['decision-bundle'];
    this.files = new Map();
    this.watchers = new Map();
    this.watchFailures = 0;
    this.pendingPaths = new Map();
    this.pathChains = new Map();
    this.statusBusy = new Map();
    this.bulkPayloadBytes = 0;
    this.bulkFilesSent = 0;
    const output = new net.Socket({ fd: 1, readable: false, writable: true });
    output.on('error', () => process.exit(0));
    this.scheduler = new FrameScheduler(output, Infinity);
    const reader = new FrameReader((header, raw) => this.onFrame(header, raw));
    process.stdin.on('data', (chunk) => reader.push(chunk));
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('error', () => process.exit(0));
    process.on('SIGHUP', () => process.exit(0));
  }

  relativeOf(fullPath) { return path.relative(home, fullPath); }

  watchDirectory(directory) {
    if (this.watchers.has(directory)) return;
    try {
      const watcher = fs.watch(directory, (eventType, name) => this.onFsEvent(directory, name));
      watcher.on('error', () => { this.watchers.delete(directory); this.scheduleDirectoryRescan(directory); });
      this.watchers.set(directory, watcher);
    } catch (error) {
      this.watchFailures += 1;
      this.scheduler.sendPriority({ t: 'watchFailed', directory: this.relativeOf(directory), code: error.code });
    }
  }

  scheduleDirectoryRescan(directory) { setTimeout(() => void this.rescanDirectory(directory), 50); }

  /** A new folder may already hold files by the time its watch is on, so it is listed after the watch. */
  async rescanDirectory(directory) {
    let entries;
    try { entries = await fsPromises.readdir(directory, { withFileTypes: true }); } catch { return; }
    this.watchDirectory(directory);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await this.rescanDirectory(entryPath);
      else if (entry.name === 'status.json') void this.sendStatus(entryPath, wallNow());
      else if (entry.isFile()) this.scheduleFile(entryPath);
    }
  }

  onFsEvent(directory, name) {
    const eventAt = wallNow();
    if (name === null) { this.scheduleDirectoryRescan(directory); return; }
    const fullPath = path.join(directory, name);
    if (name.endsWith('.tmp') || name.endsWith('.compact')) return;
    if (name === 'status.json') { void this.sendStatus(fullPath, eventAt); return; }
    this.scheduleFile(fullPath);
  }

  async sendStatus(fullPath, eventAt) {
    const busyState = this.statusBusy.get(fullPath);
    if (busyState) { busyState.dirty = eventAt; return; }
    const state = { dirty: 0 };
    this.statusBusy.set(fullPath, state);
    let nextEventAt = eventAt;
    while (nextEventAt) {
      state.dirty = 0;
      let content;
      try { content = await fsPromises.readFile(fullPath); } catch { content = null; }
      const readAt = wallNow();
      if (content) {
        this.scheduler.sendPriority({ t: 'w', p: this.relativeOf(fullPath), status: true, eventAt: nextEventAt, readAt, sentAt: 0 }, content);
      }
      nextEventAt = state.dirty;
    }
    this.statusBusy.delete(fullPath);
  }

  scheduleFile(fullPath) {
    if (this.pendingPaths.has(fullPath)) return;
    this.pendingPaths.set(fullPath, setTimeout(() => {
      this.pendingPaths.delete(fullPath);
      this.serial(fullPath, () => this.syncPath(fullPath));
    }, COALESCE_MS));
  }

  serial(fullPath, work) {
    const previous = this.pathChains.get(fullPath) ?? Promise.resolve();
    const next = previous.then(work).catch((error) => {
      this.scheduler.sendPriority({ t: 'agentError', p: this.relativeOf(fullPath), message: String(error) });
    }).finally(() => { if (this.pathChains.get(fullPath) === next) this.pathChains.delete(fullPath); });
    this.pathChains.set(fullPath, next);
    return next;
  }

  async syncPath(fullPath) {
    let stat;
    try { stat = await fsPromises.lstat(fullPath); } catch (error) {
      if (error.code !== 'ENOENT') return;
      const hadFile = this.files.delete(fullPath);
      const closedWatch = this.closeWatchesUnder(fullPath);
      if (hadFile || closedWatch) this.scheduler.sendPriority({ t: 'd', p: this.relativeOf(fullPath) });
      return;
    }
    if (stat.isDirectory()) { await this.rescanDirectory(fullPath); return; }
    if (!stat.isFile()) return;
    await this.syncFile(fullPath, stat, false);
  }

  closeWatchesUnder(fullPath) {
    let closed = false;
    for (const [directory, watcher] of this.watchers) {
      if (directory === fullPath || directory.startsWith(`${fullPath}${path.sep}`)) {
        watcher.close(); this.watchers.delete(directory); closed = true;
        for (const filePath of this.files.keys()) if (filePath.startsWith(`${directory}${path.sep}`)) this.files.delete(filePath);
      }
    }
    return closed;
  }

  async syncFile(fullPath, stat, bulk) {
    const known = this.files.get(fullPath);
    const relative = this.relativeOf(fullPath);
    let startOffset = 0;
    let rewrite = false;
    if (known) {
      if (known.ino !== stat.ino || stat.size < known.offset) rewrite = true;
      else if (stat.size === known.offset && stat.mtimeMs === known.mtimeMs) return;
      else if (stat.size === known.offset) rewrite = true;
      else {
        const handle = await fsPromises.open(fullPath, 'r');
        let tailNow;
        try {
          const tail = tailRange(known.offset);
          tailNow = await hashRange(handle, tail.position, tail.length);
        } finally { await handle.close(); }
        if (tailNow !== known.tail) rewrite = true;
        else startOffset = known.offset;
      }
    }
    const size = stat.size;
    const useBulk = bulk || rewrite || size - startOffset > PRIORITY_APPEND_LIMIT;
    if (rewrite) await this.send(useBulk, { t: 'rs', p: relative, size }, null);
    const handle = await fsPromises.open(fullPath, 'r');
    try {
      let offset = startOffset;
      if (offset === 0 && size === 0) await this.send(useBulk, { t: 'a', p: relative, o: 0, r: false }, Buffer.alloc(0));
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        const raw = buffer.subarray(0, bytesRead);
        const header = { t: 'a', p: relative, o: offset, r: rewrite };
        if (this.useGzip && useBulk && !relative.endsWith('.jpg')) {
          const compressed = await gzip(raw, { level: 1 });
          await this.send(useBulk, { ...header, z: 1, rawBytes: raw.length }, compressed);
        } else {
          await this.send(useBulk, header, raw);
        }
        offset += bytesRead;
      }
      if (rewrite) await this.send(useBulk, { t: 're', p: relative }, null);
      const tail = tailRange(offset);
      this.files.set(fullPath, { ino: stat.ino, offset, mtimeMs: stat.mtimeMs, tail: await hashRange(handle, tail.position, tail.length) });
      await this.send(useBulk, { t: 'fin', p: relative, size: offset, mtimeMs: stat.mtimeMs }, null);
      if (useBulk) this.bulkFilesSent += 1;
    } finally { await handle.close(); }
  }

  async send(useBulk, header, raw) {
    if (useBulk) {
      this.bulkPayloadBytes += raw?.length ?? 0;
      await this.scheduler.sendBulk(header.t === 'a' ? { ...header, b: 1 } : header, raw ?? Buffer.alloc(0));
    } else {
      this.scheduler.sendPriority(header, raw ?? Buffer.alloc(0));
    }
  }

  async walk(directory, collected) {
    this.watchDirectory(directory);
    let entries;
    try { entries = await fsPromises.readdir(directory, { withFileTypes: true }); } catch { return; }
    const subdirectories = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) subdirectories.push(entryPath);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) collected.push(entryPath);
    }
    for (const subdirectory of subdirectories) await this.walk(subdirectory, collected);
  }

  /** A connect: compare what the local side holds and send only what differs, newest first. */
  async startSync(hello) {
    const startedAt = wallNow();
    this.scheduler.creditBytes = hello.creditBytes ?? Infinity;
    this.useGzip = hello.gzip === true;
    const manifest = new Map(hello.manifest ?? []);
    const collected = [];
    for (const root of this.roots) {
      await fsPromises.mkdir(root, { recursive: true });
      await this.walk(root, collected);
    }
    const inventoryMs = wallNow() - startedAt;
    if (hello.assumeSynced) {
      for (const fullPath of collected) {
        const stat = await fsPromises.stat(fullPath).catch(() => null);
        if (stat) this.files.set(fullPath, { ino: stat.ino, offset: stat.size, mtimeMs: stat.mtimeMs, tail: (await fingerprint(fullPath, stat.size)).tail });
      }
      this.scheduler.sendPriority({ t: 'plan', hostFiles: collected.length, bytesToSend: 0, watches: this.watchers.size });
      return;
    }
    const jobs = [];
    let skippedFiles = 0;
    let rewriteFiles = 0;
    let appendFiles = 0;
    let newFiles = 0;
    for (let index = 0; index < collected.length; index += 32) {
      await Promise.all(collected.slice(index, index + 32).map(async (fullPath) => {
        let stat;
        try { stat = await fsPromises.stat(fullPath); } catch { return; }
        const relative = this.relativeOf(fullPath);
        const held = manifest.get(relative);
        manifest.delete(relative);
        if (!held) { newFiles += 1; jobs.push({ fullPath, stat, mtimeMs: stat.mtimeMs, plannedBytes: stat.size }); return; }
        let same = held.size <= stat.size;
        if (same) {
          const hostPrints = await fingerprint(fullPath, held.size);
          same = hostPrints.head === held.head && hostPrints.tail === held.tail;
        }
        if (same && held.size === stat.size && held.hostMtimeMs !== undefined && held.hostMtimeMs !== stat.mtimeMs) same = false;
        if (same && held.size === stat.size) {
          skippedFiles += 1;
          this.files.set(fullPath, { ino: stat.ino, offset: stat.size, mtimeMs: stat.mtimeMs, tail: held.tail });
        } else if (same) {
          appendFiles += 1;
          this.files.set(fullPath, { ino: stat.ino, offset: held.size, mtimeMs: 0, tail: held.tail });
          jobs.push({ fullPath, stat, mtimeMs: stat.mtimeMs, plannedBytes: stat.size - held.size });
        } else {
          rewriteFiles += 1;
          this.files.set(fullPath, { ino: -1, offset: held.size, mtimeMs: 0, tail: '' });
          jobs.push({ fullPath, stat, mtimeMs: stat.mtimeMs, plannedBytes: stat.size });
        }
      }));
    }
    const deleted = [...manifest.keys()];
    for (const relative of deleted) this.scheduler.sendPriority({ t: 'd', p: relative });
    jobs.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const compareMs = wallNow() - startedAt - inventoryMs;
    this.scheduler.sendPriority({ t: 'plan', hostFiles: collected.length, newFiles, appendFiles, rewriteFiles, skippedFiles, deletedFiles: deleted.length, bytesToSend: jobs.reduce((sum, job) => sum + job.plannedBytes, 0), inventoryMs, compareMs, watches: this.watchers.size });
    for (const job of jobs) {
      // Stat again: a live append may have moved the file on since the plan was made.
      await this.serial(job.fullPath, async () => {
        const stat = await fsPromises.stat(job.fullPath).catch(() => null);
        if (stat) await this.syncFile(job.fullPath, stat, true);
      });
    }
    this.scheduler.sendPriority({ t: 'syncDone', bulkPayloadBytes: this.bulkPayloadBytes, bulkFilesSent: this.bulkFilesSent, totalMs: wallNow() - startedAt, cpu: process.cpuUsage(), watches: this.watchers.size, rssBytes: process.memoryUsage().rss });
  }

  async decisions() {
    if (!this.decisionBundle) {
      this.decisionBundle = await import(pathToFileURL(this.decisionBundlePath).href);
    }
    return this.decisionBundle.default ?? this.decisionBundle;
  }

  async onFrame(header, raw) {
    if (header.t === 'hello') { void this.startSync(header).catch((error) => this.scheduler.sendPriority({ t: 'agentError', message: String(error?.stack ?? error) })); return; }
    if (header.t === 'ack') { this.scheduler.acknowledge(header.bytes); return; }
    if (header.t === 'ping') { this.scheduler.sendPriority({ t: 'pong', id: header.id, hostAt: wallNow() }); return; }
    if (header.t === 'statusAck') { this.onStatusAck(header); return; }
    if (header.t === 'rpc') {
      try {
        const result = await this.handleRpc(header.method, header.params ?? {});
        this.scheduler.sendPriority({ t: 'rpcResult', id: header.id, ok: true, result: result?.json ?? null, hostAt: wallNow() }, result?.raw ?? null);
      } catch (error) {
        this.scheduler.sendPriority({ t: 'rpcResult', id: header.id, ok: false, message: String(error?.message ?? error) });
      }
    }
  }

  onStatusAck(header) {
    // Clock-free bound: host write to local visible and back, on the host's clock alone.
    this.statusAckSamples ??= [];
    if (header.writtenAt) this.statusAckSamples.push(wallNow() - header.writtenAt);
  }

  async handleRpc(method, params) {
    if (method === 'read') return { json: {}, raw: await fsPromises.readFile(path.join(home, params.p)) };
    if (method === 'ackSamples') { const samples = this.statusAckSamples ?? []; this.statusAckSamples = []; return { json: { samples } }; }
    if (method === 'confirmedMissing') {
      try { await fsPromises.stat(params.path); return { json: { missing: false } }; } catch (error) { return { json: { missing: error.code === 'ENOENT' } }; }
    }
    if (method === 'proveGone') {
      const { proveClaudeConversationGone } = await this.decisions();
      return { json: { gone: await proveClaudeConversationGone(params) } };
    }
    if (method === 'createConversation') {
      await fsPromises.mkdir(path.dirname(params.path), { recursive: true });
      await fsPromises.writeFile(params.path, `${JSON.stringify({ type: 'user', sessionId: params.agentSessionId, message: { content: 'hello' } })}\n`);
      return { json: {} };
    }
    if (method === 'deleteConversation') { await fsPromises.rm(params.path, { force: true }); return { json: {} }; }
    if (method === 'renameFolder') { await fsPromises.rename(params.from, params.to); return { json: {} }; }
    if (method === 'stats') return { json: { watches: this.watchers.size, watchFailures: this.watchFailures, cpu: process.cpuUsage(), rssBytes: process.memoryUsage().rss } };
    throw new Error(`unknown method ${method}`);
  }
}

function hashTree() {
  const roots = [path.join(home, '.claude', 'projects')];
  const result = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) result[path.relative(home, entryPath)] = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
    }
  };
  for (const root of roots) walk(root);
  console.log(JSON.stringify(result));
}

/** The changes a dropped link misses: appends, shorter rewrites, same-length rewrites, new files, deletes. */
function mutateForDeltas() {
  requireRig('mutate-for-deltas');
  const root = path.join(home, '.claude', 'projects');
  const transcripts = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith('.jsonl') && !path.basename(directory).startsWith('-home-dev-live-')) transcripts.push({ entryPath, size: fs.statSync(entryPath).size });
    }
  };
  walk(root);
  transcripts.sort((left, right) => left.entryPath.localeCompare(right.entryPath));
  const smallEnough = transcripts.filter((entry) => entry.size > 100_000 && entry.size < 20e6);
  const summary = { appended: 0, appendedBytes: 0, rewrittenShorter: 0, rewrittenShorterBytes: 0, sameLengthMiddleEdits: 0, created: 0, createdBytes: 0, deleted: 0 };
  const line = `${JSON.stringify({ type: 'assistant', delta: true, note: 'x'.repeat(4000) })}\n`;
  for (const entry of smallEnough.slice(0, 200)) {
    fs.appendFileSync(entry.entryPath, line); summary.appended += 1; summary.appendedBytes += line.length;
  }
  for (const entry of smallEnough.slice(200, 220)) {
    const content = fs.readFileSync(entry.entryPath);
    const shorter = content.subarray(content.length - Math.floor(content.length * 0.4));
    fs.writeFileSync(`${entry.entryPath}.compact`, shorter); fs.renameSync(`${entry.entryPath}.compact`, entry.entryPath);
    summary.rewrittenShorter += 1; summary.rewrittenShorterBytes += shorter.length;
  }
  for (const entry of smallEnough.slice(220, 225)) {
    // Outside both 4096-byte fingerprint windows, because `size` exceeds 100,000. For a string, writeSync
    // takes (fd, string, position, encoding), so the offset is the third argument.
    const descriptor = fs.openSync(entry.entryPath, 'r+');
    fs.writeSync(descriptor, 'EDITED-IN-THE-MIDDLE', Math.floor(entry.size / 2), 'utf8');
    fs.closeSync(descriptor);
    summary.sameLengthMiddleEdits += 1;
  }
  for (const entry of smallEnough.slice(225, 235)) { fs.rmSync(entry.entryPath); summary.deleted += 1; }
  const newFolder = path.join(root, '-home-dev-delta-project');
  fs.mkdirSync(newFolder, { recursive: true });
  for (let index = 0; index < 50; index += 1) {
    fs.writeFileSync(path.join(newFolder, `${crypto.randomUUID()}.jsonl`), line.repeat(10)); summary.created += 1; summary.createdBytes += line.length * 10;
  }
  console.log(JSON.stringify(summary));
}

function inotifyWatchCount(pid) {
  let total = 0;
  for (const descriptor of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
    try { total += fs.readFileSync(`/proc/${pid}/fdinfo/${descriptor}`, 'utf8').split('\n').filter((line) => line.startsWith('inotify wd:')).length; } catch { /* closed meanwhile */ }
  }
  return total;
}

function makeTree(root, directoryCount) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const directories = [root];
  let made = 1;
  for (let index = 0; made < directoryCount; index += 1) {
    const session = path.join(root, `session-${index}`);
    const subagents = path.join(session, 'subagents');
    const toolResults = path.join(session, 'tool-results');
    fs.mkdirSync(subagents, { recursive: true });
    fs.mkdirSync(toolResults, { recursive: true });
    directories.push(session, subagents, toolResults);
    made += 3;
    fs.writeFileSync(path.join(root, `session-${index}.jsonl`), 'x\n');
  }
  return directories;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inotifyCount(options) {
  const directoryCount = Number(options.dirs ?? 15000);
  const root = path.join(os.tmpdir(), 'probe-inotify-count');
  const directories = makeTree(root, directoryCount);
  const results = { directories: directories.length };
  const rssBefore = process.memoryUsage().rss;
  // RSS rarely falls after a watcher closes, so each mode gets its own process and its own baseline.
  if (options.mode === 'per-folder') {
    const startedAt = performance.now();
    const watchers = directories.map((directory) => fs.watch(directory, () => undefined));
    results.perFolder = { setupMs: Math.round(performance.now() - startedAt), watches: inotifyWatchCount(process.pid), rssAddedMb: Math.round((process.memoryUsage().rss - rssBefore) / 1e6) };
    for (const watcher of watchers) watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify(results));
    process.exit(0);
  }
  const watchStartedAt = performance.now();
  const recursiveWatcher = fs.watch(root, { recursive: true }, () => undefined);
  await delay(50);
  let previous = -1;
  let lastChangedAt = watchStartedAt;
  for (;;) {
    const current = inotifyWatchCount(process.pid);
    if (current === previous && current > 0) break;
    previous = current;
    lastChangedAt = performance.now();
    await delay(250);
  }
  results.recursive = { setupMs: Math.round(lastChangedAt - watchStartedAt), watches: previous, rssAddedMb: Math.round((process.memoryUsage().rss - rssBefore) / 1e6) };
  recursiveWatcher.close();
  // A full stat walk is the rescan a design without events would pay.
  const rescanStartedAt = performance.now();
  let files = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
      else { fs.statSync(path.join(directory, entry.name)); files += 1; }
    }
  };
  walk(root);
  results.fullRescan = { ms: Math.round(performance.now() - rescanStartedAt), files };
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(results));
  process.exit(0);
}

async function inotifyRace(options) {
  const count = Number(options.count ?? 1000);
  const results = {};
  for (const mode of ['perFolderWithoutRescan', 'perFolderWithRescan', 'recursive']) {
    const root = path.join(os.tmpdir(), `probe-inotify-race-${mode}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const seen = new Set();
    const closers = [];
    const noteFile = (filePath) => { if (filePath.endsWith('.jsonl')) seen.add(filePath); };
    if (mode === 'recursive') {
      const watcher = fs.watch(root, { recursive: true }, (eventType, name) => { if (name) noteFile(path.join(root, name)); });
      closers.push(() => watcher.close());
    } else {
      const addWatch = (directory) => {
        const watcher = fs.watch(directory, (eventType, name) => {
          if (!name) return;
          const fullPath = path.join(directory, name);
          noteFile(fullPath);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              addWatch(fullPath);
              if (mode === 'perFolderWithRescan') {
                for (const entry of fs.readdirSync(fullPath, { recursive: true, withFileTypes: true })) {
                  const entryPath = path.join(entry.parentPath, entry.name);
                  if (entry.isFile()) noteFile(entryPath);
                }
              }
            }
          } catch { /* gone again */ }
        });
        closers.push(() => watcher.close());
      };
      addWatch(root);
    }
    await delay(100);
    const expected = [];
    for (let index = 0; index < count; index += 1) {
      const sessionDirectory = path.join(root, `slug-${index}`, 'subagents');
      fs.mkdirSync(sessionDirectory, { recursive: true });
      const filePath = path.join(sessionDirectory, 'agent.jsonl');
      fs.writeFileSync(filePath, 'x\n');
      expected.push(filePath);
      if (index % 20 === 0) await delay(1);
    }
    await delay(1500);
    results[mode] = { created: count, missed: expected.filter((filePath) => !seen.has(filePath)).length };
    for (const close of closers) close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(results));
  process.exit(0);
}

async function inotifyRename() {
  const results = {};
  for (const mode of ['perFolder', 'recursive']) {
    const root = path.join(os.tmpdir(), `probe-inotify-rename-${mode}`);
    fs.rmSync(root, { recursive: true, force: true });
    const slug = path.join(root, 'slug');
    fs.mkdirSync(slug, { recursive: true });
    const events = [];
    const watcher = mode === 'recursive'
      ? fs.watch(root, { recursive: true }, (eventType, name) => events.push(`${eventType}:${name}`))
      : fs.watch(slug, (eventType, name) => events.push(`${eventType}:${name}`));
    await delay(300);
    const observe = async (label, action) => {
      events.length = 0;
      action();
      await delay(300);
      return { label, events: [...events] };
    };
    const steps = [];
    steps.push(await observe('write in the watched folder', () => fs.writeFileSync(path.join(slug, 'first.jsonl'), 'a\n')));
    steps.push(await observe('rename the watched folder away', () => fs.renameSync(slug, `${slug}.moved`)));
    steps.push(await observe('write in the moved folder (old inode)', () => fs.writeFileSync(path.join(`${slug}.moved`, 'second.jsonl'), 'a\n')));
    steps.push(await observe('make a new folder at the old name', () => fs.mkdirSync(slug)));
    steps.push(await observe('write in the new folder at the old name', () => fs.writeFileSync(path.join(slug, 'third.jsonl'), 'a\n')));
    fs.mkdirSync(`${slug}.replacement`);
    fs.writeFileSync(path.join(`${slug}.replacement`, 'inside.jsonl'), 'a\n');
    fs.rmSync(path.join(slug, 'third.jsonl'));
    steps.push(await observe('rename a full folder over the empty one', () => fs.renameSync(`${slug}.replacement`, slug)));
    steps.push(await observe('write in the replacement folder', () => fs.writeFileSync(path.join(slug, 'fourth.jsonl'), 'a\n')));
    watcher.close();
    results[mode] = steps;
    fs.rmSync(root, { recursive: true, force: true });
  }
  // A watch on the file itself, the shape FileWatcher prefers, under an atomic rename.
  const directory = path.join(os.tmpdir(), 'probe-inotify-file');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const statusPath = path.join(directory, 'status.json');
  fs.writeFileSync(statusPath, '{}');
  let fileEvents = 0;
  let directoryEvents = 0;
  const fileWatcher = fs.watch(statusPath, () => { fileEvents += 1; });
  const directoryWatcher = fs.watch(directory, (eventType, name) => { if (name === 'status.json') directoryEvents += 1; });
  await delay(100);
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(`${statusPath}.tmp`, `{"n":${index}}`);
    fs.renameSync(`${statusPath}.tmp`, statusPath);
    await delay(30);
  }
  await delay(200);
  fileWatcher.close(); directoryWatcher.close();
  results.statusFileRename = { atomicRenames: 20, eventsOnFileWatch: fileEvents, eventsOnDirectoryWatch: directoryEvents };
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify(results));
  process.exit(0);
}

async function inotifyOverflow(options) {
  const eventCount = Number(options.events ?? 40000);
  const directory = path.join(os.tmpdir(), 'probe-inotify-overflow');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const seen = new Set();
  let nullNames = 0;
  const watcher = fs.watch(directory, (eventType, name) => { if (name) seen.add(name); else nullNames += 1; });
  await delay(100);
  // The loop stays busy here while files arrive, the way a long synchronous step would hold it.
  for (let index = 0; index < eventCount; index += 1) fs.writeFileSync(path.join(directory, `f${index}`), '');
  await delay(1500);
  watcher.close();
  const queueLimit = Number(fs.readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8'));
  console.log(JSON.stringify({ filesCreated: eventCount, namesSeen: seen.size, missed: eventCount - seen.size, nullNameEvents: nullNames, queueLimit }));
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}

async function inotifyExhaust(options) {
  const directoryCount = Number(options.dirs ?? 2000);
  const root = path.join(os.tmpdir(), 'probe-inotify-exhaust');
  const directories = makeTree(root, directoryCount);
  const result = { directories: directories.length, limit: Number(fs.readFileSync('/proc/sys/user/max_inotify_watches', 'utf8')) };
  let watchesPlaced = 0;
  let firstError = null;
  let errorCount = 0;
  const watchers = [];
  for (const directory of directories) {
    try { watchers.push(fs.watch(directory, () => undefined)); watchesPlaced += 1; } catch (error) {
      errorCount += 1;
      if (!firstError) firstError = { code: error.code, syscall: error.syscall, message: error.message, afterWatches: watchesPlaced };
    }
  }
  result.perFolder = { watchesPlaced, errorCount, firstError };
  // Does an existing watch still fire once the limit is hit?
  let stillFires = false;
  const probeDirectory = directories[1];
  const fired = new Promise((resolve) => { watchers[1]?.on('change', () => { stillFires = true; resolve(); }); setTimeout(resolve, 500); });
  fs.writeFileSync(path.join(probeDirectory, 'after-limit'), 'x');
  await fired;
  result.existingWatchStillFires = stillFires;
  for (const watcher of watchers) watcher.close();
  await delay(100);
  // Recursive: does the error reach the caller, or is coverage quietly partial?
  const recursiveErrors = [];
  let recursiveThrew = null;
  let recursive;
  try {
    recursive = fs.watch(root, { recursive: true }, () => undefined);
    recursive.on('error', (error) => recursiveErrors.push(error.code));
  } catch (error) { recursiveThrew = error.code; }
  await delay(1500);
  result.recursive = { threw: recursiveThrew, errorEvents: recursiveErrors.slice(0, 5), errorEventCount: recursiveErrors.length, watches: inotifyWatchCount(process.pid) };
  recursive?.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  process.exit(0);
}

/** The same counter stream as the probe's Python writer, written the way the agent writes. */
function counterStream(options) {
  const total = Number(options.bytes);
  const credit = Number(options.credit);
  const chunk = Number(options.chunk);
  const output = new net.Socket({ fd: 1, readable: false, writable: true });
  output.on('error', () => process.exit(0));
  let acknowledged = 0;
  let sent = 0;
  let counter = 0n;
  let blocked = false;
  const pump = () => {
    while (!blocked && sent < total && (!credit || sent - acknowledged * chunk < credit)) {
      const block = Buffer.alloc(chunk);
      for (let position = 0; position < chunk; position += 8) { block.writeBigUInt64BE(counter, position); counter += 1n; }
      sent += chunk;
      if (!output.write(block)) blocked = true;
    }
    if (sent >= total) output.end(() => process.exit(0));
  };
  output.on('drain', () => { blocked = false; pump(); });
  process.stdin.on('data', (data) => { acknowledged += data.length; pump(); });
  process.stdin.on('end', () => process.exit(0));
  pump();
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [mode, ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  if (mode === 'generate') generate(options);
  else if (mode === 'agent') new MirrorAgent(options);
  else if (mode === 'busy') await busy(options);
  else if (mode === 'counter-stream') counterStream(options);
  else if (mode === 'hash-tree') hashTree();
  else if (mode === 'mutate-for-deltas') mutateForDeltas();
  else if (mode === 'inotify-count') await inotifyCount(options);
  else if (mode === 'inotify-race') await inotifyRace(options);
  else if (mode === 'inotify-rename') await inotifyRename();
  else if (mode === 'inotify-overflow') await inotifyOverflow(options);
  else if (mode === 'inotify-exhaust') await inotifyExhaust(options);
  else { console.error(`unknown mode ${mode}`); process.exit(2); }
}
