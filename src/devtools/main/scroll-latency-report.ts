/**
 * Joins the renderer's and the pty host's round-trip rings into one scroll
 * latency report (the `/scroll-latency` route's answer).
 *
 * The renderer ring (`src/renderer/utils/scroll-latency-probe.ts`) and the
 * host ring (`src/main/diagnostics/pty-round-trip-probe.ts`) run on different
 * clocks, so every interval here is taken inside one ring. The one figure that
 * spans both, the transport, comes from pairing the k-th report the renderer
 * sent with the k-th mouse report the host wrote, which holds because both
 * directions are ordered channels: the renderer's round trip minus the host's
 * write-to-flush is what the two hops between the renderer and the host cost.
 *
 * "First output after a report" is the answer to it. That is exact when the
 * agent is otherwise quiet, and when reports are spaced further apart than the
 * agent's answer; `isolated` keeps only the reports answered before the next
 * one left, which is the clean number. Output the agent sends for its own
 * reasons (a spinner) can only make an answer look sooner, never later.
 */

import type { HostRoundTripEvent, HostRoundTripReading } from '../../main/diagnostics/pty-round-trip-probe';
import { FLUSH_INTERVAL_MS } from '../../main/pty/buffer/pty-buffer-manager';
import type { RendererRoundTripEvent, RendererRoundTripReading } from '../../renderer/utils/scroll-latency-probe';
import type { RoundTripInput } from '../../shared/round-trip-input';

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

export interface SessionScrollLatency {
  sessionId: string;
  counts: {
    wheels: number;
    reports: number;
    sends: number;
    unansweredSends: number;
    arrivals: number;
    /** Writes of the measured input kind (mouse reports or keystrokes) the host saw. */
    hostInputWrites: number;
    hostOutputChunks: number;
    hostFlushes: number;
  };
  renderer: {
    /** xterm turning a DOM wheel event into a mouse report. */
    wheelToReport: LatencyStats;
    /** A report waiting in the paced input queue (`write-batcher.ts`). */
    pacedQueue: LatencyStats;
    /** A send (a paced mouse report, or a keystroke) to the first output after
     *  it: the whole round trip as the renderer sees it. */
    sendToFirstArrival: LatencyStats;
    isolatedSendToFirstArrival: LatencyStats;
    /** The answer's frame reaching the renderer to xterm finishing its parse (the incoming queue plus the parse). */
    arrivalToParsed: LatencyStats;
    /** A finished parse to the animation frame it paints in. */
    parsedToPainted: LatencyStats;
    /** The input (a mouse report, or a keystroke) to the animation frame that
     *  paints the answer's frame. */
    reportToPainted: LatencyStats;
    /** IPC messages each answer arrived in. */
    answerArrivals: LatencyStats;
    /** The largest message's share of each answer's characters, median and
     *  lowest. Near 1, the frame came whole and a paint between the messages
     *  showed nothing torn. */
    frameShare: { median: number | null; lowest: number | null };
    /** Frames painted while an answer was partly delivered (see
     *  TORN_PAINT_MIN_SHARE), per answer: each showed part of a redraw. */
    tornPaints: LatencyStats;
    /** The share of answers painted torn at least once. */
    tornAnswerShare: number | null;
  };
  host: {
    /** The input written to the PTY to the first output after it: the agent plus ConPTY. */
    agentResponse: LatencyStats;
    isolatedAgentResponse: LatencyStats;
    /** That first output to the flush that posts it to main. */
    firstOutputToFlush: LatencyStats;
    writeToFlush: LatencyStats;
    /**
     * The answer's shape as the PTY delivered it: the chunks after a report up
     * to the next report or a quiet gap of `ANSWER_GAP_MS`. A frame split into
     * chunks is painted half-drawn if a flush falls between them and the agent
     * does not bracket it in DEC 2026, so a flush change has to fit these.
     */
    answerChunks: LatencyStats;
    answerSpread: LatencyStats;
    answerLargestGap: LatencyStats;
    answerFlushes: LatencyStats;
  } | null;
  /** Both hops between the renderer and the host, input and output, per paired report. */
  transport: LatencyStats | null;
  /**
   * The two hops apart: the input's from the renderer's send to the host's
   * write, and the answer's from the host's flush to its arrival. The rings
   * are lined up by each process's `performance.timeOrigin`, so each hop
   * carries that alignment's error, around a millisecond either way, which
   * moves time from one hop to the other; their sum is `transport` exactly.
   * Null when a reading carries no origin.
   */
  transportLegs: { toHost: LatencyStats; toRenderer: LatencyStats } | null;
  /** Per paired report: report-to-paint minus that report's agent answer. */
  kangenticShare: LatencyStats | null;
  /** `paired` when both sides saw the same number of reports; otherwise why not. */
  pairing: string;
  /** Medians of each leg, in round-trip order, and the end-to-end median they should add up to. */
  breakdownMs: {
    pacedQueue: number | null;
    transport: number | null;
    agent: number | null;
    hostFlushWait: number | null;
    rendererParse: number | null;
    paintWait: number | null;
    reportToPainted: number | null;
  };
  summary: string;
}

/** One session's output over the window: how often and how much the host
 *  sent toward the renderer, and how much arrived. A flush change trades
 *  batching for latency, so this is where a cost under a flood shows. */
export interface SessionOutputStream {
  sessionId: string;
  hostFlushes: number;
  hostFlushChars: number;
  hostPauses: number;
  rendererArrivals: number;
  rendererChars: number;
  /** The longest wait between two of the session's flushes in the host, and
   *  between two of its arrivals in the renderer. A session that streams
   *  steadily (a repainting agent) shows a freeze as one long gap, so these
   *  say which terminals stopped and on which side. Null under two events. */
  hostMaxFlushGapMs: number | null;
  rendererMaxArrivalGapMs: number | null;
}

export interface ScrollLatencyReport {
  /** Which input the round trips were timed for. */
  input: RoundTripInput;
  sessions: SessionScrollLatency[];
  streams: SessionOutputStream[];
  /** Every 16 ms output flush timer that fired in the window, any session, and
   *  separately the prompt flushes after input (`setImmediate`, requested 0). */
  hostFlushTimer: (LatencyStats & {
    requestedMs: number;
    firedAfter20MsShare: number | null;
    promptFlushes: LatencyStats;
  }) | null;
  hostEventLoopDelay: HostRoundTripReading['eventLoopDelay'];
  droppedEvents: { renderer: number; host: number };
}

/** A report is matched to the wheel before it only within this. */
const WHEEL_MATCH_MS = 100;
/** Output this long after the previous chunk is no longer part of the same answer. */
const ANSWER_GAP_MS = 30;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    p99Ms: round(percentile(0.99)),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(total / sorted.length),
  };
}

/** Index of the first time in ascending `times` that is >= `at` (or > `at` when `strict`), else -1. */
function firstIndexFrom(times: readonly number[], at: number, strict: boolean): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (strict ? times[middle] <= at : times[middle] < at) low = middle + 1;
    else high = middle;
  }
  return low < times.length ? low : -1;
}

/** The last time in ascending `times` that is <= `at`, else null. */
function lastAtOrBefore(times: readonly number[], at: number): number | null {
  const index = firstIndexFrom(times, at, true);
  const lastIndex = index === -1 ? times.length - 1 : index - 1;
  return lastIndex >= 0 ? times[lastIndex] : null;
}

function timesOf<Event extends { at: number }>(events: readonly Event[]): number[] {
  return events.map((event) => event.at);
}

interface RendererLegs {
  wheels: number[];
  reports: number[];
  sends: RendererRoundTripEvent[];
  arrivals: RendererRoundTripEvent[];
  arrivalTimes: number[];
  parsed: number[];
  painted: number[];
}

interface RendererRoundTrip {
  sendAt: number;
  firstArrivalAt: number;
  sendToFirstArrival: number;
  isolated: boolean;
  arrivalToParsed: number | null;
  parsedToPainted: number | null;
  reportToPainted: number | null;
  /** IPC messages the answer arrived in (see ANSWER_GAP_MS). */
  answerArrivals: number;
  /** The largest message's share of the answer's characters. */
  frameShare: number;
  /** Frames painted while the answer was partly delivered. */
  tornPaints: number;
}

/**
 * A paint is torn when the answer's messages before it carry between these
 * shares of its characters. Below the floor it showed the old frame (Claude
 * Code's empty DEC 2026 pair that opens an answer); above the ceiling it showed
 * all but a short tail (the 3 characters that close one). In between, it
 * showed part of a redraw, or one of several whole ones: Claude Code answers a
 * keystroke with two identical full repaints 15 ms apart, which counts here
 * and shows nothing wrong. Confirm a high count against the raw bytes
 * (`kangentic_devtools_terminal_forensics`) before reading it as a tear.
 */
const TORN_PAINT_MIN_SHARE = 0.05;
const TORN_PAINT_MAX_SHARE = 0.95;
/** Paint stamps closer than this are one animation frame. */
const SAME_FRAME_MS = 4;

function tornPaintsOf(painted: readonly number[], answer: readonly RendererRoundTripEvent[], answerChars: number): number {
  if (answer.length < 2 || answerChars === 0) return 0;
  const firstAt = answer[0].at;
  const lastAt = answer[answer.length - 1].at;
  const firstPaintIndex = firstIndexFrom(painted, firstAt, true);
  if (firstPaintIndex === -1) return 0;
  // Running totals, so each paint reads what had arrived before it with one
  // search instead of re-adding the answer: a flood's answer runs to
  // thousands of messages with a paint between most of them.
  const arrivalTimes = timesOf(answer);
  const charsBefore = [0];
  for (const arrival of answer) charsBefore.push(charsBefore[charsBefore.length - 1] + (arrival.chars ?? 0));
  let torn = 0;
  let lastTornAt = Number.NEGATIVE_INFINITY;
  for (let paintIndex = firstPaintIndex; paintIndex < painted.length; paintIndex++) {
    const paintedAt = painted[paintIndex];
    if (paintedAt >= lastAt) break;
    // The messages before the paint end at the first one at or after it.
    const arrivedCount = firstIndexFrom(arrivalTimes, paintedAt, false);
    const delivered = charsBefore[arrivedCount === -1 ? answer.length : arrivedCount];
    const share = delivered / answerChars;
    if (share < TORN_PAINT_MIN_SHARE || share > TORN_PAINT_MAX_SHARE || paintedAt - lastTornAt <= SAME_FRAME_MS) continue;
    torn += 1;
    lastTornAt = paintedAt;
  }
  return torn;
}

/** A send's input kind. Both of useTerminal's stamps name it; a send that
 *  names none (a hand-built reading) counts as a mouse report. */
function inputOf(event: RendererRoundTripEvent): RoundTripInput {
  return event.input ?? 'mouse';
}

function rendererLegsFor(events: readonly RendererRoundTripEvent[], sessionId: string, input: RoundTripInput): RendererLegs {
  const forSession = events.filter((event) => event.sessionId === sessionId);
  const at = (stage: RendererRoundTripEvent['stage']): number[] => timesOf(forSession.filter((event) => event.stage === stage));
  const arrivals = forSession.filter((event) => event.stage === 'arrive');
  return {
    wheels: at('wheel'),
    reports: at('report'),
    sends: forSession.filter((event) => event.stage === 'send' && inputOf(event) === input),
    arrivals,
    arrivalTimes: timesOf(arrivals),
    parsed: at('parsed'),
    painted: at('painted'),
  };
}

/**
 * One entry per send; null where no output followed it in the window.
 *
 * The answer is every message after the send up to the next send or a quiet
 * gap of ANSWER_GAP_MS, and the parse and paint legs follow its LARGEST
 * message, the one carrying the frame. Claude Code opens each answer with an
 * empty DEC 2026 pair (16 characters) a few milliseconds before the frame and
 * ends it with a 3-character tail, so timing the first message would time a
 * paint that shows nothing new.
 */
function rendererRoundTrips(legs: RendererLegs): Array<RendererRoundTrip | null> {
  return legs.sends.map((send, index) => {
    const arrivalIndex = firstIndexFrom(legs.arrivalTimes, send.at, true);
    if (arrivalIndex === -1) return null;
    const firstArrival = legs.arrivals[arrivalIndex];
    const nextSend = legs.sends[index + 1];
    let frame = firstArrival;
    let lastArrivalAt = firstArrival.at;
    let answerChars = firstArrival.chars ?? 0;
    const answer = [firstArrival];
    for (let nextIndex = arrivalIndex + 1; nextIndex < legs.arrivals.length; nextIndex++) {
      const arrival = legs.arrivals[nextIndex];
      if ((nextSend !== undefined && arrival.at > nextSend.at) || arrival.at - lastArrivalAt > ANSWER_GAP_MS) break;
      lastArrivalAt = arrival.at;
      answer.push(arrival);
      answerChars += arrival.chars ?? 0;
      if ((arrival.chars ?? 0) > (frame.chars ?? 0)) frame = arrival;
    }
    const parsedIndex = firstIndexFrom(legs.parsed, frame.at, false);
    const parsed = parsedIndex === -1 ? null : legs.parsed[parsedIndex];
    const paintedIndex = parsed === null ? -1 : firstIndexFrom(legs.painted, parsed, false);
    const painted = paintedIndex === -1 ? null : legs.painted[paintedIndex];
    const reportedAt = send.at - (send.queuedMs ?? 0);
    return {
      sendAt: send.at,
      firstArrivalAt: firstArrival.at,
      sendToFirstArrival: firstArrival.at - send.at,
      isolated: nextSend === undefined || nextSend.at > firstArrival.at,
      arrivalToParsed: parsed === null ? null : parsed - frame.at,
      parsedToPainted: parsed === null || painted === null ? null : painted - parsed,
      reportToPainted: painted === null ? null : painted - reportedAt,
      answerArrivals: answer.length,
      frameShare: answerChars > 0 ? (frame.chars ?? 0) / answerChars : 1,
      tornPaints: tornPaintsOf(legs.painted, answer, answerChars),
    };
  });
}

interface HostRoundTrip {
  writtenAt: number;
  flushedAt: number | null;
  agentResponse: number;
  isolated: boolean;
  firstOutputToFlush: number | null;
  writeToFlush: number | null;
  answerChunks: number;
  answerSpread: number;
  answerLargestGap: number;
  /** Flushes the answer's chunks went out in; more than one can paint it in parts. */
  answerFlushes: number | null;
}

function isInputWrite(event: HostRoundTripEvent, input: RoundTripInput): boolean {
  return event.stage === 'write' && (input === 'mouse' ? event.mouse === true : event.key === true);
}

function hostRoundTrips(events: readonly HostRoundTripEvent[], sessionId: string, input: RoundTripInput): {
  inputWrites: number;
  outputChunks: number;
  flushes: number;
  trips: Array<HostRoundTrip | null>;
} {
  const forSession = events.filter((event) => event.sessionId === sessionId);
  const inputWrites = timesOf(forSession.filter((event) => isInputWrite(event, input)));
  const output = timesOf(forSession.filter((event) => event.stage === 'data'));
  const flushes = timesOf(forSession.filter((event) => event.stage === 'flush'));
  const trips = inputWrites.map((writtenAt, index) => {
    const outputIndex = firstIndexFrom(output, writtenAt, true);
    if (outputIndex === -1) return null;
    const firstOutput = output[outputIndex];
    const nextWrite = inputWrites[index + 1];
    const flushIndex = firstIndexFrom(flushes, firstOutput, false);
    const flushedAt = flushIndex === -1 ? null : flushes[flushIndex];
    let lastChunk = firstOutput;
    let largestGap = 0;
    let chunkCount = 1;
    for (let chunkIndex = outputIndex + 1; chunkIndex < output.length; chunkIndex++) {
      const chunkAt = output[chunkIndex];
      if ((nextWrite !== undefined && chunkAt > nextWrite) || chunkAt - lastChunk > ANSWER_GAP_MS) break;
      largestGap = Math.max(largestGap, chunkAt - lastChunk);
      lastChunk = chunkAt;
      chunkCount += 1;
    }
    const lastFlushIndex = firstIndexFrom(flushes, lastChunk, false);
    return {
      writtenAt,
      flushedAt,
      answerFlushes: flushIndex === -1 || lastFlushIndex === -1 ? null : lastFlushIndex - flushIndex + 1,
      agentResponse: firstOutput - writtenAt,
      isolated: nextWrite === undefined || nextWrite > firstOutput,
      firstOutputToFlush: flushedAt === null ? null : flushedAt - firstOutput,
      writeToFlush: flushedAt === null ? null : flushedAt - writtenAt,
      answerChunks: chunkCount,
      answerSpread: lastChunk - firstOutput,
      answerLargestGap: largestGap,
    };
  });
  return { inputWrites: inputWrites.length, outputChunks: output.length, flushes: flushes.length, trips };
}

/** The longest step between consecutive times, or null under two. */
function maxGap(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const sorted = [...times].sort((left, right) => left - right);
  let largest = 0;
  for (let index = 1; index < sorted.length; index++) largest = Math.max(largest, sorted[index] - sorted[index - 1]);
  return round(largest);
}

/** Every session's output totals over the window, sorted by flush count. */
function outputStreams(renderer: RendererRoundTripReading, host: HostRoundTripReading | null): SessionOutputStream[] {
  const streams = new Map<string, SessionOutputStream>();
  const flushTimes = new Map<string, number[]>();
  const arrivalTimes = new Map<string, number[]>();
  const streamFor = (sessionId: string): SessionOutputStream => {
    let stream = streams.get(sessionId);
    if (!stream) {
      stream = {
        sessionId, hostFlushes: 0, hostFlushChars: 0, hostPauses: 0, rendererArrivals: 0, rendererChars: 0,
        hostMaxFlushGapMs: null, rendererMaxArrivalGapMs: null,
      };
      streams.set(sessionId, stream);
    }
    return stream;
  };
  const timesFor = (timesBySession: Map<string, number[]>, sessionId: string): number[] => {
    let times = timesBySession.get(sessionId);
    if (!times) {
      times = [];
      timesBySession.set(sessionId, times);
    }
    return times;
  };
  for (const event of host?.events ?? []) {
    if (event.stage === 'flush') {
      const stream = streamFor(event.sessionId);
      stream.hostFlushes += 1;
      stream.hostFlushChars += event.chars;
      timesFor(flushTimes, event.sessionId).push(event.at);
    } else if (event.stage === 'pause') {
      streamFor(event.sessionId).hostPauses += 1;
    }
  }
  for (const event of renderer.events) {
    if (event.stage !== 'arrive') continue;
    const stream = streamFor(event.sessionId);
    stream.rendererArrivals += 1;
    stream.rendererChars += event.chars ?? 0;
    timesFor(arrivalTimes, event.sessionId).push(event.at);
  }
  for (const stream of streams.values()) {
    stream.hostMaxFlushGapMs = maxGap(flushTimes.get(stream.sessionId) ?? []);
    stream.rendererMaxArrivalGapMs = maxGap(arrivalTimes.get(stream.sessionId) ?? []);
  }
  return [...streams.values()].sort((left, right) => right.hostFlushes - left.hostFlushes);
}

function shareSummary(shares: readonly number[]): { median: number | null; lowest: number | null } {
  if (shares.length === 0) return { median: null, lowest: null };
  const sorted = [...shares].sort((left, right) => left - right);
  const toThousandth = (value: number): number => Math.round(value * 1000) / 1000;
  return { median: toThousandth(sorted[Math.floor(sorted.length / 2)]), lowest: toThousandth(sorted[0]) };
}

function present<Value>(values: ReadonlyArray<Value | null | undefined>): Value[] {
  return values.filter((value): value is Value => value !== null && value !== undefined);
}

function describe(
  sessionId: string,
  breakdown: SessionScrollLatency['breakdownMs'],
  kangenticShare: LatencyStats | null,
): string {
  const total = breakdown.reportToPainted;
  if (total === null) return `${sessionId.slice(0, 8)}: no input was answered and painted in the window.`;
  const legs: Array<[string, number | null]> = [
    ['paced queue', breakdown.pacedQueue],
    ['transport', breakdown.transport],
    ['host flush wait', breakdown.hostFlushWait],
    ['parse', breakdown.rendererParse],
    ['paint wait', breakdown.paintWait],
  ];
  const parts = legs.filter(([, value]) => value !== null).map(([name, value]) => `${name} ${value}`).join(', ');
  const agent = breakdown.agent === null ? 'agent unmeasured' : `agent ${breakdown.agent} ms`;
  const kangentic = kangenticShare === null || kangenticShare.p50Ms === null
    ? 'Kangentic unmeasured (no host pairing)'
    : `Kangentic ${kangenticShare.p50Ms} ms (p95 ${kangenticShare.p95Ms}, p99 ${kangenticShare.p99Ms})`;
  return `${sessionId.slice(0, 8)}: median input-to-paint ${total} ms; ${agent}; ${kangentic}, taken per input as input-to-paint minus that input's agent answer. Leg medians: ${parts}.`;
}

/**
 * Join both rings. `sessionId` narrows the report to one session; `input`
 * picks which round trips to time, wheel reports or typed keystrokes.
 *
 * A keystroke's "answer" is the first output after it, which is its echo only
 * when the session is otherwise quiet. Into a streaming session, the stream's
 * next chunk stands in for the echo, so time keystrokes on an idle session and
 * read a streaming one for its `streams` totals.
 */
export function buildScrollLatencyReport(
  renderer: RendererRoundTripReading,
  host: HostRoundTripReading | null,
  sessionId?: string,
  input: RoundTripInput = 'mouse',
): ScrollLatencyReport {
  const sessionIds = new Set<string>();
  for (const event of renderer.events) if (event.stage === 'send' && inputOf(event) === input) sessionIds.add(event.sessionId);
  for (const event of host?.events ?? []) if (isInputWrite(event, input)) sessionIds.add(event.sessionId);
  const targets = sessionId ? [sessionId] : [...sessionIds];

  const sessions = targets.map((target): SessionScrollLatency => {
    const legs = rendererLegsFor(renderer.events, target, input);
    const rendererTrips = rendererRoundTrips(legs);
    const answered = present(rendererTrips);
    const hostSide = host ? hostRoundTrips(host.events, target, input) : null;
    const hostTrips = hostSide ? present(hostSide.trips) : [];

    let pairing = 'no host reading';
    let transport: LatencyStats | null = null;
    let transportLegs: SessionScrollLatency['transportLegs'] = null;
    let kangenticShare: LatencyStats | null = null;
    if (hostSide && host) {
      if (hostSide.inputWrites !== legs.sends.length) {
        pairing = `unpaired: the renderer sent ${legs.sends.length} inputs and the host wrote ${hostSide.inputWrites}`;
      } else {
        // Host time on the renderer's clock, when both rings say where they start.
        const hostToRendererClock = host.timeOrigin !== undefined && renderer.timeOrigin !== undefined
          ? host.timeOrigin - renderer.timeOrigin
          : null;
        const differences: number[] = [];
        const toHost: number[] = [];
        const toRenderer: number[] = [];
        const shares: number[] = [];
        let inconsistent = 0;
        rendererTrips.forEach((rendererTrip, index) => {
          const hostTrip = hostSide.trips[index];
          if (!rendererTrip || !hostTrip || hostTrip.writeToFlush === null || hostTrip.flushedAt === null) return;
          const difference = rendererTrip.sendToFirstArrival - hostTrip.writeToFlush;
          if (difference < 0) {
            inconsistent += 1;
            return;
          }
          differences.push(difference);
          if (hostToRendererClock !== null) {
            toHost.push(hostTrip.writtenAt + hostToRendererClock - rendererTrip.sendAt);
            toRenderer.push(rendererTrip.firstArrivalAt - (hostTrip.flushedAt + hostToRendererClock));
          }
          if (rendererTrip.reportToPainted !== null) shares.push(rendererTrip.reportToPainted - hostTrip.agentResponse);
        });
        transport = latencyStats(differences);
        if (toHost.length > 0) transportLegs = { toHost: latencyStats(toHost), toRenderer: latencyStats(toRenderer) };
        kangenticShare = latencyStats(shares);
        pairing = inconsistent > 0 ? `paired, ${inconsistent} pairs answered by different output dropped` : 'paired';
      }
    }

    const wheelToReport = present(legs.reports.map((reportedAt) => {
      const wheelAt = lastAtOrBefore(legs.wheels, reportedAt);
      return wheelAt !== null && reportedAt - wheelAt <= WHEEL_MATCH_MS ? reportedAt - wheelAt : null;
    }));
    const isolatedHost = hostTrips.filter((trip) => trip.isolated);
    const hostStats = hostSide
      ? {
        agentResponse: latencyStats(hostTrips.map((trip) => trip.agentResponse)),
        isolatedAgentResponse: latencyStats(isolatedHost.map((trip) => trip.agentResponse)),
        firstOutputToFlush: latencyStats(present(hostTrips.map((trip) => trip.firstOutputToFlush))),
        writeToFlush: latencyStats(present(hostTrips.map((trip) => trip.writeToFlush))),
        answerChunks: latencyStats(isolatedHost.map((trip) => trip.answerChunks)),
        answerSpread: latencyStats(isolatedHost.map((trip) => trip.answerSpread)),
        answerLargestGap: latencyStats(isolatedHost.map((trip) => trip.answerLargestGap)),
        answerFlushes: latencyStats(present(isolatedHost.map((trip) => trip.answerFlushes))),
      }
      : null;
    const rendererStats = {
      wheelToReport: latencyStats(wheelToReport),
      pacedQueue: latencyStats(present(legs.sends.map((send) => send.queuedMs))),
      sendToFirstArrival: latencyStats(answered.map((trip) => trip.sendToFirstArrival)),
      isolatedSendToFirstArrival: latencyStats(answered.filter((trip) => trip.isolated).map((trip) => trip.sendToFirstArrival)),
      arrivalToParsed: latencyStats(present(answered.map((trip) => trip.arrivalToParsed))),
      parsedToPainted: latencyStats(present(answered.map((trip) => trip.parsedToPainted))),
      reportToPainted: latencyStats(present(answered.map((trip) => trip.reportToPainted))),
      answerArrivals: latencyStats(answered.map((trip) => trip.answerArrivals)),
      frameShare: shareSummary(answered.map((trip) => trip.frameShare)),
      tornPaints: latencyStats(answered.map((trip) => trip.tornPaints)),
      tornAnswerShare: answered.length > 0
        ? Math.round((answered.filter((trip) => trip.tornPaints > 0).length / answered.length) * 1000) / 1000
        : null,
    };
    const agentMedian = hostStats
      ? hostStats.isolatedAgentResponse.p50Ms ?? hostStats.agentResponse.p50Ms
      : null;
    const breakdownMs = {
      pacedQueue: rendererStats.pacedQueue.p50Ms,
      transport: transport?.p50Ms ?? null,
      agent: agentMedian,
      hostFlushWait: hostStats?.firstOutputToFlush.p50Ms ?? null,
      rendererParse: rendererStats.arrivalToParsed.p50Ms,
      paintWait: rendererStats.parsedToPainted.p50Ms,
      reportToPainted: rendererStats.reportToPainted.p50Ms,
    };
    return {
      sessionId: target,
      counts: {
        wheels: legs.wheels.length,
        reports: legs.reports.length,
        sends: legs.sends.length,
        unansweredSends: rendererTrips.length - answered.length,
        arrivals: legs.arrivals.length,
        hostInputWrites: hostSide?.inputWrites ?? 0,
        hostOutputChunks: hostSide?.outputChunks ?? 0,
        hostFlushes: hostSide?.flushes ?? 0,
      },
      renderer: rendererStats,
      host: hostStats,
      transport,
      transportLegs,
      kangenticShare,
      pairing,
      breakdownMs,
      summary: describe(target, breakdownMs, kangenticShare),
    };
  });

  const flushTimers = (host?.flushTimers ?? []).filter((sample) => sample.requestedMs > 0);
  const promptFlushes = (host?.flushTimers ?? []).filter((sample) => sample.requestedMs === 0);
  const firedLate = flushTimers.filter((sample) => sample.actualMs > 20).length;
  return {
    input,
    sessions,
    streams: outputStreams(renderer, host),
    hostFlushTimer: host
      ? {
        requestedMs: FLUSH_INTERVAL_MS,
        ...latencyStats(flushTimers.map((sample) => sample.actualMs)),
        firedAfter20MsShare: flushTimers.length > 0 ? round(firedLate / flushTimers.length) : null,
        promptFlushes: latencyStats(promptFlushes.map((sample) => sample.actualMs)),
      }
      : null,
    hostEventLoopDelay: host?.eventLoopDelay ?? null,
    droppedEvents: { renderer: renderer.droppedEvents, host: host?.droppedEvents ?? 0 },
  };
}
