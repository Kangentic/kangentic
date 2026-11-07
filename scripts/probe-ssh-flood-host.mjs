// Host side of probe-ssh-flood.mjs (#913 Phase 0). Runs under plain Node on the Linux host at
// the far end of one SSH exec channel. Not shipped, and nothing under src/ imports it.
//
// Usage: the client starts it, one process per SSH channel:
//   ssh <destination> <node> probe-ssh-flood-host.mjs
//
// It multiplexes logical sessions over framed stdio. A frame is:
//   u32 payload length, u32 session id, u8 frame type, payload
// An echo session returns each keystroke frame at once. A flood session writes terminal-like
// text as fast as its credit allows. Credit copies src/main/pty/buffer/backpressure-controller.ts:
// `inFlight` counts bytes sent and not yet acked, a session pauses at `highWater` and resumes once
// it drains to `lowWater`, and the accounting is per session. The client acks the bytes it read,
// so the window covers every queue between this process and the client: the pipe to sshd, sshd's
// channel buffer, the TCP send buffer and the network.
//
// Sessions take turns one frame at a time, so a keystroke's echo waits behind at most one frame
// per flood on this side. Everything past stdout is first in, first out.

import net from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const FRAME_HEADER_BYTES = 9;
export const FrameType = Object.freeze({
  config: 1,
  open: 2,
  keystroke: 3,
  credit: 4,
  stop: 5,
  ready: 16,
  echo: 17,
  data: 18,
  stats: 19,
});

const MAX_INBOUND_PAYLOAD_BYTES = 1024 * 1024;
/** A pump turn gives way to stdin after this many bytes, so credit and keystrokes are read. */
const PUMP_TURN_BYTES = 256 * 1024;
const CAP_RETRY_MS = 5;
const COLOR_CODES = [31, 32, 33, 34, 35, 36];
const SAMPLE_WORDS = ['compile', 'src/main/index.ts', 'passed', 'worktree', 'rebase', 'lint', 'bundle', 'session', 'PR #128', 'tests'];

export function encodeFrame(sessionId, frameType, payload) {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.writeUInt32BE(sessionId, 4);
  frame.writeUInt8(frameType, 8);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/** ANSI colored build-log lines, a stable stand-in for what an agent's terminal prints. */
function buildTerminalText(byteCount, seed) {
  const lines = [];
  let total = 0;
  let index = seed;
  while (total < byteCount) {
    const color = COLOR_CODES[index % COLOR_CODES.length];
    const word = SAMPLE_WORDS[index % SAMPLE_WORDS.length];
    const line = `\x1b[${color}m[${String(index).padStart(6, '0')}]\x1b[0m ${word} ${'.'.repeat(index % 37)} done in ${index % 913} ms\r\n`;
    lines.push(line);
    total += line.length;
    index += 1;
  }
  return Buffer.from(lines.join(''), 'latin1').subarray(0, byteCount);
}

class Session {
  constructor(id, mode, settings) {
    this.id = id;
    this.mode = mode;
    this.inFlight = 0;
    this.paused = false;
    this.pauseCount = 0;
    this.sentBytes = 0;
    this.pendingFrames = [];
    this.tokens = 0;
    this.lastRefillAtMs = performance.now();
    this.nextFrameIndex = 0;
    this.floodFrames = [];
    if (mode === 'flood') {
      for (let index = 0; index < 32; index += 1) {
        const text = buildTerminalText(settings.frameBytes, id * 1000 + index * 97);
        this.floodFrames.push(encodeFrame(id, FrameType.data, text));
      }
    }
  }
}

function runHost() {
  const settings = { highWater: 1024 * 1024, lowWater: 256 * 1024, frameBytes: 4096, capBytesPerSecond: 0 };
  const sessions = new Map();
  const order = [];
  let nextTurnIndex = 0;
  let outputBlocked = false;
  let capRetryTimer = null;
  let pumpQueued = false;
  let peakOutputQueueBytes = 0;
  const startedAtMs = performance.now();

  const output = new net.Socket({ fd: 1, readable: false, writable: true });
  // A stdio pipe can open blocking, which would hold this thread while sshd is behind.
  output._handle?.setBlocking?.(false);
  output.on('error', () => process.exit(0));
  output.on('drain', () => {
    outputBlocked = false;
    pump();
  });

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
  eventLoopDelay.enable();

  function writeFrame(frame) {
    const accepted = output.write(frame);
    if (output.writableLength > peakOutputQueueBytes) peakOutputQueueBytes = output.writableLength;
    if (!accepted) outputBlocked = true;
  }

  function capAllows(session, frameBytes) {
    if (settings.capBytesPerSecond <= 0) return true;
    const nowMs = performance.now();
    const refill = ((nowMs - session.lastRefillAtMs) / 1000) * settings.capBytesPerSecond;
    // One 20 ms burst at most, so a cap is a rate and not a window.
    session.tokens = Math.min(session.tokens + refill, Math.max(settings.capBytesPerSecond * 0.02, frameBytes));
    session.lastRefillAtMs = nowMs;
    return session.tokens >= frameBytes;
  }

  /** Mirrors BackpressureController.recordEmitted: count, then pause at high water. */
  function nextFloodFrame(session) {
    if (session.mode !== 'flood' || session.paused) return null;
    if (!capAllows(session, settings.frameBytes)) {
      capRetryTimer ??= setTimeout(() => {
        capRetryTimer = null;
        pump();
      }, CAP_RETRY_MS);
      return null;
    }
    session.tokens -= settings.frameBytes;
    const frame = session.floodFrames[session.nextFrameIndex];
    session.nextFrameIndex = (session.nextFrameIndex + 1) % session.floodFrames.length;
    session.inFlight += settings.frameBytes;
    session.sentBytes += settings.frameBytes;
    if (session.inFlight >= settings.highWater) {
      session.paused = true;
      session.pauseCount += 1;
    }
    return frame;
  }

  function pump() {
    let turnBytes = 0;
    while (!outputBlocked && order.length > 0) {
      let wroteThisRound = false;
      for (let visited = 0; visited < order.length && !outputBlocked; visited += 1) {
        const session = order[nextTurnIndex % order.length];
        nextTurnIndex = (nextTurnIndex + 1) % order.length;
        const frame = session.pendingFrames.shift() ?? nextFloodFrame(session);
        if (!frame) continue;
        writeFrame(frame);
        turnBytes += frame.length;
        wroteThisRound = true;
      }
      if (!wroteThisRound) return;
      if (turnBytes >= PUMP_TURN_BYTES) {
        if (!pumpQueued) {
          pumpQueued = true;
          setImmediate(() => {
            pumpQueued = false;
            pump();
          });
        }
        return;
      }
    }
  }

  /** Mirrors BackpressureController.acknowledge: resume once drained to low water. */
  function acknowledge(session, bytes) {
    session.inFlight = Math.max(0, session.inFlight - bytes);
    if (session.paused && session.inFlight <= settings.lowWater) session.paused = false;
    pump();
  }

  function finish() {
    eventLoopDelay.disable();
    const stats = {
      uptimeMs: performance.now() - startedAtMs,
      eventLoopDelayP99Ms: eventLoopDelay.percentile(99) / 1e6,
      eventLoopDelayMaxMs: eventLoopDelay.max / 1e6,
      peakOutputQueueBytes,
      sessions: [...sessions.values()].map((session) => ({
        id: session.id,
        mode: session.mode,
        sentBytes: session.sentBytes,
        pauseCount: session.pauseCount,
        inFlightAtStop: session.inFlight,
      })),
    };
    output.end(encodeFrame(0, FrameType.stats, Buffer.from(JSON.stringify(stats), 'utf8')), () => process.exit(0));
  }

  function handleFrame(sessionId, frameType, payload) {
    switch (frameType) {
      case FrameType.config:
        Object.assign(settings, JSON.parse(payload.toString('utf8')));
        return;
      case FrameType.open: {
        const session = new Session(sessionId, payload.toString('utf8'), settings);
        sessions.set(sessionId, session);
        order.push(session);
        pump();
        return;
      }
      case FrameType.keystroke: {
        const session = sessions.get(sessionId);
        if (!session) return;
        session.pendingFrames.push(encodeFrame(sessionId, FrameType.echo, payload));
        pump();
        return;
      }
      case FrameType.credit: {
        const session = sessions.get(sessionId);
        if (session) acknowledge(session, payload.readUInt32BE(0));
        return;
      }
      case FrameType.stop:
        for (const session of sessions.values()) session.paused = true;
        finish();
        return;
      default:
        process.exit(3);
    }
  }

  let buffered = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    let offset = 0;
    while (buffered.length - offset >= FRAME_HEADER_BYTES) {
      const payloadBytes = buffered.readUInt32BE(offset);
      if (payloadBytes > MAX_INBOUND_PAYLOAD_BYTES) process.exit(3);
      if (buffered.length - offset < FRAME_HEADER_BYTES + payloadBytes) break;
      const sessionId = buffered.readUInt32BE(offset + 4);
      const frameType = buffered.readUInt8(offset + 8);
      const payload = buffered.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + payloadBytes);
      offset += FRAME_HEADER_BYTES + payloadBytes;
      handleFrame(sessionId, frameType, payload);
    }
    buffered = offset === buffered.length ? Buffer.alloc(0) : buffered.subarray(offset);
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));

  writeFrame(encodeFrame(0, FrameType.ready, Buffer.from(process.version, 'utf8')));
}

// The client imports this file for the frame format. Only a direct run starts the host.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) runHost();
