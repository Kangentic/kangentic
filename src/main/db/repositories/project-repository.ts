import { v4 as uuidv4 } from 'uuid';
import { getGlobalDb } from '../database';
import type { Project, ProjectCreateInput, ProjectRemote } from '../../../shared/types';
import { DEFAULT_AGENT } from '../../../shared/types';
import { writeTransaction } from '../transaction';
import { softly } from '../soft-db';
import { devPortRepository } from './dev-port-repository';
import { rememberProjectRoots } from '../../shared/project-roots';
import { RefusalError } from '../../../shared/refusal';

/** A `projects` row as stored: a remote project's host and folder are two nullable columns. */
type ProjectRow = Omit<Project, 'remote'> & { remote_host_id: string | null; remote_path: string | null };

/** The row as the app sees it, with the two columns folded into `remote` (null for a project on this computer). */
function toProject(row: ProjectRow): Project {
  const { remote_host_id: hostId, remote_path: remotePath, ...project } = row;
  return { ...project, remote: hostId && remotePath ? { hostId, path: remotePath } : null };
}

/**
 * A project of a removed host is hidden (#913): the SSH host it lives on was removed, which keeps its data
 * and forgets the connection. `list`, `getById` and `getLastOpened` leave it out, so what a person or an agent
 * picks from never offers it, and recovery never starts it.
 *
 * Hidden is not deleted. A reader for which "not in the list" means "gone" reads every row, or it destroys
 * what the user can bring back: a sweep, a prune, a count of what survives, and anything that asks whether a
 * folder is a remote project's. Those use `listIncludingHidden`, `listHidden`, `isHidden` or `listOnHost`.
 */
const VISIBLE_PROJECT_CONDITION = '(remote_host_id IS NULL OR remote_host_id NOT IN (SELECT id FROM ssh_hosts WHERE removed_at IS NOT NULL))';

export class ProjectRepository {
  list(): Project[] {
    const db = getGlobalDb();
    return (db.prepare(`SELECT * FROM projects WHERE ${VISIBLE_PROJECT_CONDITION} ORDER BY position ASC`).all() as ProjectRow[]).map(toProject);
  }

  /** Every row, a removed host's projects included. For a reader that must not read hidden as gone. */
  listIncludingHidden(): Project[] {
    return (getGlobalDb().prepare('SELECT * FROM projects ORDER BY position ASC').all() as ProjectRow[]).map(toProject);
  }

  /** The projects of removed hosts. */
  listHidden(): Project[] {
    return (getGlobalDb().prepare(`SELECT * FROM projects WHERE NOT ${VISIBLE_PROJECT_CONDITION} ORDER BY position ASC`).all() as ProjectRow[]).map(toProject);
  }

  private read(id: string): Project {
    const row = getGlobalDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new RefusalError(`Project ${id} is not registered.`);
    return toProject(row);
  }

  /**
   * Teach Sentry's path redaction every registered project root
   * (src/main/shared/project-roots.ts). Boot calls this once, and `create` and
   * `updatePath` keep the ledger current after that. A failed read seeds
   * nothing rather than throwing, because the redaction must not cost the boot.
   */
  rememberRegisteredRoots(): void {
    const projects = softly<Project[]>('rememberRegisteredRoots', [], () => this.list(), {
      note: 'Sentry path redaction starts without the registered project roots.',
    });
    rememberProjectRoots(projects.map((project) => project.path));
  }

  getById(id: string): Project | undefined {
    const db = getGlobalDb();
    const row = db.prepare(`SELECT * FROM projects WHERE id = ? AND ${VISIBLE_PROJECT_CONDITION}`).get(id) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  create(input: ProjectCreateInput): Project {
    // Every new project path passes here, so this is where Sentry's path
    // redaction learns it (src/main/shared/project-roots.ts), before anything
    // can fail and report it.
    rememberProjectRoots([input.path]);
    const db = getGlobalDb();
    const now = new Date().toISOString();
    const id = uuidv4();
    const project: Project = {
      id,
      name: input.name,
      path: input.path,
      github_url: input.github_url || null,
      default_agent: input.default_agent || DEFAULT_AGENT,
      default_model: input.default_model ?? null,
      default_effort: input.default_effort ?? null,
      group_id: null,
      position: 0,
      remote: input.remote ?? null,
      last_opened: now,
      created_at: now,
    };
    const tx = writeTransaction(db, () => {
      // Shift all existing projects down to make room at position 0
      db.prepare('UPDATE projects SET position = position + 1').run();
      db.prepare(
        'INSERT INTO projects (id, name, path, github_url, default_agent, default_model, default_effort, group_id, position, remote_host_id, remote_path, last_opened, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(project.id, project.name, project.path, project.github_url, project.default_agent, project.default_model, project.default_effort, project.group_id, project.position, project.remote?.hostId ?? null, project.remote?.path ?? null, project.last_opened, project.created_at);
    });
    tx();
    return project;
  }

  getLastOpened(): Project | undefined {
    const db = getGlobalDb();
    const row = db.prepare(
      `SELECT * FROM projects WHERE ${VISIBLE_PROJECT_CONDITION} ORDER BY last_opened DESC LIMIT 1`
    ).get() as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  updateLastOpened(id: string): void {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET last_opened = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  delete(id: string): void {
    const db = getGlobalDb();
    const tx = writeTransaction(db, () => {
      // Return this project's dev-server ports to the pool. Inside the
      // transaction because both tables live in the GLOBAL database, and here
      // rather than at the three delete call sites because this is the one path
      // every project removal passes through - the same reasoning as
      // TaskRepository.delete. Without it a removed project's reservations
      // would block their ports permanently - nothing sweeps them later.
      db.prepare('DELETE FROM dev_ports WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      // Reindex positions to keep them contiguous (0..N-1)
      const remaining = db.prepare('SELECT id FROM projects ORDER BY position ASC').all() as Array<{ id: string }>;
      const stmt = db.prepare('UPDATE projects SET position = ? WHERE id = ?');
      remaining.forEach((row, index) => {
        stmt.run(index, row.id);
      });
    });
    tx();
    devPortRepository.notifyChanged();
  }

  rename(id: string, name: string): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
    return this.read(id);
  }

  /** Re-point a project at a new folder on disk. Tasks/board data are keyed by project id and are unaffected. */
  updatePath(id: string, newPath: string): Project {
    // The old root stays known too: the ledger is add-only for the run.
    rememberProjectRoots([newPath]);
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(newPath, id);
    return this.read(id);
  }

  /** Point a project at a repo folder on an SSH host, or back at this computer with null (#913). */
  setRemote(projectId: string, remote: ProjectRemote | null): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET remote_host_id = ?, remote_path = ? WHERE id = ?').run(remote?.hostId ?? null, remote?.path ?? null, projectId);
    return this.read(projectId);
  }

  /**
   * Whether the project exists but is hidden because its host was removed. A reader that treats "not found" as
   * "deleted" (a workflow link's end) must ask this first, or hiding a project would be read as deleting it.
   */
  isHidden(id: string): boolean {
    const row = getGlobalDb().prepare(`SELECT id FROM projects WHERE id = ? AND NOT ${VISIBLE_PROJECT_CONDITION}`).get(id);
    return row !== undefined;
  }

  /** The projects that live on a host, hidden ones included: removing the host hides them, adding it again shows them. */
  listOnHost(hostId: string): Project[] {
    const db = getGlobalDb();
    return (db.prepare('SELECT * FROM projects WHERE remote_host_id = ? ORDER BY position ASC').all(hostId) as ProjectRow[]).map(toProject);
  }

  setDefaultAgent(projectId: string, agentName: string): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET default_agent = ? WHERE id = ?').run(agentName, projectId);
    return this.read(projectId);
  }

  setDefaultModel(projectId: string, model: string | null): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET default_model = ? WHERE id = ?').run(model, projectId);
    return this.read(projectId);
  }

  setDefaultEffort(projectId: string, effort: string | null): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET default_effort = ? WHERE id = ?').run(effort, projectId);
    return this.read(projectId);
  }

  reorder(ids: string[]): void {
    const db = getGlobalDb();
    const tx = writeTransaction(db, () => {
      const stmt = db.prepare('UPDATE projects SET position = ? WHERE id = ?');
      ids.forEach((id, index) => {
        stmt.run(index, id);
      });
    });
    tx();
  }

  setGroup(projectId: string, groupId: string | null): void {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET group_id = ? WHERE id = ?').run(groupId, projectId);
  }
}
