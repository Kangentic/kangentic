/**
 * SSH hosts and remote projects in the global database (#913), on a real SQLite: the migration upgrades
 * a database that predates it without touching a project on this computer, a host row holds a destination
 * and a key file's path and never a secret, and removing a host takes its projects, and only those, out of
 * Kangentic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/main/db/database', () => ({ getGlobalDb: () => holder.db }));

import { runGlobalMigrations } from '../../src/main/db/migrations/global-schema';
import { ProjectRepository } from '../../src/main/db/repositories/project-repository';
import { SshHostRepository } from '../../src/main/db/repositories/ssh-host-repository';

let db: Database.Database;
const projects = new ProjectRepository();
const hosts = new SshHostRepository();

beforeEach(() => {
  db = new Database(':memory:');
  holder.db = db;
  runGlobalMigrations(db);
});

afterEach(() => db.close());

describe('the migration', () => {
  it('upgrades a database from before hosts existed, leaving its projects on this computer', () => {
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, github_url TEXT,
        default_agent TEXT NOT NULL DEFAULT 'claude', last_opened TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO projects (id, name, path, last_opened, created_at) VALUES ('p1', 'old-project', '/code/old', 'a', 'a');
    `);
    holder.db = old;
    runGlobalMigrations(old);
    expect(projects.list()).toMatchObject([{ id: 'p1', name: 'old-project', remote: null }]);
    expect(old.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'ssh_hosts'").get()).toEqual({ c: 1 });
    old.close();
  });

  it('is safe to run again', () => {
    expect(() => runGlobalMigrations(db)).not.toThrow();
    expect(() => runGlobalMigrations(db)).not.toThrow();
  });

  it('gives a host row a destination and a key file path, and no column for a secret', () => {
    const columns = (db.pragma('table_info(ssh_hosts)') as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(['id', 'name', 'destination', 'key_path', 'key_created', 'created_at', 'removed_at', 'reveal_pending']);
  });
});

describe('hosts', () => {
  it('stores and reads a host, with the created-key flag as a boolean', () => {
    const user = hosts.create({ name: 'build-box', destination: 'dev@build-box' });
    const created = hosts.create({ name: 'gpu-rig', destination: 'ssh://dev@gpu-rig:2222', key_path: '/keys/gpu-rig', key_created: true });
    expect(hosts.getById(user.id)).toMatchObject({ name: 'build-box', destination: 'dev@build-box', key_path: null, key_created: false });
    expect(hosts.getById(created.id)).toMatchObject({ key_path: '/keys/gpu-rig', key_created: true });
    expect(hosts.list().map((host) => host.name)).toEqual(['build-box', 'gpu-rig']);
    expect(hosts.getById('nope')).toBeUndefined();
  });

  it('renames a host', () => {
    const host = hosts.create({ name: 'build-box', destination: 'build-box' });
    expect(hosts.rename(host.id, 'ci-box')?.name).toBe('ci-box');
  });
});

describe('remote projects', () => {
  it('keeps where the repo lives, and reads a project on this computer as not remote', () => {
    const host = hosts.create({ name: 'build-box', destination: 'build-box' });
    const remote = projects.create({ name: 'api', path: '/shell/api', remote: { hostId: host.id, path: '/home/dev/api' } });
    const local = projects.create({ name: 'site', path: '/code/site' });
    expect(remote.remote).toEqual({ hostId: host.id, path: '/home/dev/api' });
    expect(local.remote).toBeNull();
    expect(projects.getById(remote.id)?.remote).toEqual({ hostId: host.id, path: '/home/dev/api' });
    expect(projects.getById(local.id)?.remote).toBeNull();
    expect(projects.list().map((project) => project.remote?.path ?? null)).toEqual([null, '/home/dev/api']);
  });

  it('never hands the raw column names to a caller', () => {
    const host = hosts.create({ name: 'build-box', destination: 'build-box' });
    const created = projects.create({ name: 'api', path: '/shell/api', remote: { hostId: host.id, path: '/home/dev/api' } });
    for (const project of [created, projects.getById(created.id), ...projects.list(), projects.rename(created.id, 'api2')]) {
      expect(project).not.toHaveProperty('remote_host_id');
      expect(project).not.toHaveProperty('remote_path');
    }
  });

  it('moves a project to a host and back with setRemote, and lists what lives on a host', () => {
    const host = hosts.create({ name: 'build-box', destination: 'build-box' });
    const project = projects.create({ name: 'api', path: '/code/api' });
    expect(projects.setRemote(project.id, { hostId: host.id, path: '/srv/api' }).remote).toEqual({ hostId: host.id, path: '/srv/api' });
    expect(projects.listOnHost(host.id).map((entry) => entry.id)).toEqual([project.id]);
    expect(projects.setRemote(project.id, null).remote).toBeNull();
    expect(projects.listOnHost(host.id)).toEqual([]);
  });

  it('removes a host\'s projects, and only those, and keeps the order of the rest contiguous', () => {
    const doomed = hosts.create({ name: 'old-box', destination: 'old-box' });
    const kept = hosts.create({ name: 'new-box', destination: 'new-box' });
    projects.create({ name: 'on-old', path: '/shell/a', remote: { hostId: doomed.id, path: '/a' } });
    projects.create({ name: 'local', path: '/code/local' });
    projects.create({ name: 'on-new', path: '/shell/b', remote: { hostId: kept.id, path: '/b' } });
    projects.create({ name: 'also-on-old', path: '/shell/c', remote: { hostId: doomed.id, path: '/c' } });

    hosts.delete(doomed.id);
    const remaining = projects.list();
    expect(remaining.map((project) => project.name).sort()).toEqual(['local', 'on-new']);
    expect(remaining.map((project) => project.position)).toEqual([0, 1]);
    expect(hosts.list().map((host) => host.name)).toEqual(['new-box']);
  });

  it('returns the dev-server ports of a removed host\'s projects to the pool, and keeps every other project\'s', () => {
    const doomed = hosts.create({ name: 'old-box', destination: 'old-box' });
    const onHost = projects.create({ name: 'on-old', path: '/shell/a', remote: { hostId: doomed.id, path: '/a' } });
    const local = projects.create({ name: 'local', path: '/code/local' });
    const reserve = db.prepare('INSERT INTO dev_ports (port, project_id, task_id, allocated_at) VALUES (?, ?, ?, ?)');
    reserve.run(5173, onHost.id, 'task-a', new Date().toISOString());
    reserve.run(5174, local.id, 'task-b', new Date().toISOString());

    hosts.delete(doomed.id);

    const ports = db.prepare('SELECT port FROM dev_ports ORDER BY port').all() as Array<{ port: number }>;
    expect(ports.map((row) => row.port)).toEqual([5174]);
  });
});
