/**
 * The pure draft helpers behind Board setup's automations pane.
 *
 * These are the rules a rendered dialog would only exercise incidentally:
 * per-group ordering, case-insensitive naming against the database's own unique
 * index, what counts as dirty, what a Save actually sends, and the difference
 * between what EXISTS on a column and what will RUN there.
 */
import { describe, it, expect } from 'vitest';
import {
  appendRow,
  automationCounts,
  canRunRow,
  copyAutomation,
  countAutomationChanges,
  describeAutomationChanges,
  describeDraft,
  describeLastRun,
  dirtyColumnIds,
  draftsByColumn,
  findEmptyName,
  findNameConflict,
  formatHeaderLines,
  isColumnDirty,
  makeNewAutomation,
  dropIndexFor,
  moveRow,
  parseHeaderLines,
  pickerTypes,
  planAutomationSave,
  pruneColumnRows,
  remapDraftIds,
  removeRow,
  rowsFor,
  runnableAutomationCounts,
  runnableRows,
  serializeAutomation,
  setEnabled,
  setTrigger,
  spliceAtRange,
  splitTemplateSegments,
  detectTemplateVariableTrigger,
  takenNamesFor,
  toWriteInput,
  type AutomationDraft,
} from '../../src/renderer/components/dialogs/board-manager/automation-drafts';
import type { AutomationRun, ColumnAutomation, Swimlane } from '../../src/shared/types';

const AGENT_COLUMN = { auto_spawn: true, role: null } as Pick<Swimlane, 'auto_spawn' | 'role'>;
const NO_AGENT_COLUMN = { auto_spawn: false, role: null } as Pick<Swimlane, 'auto_spawn' | 'role'>;
const TODO_COLUMN = { auto_spawn: false, role: 'todo' } as Pick<Swimlane, 'auto_spawn' | 'role'>;

function draft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    id: 'a1',
    name: 'Ping',
    type: 'webhook',
    trigger: 'enter',
    enabled: true,
    config: { url: 'https://example.com' },
    ...overrides,
  };
}

function automation(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'a1',
    swimlane_id: 'lane-1',
    name: 'Ping',
    type: 'webhook',
    trigger: 'enter',
    position: 0,
    enabled: true,
    config: { url: 'https://example.com' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('grouping', () => {
  it('buckets by column and keeps enter before exit', () => {
    const byColumn = draftsByColumn([
      automation({ id: 'a1', swimlane_id: 'lane-1', trigger: 'exit', name: 'Out' }),
      automation({ id: 'a2', swimlane_id: 'lane-1', trigger: 'enter', name: 'In' }),
      automation({ id: 'a3', swimlane_id: 'lane-2', name: 'Other' }),
    ]);

    expect(byColumn['lane-1'].map((row) => row.name)).toEqual(['In', 'Out']);
    expect(byColumn['lane-2'].map((row) => row.name)).toEqual(['Other']);
  });
});

describe('creating', () => {
  it('names a new automation for its type, so the common case is typing over it', () => {
    const created = makeNewAutomation('run_script', 'exit');
    expect(created.name).toBe('New run script');
    expect(created.trigger).toBe('exit');
    expect(created.enabled).toBe(true);
    expect(created.id.startsWith('new:')).toBe(true);
  });

  it('seeds a new row with the type field defaults', () => {
    expect(makeNewAutomation('notify', 'enter').config).toMatchObject({ title: '{{title}}', body: '{{toColumn}}' });
    expect(makeNewAutomation('webhook', 'enter').config).toMatchObject({ method: 'POST' });
  });

  it('gives a copy a fresh id and a name that does not collide', () => {
    const source = draft({ id: 'a1', name: 'Ping' });
    const copied = copyAutomation(source, 'enter', ['Ping']);

    expect(copied.id).not.toBe('a1');
    expect(copied.id.startsWith('new:')).toBe(true);
    expect(copied.name).toBe('Ping (2)');
    // Independent: mutating the copy's config must not reach the original.
    copied.config.url = 'https://changed.example.com';
    expect(source.config.url).toBe('https://example.com');
  });

  it('keeps a copied name when nothing takes it', () => {
    expect(copyAutomation(draft({ name: 'Ping' }), 'exit', ['Other']).name).toBe('Ping');
  });
});

describe('ordering', () => {
  const list = [
    draft({ id: 'a1', name: 'One', trigger: 'enter' }),
    draft({ id: 'a2', name: 'Two', trigger: 'enter' }),
    draft({ id: 'a3', name: 'Three', trigger: 'exit' }),
  ];

  it('moves a row within its own group', () => {
    const moved = moveRow(list, 'a2', 'enter', 0);
    expect(rowsFor(moved, 'enter').map((row) => row.name)).toEqual(['Two', 'One']);
    expect(rowsFor(moved, 'exit').map((row) => row.name)).toEqual(['Three']);
  });

  it('moves a row across the heading, which is a trigger change and a position', () => {
    const moved = moveRow(list, 'a1', 'exit', 0);
    expect(rowsFor(moved, 'enter').map((row) => row.name)).toEqual(['Two']);
    expect(rowsFor(moved, 'exit').map((row) => row.name)).toEqual(['One', 'Three']);
  });

  it('clamps an index past the end of the group', () => {
    const moved = moveRow(list, 'a1', 'enter', 99);
    expect(rowsFor(moved, 'enter').map((row) => row.name)).toEqual(['Two', 'One']);
  });

  // The drop index is the half of a drag that a rendered test caught and no
  // type could: taking it from the group with the dragged row already removed
  // is right going UP and wrong going DOWN, so the bug hid behind half the
  // gesture. Both directions are pinned here, through `moveRow`, because the
  // index alone does not say what the user sees.
  describe('dropIndexFor', () => {
    const three = [
      draft({ id: 'a1', name: 'One', trigger: 'enter' }),
      draft({ id: 'a2', name: 'Two', trigger: 'enter' }),
      draft({ id: 'a3', name: 'Three', trigger: 'enter' }),
    ];
    const dropOn = (rows: typeof three, id: string, overId: string | null) =>
      rowsFor(moveRow(rows, id, 'enter', dropIndexFor(rows, 'enter', overId)), 'enter')
        .map((row) => row.name);

    it('puts a row dragged DOWN after the row it was dropped on', () => {
      expect(dropOn(three, 'a1', 'a2')).toEqual(['Two', 'One', 'Three']);
      expect(dropOn(three, 'a1', 'a3')).toEqual(['Two', 'Three', 'One']);
    });

    it('puts a row dragged UP in front of the row it was dropped on', () => {
      expect(dropOn(three, 'a3', 'a1')).toEqual(['Three', 'One', 'Two']);
      expect(dropOn(three, 'a2', 'a1')).toEqual(['Two', 'One', 'Three']);
    });

    it('lands a row dropped across the heading in front of its target', () => {
      const mixed = [
        draft({ id: 'b1', name: 'Enter one', trigger: 'enter' }),
        draft({ id: 'b2', name: 'Exit one', trigger: 'exit' }),
        draft({ id: 'b3', name: 'Exit two', trigger: 'exit' }),
      ];
      const moved = moveRow(mixed, 'b1', 'exit', dropIndexFor(mixed, 'exit', 'b3'));
      expect(rowsFor(moved, 'exit').map((row) => row.name)).toEqual(['Exit one', 'Enter one', 'Exit two']);
      expect(rowsFor(moved, 'enter')).toEqual([]);
    });

    it('appends when the drop was on the group rather than a row', () => {
      expect(dropIndexFor(three, 'enter', null)).toBe(3);
      // And when the target is gone, rather than throwing or landing at 0.
      expect(dropIndexFor(three, 'enter', 'no-such-row')).toBe(3);
    });
  });

  it('appends a trigger change to the end of the destination group', () => {
    const moved = setTrigger(list, 'a1', 'exit');
    expect(rowsFor(moved, 'exit').map((row) => row.name)).toEqual(['Three', 'One']);
  });

  it('leaves the list alone when the trigger does not change', () => {
    expect(setTrigger(list, 'a1', 'enter')).toBe(list);
  });
});

describe('naming', () => {
  const list = [draft({ id: 'a1', name: 'Ping' }), draft({ id: 'a2', name: 'Notify' })];

  it('finds a conflict case-insensitively and ignoring surrounding space', () => {
    expect(findNameConflict(list, '  ping  ')).toBe('Ping');
    expect(findNameConflict(list, 'PING')).toBe('Ping');
    expect(findNameConflict(list, 'Fresh')).toBeNull();
  });

  it('does not report a row against itself', () => {
    expect(findNameConflict(list, 'Ping', 'a1')).toBeNull();
  });

  it('treats a blank name as no conflict, since empty is its own error', () => {
    expect(findNameConflict(list, '   ')).toBeNull();
    expect(findEmptyName([draft({ id: 'a1', name: '  ' })])?.id).toBe('a1');
    expect(findEmptyName(list)).toBeNull();
  });

  it('lists the names a dialog must check against', () => {
    expect(takenNamesFor(list, 'a1')).toEqual(['Notify']);
  });
});

describe('what runs here', () => {
  it('separates what EXISTS from what will RUN', () => {
    const list = [
      draft({ id: 'a1', type: 'webhook', trigger: 'enter' }),
      draft({ id: 'a2', type: 'webhook', trigger: 'enter', enabled: false }),
      draft({ id: 'a3', type: 'send_message', trigger: 'enter', config: { message: 'go' } }),
      draft({ id: 'a4', type: 'webhook', trigger: 'exit' }),
    ];

    expect(automationCounts(list)).toEqual({ enter: 3, exit: 1 });
    expect(runnableAutomationCounts(list, AGENT_COLUMN)).toEqual({ enter: 2, exit: 1 });
    // With no agent the message cannot run, so the count drops rather than
    // reporting something that will not happen.
    expect(runnableAutomationCounts(list, NO_AGENT_COLUMN)).toEqual({ enter: 1, exit: 1 });
  });

  it('counts no enter rows on To Do, where an enter automation can never fire', () => {
    const list = [draft({ trigger: 'enter' }), draft({ id: 'a2', trigger: 'exit' })];
    expect(runnableAutomationCounts(list, TODO_COLUMN)).toEqual({ enter: 0, exit: 1 });
  });

  it('names the rows a count covers, for the tooltip', () => {
    const list = [
      draft({ id: 'a1', name: 'Runs', trigger: 'enter' }),
      draft({ id: 'a2', name: 'Off', trigger: 'enter', enabled: false }),
    ];
    expect(runnableRows(list, AGENT_COLUMN, 'enter').map((row) => row.name)).toEqual(['Runs']);
  });

  it('keeps a blocked row enabled, so turning the setting back on restores it', () => {
    const message = draft({ type: 'send_message', config: { message: 'go' } });
    expect(canRunRow(message, NO_AGENT_COLUMN).ok).toBe(false);
    expect(message.enabled).toBe(true);
    expect(canRunRow(message, AGENT_COLUMN).ok).toBe(true);
  });

  it('offers every stable type in the picker, disabling the ones that cannot run', () => {
    const offered = pickerTypes(NO_AGENT_COLUMN, 'enter');
    expect(offered.map((entry) => entry.type)).toEqual(['send_message', 'run_script', 'webhook', 'notify']);
    const message = offered.find((entry) => entry.type === 'send_message')!;
    expect(message.runnable.ok).toBe(false);
    expect(message.runnable.ok === false && message.runnable.reason).toBe('Start an agent here is off.');
  });
});

describe('dirty compare', () => {
  it('ignores a key the chosen type does not declare', () => {
    // A draft that was briefly a webhook keeps its url so switching back is
    // lossless. It must not read as a change.
    const before = [draft({ type: 'run_script', config: { script: 'npm ci' } })];
    const after = [draft({ type: 'run_script', config: { script: 'npm ci', url: 'https://leftover.example.com' } })];
    expect(isColumnDirty(before, after)).toBe(false);
  });

  it('ignores an empty value a field picked up and lost', () => {
    const before = [draft({ config: { url: 'https://example.com' } })];
    const after = [draft({ config: { url: 'https://example.com', body: '' } })];
    expect(isColumnDirty(before, after)).toBe(false);
  });

  it('ignores surrounding space in a name', () => {
    expect(isColumnDirty([draft({ name: 'Ping' })], [draft({ name: '  Ping  ' })])).toBe(false);
  });

  it('sees a reorder, a rename, a switch, and a trigger change', () => {
    const before = [draft({ id: 'a1', name: 'One' }), draft({ id: 'a2', name: 'Two' })];
    expect(isColumnDirty(before, [before[1], before[0]])).toBe(true);
    expect(isColumnDirty(before, [{ ...before[0], name: 'Renamed' }, before[1]])).toBe(true);
    expect(isColumnDirty(before, [{ ...before[0], enabled: false }, before[1]])).toBe(true);
    expect(isColumnDirty(before, [{ ...before[0], trigger: 'exit' }, before[1]])).toBe(true);
  });

  it('sees an add and a remove', () => {
    const before = [draft({ id: 'a1' })];
    expect(isColumnDirty(before, appendRow(before, draft({ id: 'a2', name: 'Second' })))).toBe(true);
    expect(isColumnDirty(before, removeRow(before, 'a1'))).toBe(true);
    expect(isColumnDirty(before, setEnabled(before, 'a1', false))).toBe(true);
  });

  it('treats an absent column and an empty one as the same', () => {
    expect(isColumnDirty(undefined, [])).toBe(false);
  });

  it('reports only the columns that changed', () => {
    const originals = { 'lane-1': [draft({ id: 'a1' })], 'lane-2': [draft({ id: 'a2' })] };
    const drafts = { 'lane-1': [draft({ id: 'a1', name: 'Renamed' })], 'lane-2': [draft({ id: 'a2' })] };

    expect(dirtyColumnIds(originals, drafts)).toEqual(['lane-1']);
    expect(countAutomationChanges(originals, drafts)).toBe(1);
  });

  it('describes each changed column for the discard confirmation', () => {
    const originals = { 'lane-1': [draft({ id: 'a1' })] };
    const added = { 'lane-1': [draft({ id: 'a1' }), draft({ id: 'a2', name: 'Second' })] };
    const removed = { 'lane-1': [] };
    const edited = { 'lane-1': [draft({ id: 'a1', name: 'Renamed' })] };
    const name = () => 'Executing';

    expect(describeAutomationChanges(originals, added, name)).toEqual(['Executing: added 1 automation(s)']);
    expect(describeAutomationChanges(originals, removed, name)).toEqual(['Executing: removed 1 automation(s)']);
    expect(describeAutomationChanges(originals, edited, name)).toEqual(['Executing: edited automations']);
  });
});

describe('saving', () => {
  it('sends only the columns that changed', () => {
    const originals = { 'lane-1': [draft({ id: 'a1' })], 'lane-2': [draft({ id: 'a2' })] };
    const drafts = { 'lane-1': [draft({ id: 'a1', name: 'Renamed' })], 'lane-2': [draft({ id: 'a2' })] };

    const plan = planAutomationSave(originals, drafts);
    expect(plan).toHaveLength(1);
    expect(plan[0].columnId).toBe('lane-1');
    expect(plan[0].automations[0].name).toBe('Renamed');
  });

  it('drops the renderer-local id from a new row', () => {
    const created = makeNewAutomation('webhook', 'enter');
    expect(toWriteInput(created).id).toBeUndefined();
    expect(toWriteInput(draft({ id: 'a1' })).id).toBe('a1');
  });

  it('writes only the chosen type keys, so a stray key never reaches the file', () => {
    const written = toWriteInput(draft({ type: 'run_script', config: { script: 'npm ci', url: 'https://leftover.example.com' } }));
    expect(written.config).toEqual({ script: 'npm ci' });
  });

  it('trims the name it saves', () => {
    expect(toWriteInput(draft({ name: '  Ping  ' })).name).toBe('Ping');
  });

  it('drops a column staged for deletion so its rows are never saved back', () => {
    const drafts = { 'lane-1': [draft()], 'lane-2': [draft({ id: 'a2' })] };
    expect(Object.keys(pruneColumnRows(drafts, 'lane-1'))).toEqual(['lane-2']);
  });

  it('re-points drafts when a newly created column gets its real id', () => {
    const drafts = { 'new:1': [draft()] };
    const remapped = remapDraftIds(drafts, 'new:1', 'lane-real');
    expect(Object.keys(remapped)).toEqual(['lane-real']);
    expect(remapDraftIds(drafts, 'missing', 'lane-real')).toBe(drafts);
  });
});

describe('field value helpers', () => {
  it('splices a template variable at the caret and reports where it lands', () => {
    expect(spliceAtRange('Fix  now', 4, 4, '{{title}}')).toEqual({ text: 'Fix {{title}} now', cursor: 13 });
  });

  it('replaces a selection', () => {
    expect(spliceAtRange('Fix OLD now', 4, 7, '{{title}}').text).toBe('Fix {{title}} now');
  });

  it('round-trips headers through the Name: Value format the hint promises', () => {
    const parsed = parseHeaderLines('X-Token: abc\n  Accept : application/json  \n\nnot-a-header\n');
    expect(parsed).toEqual({ 'X-Token': 'abc', Accept: 'application/json' });
    expect(formatHeaderLines(parsed)).toBe('X-Token: abc\nAccept: application/json');
  });

  it('treats a header with no value as present and empty', () => {
    expect(parseHeaderLines('X-Empty:')).toEqual({ 'X-Empty': '' });
  });
});

describe('splitTemplateSegments', () => {
  it('has nothing to paint in an empty value', () => {
    expect(splitTemplateSegments('')).toEqual([]);
  });

  it('reports a value that is only a variable as one run', () => {
    expect(splitTemplateSegments('{{title}}')).toEqual([{ text: '{{title}}', variable: 'title' }]);
  });

  it('keeps two adjacent variables apart, with no empty run between them', () => {
    // The `start > lastIndex` guard is what makes this true, and nothing else
    // in the suite reaches it: with the two variables touching there is no
    // plain text between them, so without the guard the split emits an empty
    // run and the mirror paints a stray zero-width span.
    expect(splitTemplateSegments('{{title}}{{toColumn}}')).toEqual([
      { text: '{{title}}', variable: 'title' },
      { text: '{{toColumn}}', variable: 'toColumn' },
    ]);
  });

  it('paints the text on both sides of a variable', () => {
    expect(splitTemplateSegments('Fix {{title}} now')).toEqual([
      { text: 'Fix ', variable: null },
      { text: '{{title}}', variable: 'title' },
      { text: ' now', variable: null },
    ]);
  });

  it('leaves an unclosed brace pair as plain text', () => {
    expect(splitTemplateSegments('Fix {{title')).toEqual([{ text: 'Fix {{title', variable: null }]);
  });
});

describe('the inline {{ trigger', () => {
  // Caret is expressed as an index so each case reads as "this text, caret
  // here", which is the only thing that decides the answer.
  const at = (value: string, caret: number) => detectTemplateVariableTrigger(value, caret);

  it('opens on a bare {{ with nothing typed yet', () => {
    expect(at('{{', 2)).toEqual({ query: '', rangeStart: 0, rangeEnd: 2 });
  });

  it('carries what has been typed so far as the filter', () => {
    expect(at('{{fromCol', 9)).toEqual({ query: 'fromCol', rangeStart: 0, rangeEnd: 9 });
  });

  // The case that rules out `detectDescriptionMentionTrigger`: it walks back to
  // whitespace, so inside a quoted shell argument it would hand back
  // `"{{fromCol` and never match.
  it('works mid-token, inside a quoted shell argument', () => {
    const value = 'echo "{{fromCol';
    expect(at(value, value.length)).toEqual({ query: 'fromCol', rangeStart: 6, rangeEnd: 15 });
  });

  it('does not re-open on a completed variable the caret sits after', () => {
    expect(at('{{title}}', 9)).toBeNull();
  });

  // Editing the middle of a closed variable SHOULD filter, and the range has to
  // swallow the closing braces or accepting a suggestion writes
  // `{{taskId}}tle}}`.
  it('extends through the closing braces when the caret is inside a closed variable', () => {
    expect(at('{{title}}', 4)).toEqual({ query: 'ti', rangeStart: 0, rangeEnd: 9 });
  });

  // The one path where `query` and the span being replaced disagree about
  // length, so the two helpers are composed here rather than checked apart:
  // the filter is the two characters typed, and what gets overwritten is the
  // whole closed variable around them.
  it('replaces a closed variable whole when a suggestion is accepted from inside it', () => {
    const value = '{{tocolumn}}';
    const trigger = at(value, 4);
    expect(trigger).toEqual({ query: 'to', rangeStart: 0, rangeEnd: 12 });
    const spliced = spliceAtRange(value, trigger!.rangeStart, trigger!.rangeEnd, '{{toColumn}}');
    expect(spliced).toEqual({ text: '{{toColumn}}', cursor: 12 });
  });

  it('claims the variable the caret is in, not an earlier one', () => {
    const value = '{{title}} and {{to';
    expect(at(value, value.length)).toEqual({ query: 'to', rangeStart: 14, rangeEnd: 18 });
  });

  it('stays closed once whitespace follows the braces', () => {
    expect(at('{{ title', 8)).toBeNull();
  });

  it('stays closed on a name that could never substitute', () => {
    expect(at('{{pr-url', 8)).toBeNull();
  });

  it('stays closed on a single brace', () => {
    expect(at('{title', 6)).toBeNull();
  });

  it('stays closed while a selection is active, since there is no single caret', () => {
    expect(detectTemplateVariableTrigger('{{title', 2, 7)).toBeNull();
  });
});

describe('the row sentence', () => {
  it('comes from the shared describer, so a row reads the same everywhere', () => {
    expect(describeDraft(draft({ type: 'webhook', config: { url: 'https://hooks.example.com/abc' } })))
      .toBe('POST to hooks.example.com');
    expect(describeDraft(draft({ type: 'send_message', config: { message: '/code-review', mode: 'deferred' } })))
      .toBe('Sends "/code-review" after the current turn.');
  });

  it('survives a half-built row', () => {
    for (const type of ['send_message', 'run_script', 'webhook', 'notify'] as const) {
      expect(() => describeDraft(draft({ type, config: {} }))).not.toThrow();
    }
  });
});

describe('serializeAutomation', () => {
  it('is stable across key order', () => {
    const left = draft({ config: { url: 'https://example.com', method: 'POST' } });
    const right = draft({ config: { method: 'POST', url: 'https://example.com' } });
    expect(serializeAutomation(left)).toBe(serializeAutomation(right));
  });

  it('keeps a HIDDEN field, which is the only reason hidden differs from deleted', () => {
    // `timeoutMinutes` is declared and not offered. Serialization prunes every
    // key the manifest does not declare, so had the field simply been removed,
    // opening a column in the UI and pressing Save would erase a value someone
    // hand-wrote in kangentic.json. The declaration is what carries it through.
    const serialized = serializeAutomation(
      draft({ type: 'run_script', config: { script: 'npm ci', timeoutMinutes: 45 } }),
    );
    expect(JSON.parse(serialized).config).toEqual({ script: 'npm ci', timeoutMinutes: 45 });
  });

  it('still prunes a key no field declares', () => {
    const serialized = serializeAutomation(
      draft({ type: 'run_script', config: { script: 'npm ci', workingDir: 'project' } }),
    );
    expect(JSON.parse(serialized).config).toEqual({ script: 'npm ci' });
  });
});

describe('describeLastRun', () => {
  function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
    return {
      id: 'run-1',
      automation_id: 'row-1',
      automation_name: 'Ping',
      type: 'webhook',
      task_id: 'task-1',
      swimlane_id: 'lane-1',
      trigger: 'enter',
      status: 'succeeded',
      detail: 'HTTP 204',
      attempts: 1,
      started_at: '2026-09-13T12:00:00.000Z',
      finished_at: '2026-09-13T12:00:01.000Z',
      ...overrides,
    };
  }

  // Null rather than a dash: a row that has never run has no outcome, and a
  // dash in the outcome slot reads as one.
  it('returns null for a row that has never run', () => {
    expect(describeLastRun(undefined, '2 minutes ago')).toBeNull();
  });

  it('names the outcome, when it happened, and the one-line detail', () => {
    expect(describeLastRun(run(), '2 minutes ago')).toBe('Ran 2 minutes ago. HTTP 204');
  });

  it('has a word for every status', () => {
    expect(describeLastRun(run({ status: 'failed', detail: 'HTTP 500' }), 'now')).toBe('Failed now. HTTP 500');
    expect(describeLastRun(run({ status: 'skipped', detail: 'Start an agent here is off.' }), 'now'))
      .toBe('Skipped now. Start an agent here is off.');
    expect(describeLastRun(run({ status: 'interrupted', detail: null }), 'now')).toBe('Interrupted now');
    expect(describeLastRun(run({ status: 'running', detail: null }), 'now')).toBe('Running now now');
  });

  it('drops the detail clause when there is none', () => {
    expect(describeLastRun(run({ detail: null }), '5 minutes ago')).toBe('Ran 5 minutes ago');
  });

  // The caller formats the time, so this stays clock-free and locale-free. An
  // empty string is what an unparseable timestamp yields upstream.
  it('drops the time clause when the caller could not format one', () => {
    expect(describeLastRun(run(), '')).toBe('Ran. HTTP 204');
  });
});
