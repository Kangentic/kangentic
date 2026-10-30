/**
 * The row grammar every automation shares (`src/shared/automation-describe.ts`):
 * line two is the verb and the type's one required value, with no timing and
 * nothing optional, and every option that is on is a mark beside the name, in
 * the editor's card order.
 *
 * The UI tier (`edit-automation-guards.spec.ts`) checks the marks render; this
 * file pins which rows earn which mark, including the cases that must earn none.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_VALUE_MAX,
  describeAutomation as describeAutomationIn,
  describeAutomationMarks as describeAutomationMarksIn,
  describeAutomationMarksInWords as describeAutomationMarksInWordsIn,
  describeAutomationSentence as describeAutomationSentenceIn,
  wholeFirstLine,
} from '../../src/shared/automation-describe';
import { englishI18n } from '../../src/shared/i18n/english';
import type { AutomationConfig, AutomationTrigger, AutomationType } from '../../src/shared/types';

// The words pinned below are the English an English session draws and the run
// log writes, so every call speaks through the English instance.
type MarksRow = Parameters<typeof describeAutomationMarksIn>[0];
const describeAutomation = (type: AutomationType, config: AutomationConfig) => describeAutomationIn(type, config, englishI18n);
const describeAutomationSentence = (type: AutomationType, config: AutomationConfig) => describeAutomationSentenceIn(type, config, englishI18n);
const describeAutomationMarks = (row: MarksRow) => describeAutomationMarksIn(row, englishI18n);
const describeAutomationMarksInWords = (row: MarksRow) => describeAutomationMarksInWordsIn(row, englishI18n);

function marksOf(
  type: AutomationType,
  trigger: AutomationTrigger,
  config: AutomationConfig,
  guards: { condition?: string | null; final_line?: string | null; max_runs?: number | null } = {},
) {
  return describeAutomationMarks({
    type,
    trigger,
    config,
    condition: guards.condition ?? null,
    final_line: guards.final_line ?? null,
    max_runs: guards.max_runs ?? null,
  });
}

describe('the row sentence', () => {
  it('is the verb and the one required value, with no timing and no full stop', () => {
    expect(describeAutomation('send_message', { message: 'Review it', mode: 'deferred' })).toBe('Sends "Review it"');
    expect(describeAutomation('send_message', { message: 'Review it', mode: 'immediate' })).toBe('Sends "Review it"');
    expect(describeAutomation('move_to_column', { targetColumn: 'Executing' })).toBe('Moves the task to Executing');
    expect(describeAutomation('move_to_column', { targetColumn: '' })).toBe('Moves the task to the next column');
    expect(describeAutomation('run_script', { script: 'npm run lint' })).toBe('Runs npm run lint');
    expect(describeAutomation('webhook', { url: 'https://hooks.example.com/abc', method: 'PUT' })).toBe('PUT to hooks.example.com');
    expect(describeAutomation('notify', { title: '{{title}}' })).toBe('Notifies "{{title}}"');
    expect(describeAutomation('spawn_agent', { promptTemplate: 'Plan it' })).toBe('Starts the agent with "Plan it"');
  });

  it("leaves Move to column's message out of the sentence: it is a mark", () => {
    expect(describeAutomation('move_to_column', { targetColumn: 'Executing', message: '{{agentReply}}' }))
      .toBe('Moves the task to Executing');
  });

  it('keeps the empty states', () => {
    expect(describeAutomation('send_message', {})).toBe('No message yet.');
    expect(describeAutomation('run_script', {})).toBe('No script yet.');
    expect(describeAutomation('webhook', {})).toBe('No URL yet.');
    expect(describeAutomation('notify', {})).toBe('Notifies you on the desktop and your phone.');
    expect(describeAutomation('spawn_agent', {})).toBe('Starts the agent.');
  });

  it('does not cut a long value short: the row ends it with CSS', () => {
    const message = 'Review the latest changes against the plan, fix anything the tests or the type checker report, then summarize what you changed';
    expect(message.length).toBeGreaterThan(120);
    expect(describeAutomation('send_message', { message })).toBe(`Sends "${message}"`);
  });

  it('bounds a value at the cap for the run log, and takes only its first line', () => {
    const longLine = 'x'.repeat(AUTOMATION_VALUE_MAX * 2);
    const bounded = wholeFirstLine(longLine);
    expect(bounded.endsWith('...')).toBe(true);
    expect(bounded.length).toBeLessThan(AUTOMATION_VALUE_MAX + 3);
    expect(bounded.length).toBeGreaterThan(AUTOMATION_VALUE_MAX - 3);
    expect(describeAutomation('run_script', { script: '  npm ci\nnpm test\r\nnpm run lint' })).toBe('Runs npm ci');
    expect(describeAutomation('send_message', { message: 'First line\r\nSecond line' })).toBe('Sends "First line"');
    expect(wholeFirstLine('  spaced    out  \nnext')).toBe('spaced out');
  });

  it('flags only a written script as code, so the empty state keeps the prose font', () => {
    expect(describeAutomationSentence('run_script', { script: 'npm ci' }).code).toBe(true);
    expect(describeAutomationSentence('run_script', {}).code).toBe(false);
    for (const type of ['send_message', 'webhook', 'notify', 'move_to_column', 'spawn_agent'] as const) {
      expect(describeAutomationSentence(type, { message: 'a', url: 'https://example.com', title: 'a', promptTemplate: 'a' }).code)
        .toBe(false);
    }
  });
});

describe('the marks beside a row name', () => {
  it('reads in the editor card order: Condition, Frequency, then the action', () => {
    const marks = marksOf('move_to_column', 'turn_end', { message: '{{agentReply}}' }, { condition: 'The review is clean', max_runs: 3 });
    expect(marks.map((mark) => mark.kind)).toEqual(['condition', 'frequency', 'message']);
    expect(marks.map((mark) => mark.label)).toEqual([
      'Condition: only if the review is clean.',
      'Frequency: at most 3 times until you move the task.',
      'Message: {{agentReply}}',
    ]);
    expect(marks[1].count).toBe(3);
  });

  it('marks a waiting Send message on enter and exit', () => {
    for (const trigger of ['enter', 'exit'] as const) {
      expect(marksOf('send_message', trigger, { message: 'Review', mode: 'deferred' })).toEqual([{
        kind: 'delivery',
        label: 'Delivery: waits for the current turn to end.',
        phrase: 'waits for the current turn to end',
      }]);
    }
  });

  it('never marks Delivery at a turn end, or for Run immediately', () => {
    expect(marksOf('send_message', 'turn_end', { message: 'Review', mode: 'deferred' })).toEqual([]);
    expect(marksOf('send_message', 'enter', { message: 'Review', mode: 'immediate' })).toEqual([]);
    expect(marksOf('send_message', 'exit', { message: 'Review' })).toEqual([]);
  });

  it("marks Move to column's message with the whole message, every line, and only when there is one", () => {
    expect(marksOf('move_to_column', 'turn_end', { message: '  Fix these\r\nand these\n\nthen the tests  ' }))
      .toEqual([{ kind: 'message', label: 'Message: Fix these\nand these\n\nthen the tests', phrase: 'with a message' }]);
    expect(marksOf('move_to_column', 'turn_end', { message: '   ' })).toEqual([]);
    expect(marksOf('move_to_column', 'turn_end', {})).toEqual([]);
  });

  it("gives the Condition mark the whole condition, line breaks kept, and its phrase on one line", () => {
    const [condition] = marksOf('notify', 'exit', { title: 'a' }, { condition: 'The review is clean\nand   CI is green.' });
    expect(condition.label).toBe('Condition: only if the review is clean\nand CI is green.');
    expect(condition.phrase).toBe('only if the review is clean and CI is green');
  });

  it('marks a Text match as its own Condition kind, first, with the pattern quoted whole', () => {
    const marks = marksOf('move_to_column', 'turn_end', { targetColumn: 'Testing' }, { final_line: 'Verdict:   Ready', max_runs: 1 });
    expect(marks.map((mark) => mark.kind)).toEqual(['text-match', 'frequency']);
    expect(marks[0]).toEqual({
      kind: 'text-match',
      label: 'Condition: only if the last line reads "Verdict: Ready".',
      phrase: 'only if the last line reads "Verdict: Ready"',
    });
  });

  it('marks one Condition kind, the Text match, when a row somehow carries both', () => {
    const marks = marksOf('notify', 'turn_end', { title: 'a' }, { condition: 'The review is clean', final_line: 'Verdict: *' });
    expect(marks.map((mark) => mark.kind)).toEqual(['text-match']);
  });

  it('marks no Text match off a turn end, where it never runs', () => {
    expect(marksOf('notify', 'enter', { title: 'a' }, { final_line: 'Verdict: Ready' })).toEqual([]);
    expect(marksOf('notify', 'exit', { title: 'a' }, { final_line: 'Verdict: Ready', condition: 'Tests pass' }).map((mark) => mark.kind))
      .toEqual(['condition']);
  });

  it("gives a webhook's body and headers and a notification's body no mark", () => {
    expect(marksOf('webhook', 'exit', { url: 'https://example.com', body: '{"a":1}', headers: { Authorization: 'x' } })).toEqual([]);
    expect(marksOf('notify', 'exit', { title: 'Done', body: 'It moved' })).toEqual([]);
    // Send message's own message is its sentence, so it earns no message mark.
    expect(marksOf('send_message', 'enter', { message: 'Review' })).toEqual([]);
  });

  it('marks nothing on a half-built row, and never throws', () => {
    for (const type of ['send_message', 'run_script', 'webhook', 'notify', 'move_to_column', 'spawn_agent'] as const) {
      for (const trigger of ['enter', 'turn_end', 'exit'] as const) {
        expect(() => marksOf(type, trigger, {})).not.toThrow();
        expect(marksOf(type, trigger, {})).toEqual([]);
      }
    }
  });
});

describe('the sentence tooltip', () => {
  it('holds a multi-line value whole, every line, where the row shows the first', () => {
    const message = 'Review the diff.\r\nThen run the tests\n\nand report back.';
    const sentence = describeAutomationSentence('send_message', { message });
    expect(sentence.text).toBe('Sends "Review the diff."');
    expect(sentence.tooltip).toBe('Sends "Review the diff.\nThen run the tests\n\nand report back."');

    const script = describeAutomationSentence('run_script', { script: '  npm ci\nnpm test  ' });
    expect(script.text).toBe('Runs npm ci');
    expect(script.tooltip).toBe('Runs npm ci\nnpm test');
    expect(describeAutomationSentence('spawn_agent', { promptTemplate: 'Plan it\nthen stop' }).tooltip)
      .toBe('Starts the agent with "Plan it\nthen stop"');
  });

  it('is the sentence itself for a one-line value and an empty one', () => {
    for (const [type, config] of [
      ['send_message', { message: 'Review it' }],
      ['send_message', {}],
      ['notify', { title: 'Done' }],
      ['move_to_column', { targetColumn: 'Testing', message: 'a\nb' }],
    ] as const) {
      const sentence = describeAutomationSentence(type, config);
      expect(sentence.tooltip).toBe(sentence.text);
    }
  });

  it("never prints a webhook's whole URL, in the row or its tooltip", () => {
    const sentence = describeAutomationSentence('webhook', { url: 'https://hooks.example.com/abc?signature=secret' });
    expect(sentence.text).toBe('POST to hooks.example.com');
    expect(sentence.tooltip).toBe(sentence.text);
  });
});

describe('the marks in words, for the MCP list', () => {
  it("leads with the action's own options, then the guards, joined on one line", () => {
    expect(describeAutomationMarksInWords({
      type: 'move_to_column',
      trigger: 'turn_end',
      config: { targetColumn: 'Executing', message: '{{agentReply}}\nand the rest' },
      condition: 'The review is clean',
      final_line: null,
      max_runs: 3,
    })).toBe('with a message; only if the review is clean; at most 3 times until you move the task');
  });

  it('words a Text match as a guard, after the action\'s own options', () => {
    expect(describeAutomationMarksInWords({
      type: 'move_to_column',
      trigger: 'turn_end',
      config: { targetColumn: 'Testing', message: 'Ship it' },
      condition: null,
      final_line: 'Verdict: Ready',
      max_runs: 1,
    })).toBe('with a message; only if the last line reads "Verdict: Ready"; at most once until you move the task');
  });

  it('says a Send message waits only where Delivery applies', () => {
    const row = { type: 'send_message' as const, config: { message: 'Review', mode: 'deferred' }, condition: null, final_line: null, max_runs: null };
    expect(describeAutomationMarksInWords({ ...row, trigger: 'enter' })).toBe('waits for the current turn to end');
    expect(describeAutomationMarksInWords({ ...row, trigger: 'turn_end' })).toBeNull();
  });

  it('is null for a row with no options on', () => {
    expect(describeAutomationMarksInWords({ type: 'run_script', trigger: 'enter', config: { script: 'npm ci' }, condition: null, final_line: null, max_runs: null }))
      .toBeNull();
  });
});
