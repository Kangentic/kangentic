import type { Swimlane } from '../../shared/types';
import { getExistingProjectDb } from '../db/database';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';

/**
 * A board's columns, or none when its database cannot be read or its project is
 * gone. Its own module, a plain read, so the plan approval resolver can read a
 * task's route without importing the workflow service that calls it.
 */
export function safeLanes(projectId: string): Swimlane[] {
  try {
    const db = getExistingProjectDb(projectId);
    return db ? new SwimlaneRepository(db).list() : [];
  } catch {
    return [];
  }
}
