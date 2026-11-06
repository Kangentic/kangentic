/**
 * The `No changes needed:` line (src/shared/workflow-no-changes.ts): how a
 * workflow task's agent ends a task it decided needs no change. Kangentic owns
 * it, so every reader takes it from the one constant: the matcher, the nudge,
 * and the `<workflow>` block a workflow task starts with.
 */
import { describe, it, expect } from 'vitest';
import { WORKFLOW_NO_CHANGES_LINE, noChangesReason } from '../../src/shared/workflow-no-changes';
import { WORKFLOW_NEEDS_OWNER_LINE } from '../../src/shared/workflow-needs-owner';
import { buildWorkflowXml } from '../../src/main/agent/shared/prompt-xml';
import { nudgeMessage } from '../../src/main/workflows/workflow-recovery';

describe('noChangesReason', () => {
  it('reads the reason after the line, as the agent wrote it', () => {
    expect(noChangesReason('I read the handler.\n\nNo changes needed: the route already returns 404.')).toBe('the route already returns 404.');
  });

  it('forgives case, markdown and a list marker, as a Text match does', () => {
    expect(noChangesReason('- **No changes needed:** already fixed by the last release')).toBe('already fixed by the last release');
    expect(noChangesReason('no CHANGES needed - the setting exists')).toBe('the setting exists');
    expect(noChangesReason('No change needed: the setting exists')).toBe('the setting exists');
  });

  // Windows agents write CRLF replies. The Linux CI never sees one otherwise.
  it('reads a CRLF reply, with trailing blank lines, as the same line', () => {
    expect(noChangesReason('Checked.\r\n\r\nNo changes needed: already fixed\r\n')).toBe('already fixed');
  });

  it('reads a reply with a lone trailing carriage return as the same line', () => {
    expect(noChangesReason('Checked.\nNo changes needed: already fixed\r')).toBe('already fixed');
  });

  it('reads only the last line: a line quoted mid-message is not the line', () => {
    expect(noChangesReason('I will not write "No changes needed: x" here.\n\nCarrying on with the tests.')).toBeNull();
    expect(noChangesReason(null)).toBeNull();
  });

  // A review that passes can end on these words. The fixed form with its reason
  // is what takes a task to Done, so a sentence never does.
  it('reads the words with no reason as no line at all', () => {
    expect(noChangesReason('No changes needed.')).toBeNull();
    expect(noChangesReason('**No changes needed**')).toBeNull();
    expect(noChangesReason('No changes needed:')).toBeNull();
  });

  it('reads a sentence that only starts with the words as no line at all', () => {
    expect(noChangesReason('No changes needed to the schema, so I went on to the handler.')).toBeNull();
    expect(noChangesReason('There are no changes needed: the route is fine.')).toBeNull();
  });
});

describe('every reader names the same line', () => {
  it('the matcher reads the line every writer tells the agent to write', () => {
    const asTold = WORKFLOW_NO_CHANGES_LINE.replace('<why>', 'already fixed');
    expect(noChangesReason(asTold)).toBe('already fixed');
  });

  it('the <workflow> block a workflow task starts with names it, and leaves a question to the owner line', () => {
    const block = buildWorkflowXml({ title: 'Overnight run', route: ['Executing', 'Done'], column: 'Executing', planExitTo: null, waitsFor: [], blocks: [] });
    expect(block).toContain(`"${WORKFLOW_NO_CHANGES_LINE}"`);
    const line = block.split('\n').find((candidate) => candidate.includes(WORKFLOW_NO_CHANGES_LINE));
    expect(line).toContain(`"${WORKFLOW_NEEDS_OWNER_LINE}"`);
  });

  it('the block names it in a plan column too', () => {
    const block = buildWorkflowXml({ title: 'Overnight run', route: ['Planning', 'Executing', 'Done'], column: 'Planning', planExitTo: 'Executing', waitsFor: [], blocks: [] });
    expect(block).toContain(`"${WORKFLOW_NO_CHANGES_LINE}"`);
  });

  const nudgeInput = {
    columnName: 'Testing',
    reason: null,
    leftRunning: false,
    blockers: [],
    restarted: false,
    memory: { low: false, freeBytes: null },
    landedSiblings: [],
    baseBranch: 'main',
  };

  it('the unblock nudge names it', () => {
    expect(nudgeMessage(nudgeInput)).toContain(`"${WORKFLOW_NO_CHANGES_LINE}"`);
  });

  it('a nudge about a held move names it too', () => {
    expect(nudgeMessage({ ...nudgeInput, heldMove: { targetName: 'Merge' } })).toContain(`"${WORKFLOW_NO_CHANGES_LINE}"`);
  });

  it('a nudge with the longest reason a check can give still names both lines', () => {
    const longestReason = 'x'.repeat(200);
    const message = nudgeMessage({ ...nudgeInput, reason: longestReason, landedSiblings: [{ number: 1, title: 'A sibling' }] });
    expect(message.length).toBeLessThanOrEqual(960);
    expect(message).toContain(`"${WORKFLOW_NO_CHANGES_LINE}"`);
    expect(message).toContain(`"${WORKFLOW_NEEDS_OWNER_LINE}"`);
  });
});
