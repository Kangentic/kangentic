import { v4 as uuidv4 } from 'uuid';
import { getGlobalDb } from '../database';
import type { Project, ProjectCreateInput } from '../../../shared/types';
import { DEFAULT_AGENT } from '../../../shared/types';

export class ProjectRepository {
  list(): Project[] {
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM projects ORDER BY position ASC').all() as Project[];
  }

  getById(id: string): Project | undefined {
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  create(input: ProjectCreateInput): Project {
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
      last_opened: now,
      created_at: now,
    };
    const tx = db.transaction(() => {
      // Shift all existing projects down to make room at position 0
      db.prepare('UPDATE projects SET position = position + 1').run();
      db.prepare(
        'INSERT INTO projects (id, name, path, github_url, default_agent, default_model, default_effort, group_id, position, last_opened, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(project.id, project.name, project.path, project.github_url, project.default_agent, project.default_model, project.default_effort, project.group_id, project.position, project.last_opened, project.created_at);
    });
    tx();
    return project;
  }

  getLastOpened(): Project | undefined {
    const db = getGlobalDb();
    return db.prepare(
      'SELECT * FROM projects ORDER BY last_opened DESC LIMIT 1'
    ).get() as Project | undefined;
  }

  updateLastOpened(id: string): void {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET last_opened = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  delete(id: string): void {
    const db = getGlobalDb();
    const tx = db.transaction(() => {
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
  }

  rename(id: string, name: string): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
  }

  /** Re-point a project at a new folder on disk. Tasks/board data are keyed by project id and are unaffected. */
  updatePath(id: string, newPath: string): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(newPath, id);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
  }

  setDefaultAgent(projectId: string, agentName: string): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET default_agent = ? WHERE id = ?').run(agentName, projectId);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project;
  }

  setDefaultModel(projectId: string, model: string | null): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET default_model = ? WHERE id = ?').run(model, projectId);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project;
  }

  setDefaultEffort(projectId: string, effort: string | null): Project {
    const db = getGlobalDb();
    db.prepare('UPDATE projects SET default_effort = ? WHERE id = ?').run(effort, projectId);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project;
  }

  reorder(ids: string[]): void {
    const db = getGlobalDb();
    const tx = db.transaction(() => {
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
