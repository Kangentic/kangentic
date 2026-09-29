/**
 * What each line of Settings > Knowledge Graph's Index card says. One pattern for every
 * source: caught up is the count with a check, running is the share and the
 * time left with a track and no verb, off is what it would cover (muted), and
 * a missing prerequisite is a tag in place of the value.
 */
import { describe, expect, it } from 'vitest';
import { alwaysLine, codeLine, summariesLine, timeLeft } from '../../src/renderer/components/settings/tabs/index-sources';
import type { KnowledgeGraphCodeStatus, KnowledgeGraphSummaryStatus } from '../../src/shared/types';

const sonnet = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };

const SUMMARIES: KnowledgeGraphSummaryStatus = {
  written: 0,
  finishedTasks: 674,
  skipped: 0,
  state: 'idle',
  retryInMs: null,
  minutesLeft: null,
  writtenWith: [],
  choice: sonnet,
  awaitingRewrite: 0,
};

const CODE: KnowledgeGraphCodeStatus = { state: 'estimate', branch: 'origin/main', files: 1488, passages: 12186, embedded: 0, minutesLeft: 28 };

describe('the time left', () => {
  it('says minutes under an hour and a half, then half hours', () => {
    expect(timeLeft(0.4)).toBe('1 min left');
    expect(timeLeft(3.2)).toBe('3 min left');
    expect(timeLeft(89)).toBe('89 min left');
    expect(timeLeft(150)).toBe('2.5 hr left');
  });
});

describe('an always-on source', () => {
  it('is its count with a check once nothing waits', () => {
    expect(alwaysLine({ count: 1002, percent: null, minutesLeft: null }, 'Conversations embedded'))
      .toEqual({ value: '1,002', tone: 'ready' });
  });

  it('is the share and the time left while passages wait for vectors', () => {
    expect(alwaysLine({ count: 1002, percent: 40, minutesLeft: 5 }, 'Conversations embedded'))
      .toEqual({ value: '40%, 5 min left', percent: 40, progressLabel: 'Conversations embedded' });
    // No time before the machine has measured a rate.
    expect(alwaysLine({ count: 1002, percent: 40, minutesLeft: null }, 'Conversations embedded').value).toBe('40%');
  });

  it('says nothing before the status has arrived', () => {
    expect(alwaysLine(undefined, 'Tasks embedded')).toEqual({});
  });
});

describe('the task summaries line', () => {
  it('shows only the tag while something is missing', () => {
    expect(summariesLine(true, SUMMARIES, 'Needs an agent')).toEqual({ requirement: 'Needs an agent' });
  });

  it('off, is what switching on would cover, muted, with no call count or time', () => {
    expect(summariesLine(false, SUMMARIES, undefined)).toEqual({ value: '674 tasks', tone: 'muted' });
    expect(summariesLine(false, { ...SUMMARIES, finishedTasks: 1 }, undefined).value).toBe('1 task');
    expect(summariesLine(false, { ...SUMMARIES, finishedTasks: 0 }, undefined).value).toBe('No Done tasks yet');
    // Switched off with every summary written: they stay, and still help search.
    expect(summariesLine(false, { ...SUMMARIES, written: 674, writtenWith: [{ ...sonnet, count: 674 }] }, undefined))
      .toEqual({ value: '674', tone: 'ready' });
  });

  it('writing, is the share done and the time left, rounded down', () => {
    // 148 of 674 is 21.96%.
    expect(summariesLine(true, { ...SUMMARIES, written: 148, state: 'writing', minutesLeft: 3 }, undefined))
      .toEqual({ value: '21%, 3 min left', percent: 21, progressLabel: 'Summaries written' });
  });

  it('caught up, is the count alone with a check, never who wrote them', () => {
    expect(summariesLine(true, { ...SUMMARIES, written: 674, writtenWith: [{ ...sonnet, count: 674 }] }, undefined))
      .toEqual({ value: '674', tone: 'ready' });
  });

  it('written with another model, loses its check until Rebuild rewrites them', () => {
    expect(summariesLine(true, { ...SUMMARIES, written: 674, choice: opus, writtenWith: [{ ...sonnet, count: 674 }] }, undefined))
      .toEqual({ value: '674' });
  });

  it('rewriting, counts what the current choice has written', () => {
    // 120 of 674 rewritten is 17.8%.
    const rewriting = { ...SUMMARIES, written: 674, choice: opus, awaitingRewrite: 554, minutesLeft: 3, writtenWith: [{ ...sonnet, count: 554 }, { ...opus, count: 120 }] };
    expect(summariesLine(true, rewriting, undefined))
      .toEqual({ value: '17%, 3 min left', percent: 17, progressLabel: 'Summaries rewritten' });
  });

  it('after a failed call, tints the state word and says when it is retried', () => {
    expect(summariesLine(true, { ...SUMMARIES, written: 200, state: 'retrying', retryInMs: 5 * 60_000 }, undefined))
      .toEqual({ tone: 'caution', problem: 'A call failed', value: 'retrying in 5 min' });
  });

  it('says what the agent passed over, and when nothing is Done yet', () => {
    expect(summariesLine(true, { ...SUMMARIES, finishedTasks: 673, written: 670, skipped: 3 }, undefined).value).toBe('670 of 673, 3 skipped');
    expect(summariesLine(true, { ...SUMMARIES, finishedTasks: 0 }, undefined).value).toBe('No Done tasks yet');
  });
});

describe('the source code line', () => {
  it('shows only the tag while something is missing', () => {
    expect(codeLine(CODE, 'Needs an agent')).toEqual({ requirement: 'Needs an agent' });
  });

  it('off, is the files it would read, muted, with no time', () => {
    expect(codeLine(CODE, undefined)).toEqual({ value: '1,488 files', tone: 'muted' });
    expect(codeLine({ ...CODE, files: 1 }, undefined).value).toBe('1 file');
  });

  it('runs from nothing while the branch is read, then shows the share embedded', () => {
    expect(codeLine({ ...CODE, state: 'reading', files: 0, passages: 0, minutesLeft: null }, undefined))
      .toEqual({ value: '0%', percent: 0, progressLabel: 'Source code embedded' });
    // 4,210 of 12,186 is 34.5%: rounded down, so it never reads 100% early.
    expect(codeLine({ ...CODE, state: 'indexing', embedded: 4210, minutesLeft: 150 }, undefined))
      .toEqual({ value: '34%, 2.5 hr left', percent: 34, progressLabel: 'Source code embedded' });
  });

  it('caught up, is the file count with a check', () => {
    expect(codeLine({ ...CODE, state: 'ready', embedded: 12186, minutesLeft: null }, undefined))
      .toEqual({ value: '1,488 files', tone: 'ready' });
  });

  it('says so, plainly, when nothing is committed', () => {
    expect(codeLine({ state: 'nothing-committed', branch: null, files: 0, passages: 0, embedded: 0, minutesLeft: null }, undefined))
      .toEqual({ value: 'Nothing committed yet', tone: 'muted' });
  });
});
