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
import type { AnswerSetupGap, SummaryChoice, KnowledgeGraphCodeStatus, KnowledgeGraphSummaryStatus, KnowledgeGraphSourceStatus } from '../../../../shared/types';
import { SUMMARY_BATCH_SIZE } from '../../../../shared/task-summaries';

/** A line's text and look, without its switch. */
export type SourceLineState = Pick<CardSourceLineProps, 'value' | 'tone' | 'problem' | 'percent' | 'progressLabel' | 'requirement'>;

/** The Task summaries line's info, here and in the Knowledge Graph's Index panel. */
export const SUMMARIES_INFO = `A sentence or two per Done task, so questions find it. The Knowledge Graph's agent reads each Done task's title, description, changed files, commit subjects and how its sessions ended, about ${SUMMARY_BATCH_SIZE} tasks a call, in the background.`;
/** The Source code line's info. */
export const CODE_INFO = 'The project\'s code and docs, so answers can explain it. Reads the default branch as committed: source files and docs. Tests, fixtures, data files and anything over 256 KB are skipped. Kept current as the branch moves.';

export interface SourceRequirementInput {
  semanticEnabled: boolean;
  /** Installed agents that can answer from context. */
  answerCapableAgents: number;
  /** What the Knowledge Graph's agent choice still lacks (`answerSetupGap`). */
  agentSetup: AnswerSetupGap | null;
  agentChosen: boolean;
}

/**
 * What the Task summaries and Source code lines still wait for, nearest first,
 * or undefined when nothing. Summaries are written by the agent, so they need it
 * and its model; code is read only by its answers, so it waits for the agent too.
 * The Settings card and the Knowledge Graph's Index panel both read this, so the
 * two never disagree about a tag.
 */
export function sourceRequirements(input: SourceRequirementInput): { summaries: string | undefined; code: string | undefined } {
  const { semanticEnabled, answerCapableAgents, agentSetup, agentChosen } = input;
  const summaries = !semanticEnabled
    ? 'Needs the Knowledge Graph'
    : answerCapableAgents === 0
      ? 'Needs a supported agent'
      : agentSetup === 'agent'
        ? 'Needs an agent'
        : agentSetup === 'model'
          ? 'Needs a model'
          : undefined;
  const code = !semanticEnabled
    ? 'Needs the Knowledge Graph'
    : answerCapableAgents === 0
      ? 'Needs a supported agent'
      : !agentChosen
        ? 'Needs an agent'
        : undefined;
  return { summaries, code };
}

/** "3 min left", the way a running line says it. */
export function timeLeft(minutes: number): string {
  if (minutes < 1.5) return '1 min left';
  if (minutes < 90) return `${Math.round(minutes)} min left`;
  return `${Math.round(minutes / 30) / 2} hr left`;
}

function runningLine(percent: number, minutesLeft: number | null, progressLabel: string): SourceLineState {
  return {
    value: minutesLeft === null ? `${percent}%` : `${percent}%, ${timeLeft(minutesLeft)}`,
    percent,
    progressLabel,
  };
}

/** Conversations, tasks and commits: always on, so only caught up or running. */
export function alwaysOnLine(source: KnowledgeGraphSourceStatus | undefined, progressLabel: string): SourceLineState {
  if (!source) return {};
  if (source.percent !== null) return runningLine(source.percent, source.minutesLeft, progressLabel);
  return { value: source.count.toLocaleString(), tone: 'ready' };
}

function sameChoice(first: SummaryChoice, second: SummaryChoice): boolean {
  return first.agent === second.agent && first.model === second.model && first.effort === second.effort;
}

/**
 * The task summaries (summaries) line. `requirement` is what they still wait
 * for (the Knowledge Graph, an agent, a model), which the card decides.
 */
export function summariesLine(on: boolean, summaries: KnowledgeGraphSummaryStatus | undefined, requirement: string | undefined): SourceLineState {
  if (requirement) return { requirement };
  if (!summaries) return {};
  const toWrite = Math.max(0, summaries.finishedTasks - summaries.written);
  const count = summaries.written.toLocaleString();
  if (!on) {
    // Switching off keeps what was written, and it goes on helping search.
    if (summaries.finishedTasks > 0 && toWrite === 0) return { value: count, tone: 'ready' };
    return {
      value: toWrite > 0 ? `${toWrite.toLocaleString()} ${toWrite === 1 ? 'task' : 'tasks'}` : 'No Done tasks yet',
      tone: 'muted',
    };
  }
  if (summaries.awaitingRewrite > 0 && summaries.choice) {
    // Every summary written some other way was marked, so what is left
    // unmarked is what the current choice has written.
    const total = summaries.writtenWith.reduce((sum, entry) => sum + entry.count, 0);
    const done = Math.max(0, total - summaries.awaitingRewrite);
    // Rounded down, so it never reads 100% while one still waits.
    return runningLine(total > 0 ? Math.floor((done / total) * 100) : 0, summaries.minutesLeft, 'Summaries rewritten');
  }
  if (summaries.state === 'retrying') {
    const minutes = Math.max(1, Math.round((summaries.retryInMs ?? 0) / 60_000));
    return { tone: 'caution', problem: 'A call failed', value: `retrying in ${minutes} min` };
  }
  if (summaries.finishedTasks === 0) return { value: 'No Done tasks yet' };
  if (toWrite === 0) {
    // Written with another agent or model: no check until Rebuild rewrites them.
    const choice = summaries.choice;
    const matches = choice === null || summaries.writtenWith.every((entry) => sameChoice(entry, choice));
    return matches ? { value: count, tone: 'ready' } : { value: count };
  }
  // The rest are tasks the agent passed over this launch; tried again next launch.
  // activity-state-ok: the summary pass's own state (idle, writing, retrying),
  // not a session's ActivityState.
  if (summaries.state === 'idle' && toWrite <= summaries.skipped) {
    return { value: `${count} of ${summaries.finishedTasks.toLocaleString()}, ${summaries.skipped.toLocaleString()} skipped` };
  }
  return runningLine(Math.floor((summaries.written / summaries.finishedTasks) * 100), summaries.minutesLeft, 'Summaries written');
}

function filesOf(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
}

/** The source code line. `requirement` is what it still waits for. */
export function codeLine(code: KnowledgeGraphCodeStatus | undefined, requirement: string | undefined): SourceLineState {
  if (requirement) return { requirement };
  if (!code) return {};
  switch (code.state) {
    case 'estimate':
      return { value: filesOf(code.files), tone: 'muted' };
    case 'reading':
      // Switched on and the branch not read yet: running, at nothing so far.
      return runningLine(0, null, 'Source code embedded');
    case 'indexing':
      // Rounded down, so the line never reads 100% while a passage still waits.
      return runningLine(code.passages > 0 ? Math.floor((code.embedded / code.passages) * 100) : 0, code.minutesLeft, 'Source code embedded');
    case 'ready':
      return { value: filesOf(code.files), tone: 'ready' };
    case 'nothing-committed':
      return { value: 'Nothing committed yet', tone: 'muted' };
  }
}
