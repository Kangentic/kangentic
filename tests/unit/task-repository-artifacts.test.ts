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

  describe('migration', () => {
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
