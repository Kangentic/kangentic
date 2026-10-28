/**
 * The dialogs, Workflows view and onboarding text read the session's language,
 * and the English they replace stays exact.
 *
 * Every other test runs with English active, where a translated route and an
 * English one return the same string. Each case here activates a fake French
 * catalog holding only the entries it names, then asserts the French. A message
 * whose id the entry missed would read English and fail, so the French half is
 * what proves the entry matched. The shared sentences main and MCP read
 * (refusals, waiting labels, automation sentences, plan approval) keep their
 * English readers in i18n-english-readers.test.ts and workflow-refusals.test.ts.
 *
 * Tier: Unit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import type { Swimlane, WorkflowRouteStep, WorkflowViewTask } from '../../src/shared/types';
import { WORKFLOW_REFUSAL_MESSAGES } from '../../src/shared/workflow-refusals';
import { boardMoveRefusal, isWorkflowLockMessage, type BoardWorkflow } from '../../src/renderer/utils/board-workflow';
import { describeAutomationChanges, makeNewAutomation } from '../../src/renderer/components/dialogs/board-manager/automation-drafts';
import { countsLine } from '../../src/renderer/components/workflows/workflow-text';
import { WALKTHROUGH_STEPS, resolveStepLabel } from '../../src/renderer/components/onboarding/walkthrough-steps';
import { stepRefusal } from '../../src/renderer/components/workflows/workflow-graph';

type Translation = [MessageDescriptor, string];

/**
 * Loads a French catalog holding only `translations` into the session's i18n
 * and activates it. `loadAndActivate` replaces the locale's messages, so each
 * case starts from exactly the entries it names.
 */
function activateFrench(translations: Translation[]): void {
  const messages: Record<string, ReturnType<typeof compileMessage>> = {};
  for (const [descriptor, translation] of translations) {
    if (!descriptor.id) throw new Error(`A descriptor with no id cannot key a translation: ${JSON.stringify(descriptor)}`);
    messages[descriptor.id] = compileMessage(translation);
  }
  i18n.loadAndActivate({ locale: 'fr', messages });
}

afterEach(() => {
  i18n.activate('en');
});

describe('the board', () => {
  const workflow: BoardWorkflow = {
    workflowId: 'workflow-1',
    homeProjectId: 'project-1',
    title: 'Ship it',
    colorSlot: 0,
    state: 'running',
    waitingFor: [],
    humanGateTargetId: null,
    hasLinks: false,
    stallReason: null,
  };
  const task = { display_id: 4, swimlane_id: 'lane-a' };

  it('shows a refused drag in the session language', () => {
    activateFrench([[WORKFLOW_REFUSAL_MESSAGES.locked('#4', 'Ship it'), '{label} est verrouillé pendant que {workflowTitle} tourne.']]);
    expect(boardMoveRefusal(workflow, task, { id: 'lane-b', role: null })).toBe('#4 est verrouillé pendant que Ship it tourne.');
  });

  it('still recognizes the English sentence main writes while another language is active', () => {
    activateFrench([[WORKFLOW_REFUSAL_MESSAGES.locked('#4', 'Ship it'), '{label} est verrouillé pendant que {workflowTitle} tourne.']]);
    // The literal is what main's refusal says; it is not computed from WORKFLOW_REFUSALS.
    expect(isWorkflowLockMessage('#4 is locked while Ship it runs.', task, workflow)).toBe(true);
    expect(isWorkflowLockMessage('Some other failure', task, workflow)).toBe(false);
  });
});

describe('Board manager automation changes', () => {
  const columnName = '';
  const addedCount = 0;
  const added = msg`${{ columnName }}: added ${plural({ addedCount }, { one: '# automation', other: '# automations' })}`;
  const originals = {};
  const drafts = { 'lane-1': [makeNewAutomation('notify', 'enter'), makeNewAutomation('run_script', 'enter')] };

  it('words an addition in English while English is active', () => {
    expect(describeAutomationChanges(originals, drafts, () => 'Executing')).toEqual(['Executing: added 2 automations']);
  });

  it('words an addition in the session language, with the column name as data', () => {
    activateFrench([[added, '{columnName} : ajout de {addedCount, plural, one {# automatisation} other {# automatisations}}']]);
    expect(describeAutomationChanges(originals, drafts, () => 'Executing')).toEqual(['Executing : ajout de 2 automatisations']);
  });
});

describe('the Workflows view sentences', () => {
  it('joins the counts with the session language list format', () => {
    const inProgressCount = 0;
    const queuedCount = 0;
    const blockedCount = 0;
    activateFrench([
      [msg`${{ inProgressCount }} in progress`, '{inProgressCount} en cours'],
      [msg`${{ queuedCount }} queued`, '{queuedCount} en attente'],
      [msg`${{ blockedCount }} blocked`, '{blockedCount} bloquées'],
    ]);
    const parts = ['2 en cours', '1 en attente', '3 bloquées'];
    const expected = new Intl.ListFormat('fr', { type: 'unit', style: 'short' }).format(parts);
    // Guard: where French and English join alike, the assertion below could not tell which locale was read.
    expect(expected).not.toBe(new Intl.ListFormat('en', { type: 'unit', style: 'short' }).format(parts));
    expect(countsLine({ inProgressCount: 2, queuedCount: 1, blockedCount: 3 })).toBe(expected);
  });

  it('refuses a locked route step in the session language, naming the column as written', () => {
    const route = (name: string, state: WorkflowRouteStep['state']): WorkflowRouteStep => ({
      swimlaneId: name.toLowerCase(), name, color: null, icon: null, state, finishedAt: null,
    });
    const working = {
      key: 'task-1', projectId: 'project-1', task: null, planned: null, title: 'Task 1', displayId: 4, place: 'working',
      swimlaneId: 'code', steps: [route('Code', 'current'), route('Test', 'ahead')],
    } as unknown as WorkflowViewTask;
    activateFrench([[WORKFLOW_REFUSAL_MESSAGES.stepReached('#4', 'Code'), '{label} a atteint {columnName}. Seules les colonnes suivantes peuvent changer.']]);
    expect(stepRefusal(working, 0)).toBe('#4 a atteint Code. Seules les colonnes suivantes peuvent changer.');
    expect(stepRefusal(working, 1)).toBeNull();
  });
});

describe('the onboarding checklist', () => {
  const planningLane = {
    id: 'lane-planning',
    name: 'Planning',
    position: 1,
    auto_spawn: true,
    is_ghost: false,
    is_archived: false,
    permission_mode: null,
    role: null,
  } as unknown as Swimlane;
  const dragStep = WALKTHROUGH_STEPS[3];

  it('names the column that starts an agent in the drag step', () => {
    expect(dragStep.key).toBe('draggedToAutoSpawnLane');
    expect(resolveStepLabel(dragStep, [planningLane])).toBe('Drag it to Planning');
  });

  it('names the column as written when another language is active, and translates the fixed label without one', () => {
    const laneName = '';
    activateFrench([
      [msg`Drag it to ${{ laneName }}`, 'Glissez-la vers {laneName}'],
      [dragStep.label as MessageDescriptor, 'Glissez-la vers une colonne qui lance un agent'],
    ]);
    expect(resolveStepLabel(dragStep, [planningLane])).toBe('Glissez-la vers Planning');
    expect(resolveStepLabel(dragStep, [])).toBe('Glissez-la vers une colonne qui lance un agent');
  });
});
