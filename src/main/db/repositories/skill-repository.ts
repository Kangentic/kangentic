import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Skill, SkillCreateInput, SkillUpdateInput, SwimlaneTransition } from '../../../shared/types';

export class SkillRepository {
  constructor(private db: Database.Database) {}

  list(): Skill[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as Skill[];
  }

  getById(id: string): Skill | undefined {
    return this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill | undefined;
  }

  create(input: SkillCreateInput): Skill {
    const now = new Date().toISOString();
    const id = uuidv4();
    const skill: Skill = {
      id,
      name: input.name,
      type: input.type,
      config_json: input.config_json,
      created_at: now,
    };
    this.db.prepare(
      'INSERT INTO skills (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(skill.id, skill.name, skill.type, skill.config_json, skill.created_at);
    return skill;
  }

  update(input: SkillUpdateInput): Skill {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Skill ${input.id} not found`);

    const updated = { ...existing };
    if (input.name !== undefined) updated.name = input.name;
    if (input.type !== undefined) updated.type = input.type;
    if (input.config_json !== undefined) updated.config_json = input.config_json;

    this.db.prepare(
      'UPDATE skills SET name = ?, type = ?, config_json = ? WHERE id = ?'
    ).run(updated.name, updated.type, updated.config_json, updated.id);
    return updated;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM swimlane_transitions WHERE skill_id = ?').run(id);
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  // Transition management
  listTransitions(): SwimlaneTransition[] {
    return this.db.prepare('SELECT * FROM swimlane_transitions ORDER BY from_swimlane_id, to_swimlane_id, execution_order').all() as SwimlaneTransition[];
  }

  getTransitionsFor(fromId: string, toId: string): SwimlaneTransition[] {
    // Exact match takes priority; fall back to wildcard '*' source
    const exact = this.db.prepare(
      'SELECT * FROM swimlane_transitions WHERE from_swimlane_id = ? AND to_swimlane_id = ? ORDER BY execution_order'
    ).all(fromId, toId) as SwimlaneTransition[];
    if (exact.length > 0) return exact;
    return this.db.prepare(
      "SELECT * FROM swimlane_transitions WHERE from_swimlane_id = '*' AND to_swimlane_id = ? ORDER BY execution_order"
    ).all(toId) as SwimlaneTransition[];
  }

  /** Returns the set of swimlane IDs that have spawn_agent transitions targeting them. */
  getAgentSwimlaneIds(): Set<string> {
    const transitions = this.listTransitions();
    const skills = this.list();
    const ids = new Set<string>();
    for (const t of transitions) {
      const skill = skills.find((s) => s.id === t.skill_id);
      if (skill?.type === 'spawn_agent') {
        ids.add(t.to_swimlane_id);
      }
    }
    return ids;
  }

  setTransitions(fromId: string, toId: string, skillIds: string[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? AND to_swimlane_id = ?').run(fromId, toId);
      const insert = this.db.prepare(
        'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, skill_id, execution_order) VALUES (?, ?, ?, ?, ?)'
      );
      skillIds.forEach((skillId, order) => {
        insert.run(uuidv4(), fromId, toId, skillId, order);
      });
    });
    tx();
  }
}
