/**
 * What a user loses if these reports go quiet: the database layer answers these
 * failures with a default and carries on, so each one used to look like nothing
 * happened. A ledger read that degraded told nobody, an automation whose stored
 * config would not parse ran as an empty one, a workflow plan that would not
 * parse read as an empty plan that the next save writes over, a listener of the
 * dev-port ledger that threw left a forwarded port stale, and a user whose
 * database could not be read saw no dialog when the dialog itself failed.
 *
 * Each case runs the real module, makes one input fail, and reads the call that
 * reached `reportHandledError`: source `db`, its `stage`, and that nothing stored
 * or typed left with it. The failing values carry a task title for that check.
 *
 * Modules are re-imported per test (`vi.resetModules`): the reporter latches a
 * key once per run, and the dialog keeps a notify-once flag at module scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { reportedText as sharedReportedText } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const electronControl = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  quit: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { quit: electronControl.quit },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: electronControl.showMessageBox },
}));

/** A task title, in every failing value, so a report that carried the value would carry it. */
const USER_TEXT = 'Fix Acme billing';

const defect = (): Error => new TypeError(`Cannot read the title of "${USER_TEXT}"`);
const sqliteIoError = (): Error => Object.assign(new Error(`disk I/O error reading ${USER_TEXT}`), { code: 'SQLITE_IOERR' });

/** Everything the reports carried, as text, so user text cannot hide in any field. */
const reportedText = (): string => sharedReportedText(reportHandledError);

/** The one report that was sent: its tags, checked for the stage, and for user text. */
function expectOneReport(stage: string, extraTags: Record<string, string> = {}): void {
  expect(reportHandledError.mock.calls.map((call) => (call[1] as Record<string, string>).stage)).toEqual([stage]);
  expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'db', stage, ...extraTags });
  expect(reportedText()).not.toMatch(/acme/i);
}

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  electronControl.showMessageBox.mockReset();
  electronControl.quit.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a soft database access', () => {
  it('reports soft_read when an access that asks for no dialog degrades', async () => {
    const { softly } = await import('../../src/main/db/soft-db');

    const leases = softly('listForTask', [] as string[], () => { throw sqliteIoError(); }, { level: 'warn' });

    expect(leases).toEqual([]);
    expectOneReport('soft_read', { errno: 'SQLITE_IOERR' });
    // An environment failure groups by its code, whatever read met it.
    expect(reportHandledError.mock.calls[0][3]).toEqual(['handled-env', 'Error', 'SQLITE_IOERR']);
  });

  it('leaves a notifying access to the notifier, which reports it itself', async () => {
    const { softly, setGlobalDbFailureNotifier } = await import('../../src/main/db/soft-db');
    const notifier = vi.fn();
    setGlobalDbFailureNotifier(notifier);
    const failure = sqliteIoError();

    expect(softly('project:list', [] as string[], () => { throw failure; }, { notify: true })).toEqual([]);

    expect(notifier).toHaveBeenCalledWith(failure, 'project:list');
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing while the app is quitting, when every connection is closed on purpose', async () => {
    const { setShuttingDown } = await import('../../src/main/shutdown-state');
    const { softly } = await import('../../src/main/db/soft-db');
    setShuttingDown();

    expect(softly('listForTask', [] as string[], () => { throw defect(); })).toEqual([]);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the dev-port ledger\'s listeners', () => {
  it('reports dev_port_listener when a listener throws, and still tells the next one', async () => {
    const { DevPortRepository } = await import('../../src/main/db/repositories/dev-port-repository');
    const repository = new DevPortRepository();
    const next = vi.fn();
    repository.onChange(() => { throw defect(); });
    repository.onChange(next);

    repository.notifyChanged();

    expect(next).toHaveBeenCalledTimes(1);
    expectOneReport('dev_port_listener', { error_name: 'TypeError' });
  });
});

describe('stored values that will not parse', () => {
  let database: Database.Database;

  beforeEach(async () => {
    const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
  });

  afterEach(() => {
    database.close();
  });

  it('reports automation_config_parse when an automation\'s config reads as empty, with none of the config in it', async () => {
    const { AutomationRepository } = await import('../../src/main/db/repositories/automation-repository');
    const lane = database.prepare('SELECT id FROM swimlanes WHERE name = ?').get('Executing') as { id: string };
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO column_automations (id, swimlane_id, name, type, trigger, position, enabled, config_json, created_at, updated_at)
      VALUES ('automation-broken', ?, 'Tell the agent', 'send_message', 'enter', 99, 1, ?, ?, ?)
    `).run(lane.id, `{"message": "${USER_TEXT}`, now, now);

    const automation = new AutomationRepository(database).getById('automation-broken');

    expect(automation?.config).toEqual({});
    expectOneReport('automation_config_parse', { error_name: 'SyntaxError' });
  });

  it('reports draft_parse when a workflow\'s stored plan reads as an empty one, with none of the plan in it', async () => {
    const { parseDraft } = await import('../../src/main/db/repositories/workflow-repository');

    const draft = parseDraft(`{"tasks": [{"key": "api", "title": "${USER_TEXT}"`);

    expect(draft).toEqual({ tasks: [], links: [] });
    expectOneReport('draft_parse', { error_name: 'SyntaxError' });
  });

  // The read above answers an empty plan. A save built on that read used to replace the
  // text in the row, which is what a person had shaped, with the new plan.
  it('leaves a stored plan that will not parse in the row: a save is refused and the silent writes are skipped', async () => {
    const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
    const workflows = new WorkflowRepository(database);
    const workflow = workflows.create({ title: 'Billing' });
    const unreadable = `{"tasks": [{"key": "api", "title": "${USER_TEXT}"`;
    database.prepare('UPDATE workflows SET draft_json = ? WHERE id = ?').run(unreadable, workflow.id);
    const stored = (): string | null => (database.prepare('SELECT draft_json FROM workflows WHERE id = ?').get(workflow.id) as { draft_json: string | null }).draft_json;
    const replacement = { tasks: [], links: [] };

    expect(() => workflows.saveDraft(workflow.id, replacement)).toThrow(/could not be read, so nothing was saved over it/);
    workflows.writeDraftLayout(workflow.id, replacement);
    expect(workflows.writeAdoptedDraft(workflow.id, replacement)).toBe(false);

    expect(stored()).toBe(unreadable);
    expect(reportedText()).not.toMatch(/acme/i);
  });

  it('still saves over a stored plan that parses', async () => {
    const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
    const workflows = new WorkflowRepository(database);
    const workflow = workflows.create({ title: 'Billing' });

    const saved = workflows.saveDraft(workflow.id, { tasks: [], links: [] });

    expect(saved.revision).toBe(workflow.revision + 1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for a plan that parses, or for none at all', async () => {
    const { parseDraft } = await import('../../src/main/db/repositories/workflow-repository');

    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('{"tasks": [], "links": []}')).toEqual({ tasks: [], links: [] });

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the unreadable-database dialog', () => {
  it('reports dialog_show when the dialog itself cannot open', async () => {
    // The unit tier runs with NODE_ENV=test, where the dialog is suppressed.
    vi.stubEnv('NODE_ENV', 'production');
    electronControl.showMessageBox.mockImplementation(async () => { throw defect(); });
    const { notifyGlobalDbUnavailable } = await import('../../src/main/db/global-db-dialog');

    notifyGlobalDbUnavailable(sqliteIoError(), 'project:list', null);

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
    expect(electronControl.showMessageBox).toHaveBeenCalledTimes(1);
    expectOneReport('dialog_show', { error_name: 'TypeError' });
  });
});
