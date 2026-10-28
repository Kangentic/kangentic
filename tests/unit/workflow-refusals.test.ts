/**
 * What a workflow guard says (`src/shared/workflow-refusals.ts`), pinned to the
 * sentences the literal version of this module wrote before it became messages.
 *
 * Main throws `WORKFLOW_REFUSALS` (over IPC and MCP), an agent reads it, the phone
 * receives it, and the renderer matches a thrown refusal against it, so the words
 * are a contract. `WORKFLOW_REFUSAL_MESSAGES` is the same wording as descriptors
 * the renderer shows in the session language. Every shipped msgstr is empty, so an
 * English session shows the same sentence from both, and each row below checks both.
 *
 * Every expected string is the template literal of the pre-change `WORKFLOW_REFUSALS`
 * object (`git show HEAD:src/shared/workflow-refusals.ts`) with the row's arguments
 * filled in, written out by hand rather than read back from the code under test.
 *
 * Red-green: rewording any `msg` in workflow-refusals.ts, swapping the two
 * `unlinkChangesNothing` branches, or turning a plain entry from a getter into an
 * eagerly built string each fail a test here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WORKFLOW_REFUSALS, WORKFLOW_REFUSAL_MESSAGES, workflowTaskLabel } from '../../src/shared/workflow-refusals';
import { englishI18n } from '../../src/shared/i18n/english';
import { translateText } from '../../src/renderer/i18n/translate';

/** The 22 keys of the pre-change `WORKFLOW_REFUSALS` object, in its order. */
const PRE_CHANGE_KEYS = [
  'cannotWait',
  'noBlockerCandidates',
  'blockerDone',
  'selfLink',
  'alreadyWaits',
  'loop',
  'unlinkChangesNothing',
  'doneStays',
  'routeEmpty',
  'stepReached',
  'planPassed',
  'planDone',
  'planApprovalValue',
  'planApprovalPerTask',
  'notInWorkflow',
  'agentWorking',
  'locked',
  'toDoNeedsRemove',
  'pausedForAgents',
  'removeFirst',
  'notFound',
];

type RefusalKey = keyof typeof WORKFLOW_REFUSAL_MESSAGES;

interface RefusalRow {
  key: RefusalKey;
  /** The arguments a builder takes; empty for a plain entry. */
  args: string[];
  /** The sentence the pre-change literal produced for these arguments. */
  expected: string;
}

const TITLE_LABEL = workflowTaskLabel(null, 'Fix login');

const ROWS: RefusalRow[] = [
  { key: 'cannotWait', args: ['#414'], expected: '#414 has started. Only a task in To Do can wait for another.' },
  // A planned task has no number yet, so its label is its title in quotes.
  { key: 'cannotWait', args: [TITLE_LABEL], expected: '"Fix login" has started. Only a task in To Do can wait for another.' },
  { key: 'noBlockerCandidates', args: [], expected: 'No task it can wait for.' },
  { key: 'blockerDone', args: ['#414'], expected: '#414 is done. Waiting for it changes nothing.' },
  { key: 'selfLink', args: [], expected: 'A task cannot wait for itself.' },
  { key: 'alreadyWaits', args: ['#12', '#7'], expected: '#12 already waits for #7.' },
  { key: 'loop', args: [], expected: "That link closes a loop. A workflow's links cannot go in a circle." },
  { key: 'unlinkChangesNothing', args: ['#414', 'is done'], expected: '#414 is done. Removing the link changes nothing.' },
  { key: 'unlinkChangesNothing', args: ['#414', 'has started'], expected: '#414 has started. Removing the link changes nothing.' },
  { key: 'doneStays', args: ['#414'], expected: '#414 is done and stays with its workflow.' },
  { key: 'routeEmpty', args: [], expected: 'A task visits at least one column.' },
  { key: 'stepReached', args: ['#414', 'Executing'], expected: '#414 has reached Executing. Only the columns after it can change.' },
  { key: 'planPassed', args: ['#414', 'Planning'], expected: '#414 has passed Planning. Its plan approval can no longer change.' },
  { key: 'planDone', args: ['#414'], expected: '#414 is done. Its plan approval can no longer change.' },
  { key: 'planApprovalValue', args: [], expected: 'planApproval must be "automatic", "manual", or null.' },
  { key: 'planApprovalPerTask', args: [], expected: 'planApproval is set per task now. Put planApproval on each task entry.' },
  {
    key: 'notInWorkflow',
    args: ['#414'],
    expected: "#414 is not in a workflow. Its column's Plan approval decides; change that with kangentic_update_column.",
  },
  { key: 'agentWorking', args: [], expected: 'Available when the workflow agent finishes' },
  { key: 'locked', args: ['#414', 'Usage budgets'], expected: '#414 is locked while Usage budgets runs.' },
  {
    key: 'toDoNeedsRemove',
    args: ['#414', 'Usage budgets'],
    expected: '#414 is in Usage budgets. Remove it from the workflow to move it to To Do.',
  },
  {
    key: 'pausedForAgents',
    args: ['#414', 'Usage budgets'],
    expected: '#414 is in Usage budgets, which is paused. Resume it to move its tasks.',
  },
  { key: 'removeFirst', args: ['#414', 'Usage budgets'], expected: 'Remove #414 from Usage budgets first.' },
  { key: 'notFound', args: ['release-train'], expected: 'No workflow "release-train" in this project.' },
  // Values are substituted, never re-read as ICU: braces, an apostrophe and a hash in a title or a
  // column name reach the sentence exactly as typed.
  { key: 'locked', args: [TITLE_LABEL, "Q3's {beta} #2"], expected: '"Fix login" is locked while Q3\'s {beta} #2 runs.' },
  { key: 'stepReached', args: ['#9', "Review {draft}'s notes"], expected: "#9 has reached Review {draft}'s notes. Only the columns after it can change." },
  { key: 'notFound', args: ["it's {gone}"], expected: 'No workflow "it\'s {gone}" in this project.' },
];

/** What main throws: the English form. */
function englishOf(key: RefusalKey, args: string[]): string {
  const entry: unknown = WORKFLOW_REFUSALS[key];
  return typeof entry === 'function' ? (entry as (...values: string[]) => string)(...args) : (entry as string);
}

/** What the renderer shows: the descriptor, through the session's translator. */
function shownOf(key: RefusalKey, args: string[]): string {
  const entry = WORKFLOW_REFUSAL_MESSAGES[key];
  const descriptor = typeof entry === 'function' ? (entry as (...values: string[]) => Parameters<typeof translateText>[0])(...args) : entry;
  return translateText(descriptor);
}

describe('WORKFLOW_REFUSALS keys', () => {
  it('are the keys the literal object had, no more and no fewer', () => {
    expect(Object.keys(WORKFLOW_REFUSALS)).toEqual(PRE_CHANGE_KEYS);
  });

  it('are the keys of the messages they are built from', () => {
    expect(Object.keys(WORKFLOW_REFUSALS)).toEqual(Object.keys(WORKFLOW_REFUSAL_MESSAGES));
  });

  it('each have a row below, so a new refusal is pinned the day it is added', () => {
    expect([...new Set(ROWS.map((row) => row.key))].sort()).toEqual([...PRE_CHANGE_KEYS].sort());
  });
});

describe('WORKFLOW_REFUSALS in English (what main throws, an agent reads and the renderer matches)', () => {
  it.each(ROWS.map((row) => [`${row.key}(${row.args.map((arg) => JSON.stringify(arg)).join(', ')})`, row] as const))(
    '%s reads as the pre-change sentence',
    (_name, row) => {
      expect(englishOf(row.key, row.args)).toBe(row.expected);
    },
  );
});

describe('WORKFLOW_REFUSAL_MESSAGES in the session language (what the Workflows view and task detail show)', () => {
  it.each(ROWS.map((row) => [`${row.key}(${row.args.map((arg) => JSON.stringify(arg)).join(', ')})`, row] as const))(
    '%s reads as the same sentence in an English session',
    (_name, row) => {
      expect(shownOf(row.key, row.args)).toBe(row.expected);
    },
  );
});

describe('the unlinkChangesNothing branches', () => {
  it('are two messages, one per fact, not one message with the fact pasted in', () => {
    const done = WORKFLOW_REFUSAL_MESSAGES.unlinkChangesNothing('#414', 'is done');
    const started = WORKFLOW_REFUSAL_MESSAGES.unlinkChangesNothing('#414', 'has started');
    expect(done.id).not.toBe(started.id);
    expect(done.values).toEqual({ label: '#414' });
    expect(started.values).toEqual({ label: '#414' });
  });
});

describe('a plain refusal is read when it is asked for', () => {
  // The module loads before the English catalog does in a production renderer, so an
  // eagerly resolved string would be the message id. A getter reads the catalog as of the read.
  const selfLinkId = WORKFLOW_REFUSAL_MESSAGES.selfLink.id;
  const original = englishI18n.messages[selfLinkId];

  afterEach(() => {
    englishI18n.load('en', { [selfLinkId]: original });
  });

  it('follows the catalog as it is at the time of the read', () => {
    expect(original).toBeDefined();
    expect(WORKFLOW_REFUSALS.selfLink).toBe('A task cannot wait for itself.');
    englishI18n.load('en', { [selfLinkId]: 'A task cannot wait for itself (reworded).' });
    expect(WORKFLOW_REFUSALS.selfLink).toBe('A task cannot wait for itself (reworded).');
  });

  it('is enumerable like the literal object was, so spreading or iterating it sees every key', () => {
    const copied = { ...WORKFLOW_REFUSALS };
    expect(Object.keys(copied)).toEqual(PRE_CHANGE_KEYS);
    expect(copied.noBlockerCandidates).toBe('No task it can wait for.');
  });
});

describe('workflowTaskLabel', () => {
  it('names a task by its number once it exists, and by its quoted title before Start', () => {
    expect(workflowTaskLabel(414, 'Fix login')).toBe('#414');
    expect(workflowTaskLabel(null, 'Fix login')).toBe('"Fix login"');
    expect(workflowTaskLabel(undefined, 'Fix login')).toBe('"Fix login"');
    expect(workflowTaskLabel(0, 'Fix login')).toBe('"Fix login"');
  });
});
