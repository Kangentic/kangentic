/**
 * `TaskRepository` artifacts on a real SQLite database (#1056). A user loses:
 * the design links in a task's description never reaching its Artifacts list,
 * a link they removed coming back on the next edit, an agent's publish making
 * a card jump to the top of "recently updated", or an upgrade that breaks on
 * an existing board.
 *
 * Red-green: make `applyArtifactChanges` write `updated_at`, or make
 * `updateWithinTransaction` skip the dismissed list, and the matching test fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { artifactKey } from '../../src/shared/artifact-platforms';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';

const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const GOOGLE_DOC = 'https://docs.google.com/document/d/1xR4abc/edit';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';

describe('TaskRepository artifacts', () => {
  let database: ReturnType<typeof openTestDatabase>;
  let tasks: TaskRepository;
  let laneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    laneId = new SwimlaneRepository(database).list().filter((lane) => lane.role === null)[0].id;
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  function urlsOf(taskId: string): string[] {
    return (tasks.getById(taskId)?.artifacts ?? []).map((artifact) => artifact.url);
  }

  /** Pin a task's creation time, and its id when given, so the order other tasks name a link in is set by the test. */
  function stamp(taskId: string, createdAt: string, newId?: string): void {
    // Nothing references these fresh tasks, but the key check is on while the id moves.
    database.pragma('foreign_keys = OFF');
    database.prepare('UPDATE tasks SET created_at = ?, id = ? WHERE id = ?').run(createdAt, newId ?? taskId, taskId);
    database.pragma('foreign_keys = ON');
  }

  it('starts a task with no artifacts', () => {
    const task = tasks.create({ title: 'Plain', description: 'nothing linked', swimlane_id: laneId });
    expect(task.artifacts).toEqual([]);
    expect(tasks.getById(task.id)?.artifacts).toEqual([]);
  });

  it('creates a task whose description links a design and a document as detected artifacts', () => {
    const task = tasks.create({ title: 'Linked', description: `Build ${FIGMA} per ${GOOGLE_DOC}.`, swimlane_id: laneId });
    expect(task.artifacts.map((artifact) => [artifact.url, artifact.source])).toEqual([
      [FIGMA, 'detected'],
      [GOOGLE_DOC, 'detected'],
    ]);
    expect(tasks.getById(task.id)?.artifacts).toEqual(task.artifacts);
  });

  it('creates a task without a link its dismissedArtifacts already names, and remembers the key', () => {
    const description = `Build ${FIGMA} please`;
    const withoutDismissal = tasks.create({ title: 'Plain', description, swimlane_id: laneId });
    expect(withoutDismissal.artifacts.map((artifact) => artifact.url)).toEqual([FIGMA]);

    const key = artifactKey(FIGMA);
    const task = tasks.create({ title: 'Moved', description, swimlane_id: laneId, dismissedArtifacts: [key] });
    expect(task.artifacts).toEqual([]);
    expect(tasks.getById(task.id)?.artifacts).toEqual([]);
    expect(tasks.getDismissedArtifacts(task.id)).toEqual([key]);
  });

  it('does not detect a tracker link in a description', () => {
    const task = tasks.create({ title: 'Issue', description: 'See https://github.com/owner/repo/issues/3', swimlane_id: laneId });
    expect(task.artifacts).toEqual([]);
  });

  it('creates with given artifacts under the given source', () => {
    const task = tasks.create({
      title: 'Given',
      description: '',
      swimlane_id: laneId,
      artifacts: [{ url: MIRO, name: 'Flow' }],
      artifactSource: 'agent',
    });
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0]).toMatchObject({ url: MIRO, name: 'Flow', source: 'agent' });
  });

  it('defaults the source of given artifacts to user', () => {
    const task = tasks.create({ title: 'Given', description: '', swimlane_id: laneId, artifacts: [{ url: MIRO }] });
    expect(task.artifacts[0].source).toBe('user');
  });

  it('returns the same artifacts from getById and list', () => {
    const task = tasks.create({ title: 'Linked', description: FIGMA, swimlane_id: laneId });
    const listed = tasks.list().find((candidate) => candidate.id === task.id);
    expect(listed?.artifacts).toEqual(tasks.getById(task.id)?.artifacts);
    expect(listed?.artifacts).toHaveLength(1);
  });

  it('never exposes the dismissed list on the task', () => {
    const task = tasks.create({ title: 'Linked', description: FIGMA, swimlane_id: laneId });
    expect(Object.keys(tasks.getById(task.id) ?? {})).not.toContain('dismissed_artifacts');
  });

  describe('update', () => {
    it('adds a link a description gains', () => {
      const task = tasks.create({ title: 'T', description: 'none yet', swimlane_id: laneId });
      const updated = tasks.update({ id: task.id, description: `now ${FIGMA}` });
      expect(updated.artifacts.map((artifact) => artifact.url)).toEqual([FIGMA]);
      expect(urlsOf(task.id)).toEqual([FIGMA]);
    });

    it('keeps a task a user edited without a description change as it was', () => {
      const task = tasks.create({ title: 'T', description: FIGMA, swimlane_id: laneId });
      const updated = tasks.update({ id: task.id, title: 'Renamed' });
      expect(updated.artifacts).toEqual(task.artifacts);
    });

    it('does not bring back a removed link that the description still carries', () => {
      const task = tasks.create({ title: 'T', description: FIGMA, swimlane_id: laneId });
      tasks.update({ id: task.id, artifactChanges: { remove: [FIGMA] } });
      expect(urlsOf(task.id)).toEqual([]);

      tasks.update({ id: task.id, description: `${FIGMA} and more words` });
      expect(urlsOf(task.id)).toEqual([]);
      expect(tasks.getDismissedArtifacts(task.id)).toHaveLength(1);
    });

    it('lets a person put a removed link back', () => {
      const task = tasks.create({ title: 'T', description: FIGMA, swimlane_id: laneId });
      tasks.update({ id: task.id, artifactChanges: { remove: [FIGMA] } });
      tasks.update({ id: task.id, artifactChanges: { add: [{ url: FIGMA }], source: 'user' } });
      expect(urlsOf(task.id)).toEqual([FIGMA]);
      expect(tasks.getDismissedArtifacts(task.id)).toEqual([]);
    });

    it('applies the caller artifact change in the same write as the description detection', () => {
      const task = tasks.create({ title: 'T', description: '', swimlane_id: laneId });
      const updated = tasks.update({ id: task.id, description: GOOGLE_DOC, artifactChanges: { add: [{ url: MIRO }] } });
      expect(updated.artifacts.map((artifact) => artifact.url)).toEqual([MIRO, GOOGLE_DOC]);
    });
  });

  describe('updated_at', () => {
    it('is left alone by applyArtifactChanges and bumped by update with artifactChanges', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      const task = tasks.create({ title: 'T', description: '', swimlane_id: laneId });
      const createdUpdatedAt = tasks.getById(task.id)?.updated_at;

      vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'));
      const result = tasks.applyArtifactChanges(task.id, { add: [{ url: MIRO }], source: 'agent' });
      expect(result?.changed).toBe(true);
      expect(result?.added).toHaveLength(1);
      expect(tasks.getById(task.id)?.updated_at).toBe(createdUpdatedAt);
      expect(urlsOf(task.id)).toEqual([MIRO]);

      vi.setSystemTime(new Date('2026-03-03T00:00:00.000Z'));
      tasks.update({ id: task.id, artifactChanges: { add: [{ url: FIGMA }] } });
      expect(tasks.getById(task.id)?.updated_at).toBe('2026-03-03T00:00:00.000Z');
    });

    it('applyArtifactChanges returns null for a task that does not exist', () => {
      expect(tasks.applyArtifactChanges('missing-task', { add: [{ url: MIRO }] })).toBeNull();
    });
  });

  describe('a nameless link borrows the name the project gives it', () => {
    const CANVAS = 'https://claude.ai/artifact/G1CN5cN1G4eS6JF6EbHqv7';

    function namesOf(taskId: string): Array<string | null> {
      return (tasks.getById(taskId)?.artifacts ?? []).map((artifact) => artifact.name);
    }

    it('names a detected link the way another task already names it, marked borrowed', () => {
      tasks.create({ title: 'Design', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Jira import design' }] });
      const later = tasks.create({ title: 'Build', description: '', swimlane_id: laneId });
      tasks.applyArtifactChanges(later.id, { add: [{ url: `${CANVAS}#page-1` }], source: 'detected' });
      expect(tasks.getById(later.id)?.artifacts).toEqual([
        expect.objectContaining({ url: `${CANVAS}#page-1`, name: 'Jira import design', name_from: 'borrowed', source: 'detected' }),
      ]);
    });

    it('borrows for a link found in a new task description', () => {
      tasks.create({ title: 'Design', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Jira import design' }] });
      const task = tasks.create({ title: 'Build', description: `Per ${CANVAS} please`, swimlane_id: laneId });
      expect(namesOf(task.id)).toEqual(['Jira import design']);
    });

    it('finds a name stored under a link written with a different host case or an unencoded path', () => {
      tasks.create({ title: 'Short', description: '', swimlane_id: laneId, artifacts: [{ url: 'https://Example.ORG/a', name: 'Short page' }] });
      tasks.create({ title: 'Accented', description: '', swimlane_id: laneId, artifacts: [{ url: 'https://example.org/plans/café-layout', name: 'Cafe layout' }] });
      const later = tasks.create({ title: 'Later', description: '', swimlane_id: laneId });
      tasks.applyArtifactChanges(later.id, { add: [{ url: 'https://example.org/a' }, { url: 'https://example.org/plans/caf%C3%A9-layout' }], source: 'detected' });
      expect(namesOf(later.id)).toEqual(['Short page', 'Cafe layout']);
    });

    it('keeps a name the add brings, and borrows nothing from the task itself', () => {
      tasks.create({ title: 'Design', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Jira import design' }] });
      const named = tasks.create({ title: 'Named', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Own name' }] });
      expect(namesOf(named.id)).toEqual(['Own name']);

      const lone = tasks.create({ title: 'Lone', description: '', swimlane_id: laneId, artifacts: [{ url: MIRO }] });
      tasks.applyArtifactChanges(lone.id, { add: [{ url: MIRO }], source: 'detected' });
      expect(namesOf(lone.id)).toEqual([null]);
    });

    // Red: name every nameless row the write touches, not only the ones it added,
    // and the held link takes the other task's name on this re-add.
    it('leaves a link the task already holds nameless when another task names it and detection adds it again', () => {
      const holder = tasks.create({ title: 'Holder', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS }] });
      tasks.create({ title: 'Namer', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Jira import design' }] });
      expect(namesOf(holder.id)).toEqual([null]);

      const result = tasks.applyArtifactChanges(holder.id, { add: [{ url: CANVAS }], source: 'detected' });
      expect(result?.changed).toBe(false);
      expect(namesOf(holder.id)).toEqual([null]);
      expect(tasks.getById(holder.id)?.artifacts[0].name_from).toBeUndefined();
    });

    // Red: drop the oldest-first sort and the pick follows row order, so the task
    // created first (but stamped later) names the link.
    it('takes the name from the older task whatever order the tasks were written in', () => {
      const newer = tasks.create({ title: 'Written first', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'From the newer task' }] });
      const older = tasks.create({ title: 'Written second', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'From the older task' }] });
      stamp(newer.id, '2026-02-01T00:00:00.000Z');
      stamp(older.id, '2026-01-01T00:00:00.000Z');
      const later = tasks.create({ title: 'Later', description: '', swimlane_id: laneId });
      tasks.applyArtifactChanges(later.id, { add: [{ url: CANVAS }], source: 'detected' });
      expect(namesOf(later.id)).toEqual(['From the older task']);
    });

    // Red: drop the id tie-break and the pick follows row order, which here is the opposite of id order.
    it('takes the name from the task with the smaller id when two were created at the same time', () => {
      const writtenFirst = tasks.create({ title: 'Written first', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'From the larger id' }] });
      const writtenSecond = tasks.create({ title: 'Written second', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'From the smaller id' }] });
      stamp(writtenFirst.id, '2026-01-01T00:00:00.000Z', 'zzz-task');
      stamp(writtenSecond.id, '2026-01-01T00:00:00.000Z', 'aaa-task');
      // The premise: the scan returns the larger id first, so only the tie-break can pick the smaller.
      const scanned = database.prepare("SELECT id FROM tasks WHERE artifacts <> '[]' AND instr(lower(artifacts), ?) > 0").all('g1cn5cn1g4es6jf6ebhqv7') as Array<{ id: string }>;
      expect(scanned.map((row) => row.id)).toEqual(['zzz-task', 'aaa-task']);
      const later = tasks.create({ title: 'Later', description: '', swimlane_id: laneId });
      tasks.applyArtifactChanges(later.id, { add: [{ url: CANVAS }], source: 'detected' });
      expect(namesOf(later.id)).toEqual(['From the smaller id']);
    });

    // Red: drop `id <> ?` from the lookup and the re-added row borrows "Old" from
    // this task's own stored row, which the write has not replaced yet.
    it('borrows nothing from the task\'s own stored row when it removes and re-adds a link in one call', () => {
      const task = tasks.create({ title: 'Own', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Old' }] });
      const result = tasks.applyArtifactChanges(task.id, { remove: [CANVAS], add: [{ url: CANVAS }], source: 'agent' });
      expect(result?.added).toHaveLength(1);
      expect(namesOf(task.id)).toEqual([null]);
      expect(tasks.getById(task.id)?.artifacts[0].name_from).toBeUndefined();
    });

    // Red: borrow before the merge and the full list drops the add, so nothing is named.
    it('names a link added at the cap by a call that also removes one', () => {
      tasks.create({ title: 'Design', description: '', swimlane_id: laneId, artifacts: [{ url: CANVAS, name: 'Jira import design' }] });
      const held = Array.from({ length: 50 }, (_, position) => ({ url: `https://example.org/cap-link-${position}` }));
      const full = tasks.create({ title: 'Full', description: '', swimlane_id: laneId, artifacts: held });
      expect(tasks.getById(full.id)?.artifacts).toHaveLength(50);

      tasks.applyArtifactChanges(full.id, { remove: [held[0].url], add: [{ url: CANVAS }], source: 'agent' });
      const stored = tasks.getById(full.id)?.artifacts ?? [];
      expect(stored).toHaveLength(50);
      expect(stored[49]).toMatchObject({ url: CANVAS, name: 'Jira import design', name_from: 'borrowed' });
    });

    // Red: let the decodeURI throw out of the lookup and the add throws instead of storing the link.
    it('adds a link whose path has a malformed percent escape, and still borrows its name', () => {
      const malformed = 'https://example.org/plans/bad%E0%A4-layout';
      const named = tasks.create({ title: 'Named', description: '', swimlane_id: laneId, artifacts: [{ url: malformed, name: 'Bad layout' }] });
      expect(namesOf(named.id)).toEqual(['Bad layout']);

      const later = tasks.create({ title: 'Later', description: '', swimlane_id: laneId });
      expect(() => tasks.applyArtifactChanges(later.id, { add: [{ url: malformed }], source: 'detected' })).not.toThrow();
      expect(urlsOf(later.id)).toEqual([malformed]);
      expect(namesOf(later.id)).toEqual(['Bad layout']);
    });
  });

  describe('migration', () => {
    const CANVAS = 'https://claude.ai/artifact/WpdicMm97cV1F6AUGU3RFA';
    const NOW = '2026-01-02T03:04:05.000Z';

    function storeRaw(taskId: string, artifacts: unknown[], dismissed: string[] = []): void {
      database.prepare('UPDATE tasks SET artifacts = ?, dismissed_artifacts = ? WHERE id = ?')
        .run(JSON.stringify(artifacts), JSON.stringify(dismissed), taskId);
    }

    function rerunFold(): void {
      database.prepare("DELETE FROM schema_meta WHERE key = 'artifacts_folded_at'").run();
      runProjectMigrations(database);
    }

    it('folds a canvas stored as several deep-link rows into its first row, and re-keys dismissals', () => {
      const task = tasks.create({ title: 'Panel marks', description: '', swimlane_id: laneId });
      storeRaw(task.id, [
        { url: CANVAS, name: null, source: 'detected', added_at: NOW },
        { url: MIRO, name: 'Flow', source: 'user', added_at: NOW },
        { url: `${CANVAS}#page-dcb81aee8d83`, name: 'Panel tab marks', name_from: 'publish', source: 'publish', added_at: NOW },
        { url: `${CANVAS}#artboard-2`, name: null, source: 'detected', added_at: NOW },
      ], [`https://claude.ai/artifact/Gone123#page-1`, `https://claude.ai/artifact/Gone123#page-2`]);

      rerunFold();

      expect(tasks.getById(task.id)?.artifacts).toEqual([
        { url: CANVAS, name: 'Panel tab marks', name_from: 'publish', source: 'detected', added_at: NOW },
        { url: MIRO, name: 'Flow', source: 'user', added_at: NOW },
      ]);
      expect(tasks.getDismissedArtifacts(task.id)).toEqual(['https://claude.ai/artifact/Gone123']);
    });

    it('gives a nameless row the name another task gives the link', () => {
      const named = tasks.create({ title: 'Jira import', description: '', swimlane_id: laneId });
      const bare = tasks.create({ title: 'Build import', description: '', swimlane_id: laneId });
      storeRaw(named.id, [{ url: CANVAS, name: 'Jira import design', source: 'user', added_at: NOW }]);
      storeRaw(bare.id, [{ url: CANVAS, name: null, source: 'detected', added_at: NOW }]);

      rerunFold();

      expect(tasks.getById(bare.id)?.artifacts).toEqual([
        { url: CANVAS, name: 'Jira import design', name_from: 'borrowed', source: 'detected', added_at: NOW },
      ]);
    });

    // Red: drop ORDER BY created_at in the fold's read and the pick follows row order.
    it('gives a nameless row the name of the older task, whatever order the tasks were written in', () => {
      const newer = tasks.create({ title: 'Written first', description: '', swimlane_id: laneId });
      const older = tasks.create({ title: 'Written second', description: '', swimlane_id: laneId });
      const bare = tasks.create({ title: 'Bare', description: '', swimlane_id: laneId });
      storeRaw(newer.id, [{ url: CANVAS, name: 'From the newer task', source: 'user', added_at: NOW }]);
      storeRaw(older.id, [{ url: CANVAS, name: 'From the older task', source: 'user', added_at: NOW }]);
      storeRaw(bare.id, [{ url: CANVAS, name: null, source: 'detected', added_at: NOW }]);
      stamp(newer.id, '2026-02-01T00:00:00.000Z');
      stamp(older.id, '2026-01-01T00:00:00.000Z');

      rerunFold();

      expect(tasks.getById(bare.id)?.artifacts[0]).toMatchObject({ name: 'From the older task', name_from: 'borrowed' });
    });

    // Red: drop `, id` from the fold's ORDER BY and the pick follows row order, the opposite of id order here.
    it('gives a nameless row the name of the task with the smaller id when two share a creation time', () => {
      const writtenFirst = tasks.create({ title: 'Written first', description: '', swimlane_id: laneId });
      const writtenSecond = tasks.create({ title: 'Written second', description: '', swimlane_id: laneId });
      const bare = tasks.create({ title: 'Bare', description: '', swimlane_id: laneId });
      storeRaw(writtenFirst.id, [{ url: CANVAS, name: 'From the larger id', source: 'user', added_at: NOW }]);
      storeRaw(writtenSecond.id, [{ url: CANVAS, name: 'From the smaller id', source: 'user', added_at: NOW }]);
      storeRaw(bare.id, [{ url: CANVAS, name: null, source: 'detected', added_at: NOW }]);
      stamp(writtenFirst.id, '2026-01-01T00:00:00.000Z', 'zzz-task');
      stamp(writtenSecond.id, '2026-01-01T00:00:00.000Z', 'aaa-task');
      stamp(bare.id, '2026-03-01T00:00:00.000Z');

      rerunFold();

      expect(tasks.getById(bare.id)?.artifacts[0]).toMatchObject({ name: 'From the smaller id', name_from: 'borrowed' });
    });

    // Red: parse the dismissed column with a bare JSON.parse and the open throws on the text.
    it('survives a task whose dismissed list is unreadable text, and ends with a valid list', () => {
      const task = tasks.create({ title: 'Garbled', description: '', swimlane_id: laneId });
      database.prepare('UPDATE tasks SET artifacts = ?, dismissed_artifacts = ? WHERE id = ?').run(
        JSON.stringify([
          { url: CANVAS, name: null, source: 'detected', added_at: NOW },
          { url: `${CANVAS}#page-1`, name: 'Canvas', source: 'detected', added_at: NOW },
        ]),
        'not json',
        task.id,
      );

      expect(() => rerunFold()).not.toThrow();

      expect(tasks.getById(task.id)?.artifacts).toEqual([{ url: CANVAS, name: 'Canvas', source: 'detected', added_at: NOW }]);
      const stored = database.prepare('SELECT dismissed_artifacts FROM tasks WHERE id = ?').get(task.id) as { dismissed_artifacts: string };
      expect(Array.isArray(JSON.parse(stored.dismissed_artifacts))).toBe(true);
      expect(tasks.getDismissedArtifacts(task.id)).toEqual([]);
    });

    // Red: return before the flag insert when no row holds artifacts and the fold re-runs on every open.
    it('sets the folded flag on a database with no artifacts at all', () => {
      tasks.create({ title: 'Plain', description: '', swimlane_id: laneId });
      database.prepare("DELETE FROM schema_meta WHERE key = 'artifacts_folded_at'").run();

      runProjectMigrations(database);

      const flag = database.prepare("SELECT value FROM schema_meta WHERE key = 'artifacts_folded_at'").get() as { value: string } | undefined;
      expect(flag).toBeDefined();
      expect(Number.isNaN(Date.parse(flag?.value ?? ''))).toBe(false);
    });

    it('runs once per database', () => {
      const task = tasks.create({ title: 'Later', description: '', swimlane_id: laneId });
      storeRaw(task.id, [
        { url: CANVAS, name: null, source: 'detected', added_at: NOW },
        { url: `${CANVAS}#page-1`, name: null, source: 'detected', added_at: NOW },
      ]);
      // The flag from this database's first migration is still there.
      runProjectMigrations(database);
      expect(urlsOf(task.id)).toEqual([CANVAS, `${CANVAS}#page-1`]);
    });

    it('reads a row from before the columns existed as having no artifacts, and is safe to run again', () => {
      const task = tasks.create({ title: 'Old', description: '', swimlane_id: laneId });
      // Put the database back the way it was before the migration.
      database.exec('ALTER TABLE tasks DROP COLUMN artifacts');
      database.exec('ALTER TABLE tasks DROP COLUMN dismissed_artifacts');

      runProjectMigrations(database);
      expect(tasks.getById(task.id)?.artifacts).toEqual([]);
      expect(tasks.getDismissedArtifacts(task.id)).toEqual([]);

      // Idempotent: a second run adds nothing and keeps what was written.
      tasks.applyArtifactChanges(task.id, { add: [{ url: MIRO }] });
      runProjectMigrations(database);
      expect(urlsOf(task.id)).toEqual([MIRO]);
    });
  });
});
