/**
 * `setColumnMessage`: the MCP `autoCommand` parameter's landing place.
 *
 * This exists because the parameter was a silent no-op. `kangentic_update_column
 * ({autoCommand: "/review"})` wrote `swimlanes.auto_command`, echoed the value
 * back, and returned success, while the engine read the column's `send_message`
 * automation instead. A confirmed write that changes nothing is the worst of the
 * silent-failure shapes, because the caller is told it worked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setColumnMessage, setColumnMessageMode, uniqueName } from '../../src/main/automations/column-message';
import type { AutomationWriteInput } from '../../src/main/db/repositories/automation-repository';
import type { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import type { ColumnAutomation } from '../../src/shared/types';

const COLUMN_ID = 'lane-review';

/**
 * An in-memory stand-in for the repository, holding one column's rows.
 *
 * A fake rather than the real repository on the node:sqlite harness because
 * what is under test is the READ-MODIFY-WRITE decision (which row is targeted,
 * what is preserved, what is dropped), not the SQL. `replaceForColumn`'s own
 * position assignment and id preservation are pinned in
 * `automation-repository.test.ts`.
 */
function makeRepo(initial: ColumnAutomation[] = []) {
  let rows = [...initial];
  const writes: AutomationWriteInput[][] = [];
  const repo = {
    listForColumn: (swimlaneId: string) => rows.filter((row) => row.swimlane_id === swimlaneId),
    replaceForColumn: (swimlaneId: string, automations: AutomationWriteInput[]) => {
      writes.push(automations);
      const nextPosition = { enter: 0, exit: 0 };
      rows = automations.map((automation) => {
        const position = nextPosition[automation.trigger];
        nextPosition[automation.trigger] += 1;
        return {
          id: automation.id ?? `minted-${position}`,
          swimlane_id: swimlaneId,
          name: automation.name,
          type: automation.type,
          trigger: automation.trigger,
          position,
          enabled: automation.enabled,
          config: automation.config,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      });
      return rows;
    },
  };
  return {
    repo: repo as unknown as AutomationRepository,
    rows: () => rows,
    writes: () => writes,
  };
}

function makeRow(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'row-1',
    swimlane_id: COLUMN_ID,
    name: 'Message',
    type: 'send_message',
    trigger: 'enter',
    position: 0,
    enabled: true,
    config: { message: '/old', mode: 'immediate' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('setColumnMessage', () => {
  let fake: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fake = makeRepo();
  });

  it('creates a message automation on a column that has none', () => {
    const result = setColumnMessage(fake.repo, COLUMN_ID, '/review --strict');
    expect(result).toEqual({ action: 'created', name: 'Message' });
    expect(fake.rows()).toHaveLength(1);
    expect(fake.rows()[0]).toMatchObject({
      name: 'Message',
      type: 'send_message',
      trigger: 'enter',
      enabled: true,
      config: { message: '/review --strict', mode: 'immediate' },
    });
  });

  it('updates the existing message row rather than adding a second one', () => {
    fake = makeRepo([makeRow()]);
    const result = setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(result).toEqual({ action: 'updated', name: 'Message' });
    expect(fake.rows()).toHaveLength(1);
    expect(fake.rows()[0].config.message).toBe('/new');
  });

  it('keeps the row id, so its run history and created_at survive the write', () => {
    fake = makeRepo([makeRow({ id: 'row-stable' })]);
    setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(fake.writes()[0][0].id).toBe('row-stable');
  });

  it('targets the FIRST message row by position, not the first in the array', () => {
    fake = makeRepo([
      makeRow({ id: 'second', name: 'Follow up', position: 1, config: { message: '/second' } }),
      makeRow({ id: 'first', name: 'Message', position: 0, config: { message: '/first' } }),
    ]);
    const result = setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(result.name).toBe('Message');
    expect(fake.rows().find((row) => row.id === 'first')?.config.message).toBe('/new');
    expect(fake.rows().find((row) => row.id === 'second')?.config.message).toBe('/second');
  });

  // Asking for a message is asking for it to be SENT. Skipping a disabled row
  // would build a second message row beside the one the user switched off, and
  // the engine would then deliver the wrong one (or neither).
  it('switches a disabled message row back on rather than adding another', () => {
    fake = makeRepo([makeRow({ enabled: false })]);
    const result = setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(result.action).toBe('updated');
    expect(fake.rows()).toHaveLength(1);
    expect(fake.rows()[0].enabled).toBe(true);
  });

  it('keeps the row\'s existing mode when the caller does not name one', () => {
    fake = makeRepo([makeRow({ config: { message: '/old', mode: 'deferred' } })]);
    setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(fake.rows()[0].config.mode).toBe('deferred');
  });

  it('applies an explicit mode', () => {
    fake = makeRepo([makeRow()]);
    setColumnMessage(fake.repo, COLUMN_ID, '/new', 'deferred');
    expect(fake.rows()[0].config.mode).toBe('deferred');
  });

  it('drops the legacy `command` key, so a row stops carrying two message fields', () => {
    fake = makeRepo([makeRow({ config: { command: '/legacy' } })]);
    setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(fake.rows()[0].config).toEqual({ message: '/new', mode: 'immediate' });
  });

  it('deletes the row on null, and on an empty string', () => {
    fake = makeRepo([makeRow(), makeRow({ id: 'script', name: 'Setup', type: 'run_script', position: 1, config: { script: 'echo hi' } })]);
    const result = setColumnMessage(fake.repo, COLUMN_ID, null);
    expect(result).toEqual({ action: 'cleared', name: 'Message' });
    expect(fake.rows()).toHaveLength(1);
    expect(fake.rows()[0].type).toBe('run_script');
  });

  it('reports unchanged when there is nothing to clear', () => {
    const result = setColumnMessage(fake.repo, COLUMN_ID, null);
    expect(result).toEqual({ action: 'unchanged', name: null });
    expect(fake.writes()).toHaveLength(0);
  });

  it('leaves every other row untouched, including exit rows and other types', () => {
    fake = makeRepo([
      makeRow(),
      makeRow({ id: 'webhook', name: 'Ping', type: 'webhook', position: 1, config: { url: 'https://example.com' } }),
      makeRow({ id: 'exit-msg', name: 'Handoff', trigger: 'exit', position: 0, config: { message: '/wrap-up' } }),
    ]);
    setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(fake.rows()).toHaveLength(3);
    expect(fake.rows().find((row) => row.id === 'webhook')?.config.url).toBe('https://example.com');
    expect(fake.rows().find((row) => row.id === 'exit-msg')?.config.message).toBe('/wrap-up');
  });

  // An EXIT message row is a different automation. Writing the column's entry
  // message must never re-point it, or "send this on the way out" would be
  // silently rewritten by an unrelated call.
  it('never targets an exit message row, even when it is the only one', () => {
    fake = makeRepo([makeRow({ id: 'exit-msg', name: 'Handoff', trigger: 'exit', config: { message: '/wrap-up' } })]);
    const result = setColumnMessage(fake.repo, COLUMN_ID, '/new');
    expect(result.action).toBe('created');
    expect(fake.rows()).toHaveLength(2);
    expect(fake.rows().find((row) => row.id === 'exit-msg')?.config.message).toBe('/wrap-up');
  });
});

describe('setColumnMessageMode', () => {
  let fake: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fake = makeRepo();
  });

  it('reports unchanged when there is no message row for the mode to apply to', () => {
    const result = setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');
    expect(result).toEqual({ action: 'unchanged', name: null });
    expect(fake.writes()).toHaveLength(0);
  });

  // Setting a delivery mode says nothing about whether the message should run.
  // `setColumnMessage` deliberately switches a disabled row back on because
  // asking for a message IS asking for it to be sent; a bare mode change carries
  // no such request, so a disabled row must stay disabled.
  it('changes the mode without switching a disabled row on', () => {
    fake = makeRepo([makeRow({ enabled: false, config: { message: '/msg', mode: 'immediate' } })]);
    const result = setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');

    expect(result.action).toBe('updated');
    expect(fake.rows()[0].enabled).toBe(false);
    expect(fake.rows()[0].config.mode).toBe('deferred');
  });

  it('leaves an enabled row enabled while changing its mode', () => {
    fake = makeRepo([makeRow({ enabled: true, config: { message: '/msg', mode: 'immediate' } })]);
    setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');
    expect(fake.rows()[0].enabled).toBe(true);
  });

  it('reports unchanged, and writes nothing, when the row already has that mode', () => {
    fake = makeRepo([makeRow({ config: { message: '/msg', mode: 'deferred' } })]);
    const result = setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');
    expect(result).toEqual({ action: 'unchanged', name: 'Message' });
    expect(fake.writes()).toHaveLength(0);
  });

  // The same row `setColumnMessage` targets: the first `send_message` enter row
  // BY POSITION, including a disabled one. `resolveColumnMessage` filters on
  // `enabled`, so if this read the text back through that resolver instead, a
  // disabled first row would be skipped and the SECOND (enabled) row would take
  // the mode change instead, silently rewriting a different automation.
  it('targets the first message row by position, not the one resolveColumnMessage would pick', () => {
    fake = makeRepo([
      makeRow({ id: 'first', name: 'First message', position: 0, enabled: false, config: { message: '/first', mode: 'immediate' } }),
      makeRow({ id: 'second', name: 'Second message', position: 1, enabled: true, config: { message: '/second', mode: 'immediate' } }),
    ]);

    const result = setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');

    expect(result.name).toBe('First message');
    expect(fake.rows().find((row) => row.id === 'first')?.config.mode).toBe('deferred');
    expect(fake.rows().find((row) => row.id === 'second')?.config.mode).toBe('immediate');
  });

  it('never targets an exit message row, even when it is the only one', () => {
    fake = makeRepo([makeRow({ id: 'exit-msg', name: 'Handoff', trigger: 'exit', config: { message: '/wrap-up', mode: 'immediate' } })]);
    const result = setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');
    expect(result).toEqual({ action: 'unchanged', name: null });
  });

  it('leaves the message text untouched', () => {
    fake = makeRepo([makeRow({ config: { message: '/keep-me', mode: 'immediate' } })]);
    setColumnMessageMode(fake.repo, COLUMN_ID, 'deferred');
    expect(fake.rows()[0].config.message).toBe('/keep-me');
  });
});

describe('uniqueName', () => {
  it('returns the base when it is free', () => {
    expect(uniqueName('Message', ['Setup', 'Ping'])).toBe('Message');
  });

  it('suffixes past a collision', () => {
    expect(uniqueName('Message', ['Message'])).toBe('Message 2');
    expect(uniqueName('Message', ['Message', 'Message 2'])).toBe('Message 3');
  });

  // The unique index is COLLATE NOCASE, so a case-only difference collides at
  // the database. Folding case here is what stops the insert throwing.
  it('folds case, matching the unique index', () => {
    expect(uniqueName('Message', ['message'])).toBe('Message 2');
  });

  it('ignores surrounding whitespace, matching the dialog\'s own check', () => {
    expect(uniqueName('Message', ['  Message  '])).toBe('Message 2');
  });
});
