/**
 * Session recovery & reconciliation on project open.
 *
 * Two distinct flows:
 *   - `resumeSuspendedSessions` - picks up DB records in `suspended` or
 *     `orphaned` state and respawns them (resumes via `agent_session_id`
 *     when possible). Input = dirty-shutdown state in the DB.
 *   - `autoSpawnTasks` - finds tasks in `auto_spawn=true` columns that
 *     have no PTY session and starts a fresh agent. Input = the
 *     auto-spawn invariant.
 *
 * Shared agent-resolution + buildCommand logic lives in `./prepare-spawn`.
 */
export { resumeSuspendedSessions } from './resume-suspended';
export { autoSpawnTasks } from './auto-spawn';
