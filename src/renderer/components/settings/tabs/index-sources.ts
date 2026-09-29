/**
 * What each line of Settings > Knowledge Graph's Index card says, from the index's
 * status: one line per source, its state or size at the switch's edge.
 *
 * Pure, so every state a line can be in is pinned by a unit test rather than
 * read off a render. The card itself only adds the switches.
 *
 * A line's value follows one pattern whatever the source:
 * - caught up: the count, with a check;
 * - running: the share done and the time left, with a track and no verb (the
 *   line's name says what runs);
 * - off: what switching it on would cover, muted;
 * - waiting on something missing: a tag in place of the value.
 */

import type { CardSourceLineProps } from '../settings-card';
import type { DigestChoice, MemoryCodeStatus, MemoryDigestStatus, MemorySourceStatus } from '../../../../shared/types';

/** A line's text and look, without its switch. */
export type SourceLineState = Pick<CardSourceLineProps, 'value' | 'tone' | 'problem' | 'percent' | 'progressLabel' | 'requirement'>;

/** "3 min left", the way a running line says it. */
export function timeLeft(minutes: number): string {
  if (minutes < 1.5) return '1 min left';
  if (minutes < 90) return `${Math.round(minutes)} min left`;
  return `${Math.round(minutes / 30) / 2} hr left`;
}

function running(percent: number, minutesLeft: number | null, progressLabel: string): SourceLineState {
  return {
    value: minutesLeft === null ? `${percent}%` : `${percent}%, ${timeLeft(minutesLeft)}`,
    percent,
    progressLabel,
  };
}

/** Conversations, tasks and commits: always on, so only caught up or running. */
export function alwaysLine(source: MemorySourceStatus | undefined, progressLabel: string): SourceLineState {
  if (!source) return {};
  if (source.percent !== null) return running(source.percent, source.minutesLeft, progressLabel);
  return { value: source.count.toLocaleString(), tone: 'ready' };
}

function sameChoice(first: DigestChoice, second: DigestChoice): boolean {
  return first.agent === second.agent && first.model === second.model && first.effort === second.effort;
}

/**
 * The task summaries (digests) line. `requirement` is what they still wait
 * for (the Knowledge Graph, an agent, a model), which the card decides.
 */
export function summariesLine(on: boolean, digests: MemoryDigestStatus | undefined, requirement: string | undefined): SourceLineState {
  if (requirement) return { requirement };
  if (!digests) return {};
  const toWrite = Math.max(0, digests.finishedTasks - digests.written);
  const count = digests.written.toLocaleString();
  if (!on) {
    // Switching off keeps what was written, and it goes on helping search.
    if (digests.finishedTasks > 0 && toWrite === 0) return { value: count, tone: 'ready' };
    return {
      value: toWrite > 0 ? `${toWrite.toLocaleString()} ${toWrite === 1 ? 'task' : 'tasks'}` : 'No Done tasks yet',
      tone: 'muted',
    };
  }
  if (digests.awaitingRewrite > 0 && digests.choice) {
    // Every summary written some other way was marked, so what is left
    // unmarked is what the current choice has written.
    const total = digests.writtenWith.reduce((sum, entry) => sum + entry.count, 0);
    const done = Math.max(0, total - digests.awaitingRewrite);
    // Rounded down, so it never reads 100% while one still waits.
    return running(total > 0 ? Math.floor((done / total) * 100) : 0, digests.minutesLeft, 'Summaries rewritten');
  }
  if (digests.state === 'retrying') {
    const minutes = Math.max(1, Math.round((digests.retryInMs ?? 0) / 60_000));
    return { tone: 'caution', problem: 'A call failed', value: `retrying in ${minutes} min` };
  }
  if (digests.finishedTasks === 0) return { value: 'No Done tasks yet' };
  if (toWrite === 0) {
    // Written with another agent or model: no check until Rebuild rewrites them.
    const choice = digests.choice;
    const matches = choice === null || digests.writtenWith.every((entry) => sameChoice(entry, choice));
    return matches ? { value: count, tone: 'ready' } : { value: count };
  }
  // The rest are tasks the agent passed over this launch; tried again next launch.
  // activity-state-ok: the digest pass's own state (idle, writing, retrying),
  // not a session's ActivityState.
  if (digests.state === 'idle' && toWrite <= digests.skipped) {
    return { value: `${count} of ${digests.finishedTasks.toLocaleString()}, ${digests.skipped.toLocaleString()} skipped` };
  }
  return running(Math.floor((digests.written / digests.finishedTasks) * 100), digests.minutesLeft, 'Summaries written');
}

function filesOf(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
}

/** The source code line. `requirement` is what it still waits for. */
export function codeLine(code: MemoryCodeStatus | undefined, requirement: string | undefined): SourceLineState {
  if (requirement) return { requirement };
  if (!code) return {};
  switch (code.state) {
    case 'estimate':
      return { value: filesOf(code.files), tone: 'muted' };
    case 'reading':
      // Switched on and the branch not read yet: running, at nothing so far.
      return running(0, null, 'Source code embedded');
    case 'indexing':
      // Rounded down, so the line never reads 100% while a passage still waits.
      return running(code.passages > 0 ? Math.floor((code.embedded / code.passages) * 100) : 0, code.minutesLeft, 'Source code embedded');
    case 'ready':
      return { value: filesOf(code.files), tone: 'ready' };
    case 'nothing-committed':
      return { value: 'Nothing committed yet', tone: 'muted' };
  }
}
