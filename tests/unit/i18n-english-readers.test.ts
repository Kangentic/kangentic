/**
 * Text an agent or a thrown error reads stays English when the session is not.
 *
 * Main writes refusals, stored run reasons and the row sentence an agent lists
 * through `englishText` / `englishI18n`, while the renderer shows the same
 * descriptors through `translateText`. The renderer, the phone and MCP match a
 * thrown refusal against its exact English, so a reader that slipped onto the UI's
 * translator would work in an English session (every shipped msgstr is empty
 * today) and break only in the first translated one.
 *
 * Each test activates a pseudo language (`helpers/pseudo-locale.ts`: every message
 * translated, with a marker in front), asserts the UI's translator DOES return the
 * marked text (so the catalog was active), and asserts the English reader did not.
 *
 * Red-green: resolving any of these through the global `i18n` instead of
 * `englishI18n` (`englishText`) puts the marker in the English assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { englishI18n, englishText } from '../../src/shared/i18n/english';
import { translateText } from '../../src/renderer/i18n/translate';
import {
  AUTOMATIONS_DISABLED_REASON,
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGER_PHRASES,
  canColumnRun,
} from '../../src/shared/automation-manifest';
import { describeAutomation, describeAutomationMarksInWords } from '../../src/shared/automation-describe';
import { WORKFLOW_REFUSALS, WORKFLOW_REFUSAL_MESSAGES } from '../../src/shared/workflow-refusals';
import { workflowMoveRefusal, workflowMoveRefusalMessage, type WorkflowMoveCheck } from '../../src/shared/workflow-lock';
import { resumeBlockMessage, resumeBlockRefusal, resumeBlockReasonOfMessage } from '../../src/shared/session-resume-eligibility';
import { planApprovalLabel, planApprovalMessage } from '../../src/shared/transcript-format';
import { automationRegistry } from '../../src/main/automations/automation-registry';
import { PSEUDO_LOCALE, PSEUDO_MARKER, activatePseudoLocale, restoreEnglishLocale } from './helpers/pseudo-locale';

beforeEach(async () => {
  await activatePseudoLocale();
});

afterEach(() => {
  restoreEnglishLocale();
});

describe('the pseudo language the tests below rely on', () => {
  it('is the UI language, and marks what the UI translator returns', () => {
    expect(i18n.locale).toBe(PSEUDO_LOCALE);
    expect(translateText(AUTOMATIONS_DISABLED_REASON)).toBe(`${PSEUDO_MARKER}Automations are paused for this task.`);
  });

  it('leaves the English instance on English', () => {
    expect(englishI18n.locale).toBe('en');
    expect(englishText(AUTOMATIONS_DISABLED_REASON)).toBe('Automations are paused for this task.');
  });
});

describe('the row sentence an agent reads (describeAutomation through englishI18n)', () => {
  it('is English from the English instance and translated from the UI instance', () => {
    expect(describeAutomation('send_message', { message: 'Review it' }, i18n)).toBe(`${PSEUDO_MARKER}Sends "Review it"`);
    expect(describeAutomation('send_message', { message: 'Review it' }, englishI18n)).toBe('Sends "Review it"');
  });

  it('is English from the adapter describe the run log and the MCP list use', () => {
    // The catalog is live for the UI's instance, which the adapters must not use.
    expect(describeAutomation('send_message', { message: 'Review it' }, i18n)).toBe(`${PSEUDO_MARKER}Sends "Review it"`);
    expect(automationRegistry.getOrThrow('send_message').describe({ message: 'Review it' })).toBe('Sends "Review it"');
    expect(automationRegistry.getOrThrow('run_script').describe({ script: 'npm ci' })).toBe('Runs npm ci');
    expect(automationRegistry.getOrThrow('move_to_column').describe({ targetColumn: 'Testing' })).toBe('Moves the task to Testing');
  });

  it('words the marks of the MCP list in English too', () => {
    const row = { type: 'move_to_column' as const, trigger: 'turn_end' as const, config: { targetColumn: 'Executing', message: 'Go' }, condition: 'The review is clean', final_line: null, max_runs: 3 };
    expect(describeAutomationMarksInWords(row, i18n)).toContain(PSEUDO_MARKER);
    expect(describeAutomationMarksInWords(row, englishI18n))
      .toBe('with a message; only if the review is clean; at most 3 times until you move the task');
  });
});

describe('the run log reasons the engine stores (canColumnRun through englishText)', () => {
  it('reads English from englishText and the translation from the UI', () => {
    const verdict = canColumnRun('send_message', { autoSpawn: false, role: null }, 'enter');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(translateText(verdict.reason)).toBe(`${PSEUDO_MARKER}Start an agent here is off.`);
    expect(englishText(verdict.reason)).toBe('Start an agent here is off.');
  });
});

describe('the trigger names an MCP automation listing prints', () => {
  it('are English from englishText while the Automations pane shows the translation', () => {
    expect(translateText(AUTOMATION_TRIGGER_LABELS.turn_end)).toBe(`${PSEUDO_MARKER}On agent turn end`);
    expect(englishText(AUTOMATION_TRIGGER_LABELS.turn_end)).toBe('On agent turn end');
    expect(translateText(AUTOMATION_TRIGGER_PHRASES.turn_end)).toBe(`${PSEUDO_MARKER}on agent turn end`);
    expect(englishText(AUTOMATION_TRIGGER_PHRASES.turn_end)).toBe('on agent turn end');
  });
});

describe('WORKFLOW_REFUSALS (what main throws and the renderer matches)', () => {
  it('is English for a builder with values', () => {
    expect(translateText(WORKFLOW_REFUSAL_MESSAGES.locked('#12', 'Release'))).toBe(`${PSEUDO_MARKER}#12 is locked while Release runs.`);
    expect(WORKFLOW_REFUSALS.locked('#12', 'Release')).toBe('#12 is locked while Release runs.');
  });

  it('is English for a plain entry, which resolves when it is read', () => {
    expect(translateText(WORKFLOW_REFUSAL_MESSAGES.loop)).toBe(`${PSEUDO_MARKER}That link closes a loop. A workflow's links cannot go in a circle.`);
    expect(WORKFLOW_REFUSALS.loop).toBe("That link closes a loop. A workflow's links cannot go in a circle.");
  });

  it('is English for both unlinkChangesNothing branches', () => {
    expect(WORKFLOW_REFUSALS.unlinkChangesNothing('#12', 'is done')).toBe('#12 is done. Removing the link changes nothing.');
    expect(WORKFLOW_REFUSALS.unlinkChangesNothing('#12', 'has started')).toBe('#12 has started. Removing the link changes nothing.');
    expect(translateText(WORKFLOW_REFUSAL_MESSAGES.unlinkChangesNothing('#12', 'is done'))).toContain(PSEUDO_MARKER);
    expect(translateText(WORKFLOW_REFUSAL_MESSAGES.unlinkChangesNothing('#12', 'has started'))).toContain(PSEUDO_MARKER);
  });

  it('keeps every entry English, with the UI translating the same entry', () => {
    for (const [key, entry] of Object.entries(WORKFLOW_REFUSAL_MESSAGES)) {
      // Every builder takes strings; two of them is enough for the widest.
      const descriptor = typeof entry === 'function' ? (entry as (...values: string[]) => MessageDescriptor)('#12', 'Release') : entry;
      const english = (WORKFLOW_REFUSALS as unknown as Record<string, unknown>)[key];
      const englishSentence = typeof english === 'function' ? (english as (...values: string[]) => string)('#12', 'Release') : english;
      expect(translateText(descriptor), `${key} in the UI`).toContain(PSEUDO_MARKER);
      expect(englishSentence, `${key} in English`).not.toContain(PSEUDO_MARKER);
      expect(englishSentence, `${key} in English`).toBe(englishText(descriptor));
    }
  });
});

describe('the workflow move lock (what the move handlers and the MCP move tool throw)', () => {
  const lockedCheck: WorkflowMoveCheck = {
    displayId: 414,
    workflowTitle: 'Usage budgets',
    workflowState: 'running',
    origin: 'renderer',
    fromSwimlaneId: 'executing',
    toSwimlaneId: 'review',
    toRole: null,
    moverIsTaskAgent: false,
    humanGateTargetId: null,
  };

  it('throws English while the board shows the translation', () => {
    const message = workflowMoveRefusalMessage(lockedCheck);
    expect(message).not.toBeNull();
    expect(translateText(message ?? '')).toBe(`${PSEUDO_MARKER}#414 is locked while Usage budgets runs.`);
    expect(workflowMoveRefusal(lockedCheck)).toBe('#414 is locked while Usage budgets runs.');
  });

  it('throws English for the pausedForAgents and To Do sentences too', () => {
    const paused: WorkflowMoveCheck = { ...lockedCheck, workflowState: 'paused', origin: 'agent' };
    const toDo: WorkflowMoveCheck = { ...lockedCheck, origin: 'agent', toSwimlaneId: 'todo', toRole: 'todo' };
    // The catalog is live for the board's translator on both branches.
    expect(translateText(workflowMoveRefusalMessage(paused) ?? '')).toContain(PSEUDO_MARKER);
    expect(translateText(workflowMoveRefusalMessage(toDo) ?? '')).toContain(PSEUDO_MARKER);
    expect(workflowMoveRefusal(paused)).toBe('#414 is in Usage budgets, which is paused. Resume it to move its tasks.');
    expect(workflowMoveRefusal(toDo)).toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
  });
});

describe('the resume refusal (what main throws and the renderer reads back)', () => {
  it('throws English while the card menu shows the translation', () => {
    expect(translateText(resumeBlockRefusal('done')))
      .toBe(`${PSEUDO_MARKER}This task is complete. Move it out of Done to continue working on it.`);
    expect(resumeBlockMessage('done')).toBe('This task is complete. Move it out of Done to continue working on it.');
  });

  it('still reads the thrown English back to its reason', () => {
    for (const reason of ['todo', 'done', 'archived'] as const) {
      // The catalog is live for the card menu's translator.
      expect(translateText(resumeBlockRefusal(reason))).toContain(PSEUDO_MARKER);
      expect(resumeBlockReasonOfMessage(resumeBlockMessage(reason))).toBe(reason);
    }
  });
});

describe('the plan approval label (what a copied plan and an agent-read transcript carry)', () => {
  it('is English as markdown text while the conversation viewer shows the translation', () => {
    expect(translateText(planApprovalMessage('automatic'))).toBe(`${PSEUDO_MARKER}Approved automatically`);
    expect(planApprovalLabel('automatic')).toBe('Approved automatically');
    expect(planApprovalLabel('user')).toBe('Approved by you');
  });
});
