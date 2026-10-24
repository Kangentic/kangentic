import { describe, expect, it } from 'vitest';
import type { Profiler } from 'node:inspector';
import { summarizeBusyProfile, summarizeProfile } from '../../src/devtools/main/stall-profiler';

/** root -> (idle); root -> dispatch -> parseTranscript. */
function profileOf(samples: number[]): Profiler.Profile {
  const frame = (functionName: string, url: string, lineNumber: number) => ({
    functionName, scriptId: '1', url, lineNumber, columnNumber: 0,
  });
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)', '', 0), children: [2, 3] },
      { id: 2, callFrame: frame('(idle)', '', 0) },
      { id: 3, callFrame: frame('dispatch', 'file:///app/main/ipc/router.js', 9), children: [4] },
      { id: 4, callFrame: frame('parseTranscript', 'file:///app/main/agent/transcript-parser.js', 41) },
    ],
    startTime: 0,
    endTime: samples.length * 1000,
    samples,
    // One millisecond between samples.
    timeDeltas: samples.map(() => 1000),
  };
}

describe('summarizeProfile', () => {
  it('names the heaviest functions of the longest busy run, and its stack', () => {
    // A 4 ms busy run (three samples in the parser, one in its caller), and a
    // shorter 1 ms one later.
    const summary = summarizeProfile(profileOf([2, 2, 4, 4, 4, 3, 2, 4, 2]));

    expect(summary.longestBusyRunMs).toBe(4);
    expect(summary.topFrames).toEqual([
      { functionName: 'parseTranscript', location: 'agent/transcript-parser.js:42', selfMs: 3 },
      { functionName: 'dispatch', location: 'ipc/router.js:10', selfMs: 1 },
    ]);
    expect(summary.heaviestStack).toEqual([
      'dispatch ipc/router.js:10',
      'parseTranscript agent/transcript-parser.js:42',
    ]);
  });

  it('summarises only the tail it is given, where the stall happened', () => {
    // An early 3 ms busy run in the caller, then a 2 ms one in the parser at
    // the end. Only the last 4 ms are the tail.
    const summary = summarizeProfile(profileOf([3, 3, 3, 2, 2, 2, 2, 4, 4, 2]), 4);

    expect(summary.longestBusyRunMs).toBe(2);
    expect(summary.topFrames.map((frame) => frame.functionName)).toEqual(['parseTranscript']);
  });

  it('counts the whole window when the profile marks no idle samples', () => {
    const summary = summarizeProfile(profileOf([4, 3, 4]));

    expect(summary.longestBusyRunMs).toBeNull();
    expect(summary.topFrames.map((frame) => [frame.functionName, frame.selfMs])).toEqual([
      ['parseTranscript', 2],
      ['dispatch', 1],
    ]);
  });
});

describe('summarizeBusyProfile', () => {
  it('adds up every busy sample and ranks functions by self time', () => {
    const profile: Profiler.Profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4] },
        { id: 2, callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 } },
        { id: 3, callFrame: { functionName: 'parse', scriptId: '1', url: 'file:///app/node_modules/xterm-headless.js', lineNumber: 9, columnNumber: 0 } },
        { id: 4, callFrame: { functionName: 'spawn', scriptId: '2', url: 'node:child_process', lineNumber: 0, columnNumber: 0 } },
      ],
      startTime: 0,
      endTime: 6000,
      samples: [2, 3, 3, 2, 3, 4],
      timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000],
    };
    const summary = summarizeBusyProfile(profile);
    expect(summary.sampledMs).toBe(6);
    expect(summary.busyMs).toBe(4);
    expect(summary.topFrames[0]).toEqual({ functionName: 'parse', location: 'node_modules/xterm-headless.js:10', selfMs: 3 });
    expect(summary.topFrames[1].functionName).toBe('spawn');
  });

  it('keeps every busy run, where summarizeProfile keeps only the longest', () => {
    // Two busy runs split by idle: 3 ms in the parser, then 2 ms in its caller.
    const summary = summarizeBusyProfile(profileOf([4, 4, 4, 2, 3, 3, 2]));

    expect(summary.busyMs).toBe(5);
    expect(summary.topFrames.map((frame) => [frame.functionName, frame.selfMs])).toEqual([
      ['parseTranscript', 3],
      ['dispatch', 2],
    ]);
  });
});
