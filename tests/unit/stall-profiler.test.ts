import { describe, expect, it } from 'vitest';
import type { Profiler } from 'node:inspector';
import { summarizeProfile } from '../../src/devtools/main/stall-profiler';

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
