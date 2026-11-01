/**
 * The `Needs owner:` line (src/shared/workflow-needs-owner.ts): the one way a
 * workflow task's agent stops the workflow and notifies the owner. The engine
 * owns it, so every reader takes it from the one constant: the matcher, the
 * nudge, and the `<workflow>` block a workflow task starts with.
 */
import { describe, it, expect } from 'vitest';
import { WORKFLOW_NEEDS_OWNER_LINE, needsOwnerQuestion } from '../../src/shared/workflow-needs-owner';
import { buildWorkflowXml } from '../../src/main/agent/shared/prompt-xml';
import { nudgeMessage } from '../../src/main/workflows/workflow-recovery';

describe('needsOwnerQuestion', () => {
  it('reads the question after the line, as the agent wrote it', () => {
    expect(needsOwnerQuestion('I compared both.\n\nNeeds owner: keep the old export, or drop it?')).toBe('keep the old export, or drop it?');
  });

  it('forgives case, markdown and a list marker, as a Text match does', () => {
    expect(needsOwnerQuestion('- **Needs owner:** which of the two layouts?')).toBe('which of the two layouts?');
    expect(needsOwnerQuestion('needs OWNER - ship behind a flag?')).toBe('ship behind a flag?');
  });

  it('reads the line alone as a wait with no question named', () => {
    expect(needsOwnerQuestion('Done with the analysis.\nNeeds owner:')).toBe('');
  });

  it('reads only the last line: a line quoted mid-message, or a different word, is not the line', () => {
    expect(needsOwnerQuestion('If I needed you I would write "Needs owner: x".\n\nCarrying on with the tests.')).toBeNull();
    expect(needsOwnerQuestion('Needs ownership review before merge.')).toBeNull();
    expect(needsOwnerQuestion(null)).toBeNull();
  });

  it('reads a last sentence that only starts with the words as no line at all', () => {
    expect(needsOwnerQuestion('Reviewed the diff.\nNeeds owner sign-off is not required here.')).toBeNull();
    expect(needsOwnerQuestion('Needs owner sign-off is not required here.')).toBeNull();
  });

  it('forgives a hyphen or extra spaces inside the label', () => {
    expect(needsOwnerQuestion('Needs-owner: pick A?')).toBe('pick A?');
    expect(needsOwnerQuestion('Needs  owner: pick A?')).toBe('pick A?');
  });

  it('reads the label ending the line, with only a full stop or marks after it, as a wait with no question named', () => {
    expect(needsOwnerQuestion('Needs owner.')).toBe('');
    expect(needsOwnerQuestion('**Needs owner**')).toBe('');
  });
});

describe('every reader names the same line', () => {
  it('the matcher reads the line every writer tells the agent to write', () => {
    const asTold = WORKFLOW_NEEDS_OWNER_LINE.replace('<the question>', 'pick one?');
    expect(needsOwnerQuestion(asTold)).toBe('pick one?');
  });

  it('the <workflow> block a workflow task starts with names it', () => {
    const block = buildWorkflowXml({ title: 'Overnight run', route: ['Executing', 'Done'], column: 'Executing', planExitTo: null, waitsFor: [], blocks: [] });
    expect(block).toContain(`"${WORKFLOW_NEEDS_OWNER_LINE}"`);
    expect(block).toContain('a change from the plan, something the owner must weigh in on, or a decision between options');
  });

  it('the unblock nudge names it', () => {
    const message = nudgeMessage({
      columnName: 'Testing',
      reason: null,
      leftRunning: false,
      blockers: [],
      restarted: false,
      memory: { low: false, freeBytes: null },
      landedSiblings: [],
      baseBranch: 'main',
    });
    expect(message).toContain(`"${WORKFLOW_NEEDS_OWNER_LINE}"`);
  });
});
