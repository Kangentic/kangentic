/**
 * A project of a removed host is hidden (#913), through the real repositories on a real global database.
 * Removing a host keeps its row with `removed_at` set; every read of "the projects" then leaves its projects
 * out, `listOnHost` still finds them, and restoring the host shows them again with nothing changed.
 *
 * What a user loses if it breaks: a removed host's projects still in the sidebar, search or the MCP tools,
 * a hidden project opened by a stale id, or a project that does not come back when its host does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/main/db/database', () => ({ getGlobalDb: () => holder.db }));

import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { ProjectRepository } from '../../src/main/db/repositories/project-repository';
import { SshHostRepository } from '../../src/main/db/repositories/ssh-host-repository';

const directory = path.join(os.tmpdir(), 'kangentic-hidden-projects');
const projects = new ProjectRepository();
const hosts = new SshHostRepository();
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  holder.db = db;
  runGlobalMigrations(db);
});

afterEach(() => db.close());

function addRemoteProject(name: string, hostId: string, remotePath: string) {
  return projects.create({ name, path: path.join(directory, name), remote: { hostId, path: remotePath } });
}

describe('a removed host\'s projects', () => {
  it('are left out of every read of the projects, and a local project is not', () => {
    const host = hosts.create({ name: 'Lab', destination: 'lab' });
    const local = projects.create({ name: 'local', path: path.join(directory, 'local') });
    const remote = addRemoteProject('remote', host.id, '/home/dev/api');
    expect(projects.list().map((project) => project.id).sort()).toEqual([local.id, remote.id].sort());

    hosts.markRemoved(host.id);

    expect(projects.list().map((project) => project.id)).toEqual([local.id]);
    expect(projects.getById(remote.id)).toBeUndefined();
    expect(projects.getById(local.id)?.id).toBe(local.id);
    expect(projects.getLastOpened()?.id).toBe(local.id);
  });

  it('read as hidden, not as missing, so a reader of "not found" can tell hiding from deleting', () => {
    const host = hosts.create({ name: 'Lab', destination: 'lab' });
    const remote = addRemoteProject('remote', host.id, '/home/dev/api');
    const local = projects.create({ name: 'local', path: path.join(directory, 'local') });
    expect(projects.isHidden(remote.id)).toBe(false);

    hosts.markRemoved(host.id);

    expect(projects.isHidden(remote.id)).toBe(true);
    expect(projects.isHidden(local.id)).toBe(false);
    expect(projects.isHidden('never-registered')).toBe(false);
  });

  it('are still found by their host, which is how they are shown again or cleared', () => {
    const host = hosts.create({ name: 'Lab', destination: 'lab' });
    const remote = addRemoteProject('remote', host.id, '/home/dev/api');
    hosts.markRemoved(host.id);

    expect(projects.listOnHost(host.id).map((project) => project.id)).toEqual([remote.id]);
  });

  it('come back with nothing changed once the host is restored', () => {
    const host = hosts.create({ name: 'Lab', destination: 'lab' });
    const remote = addRemoteProject('remote', host.id, '/home/dev/api');
    hosts.markRemoved(host.id);

    hosts.restore(host.id, 'Build server');

    const back = projects.getById(remote.id);
    expect(back).toMatchObject({ id: remote.id, name: 'remote', remote: { hostId: host.id, path: '/home/dev/api' } });
    expect(projects.list().map((project) => project.id)).toEqual([remote.id]);
  });

  it('are not touched by a project on another host', () => {
    const removed = hosts.create({ name: 'Old', destination: 'old' });
    const kept = hosts.create({ name: 'Kept', destination: 'kept' });
    const gone = addRemoteProject('gone', removed.id, '/home/dev/a');
    const stays = addRemoteProject('stays', kept.id, '/home/dev/b');

    hosts.markRemoved(removed.id);

    expect(projects.list().map((project) => project.id)).toEqual([stays.id]);
    expect(projects.getById(gone.id)).toBeUndefined();
  });
});

describe('the host table', () => {
  it('lists the hosts in use and the removed ones apart, and finds either by id', () => {
    const first = hosts.create({ name: 'A', destination: 'a' });
    const second = hosts.create({ name: 'B', destination: 'b' });

    hosts.markRemoved(second.id);

    expect(hosts.list().map((host) => host.id)).toEqual([first.id]);
    expect(hosts.listRemoved().map((host) => host.id)).toEqual([second.id]);
    expect(hosts.getById(second.id)?.removed_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('forgets the key and its flag when a host is removed, since the key is deleted with it', () => {
    const host = hosts.create({ name: 'A', destination: 'a', key_path: '/config/ssh/a/id', key_created: true });

    hosts.markRemoved(host.id);

    expect(hosts.getById(host.id)).toMatchObject({ key_path: null, key_created: false });
  });

  it('remembers that a restored host\'s projects have not started, until that is cleared, and forgets it on a removal', () => {
    const host = hosts.create({ name: 'A', destination: 'a' });
    expect(hosts.getById(host.id)?.reveal_pending).toBe(false);
    hosts.markRemoved(host.id);

    hosts.restore(host.id, 'A');
    expect(hosts.getById(host.id)?.reveal_pending).toBe(true);

    hosts.clearRevealPending(host.id);
    expect(hosts.getById(host.id)?.reveal_pending).toBe(false);

    hosts.restore(host.id, 'A');
    hosts.markRemoved(host.id);
    expect(hosts.getById(host.id)?.reveal_pending).toBe(false);
  });

  it('shows a restored host in the list again, under the name it is given now', () => {
    const host = hosts.create({ name: 'Old name', destination: 'a' });
    hosts.markRemoved(host.id);

    hosts.restore(host.id, 'New name');

    expect(hosts.list()).toEqual([expect.objectContaining({ id: host.id, name: 'New name', removed_at: null })]);
    expect(hosts.listRemoved()).toEqual([]);
  });
});
