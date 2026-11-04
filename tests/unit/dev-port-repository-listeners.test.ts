/**
 * The ledger's change listeners (#913): what is derived from the dev-port ledger, the ports forwarded
 * from an SSH host, follows it only if a claim and a release tell their listeners. Run against the real
 * repository and a real SQLite engine.
 *
 * What a user loses if it breaks: a reserved dev-server port of a remote project that never reaches
 * localhost, or a released one forwarded until the app restarts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { openTestDatabase } from './helpers/test-database';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/main/db/database', () => ({ getGlobalDb: () => holder.db }));

import { DevPortRepository } from '../../src/main/db/repositories/dev-port-repository';

let db: Database.Database;

beforeEach(() => {
  db = openTestDatabase();
  runGlobalMigrations(db);
  holder.db = db;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('DevPortRepository.onChange', () => {
  it('tells a listener when a claim succeeds, and not when the port was already taken', () => {
    const repository = new DevPortRepository();
    const listener = vi.fn();
    repository.onChange(listener);

    expect(repository.claim(7300, 'project-1', 'task-1')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(repository.claim(7300, 'project-1', 'task-2')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tells a listener after the rows are gone when a task releases its ports', () => {
    const repository = new DevPortRepository();
    repository.claim(7301, 'project-1', 'task-1');
    const heldWhenTold: number[] = [];
    repository.onChange(() => heldWhenTold.push(repository.listAll().length));

    repository.releaseByTaskId('task-1');

    expect(heldWhenTold).toEqual([0]);
  });

  it('stops telling a listener that unsubscribed', () => {
    const repository = new DevPortRepository();
    const listener = vi.fn();
    const unsubscribe = repository.onChange(listener);
    unsubscribe();

    repository.claim(7302, 'project-1', 'task-1');

    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a listener that throws, still tells the others, and still returns the claim', () => {
    const repository = new DevPortRepository();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const after = vi.fn();
    repository.onChange(() => { throw new Error('a listener broke'); });
    repository.onChange(after);

    expect(repository.claim(7303, 'project-1', 'task-1')).toBe(true);
    expect(() => repository.releaseByTaskId('task-1')).not.toThrow();

    expect(after).toHaveBeenCalledTimes(2);
  });
});
