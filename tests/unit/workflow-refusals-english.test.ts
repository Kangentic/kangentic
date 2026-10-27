/**
 * The workflow view's, aria and walkthrough English, pinned, so converting them to
 * Lingui descriptors must not change one character. The refusals' own English
 * pair is pinned in workflow-refusals.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { UNNAMED_BLOCKER_LABEL, waitingLabel } from '../../src/shared/workflow-waiting';
import { translateText } from '../../src/renderer/i18n/translate';
import { countsLine, progressBarTitle, progressText, stalledLine, stalledTip, tasksText } from '../../src/renderer/components/workflows/workflow-text';
import { buildWorkflowAriaLabelConfig } from '../../src/renderer/components/workflows/workflow-aria-labels';
import { WALKTHROUGH_STEPS, resolveStepLabel } from '../../src/renderer/components/onboarding/walkthrough-steps';

describe('workflow view sentences in English', () => {
  it('words the counts and lists as the view always did, with a correct one', () => {
    expect(tasksText(1)).toBe('1 task');
    expect(tasksText(9)).toBe('9 tasks');
    expect(stalledLine([{ displayId: 412, reason: 'x' }])).toBe('Stalled on #412');
    expect(stalledLine([{ displayId: 1, reason: 'x' }, { displayId: 2, reason: 'y' }, { displayId: 3, reason: 'z' }])).toBe('Stalled on 3 tasks');
    expect(stalledTip([{ displayId: 4, reason: 'Waiting.' }, { displayId: 5, reason: 'Stuck.' }])).toBe('#4: Waiting. #5: Stuck.');
    expect(countsLine({ inProgressCount: 2, queuedCount: 0, blockedCount: 3 })).toBe('2 in progress, 3 blocked');
    expect(progressBarTitle(progressText(2, 9), countsLine({ inProgressCount: 1, queuedCount: 6, blockedCount: 0 })))
      .toBe('2 of 9 done. 1 in progress, 6 queued.');
    expect(progressBarTitle(progressText(0, 3), '')).toBe('0 of 3 done.');
  });

  it('words React Flow screen-reader text, without the delete clause', () => {
    const config = buildWorkflowAriaLabelConfig();
    expect(config['node.a11yDescription.keyboardDisabled']).toBe(
      'Press enter or space to select a node. You can then use the arrow keys to move the node around. Press escape to cancel.',
    );
    const liveMessage = config['node.a11yDescription.ariaLiveMessage'];
    expect(liveMessage?.({ direction: 'left', x: 10, y: 20 })).toBe('Moved selected node left. New position, x: 10, y: 20');
    expect(config['handle.ariaLabel']).toBe('Handle');
  });

  it('words the walkthrough with the column name as a placeholder', () => {
    expect(translateText(WALKTHROUGH_STEPS[2].description)).toBe('Say what you want done in a sentence or two.');
    expect(WALKTHROUGH_STEPS[2].calloutBody([])).toBe(
      "Tasks start from this button. An agent can also create them for you through Kangentic's MCP server.",
    );
    expect(WALKTHROUGH_STEPS[3].calloutBody([])).toBe('No column starts an agent yet. Turn that on for a column in Board manager.');
    expect(resolveStepLabel(WALKTHROUGH_STEPS[3], [])).toBe('Drag it to a column that starts an agent');
  });
});

describe('waitingLabel English', () => {
  it('words each state as it always has, once resolved', () => {
    const resolved = (pending: string[], paused: boolean) => {
      const waiting = waitingLabel(pending, paused);
      return { label: translateText(waiting.label), paused: waiting.paused };
    };
    expect(resolved(['#413'], false)).toEqual({ label: 'Blocked by #413...', paused: false });
    expect(resolved([UNNAMED_BLOCKER_LABEL], false)).toEqual({ label: 'Blocked by a task...', paused: false });
    expect(resolved(['#1', '#2'], false)).toEqual({ label: 'Blocked by 2 tasks...', paused: false });
    expect(resolved([], true)).toEqual({ label: 'Paused', paused: true });
    expect(resolved([], false)).toEqual({ label: 'Queued...', paused: false });
  });
});
