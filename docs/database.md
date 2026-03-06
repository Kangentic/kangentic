# Database Architecture

## Two-Database Architecture

Kangentic uses a two-database design:

- **Global DB** (`<configDir>/index.db`) -- stores the project list and global configuration.
- **Per-project DB** (`<configDir>/projects/<projectId>.db`) -- stores tasks, swimlanes, actions, and sessions for a single project.

This separation keeps project data isolated. Deleting a project removes only its database file.

## Database Locations

The config directory is platform-dependent:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%/kangentic/` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`) |

Overridable via the `KANGENTIC_DATA_DIR` environment variable. When set, all database files are stored under that directory instead of the platform default.

## Configuration

All database connections are opened with:

- **WAL mode** for concurrent reads
- **busy_timeout = 5000ms** to wait on locked databases
- **foreign_keys = ON** to enforce referential integrity
- **better-sqlite3** (synchronous, no async) -- all queries block the Node.js event loop briefly but avoid callback complexity

## Global DB Schema

### projects table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| path | TEXT | NOT NULL | |
| github_url | TEXT | | NULL |
| default_agent | TEXT | NOT NULL | 'claude' |
| position | INTEGER | NOT NULL | 0 |
| last_opened | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

### global_config table

| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

## Per-Project DB Schema

### swimlanes table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| role | TEXT | | NULL |
| position | INTEGER | NOT NULL | |
| color | TEXT | NOT NULL | '#3b82f6' |
| icon | TEXT | | NULL |
| is_archived | INTEGER | NOT NULL | 0 |
| permission_strategy | TEXT | | NULL |
| auto_spawn | INTEGER | NOT NULL | 1 |
| auto_command | TEXT | | NULL |
| plan_exit_target_id | TEXT | | NULL |
| created_at | TEXT | NOT NULL | |

Valid role values: `backlog`, `done`, or NULL (custom column).

### tasks table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | '' |
| swimlane_id | TEXT | NOT NULL, FK->swimlanes | |
| position | INTEGER | NOT NULL | |
| agent | TEXT | | NULL |
| session_id | TEXT | | NULL |
| worktree_path | TEXT | | NULL |
| branch_name | TEXT | | NULL |
| pr_number | INTEGER | | NULL |
| pr_url | TEXT | | NULL |
| base_branch | TEXT | | NULL |
| use_worktree | INTEGER | | NULL |
| archived_at | TEXT | | NULL |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

Index: `idx_tasks_swimlane_position` on (swimlane_id, position).

### actions table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| type | TEXT | NOT NULL | |
| config_json | TEXT | NOT NULL | '{}' |
| created_at | TEXT | NOT NULL | |

Valid types: `spawn_agent`, `send_command`, `run_script`, `kill_session`, `create_worktree`, `cleanup_worktree`, `create_pr`, `webhook`.

### swimlane_transitions table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| from_swimlane_id | TEXT | NOT NULL | |
| to_swimlane_id | TEXT | NOT NULL, FK->swimlanes | |
| action_id | TEXT | NOT NULL, FK->actions | |
| execution_order | INTEGER | NOT NULL | 0 |

Note: `from_swimlane_id` has no foreign key constraint. This allows a wildcard value (`*`) as the source, meaning the transition fires regardless of which column the task came from.

Index: `idx_transitions_from_to` on (from_swimlane_id, to_swimlane_id).

### sessions table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks | |
| session_type | TEXT | NOT NULL | |
| claude_session_id | TEXT | | NULL |
| command | TEXT | NOT NULL | |
| cwd | TEXT | NOT NULL | |
| permission_mode | TEXT | | NULL |
| prompt | TEXT | | NULL |
| status | TEXT | NOT NULL | 'running' |
| exit_code | INTEGER | | NULL |
| started_at | TEXT | NOT NULL | |
| suspended_at | TEXT | | NULL |
| exited_at | TEXT | | NULL |

Valid session_type values: `claude_agent`, `run_script`.

Valid status values: `running`, `suspended`, `exited`, `orphaned`.

### task_attachments table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| filename | TEXT | NOT NULL | |
| file_path | TEXT | NOT NULL | |
| media_type | TEXT | NOT NULL | |
| size_bytes | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |

Index: `idx_task_attachments_task_id` on (task_id).

## Migration Strategy

Migrations run automatically on database open. The strategy uses three approaches depending on the change:

- **Initial schema** uses `CREATE TABLE IF NOT EXISTS` so first-run and re-runs are idempotent.
- **Incremental changes** use `ALTER TABLE ADD COLUMN` with existence checks via `PRAGMA table_info()` to avoid errors on already-migrated databases.
- **Table recreation** is used when foreign key constraints need removal (e.g., `swimlane_transitions` wildcard source required dropping the FK on `from_swimlane_id`).
- **Data migrations** (e.g., converting explicit transitions to wildcards, updating legacy permission modes) run alongside schema changes.

## Repository Pattern

One repository class per table:

- `ProjectRepository` -- operates on the global DB.
- `TaskRepository`, `SwimlaneRepository`, `ActionRepository`, `SessionRepository`, `AttachmentRepository` -- operate on per-project DBs.

All queries are synchronous (better-sqlite3). Transactions are used for position shifts (task move, swimlane reorder, project reorder) to ensure consistent ordering.

## Connection Management

- `getGlobalDb()` -- singleton, created on first access.
- `getProjectDb(projectId)` -- cached per project ID, reused across the app lifecycle.
- `closeProjectDb(projectId)` -- close and remove from cache on project delete.
- `closeAll()` -- close all connections on app shutdown.

## Default Seed Data

New projects are seeded with 7 default swimlanes:

1. **Backlog** (role: `backlog`)
2. **Planning**
3. **Executing**
4. **Code Review**
5. **Tests**
6. **Ship It**
7. **Done** (role: `done`)

Two default actions are created:

- **Start Planning Agent** (`spawn_agent`) -- wired to transitions into the Planning column.
- **Kill Session** (`kill_session`) -- wired to transitions into the Done column.
