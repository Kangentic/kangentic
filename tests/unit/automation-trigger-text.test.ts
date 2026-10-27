/**
 * How a trigger is named (`AUTOMATION_TRIGGER_LABELS` and `AUTOMATION_TRIGGER_PHRASES`
 * in `src/shared/automation-manifest.ts`).
 *
 * The label is the trigger as a heading ("On task enter": the Automations pane's
 * groups, the Edit automation dialog's Trigger, the MCP listings). The phrase is the
 * same trigger as words that follow a column's name in the picker's "copy from
 * another column" row ("Executing, on task enter"). The picker used to write that as
 * `label.toLowerCase()`; the phrase is its own message because a translation cannot
 * be lower-cased into the middle of a sentence.
 *
 * No `describeAutomation*` function reads the phrases: the only reader is
 * `AddAutomationPicker.tsx`, a renderer component, so they are pinned here through
 * `englishText`. The two ways a reader resolves them are asserted together, because
 * the shipped catalogs are untranslated and an English session cannot tell them apart.
 *
 * Red-green: rewording a phrase, pointing a trigger at another trigger's message, or
 * dropping an entry fails a test here.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGER_PHRASES,
} from '../../src/shared/automation-manifest';
import { englishText } from '../../src/shared/i18n/english';
import { translateText } from '../../src/renderer/i18n/translate';
import type { AutomationTrigger } from '../../src/shared/types';

/** The headings the pre-change `AUTOMATION_TRIGGER_LABELS` strings gave (`git show HEAD:src/shared/automation-manifest.ts`). */
const LABELS: Record<AutomationTrigger, string> = {
  enter: 'On task enter',
  turn_end: 'On agent turn end',
  exit: 'On task exit',
};

/** What the picker wrote after a column's name before the phrases existed: each label, lower-cased. */
const PHRASES: Record<AutomationTrigger, string> = {
  enter: 'on task enter',
  turn_end: 'on agent turn end',
  exit: 'on task exit',
};

const TRIGGERS = ['enter', 'turn_end', 'exit'] as const;

describe('the trigger tables', () => {
  it('cover every trigger the app has, and only those', () => {
    expect([...AUTOMATION_TRIGGERS].sort()).toEqual([...TRIGGERS].sort());
    expect(Object.keys(AUTOMATION_TRIGGER_LABELS).sort()).toEqual([...TRIGGERS].sort());
    expect(Object.keys(AUTOMATION_TRIGGER_PHRASES).sort()).toEqual([...TRIGGERS].sort());
  });
});

describe('AUTOMATION_TRIGGER_LABELS', () => {
  it.each(TRIGGERS)('%s reads as its heading in English and in an English session', (trigger) => {
    expect(englishText(AUTOMATION_TRIGGER_LABELS[trigger])).toBe(LABELS[trigger]);
    expect(translateText(AUTOMATION_TRIGGER_LABELS[trigger])).toBe(LABELS[trigger]);
  });
});

describe('AUTOMATION_TRIGGER_PHRASES', () => {
  it.each(TRIGGERS)('%s reads as the words after a column name in English and in an English session', (trigger) => {
    expect(englishText(AUTOMATION_TRIGGER_PHRASES[trigger])).toBe(PHRASES[trigger]);
    expect(translateText(AUTOMATION_TRIGGER_PHRASES[trigger])).toBe(PHRASES[trigger]);
  });

  it.each(TRIGGERS)('%s is the lower-cased label, as the picker wrote it before', (trigger) => {
    expect(englishText(AUTOMATION_TRIGGER_PHRASES[trigger])).toBe(englishText(AUTOMATION_TRIGGER_LABELS[trigger]).toLowerCase());
  });

  it('is its own message per trigger, not the label reused', () => {
    const phraseIds = TRIGGERS.map((trigger) => AUTOMATION_TRIGGER_PHRASES[trigger].id);
    const labelIds = TRIGGERS.map((trigger) => AUTOMATION_TRIGGER_LABELS[trigger].id);
    expect(new Set(phraseIds).size).toBe(TRIGGERS.length);
    for (const id of phraseIds) expect(labelIds).not.toContain(id);
  });
});
