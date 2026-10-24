import { describe, it, expect } from 'vitest';
import { buildScrollLatencyReport, latencyStats } from '../../src/devtools/main/scroll-latency-report';
import type { HostRoundTripEvent, HostRoundTripReading } from '../../src/main/diagnostics/pty-round-trip-probe';
import type { RendererRoundTripEvent, RendererRoundTripReading } from '../../src/renderer/utils/scroll-latency-probe';

const SESSION = 'session-a';
const OTHER_SESSION = 'session-b';
const WHEEL_UP = '\x1b[<64;10;5M';

function rendererReading(events: RendererRoundTripEvent[]): RendererRoundTripReading {
  return { armedAt: 0, armedUntil: 10_000, now: 10_000, events, droppedEvents: 0 };
}

function hostReading(events: HostRoundTripEvent[], flushTimers: HostRoundTripReading['flushTimers'] = []): HostRoundTripReading {
  return { armedAt: 0, armedUntil: 10_000, now: 10_000, events, flushTimers, eventLoopDelay: null, droppedEvents: 0 };
}

/**
 * Three reports 100 ms apart, each answered the same way. The renderer's
 * clock starts at 1000 and the host's at 5000, so nothing may join across
 * clocks except by order.
 */
function threeAnsweredReports(): { renderer: RendererRoundTripEvent[]; host: HostRoundTripEvent[] } {
  const renderer: RendererRoundTripEvent[] = [];
  const host: HostRoundTripEvent[] = [];
  for (let index = 0; index < 3; index++) {
    const rendererBase = 1000 + index * 100;
    renderer.push(
      { at: rendererBase - 6, sessionId: SESSION, stage: 'wheel' },
      { at: rendererBase - 5, sessionId: SESSION, stage: 'report', chars: WHEEL_UP.length },
      { at: rendererBase, sessionId: SESSION, stage: 'send', chars: WHEEL_UP.length, queuedMs: 5 },
      { at: rendererBase + 60, sessionId: SESSION, stage: 'arrive', chars: 3000 },
      { at: rendererBase + 62, sessionId: SESSION, stage: 'parsed', chars: 3000 },
      { at: rendererBase + 70, sessionId: SESSION, stage: 'painted' },
    );
    const hostBase = 5000 + index * 100;
    host.push(
      { at: hostBase, sessionId: SESSION, stage: 'write', chars: WHEEL_UP.length, mouse: true },
      { at: hostBase + 40, sessionId: SESSION, stage: 'data', chars: 3000 },
      { at: hostBase + 56, sessionId: SESSION, stage: 'flush', chars: 3000 },
    );
  }
  return { renderer, host };
}

describe('latencyStats', () => {
  it('reports nulls for no samples', () => {
    expect(latencyStats([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null });
  });

  it('reads percentiles off the sorted samples', () => {
    const stats = latencyStats([30, 10, 20, 40]);
    expect(stats.count).toBe(4);
    expect(stats.p50Ms).toBe(30);
    expect(stats.maxMs).toBe(40);
    expect(stats.meanMs).toBe(25);
  });
});

describe('buildScrollLatencyReport', () => {
  it('splits each answered report into its legs and pairs the two rings by order', () => {
    const { renderer, host } = threeAnsweredReports();
    const report = buildScrollLatencyReport(rendererReading(renderer), hostReading(host));
    expect(report.sessions).toHaveLength(1);
    const session = report.sessions[0];
    expect(session.pairing).toBe('paired');
    expect(session.renderer.wheelToReport.p50Ms).toBe(1);
    expect(session.renderer.pacedQueue.p50Ms).toBe(5);
    expect(session.renderer.sendToFirstArrival.p50Ms).toBe(60);
    expect(session.renderer.isolatedSendToFirstArrival.count).toBe(3);
    expect(session.renderer.arrivalToParsed.p50Ms).toBe(2);
    expect(session.renderer.parsedToPainted.p50Ms).toBe(8);
    // Painted 70 ms after the send, which waited 5 ms in the queue.
    expect(session.renderer.reportToPainted.p50Ms).toBe(75);
    expect(session.host?.agentResponse.p50Ms).toBe(40);
    expect(session.host?.firstOutputToFlush.p50Ms).toBe(16);
    expect(session.host?.writeToFlush.p50Ms).toBe(56);
    // 60 ms seen by the renderer, 56 of it inside the host.
    expect(session.ipcAndMain?.p50Ms).toBe(4);
    expect(session.breakdownMs).toEqual({
      pacedQueue: 5,
      ipcAndMain: 4,
      agent: 40,
      hostFlushWait: 16,
      rendererParse: 2,
      paintWait: 8,
      reportToPainted: 75,
    });
    // Per report: 75 ms to paint, 40 of it the agent's answer.
    expect(session.kangenticShare?.p50Ms).toBe(35);
    expect(session.summary).toContain('median input-to-paint 75 ms; agent 40 ms; Kangentic 35 ms');
    // Each answer here is one chunk.
    expect(session.host?.answerChunks.p50Ms).toBe(1);
    expect(session.host?.answerSpread.p50Ms).toBe(0);
  });

  it('measures how an answer split into chunks arrived', () => {
    const host: HostRoundTripEvent[] = [
      { at: 100, sessionId: SESSION, stage: 'write', chars: WHEEL_UP.length, mouse: true },
      { at: 103, sessionId: SESSION, stage: 'data', chars: 4000 },
      { at: 103.5, sessionId: SESSION, stage: 'data', chars: 4000 },
      { at: 109, sessionId: SESSION, stage: 'data', chars: 500 },
      // A quiet gap over 30 ms ends the answer; this is the next turn's output.
      { at: 200, sessionId: SESSION, stage: 'data', chars: 10 },
    ];
    const session = buildScrollLatencyReport(rendererReading([]), hostReading(host), SESSION).sessions[0];
    expect(session.host?.answerChunks.p50Ms).toBe(3);
    expect(session.host?.answerSpread.p50Ms).toBe(6);
    expect(session.host?.answerLargestGap.p50Ms).toBe(5.5);
  });

  it('leaves output for other sessions out of a session\'s legs', () => {
    const { renderer, host } = threeAnsweredReports();
    // Another session's output lands before this session's answer on both sides.
    renderer.push({ at: 1010, sessionId: OTHER_SESSION, stage: 'arrive', chars: 10 });
    host.push({ at: 5010, sessionId: OTHER_SESSION, stage: 'data', chars: 10 });
    const sortByTime = <Event extends { at: number }>(events: Event[]): Event[] => events.sort((left, right) => left.at - right.at);
    const report = buildScrollLatencyReport(rendererReading(sortByTime(renderer)), hostReading(sortByTime(host)), SESSION);
    expect(report.sessions[0].renderer.sendToFirstArrival.p50Ms).toBe(60);
    expect(report.sessions[0].host?.agentResponse.p50Ms).toBe(40);
  });

  it('says why it cannot pair when the two sides saw different report counts', () => {
    const { renderer, host } = threeAnsweredReports();
    const report = buildScrollLatencyReport(rendererReading(renderer), hostReading(host.slice(3)));
    expect(report.sessions[0].pairing).toBe('unpaired: the renderer sent 3 inputs and the host wrote 2');
    expect(report.sessions[0].ipcAndMain).toBeNull();
    expect(report.sessions[0].breakdownMs.agent).toBe(40);
  });

  it('times the parse and paint of the message that carries the frame, not the first one', () => {
    // Claude Code's shape: an empty DEC 2026 pair, the frame, then a short tail.
    const renderer: RendererRoundTripEvent[] = [
      { at: 100, sessionId: SESSION, stage: 'send', queuedMs: 0 },
      { at: 103, sessionId: SESSION, stage: 'arrive', chars: 16 },
      { at: 103.2, sessionId: SESSION, stage: 'parsed', chars: 16 },
      { at: 107, sessionId: SESSION, stage: 'painted' },
      { at: 108, sessionId: SESSION, stage: 'arrive', chars: 4700 },
      { at: 108.5, sessionId: SESSION, stage: 'parsed', chars: 4700 },
      { at: 114, sessionId: SESSION, stage: 'painted' },
      { at: 125, sessionId: SESSION, stage: 'arrive', chars: 3 },
    ];
    const session = buildScrollLatencyReport(rendererReading(renderer), null).sessions[0];
    expect(session.renderer.sendToFirstArrival.p50Ms).toBe(3);
    expect(session.renderer.arrivalToParsed.p50Ms).toBe(0.5);
    expect(session.renderer.parsedToPainted.p50Ms).toBe(5.5);
    expect(session.renderer.reportToPainted.p50Ms).toBe(14);
    expect(session.renderer.answerArrivals.p50Ms).toBe(3);
    expect(session.renderer.frameShare).toEqual({ median: 0.996, lowest: 0.996 });
    // The paint after the empty pair showed the old frame, the one after the
    // frame showed all but the tail: neither is torn.
    expect(session.renderer.tornPaints.maxMs).toBe(0);
    expect(session.renderer.tornAnswerShare).toBe(0);
  });

  it('counts a frame painted while a redraw was half delivered as torn, once per frame', () => {
    // An inline renderer's redraw in three even pieces, with paints between them.
    const renderer: RendererRoundTripEvent[] = [
      { at: 100, sessionId: SESSION, stage: 'send', queuedMs: 0 },
      { at: 102, sessionId: SESSION, stage: 'arrive', chars: 1000 },
      { at: 103, sessionId: SESSION, stage: 'painted' },
      { at: 103.5, sessionId: SESSION, stage: 'painted' },
      { at: 106, sessionId: SESSION, stage: 'arrive', chars: 1000 },
      { at: 120, sessionId: SESSION, stage: 'painted' },
      { at: 121, sessionId: SESSION, stage: 'arrive', chars: 1000 },
      { at: 130, sessionId: SESSION, stage: 'painted' },
      { at: 400, sessionId: SESSION, stage: 'send', queuedMs: 0 },
      { at: 402, sessionId: SESSION, stage: 'arrive', chars: 3000 },
      { at: 410, sessionId: SESSION, stage: 'painted' },
    ];
    const session = buildScrollLatencyReport(rendererReading(renderer), null).sessions[0];
    // The first answer: 103 and 103.5 are one frame at a third delivered, 120
    // is two thirds; 130 follows the last piece. The second came whole.
    expect(session.renderer.tornPaints.maxMs).toBe(2);
    expect(session.renderer.tornAnswerShare).toBe(0.5);
  });

  it('marks a report answered only after the next one left as not isolated', () => {
    const renderer: RendererRoundTripEvent[] = [
      { at: 100, sessionId: SESSION, stage: 'send', queuedMs: 0 },
      { at: 116, sessionId: SESSION, stage: 'send', queuedMs: 0 },
      { at: 150, sessionId: SESSION, stage: 'arrive', chars: 100 },
    ];
    const session = buildScrollLatencyReport(rendererReading(renderer), null).sessions[0];
    expect(session.renderer.sendToFirstArrival.count).toBe(2);
    expect(session.renderer.isolatedSendToFirstArrival.count).toBe(1);
    expect(session.renderer.isolatedSendToFirstArrival.p50Ms).toBe(34);
    expect(session.pairing).toBe('no host reading');
  });

  it('counts a report nothing answered', () => {
    const renderer: RendererRoundTripEvent[] = [{ at: 100, sessionId: SESSION, stage: 'send', queuedMs: 0 }];
    const session = buildScrollLatencyReport(rendererReading(renderer), null).sessions[0];
    expect(session.counts.unansweredSends).toBe(1);
    expect(session.summary).toContain('no input was answered and painted');
  });

  it('times keystrokes apart from wheel reports when asked for key input', () => {
    const renderer: RendererRoundTripEvent[] = [
      { at: 100, sessionId: SESSION, stage: 'send', queuedMs: 0, input: 'mouse' },
      { at: 105, sessionId: SESSION, stage: 'arrive', chars: 4000 },
      { at: 300, sessionId: SESSION, stage: 'send', queuedMs: 0, input: 'key' },
      { at: 302, sessionId: SESSION, stage: 'arrive', chars: 20 },
      { at: 302.2, sessionId: SESSION, stage: 'parsed', chars: 20 },
      { at: 306, sessionId: SESSION, stage: 'painted' },
    ];
    const host: HostRoundTripEvent[] = [
      { at: 1000, sessionId: SESSION, stage: 'write', chars: WHEEL_UP.length, mouse: true },
      { at: 1001, sessionId: SESSION, stage: 'data', chars: 4000 },
      { at: 1200, sessionId: SESSION, stage: 'write', chars: 1, key: true },
      { at: 1201, sessionId: SESSION, stage: 'data', chars: 20 },
      { at: 1201.1, sessionId: SESSION, stage: 'flush', chars: 20 },
    ];
    const report = buildScrollLatencyReport(rendererReading(renderer), hostReading(host), SESSION, 'key');
    expect(report.input).toBe('key');
    const session = report.sessions[0];
    expect(session.pairing).toBe('paired');
    expect(session.counts.sends).toBe(1);
    expect(session.renderer.reportToPainted.p50Ms).toBe(6);
    expect(session.host?.agentResponse.p50Ms).toBe(1);
    expect(session.host?.firstOutputToFlush.p50Ms).toBe(0.1);
  });

  it('totals each session\'s output, flushes and backpressure pauses', () => {
    const host: HostRoundTripEvent[] = [
      { at: 1, sessionId: SESSION, stage: 'flush', chars: 100 },
      { at: 2, sessionId: OTHER_SESSION, stage: 'flush', chars: 50 },
      { at: 3, sessionId: OTHER_SESSION, stage: 'flush', chars: 70 },
      { at: 4, sessionId: OTHER_SESSION, stage: 'pause', chars: 0 },
    ];
    const renderer: RendererRoundTripEvent[] = [
      { at: 5, sessionId: OTHER_SESSION, stage: 'arrive', chars: 120 },
    ];
    const report = buildScrollLatencyReport(rendererReading(renderer), hostReading(host));
    expect(report.streams).toEqual([
      { sessionId: OTHER_SESSION, hostFlushes: 2, hostFlushChars: 120, hostPauses: 1, rendererArrivals: 1, rendererChars: 120 },
      { sessionId: SESSION, hostFlushes: 1, hostFlushChars: 100, hostPauses: 0, rendererArrivals: 0, rendererChars: 0 },
    ]);
  });

  it('reports how late the flush timer fired, apart from the prompt flushes', () => {
    const timers = [16, 16.5, 31, 31.2].map((actualMs, index) => ({ at: index, sessionId: SESSION, requestedMs: 16, actualMs }));
    const promptFlushes = [0.1, 0.2].map((actualMs, index) => ({ at: 10 + index, sessionId: SESSION, requestedMs: 0, actualMs }));
    const report = buildScrollLatencyReport(rendererReading([]), hostReading([], [...timers, ...promptFlushes]));
    expect(report.hostFlushTimer?.count).toBe(4);
    expect(report.hostFlushTimer?.firedAfter20MsShare).toBe(0.5);
    expect(report.hostFlushTimer?.promptFlushes.count).toBe(2);
    expect(report.hostFlushTimer?.promptFlushes.maxMs).toBe(0.2);
  });
});
