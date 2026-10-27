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
 *
 * The builders run while a line renders, so they translate as they build
 * (`translateText`); nothing here is translated at module load.
 */

import { msg } from '@lingui/core/runtime-macro';
import { KNOWLEDGE_GRAPH_UNAVAILABLE_TAG } from '../../../lib/knowledge-graph-support';
import { translateText } from '../../../i18n/translate';
import type { CardSourceLineProps } from '../settings-card';
import type { AnswerSetupGap, SummaryChoice, KnowledgeGraphCodeStatus, KnowledgeGraphSummaryStatus, KnowledgeGraphSourceStatus } from '../../../../shared/types';

/** A line's text and look, without its switch. */
export type SourceLineState = Pick<CardSourceLineProps, 'value' | 'tone' | 'problem' | 'percent' | 'progressLabel' | 'requirement'>;

/** The Task summaries line's info, here and in the Knowledge Graph's Index panel. Resolve it where it shows. */
export const SUMMARIES_INFO = msg`A sentence or two per Done task, written in the background from its title, description, files and commits.`;
/** The Source code line's info. Resolve it where it shows. */
export const CODE_INFO = msg`The default branch's source and docs, kept current; tests, data files and files over 256 KB are skipped.`;

const TEXT = {
  needsKnowledgeGraph: msg`Needs the Knowledge Graph`,
  needsSupportedAgent: msg`Needs a supported agent`,
  needsAgent: msg`Needs an agent`,
  needsModel: msg`Needs a model`,
  minutesLeft: msg({ message: '{minutes, plural, one {# min left} other {# min left}}' }),
  hoursLeft: msg({ message: '{hours, plural, one {# hr left} other {# hr left}}' }),
  percentAndTimeLeft: msg({ message: '{percent}%, {timeLeft}' }),
  notYetIndexed: msg`Not yet indexed`,
  tasksToWrite: msg({ message: '{toWrite, plural, one {# task} other {# tasks}}' }),
  noDoneTasks: msg`No Done tasks yet`,
  callFailed: msg`A call failed`,
  retryingIn: msg({ message: '{minutes, plural, one {retrying in # min} other {retrying in # min}}' }),
  summariesRewritten: msg`Summaries rewritten`,
  summariesWritten: msg`Summaries written`,
  writtenOfFinishedSkipped: msg({ message: '{count} of {finished}, {skipped} skipped' }),
  writtenOfFinished: msg({ message: '{count} of {finished}' }),
  files: msg({ message: '{count, plural, one {# file} other {# files}}' }),
  sourceCodeEmbedded: msg`Source code embedded`,
  nothingCommitted: msg`Nothing committed yet`,
};

export interface SourceRequirementInput {
  /** Whether the Knowledge Graph's local model can run in this build at all
   *  (`knowledgeGraphSupported`: not on Intel Macs). */
  knowledgeGraphSupported: boolean;
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
 * two never disagree about a tag. In a build the local model cannot run in, both
 * read "Unavailable", the Knowledge Graph card's own tag, rather than naming a
 * prerequisite that can never be met there.
 */
export function sourceRequirements(input: SourceRequirementInput): { summaries: string | undefined; code: string | undefined } {
  const { knowledgeGraphSupported, semanticEnabled, answerCapableAgents, agentSetup, agentChosen } = input;
  if (!knowledgeGraphSupported) return { summaries: KNOWLEDGE_GRAPH_UNAVAILABLE_TAG, code: KNOWLEDGE_GRAPH_UNAVAILABLE_TAG };
  const summaries = !semanticEnabled
    ? translateText(TEXT.needsKnowledgeGraph)
    : answerCapableAgents === 0
      ? translateText(TEXT.needsSupportedAgent)
      : agentSetup === 'agent'
        ? translateText(TEXT.needsAgent)
        : agentSetup === 'model'
          ? translateText(TEXT.needsModel)
          : undefined;
  const code = !semanticEnabled
    ? translateText(TEXT.needsKnowledgeGraph)
    : answerCapableAgents === 0
      ? translateText(TEXT.needsSupportedAgent)
      : !agentChosen
        ? translateText(TEXT.needsAgent)
        : undefined;
  return { summaries, code };
}

/** "3 min left", the way a running line says it. */
export function timeLeft(minutes: number): string {
  if (minutes < 1.5) return translateText(TEXT.minutesLeft, { minutes: 1 });
  if (minutes < 90) return translateText(TEXT.minutesLeft, { minutes: Math.round(minutes) });
  return translateText(TEXT.hoursLeft, { hours: Math.round(minutes / 30) / 2 });
}

function runningLine(percent: number, minutesLeft: number | null, progressLabel: string): SourceLineState {
  return {
    value: minutesLeft === null
      ? `${percent}%`
      : translateText(TEXT.percentAndTimeLeft, { percent, timeLeft: timeLeft(minutesLeft) }),
    percent,
    progressLabel,
  };
}

/** A source with nothing in it says so, never a checked 0. */
export function notYetIndexed(): SourceLineState {
  return { value: translateText(TEXT.notYetIndexed), tone: 'muted' };
}

/** Conversations, tasks and commits: always on, so only caught up or running. */
export function alwaysOnLine(source: KnowledgeGraphSourceStatus | undefined, progressLabel: string): SourceLineState {
  if (!source) return {};
  if (source.percent !== null) return runningLine(source.percent, source.minutesLeft, progressLabel);
  if (source.count === 0) return notYetIndexed();
  return { value: source.count.toLocaleString(), tone: 'ready' };
}

function sameChoice(first: SummaryChoice, second: SummaryChoice): boolean {
  return first.agent === second.agent && first.model === second.model && first.effort === second.effort;
}

/**
 * The task summaries (summaries) line. `requirement` is what they still wait
 * for (the Knowledge Graph, an agent, a model), which the card decides.
 *
 * A track only while a pass is writing (running, queued, or between two passes
 * of a backfill): a line that is behind with nothing writing it reads "N of M",
 * so a project no pass reaches never draws a track that does not move.
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
      value: toWrite > 0 ? translateText(TEXT.tasksToWrite, { toWrite }) : translateText(TEXT.noDoneTasks),
      tone: 'muted',
    };
  }
  // The summary pass's own state (idle, writing, retrying), not a session's ActivityState.
  const writing = summaries.state === 'writing';
  if (writing && summaries.awaitingRewrite > 0 && summaries.choice) {
    // Every summary written some other way was marked, so what is left
    // unmarked is what the current choice has written.
    const total = summaries.writtenWith.reduce((sum, entry) => sum + entry.count, 0);
    const done = Math.max(0, total - summaries.awaitingRewrite);
    // Rounded down, so it never reads 100% while one still waits.
    return runningLine(total > 0 ? Math.floor((done / total) * 100) : 0, summaries.minutesLeft, translateText(TEXT.summariesRewritten));
  }
  if (summaries.state === 'retrying') {
    const minutes = Math.max(1, Math.round((summaries.retryInMs ?? 0) / 60_000));
    return { tone: 'caution', problem: translateText(TEXT.callFailed), value: translateText(TEXT.retryingIn, { minutes }) };
  }
  if (summaries.finishedTasks === 0) return { value: translateText(TEXT.noDoneTasks) };
  if (toWrite === 0) {
    // Written with another agent or model, a rewrite waiting included: no check
    // until Rebuild's rewrites land.
    const choice = summaries.choice;
    const matches = choice === null || summaries.writtenWith.every((entry) => sameChoice(entry, choice));
    return matches ? { value: count, tone: 'ready' } : { value: count };
  }
  if (writing) {
    return runningLine(Math.floor((summaries.written / summaries.finishedTasks) * 100), summaries.minutesLeft, translateText(TEXT.summariesWritten));
  }
  // Behind, and nothing writing: what is written of what could be, and the
  // tasks the agent passed over this launch (asked again next launch).
  const finished = summaries.finishedTasks.toLocaleString();
  return {
    value: summaries.skipped > 0
      ? translateText(TEXT.writtenOfFinishedSkipped, { count, finished, skipped: summaries.skipped.toLocaleString() })
      : translateText(TEXT.writtenOfFinished, { count, finished }),
  };
}

function filesOf(count: number): string {
  return translateText(TEXT.files, { count });
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
      return runningLine(0, null, translateText(TEXT.sourceCodeEmbedded));
    case 'indexing':
      // Rounded down, so the line never reads 100% while a passage still waits.
      return runningLine(code.passages > 0 ? Math.floor((code.embedded / code.passages) * 100) : 0, code.minutesLeft, translateText(TEXT.sourceCodeEmbedded));
    case 'ready':
      return { value: filesOf(code.files), tone: 'ready' };
    case 'nothing-committed':
      return { value: translateText(TEXT.nothingCommitted), tone: 'muted' };
  }
}
