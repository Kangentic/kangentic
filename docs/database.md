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

All database connections are opened with three pragmas:

- `journal_mode = WAL` -- concurrent reads without blocking writers
- `busy_timeout = 5000` -- wait up to 5 seconds on locked databases before returning SQLITE_BUSY
- `foreign_keys = ON` -- enforce referential integrity on all foreign key constraints

All queries are synchronous via **better-sqlite3** -- they block the Node.js event loop briefly but avoid callback complexity.

## Global DB Schema

### projects table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| path | TEXT | NOT NULL | |
| github_url | TEXT | | NULL |
| default_agent | TEXT | NOT NULL | 'claude' |
| group_id | TEXT | | NULL |
| position | INTEGER | NOT NULL | 0 |
| last_opened | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

### project_groups table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| position | INTEGER | NOT NULL | |
| is_collapsed | INTEGER | NOT NULL | 0 |

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
| permission_mode | TEXT | | NULL |
| auto_spawn | INTEGER | NOT NULL | 1 |
| auto_command | TEXT | | NULL |
| plan_exit_target_id | TEXT | | NULL |
| is_ghost | INTEGER | NOT NULL | 0 |
| created_at | TEXT | NOT NULL | |

Valid role values: `todo`, `done`, or NULL (custom column).

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
| suspended_by | TEXT | | NULL |
| total_cost_usd | REAL | | NULL |
| total_input_tokens | INTEGER | | NULL |
| total_output_tokens | INTEGER | | NULL |
| model_id | TEXT | | NULL |
| model_display_name | TEXT | | NULL |
| total_duration_ms | INTEGER | | NULL |
| tool_call_count | INTEGER | | NULL |
| lines_added | INTEGER | | NULL |
| lines_removed | INTEGER | | NULL |
| files_changed | INTEGER | | NULL |

Valid session_type values: `claude_agent`, `run_script`.

Valid status values: `running`, `queued`, `suspended`, `exited`, `orphaned`.

Valid suspended_by values: `user` (explicit pause button), `system` (shutdown, task move, idle timeout), or `NULL` (legacy records, treated as `system`).

Valid permission_mode values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions` (see `PermissionMode` type in `src/shared/types.ts`).

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

### backlog_items table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | '' |
| priority | INTEGER | NOT NULL | 0 |
| labels | TEXT | NOT NULL | '[]' |
| position | INTEGER | NOT NULL | |
| external_id | TEXT | | NULL |
| external_source | TEXT | | NULL |
| external_url | TEXT | | NULL |
| sync_status | TEXT | | NULL |
| attachment_count | INTEGER | NOT NULL | 0 |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

Indexes: `idx_backlog_position` on (position), `idx_backlog_external` on (external_source, external_id).

## Migration Strategy

Migrations run automatically on database open via `runGlobalMigrations()` (from `src/main/db/migrations/global-schema.ts`) and `runProjectMigrations()` (from `src/main/db/migrations/project-schema.ts`). Default swimlane and action seeding lives in `src/main/db/migrations/default-data.ts`. The strategy uses three approaches depending on the change:

- **Initial schema** uses `CREATE TABLE IF NOT EXISTS` so first-run and re-runs are idempotent.
- **Incremental changes** use `ALTER TABLE ADD COLUMN` with existence checks via `PRAGMA table_info()` to avoid errors on already-migrated databases.
- **Table recreation** is used when foreign key constraints need removal (e.g., `swimlane_transitions` wildcard source required dropping the FK on `from_swimlane_id`).
- **Data migrations** (e.g., converting explicit transitions to wildcards, updating legacy permission modes) run alongside schema changes.

### Key Migrations (Per-Project DB)

Listed in execution order within `runProjectMigrations()`:

1. **`role` column on swimlanes** -- adds the `role` column and backfills `todo` (originally `backlog`), `planning`, `running` by position, plus `done` for archived columns.
2. **`icon` column on swimlanes** -- adds custom icon support.
3. **`archived_at` column on tasks** -- supports the Done auto-archive feature.
4. **`base_branch` column on tasks** -- per-task base branch override.
5. **`use_worktree` column on tasks** -- per-task worktree override.
6. **`swimlane_transitions` table recreation** -- drops the foreign key constraint on `from_swimlane_id` to allow wildcard `*` source. SQLite requires full table recreation to remove a constraint.
7. **Wildcard transition data migration** -- converts explicit per-source transitions (e.g., To Do->Planning) into wildcard transitions (*->Planning). Groups by target swimlane and action, keeping the lowest execution_order.
8. **`task_attachments` table** -- creates the table with `ON DELETE CASCADE` on `task_id` and an index on `task_id`.
9. **`spawn_agent` config data migrations** (single pass over all spawn_agent actions):
   - Appends `{{attachments}}` to prompt templates that lack it
   - Removes legacy permission modes (`dangerously-skip`, `bypass-permissions`) from action config (action-level permissionMode was removed in a later migration)
   - Updates old `Task: {{title}}...` prompt template to `{{title}}{{description}}{{attachments}}`
10. **`permission_strategy` and `auto_spawn` columns on swimlanes** -- adds per-column permission strategy and auto-spawn toggle. Backfills: todo/done get `auto_spawn = 0`, planning gets `permission_strategy = 'plan'`, running role is converted to a custom column. (Column later renamed to `permission_mode` in migration 16.)
11. **`auto_command` column on swimlanes** -- per-column auto-command support.
12. **`is_terminal` renamed to `is_archived`** -- uses `ALTER TABLE RENAME COLUMN`.
13. **`plan_exit_target_id` column on swimlanes** -- adds plan exit target and removes the `planning` system role. Sets icon to `map` for former planning-role columns, clears the role, and auto-sets `plan_exit_target_id` to the next column by position.
14. **`suspended_by` column on sessions** -- tracks who suspended the session (`user` or `system`). Used by session recovery to skip user-paused sessions on relaunch.
15. **Legacy `permission_strategy` rename** -- converts `project-settings` to `default` and `dangerously-skip` to `bypass-permissions` in swimlanes. (Values later migrated again in migration 18.)
16. **`is_ghost` column on swimlanes** -- adds ghost column support for board config reconciliation. Ghost columns are columns removed from `kangentic.json` but still holding tasks.
17. **Session metrics columns** -- adds `total_cost_usd`, `total_input_tokens`, `total_output_tokens`, `model_id`, `model_display_name`, `total_duration_ms`, `tool_call_count`, `lines_added`, `lines_removed`, `files_changed` to sessions for completed task summaries.
18. **`permission_strategy` column renamed to `permission_mode`** -- renames the `permission_strategy` column to `permission_mode` on swimlanes. Migrates old values: `bypass-permissions` to `bypassPermissions`, removes `manual` (alias for `default`). Adds `dontAsk` as a new valid mode. Also removes `permissionMode` from action `config_json` (action-level override removed; resolution is now swimlane override then global setting).
19. **Legacy `permission_mode` value normalization** -- unconditional data migration that runs on every DB open. Normalizes legacy values in both swimlanes and sessions: `project-settings` to `default`, `manual` to `default`, `dangerously-skip` to `bypassPermissions`, `bypass-permissions` to `bypassPermissions`. Ensures all records use the current `PermissionMode` union values regardless of when they were created.
20. **Swimlane role rename (`backlog` to `todo`)** -- renames the "Backlog" swimlane to "To Do" (also catches "Not Started") and migrates role values from `backlog` to `todo`.
21. **`backlog_items` table** -- creates the staging area table for the Backlog View feature. Stores pre-board items with priority, labels, external source tracking, and position ordering. Includes indexes on position and (external_source, external_id).

### Key Migrations (Global DB)

1. **`position` column on projects** -- adds explicit project ordering. Backfills positions based on `last_opened DESC` order to preserve the original visual order.
2. **`project_groups` table** -- creates the project groups table for organizing projects into named, collapsible sections.
3. **`group_id` column on projects** -- adds nullable foreign key linking projects to their group.

## Repository Pattern

One repository class per table. All queries are synchronous (better-sqlite3). Transactions are used for position shifts (task move, swimlane reorder, project reorder) to ensure consistent ordering.

### ProjectRepository

Operates on the global DB. Uses `getGlobalDb()` internally -- no constructor argument needed.

| Method | Description |
|--------|-------------|
| `list()` | All projects ordered by position ASC |
| `getById(id)` | Single project by ID |
| `create(input)` | Insert at position 0, shifting all existing projects down |
| `getLastOpened()` | Most recently opened project (by `last_opened` DESC) |
| `updateLastOpened(id)` | Set `last_opened` to now |
| `rename(id, name)` | Rename a project |
| `delete(id)` | Delete and reindex positions to keep them contiguous (0..N-1) |
| `reorder(ids)` | Set positions from the ordered array of IDs |

### TaskRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list(swimlaneId?)` | Active (non-archived) tasks, optionally filtered by swimlane. Includes `attachment_count` via LEFT JOIN on `task_attachments`. |
| `getById(id)` | Single task by ID (includes `attachment_count`) |
| `getBySessionId(sessionId)` | Find the active (non-archived) task that owns a given PTY session |
| `create(input)` | Insert at the end of the target swimlane (next position) |
| `update(input)` | Partial update -- only provided fields are changed |
| `move(input)` | Transactional move: shift positions in old and new swimlanes, update task |
| `archive(id)` | Set `archived_at` to now (soft-delete for Done column) |
| `unarchive(id, targetSwimlaneId, position)` | Clear `archived_at`, move to target swimlane and position |
| `listArchived()` | All archived tasks ordered by `archived_at` DESC |
| `delete(id)` | Hard delete with position shift in the owning swimlane |

### SwimlaneRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list()` | All swimlanes ordered by position ASC. Maps integer columns to booleans (`is_archived`, `auto_spawn`). |
| `getById(id)` | Single swimlane by ID |
| `create(input)` | Insert before the `done` column (if any), otherwise at the end. Shifts positions of existing columns. |
| `update(input)` | Partial update -- only provided fields are changed |
| `reorder(ids)` | Set positions from ordered array. Enforces constraints: todo must be position 0, custom columns (role=null) cannot be position 0. |
| `delete(id)` | Delete a custom column. System columns (`todo`, `done`) cannot be deleted. Columns with tasks cannot be deleted. Also cleans up related transitions and dangling `plan_exit_target_id` references. |

### ActionRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list()` | All actions ordered by name ASC |
| `getById(id)` | Single action by ID |
| `create(input)` | Insert a new action |
| `update(input)` | Partial update -- only provided fields are changed |
| `delete(id)` | Delete action and all associated transitions |
| `listTransitions()` | All transitions ordered by from_swimlane_id, to_swimlane_id, execution_order |
| `getTransitionsFor(fromId, toId)` | Get transitions for a specific move. Exact source match takes priority; falls back to wildcard `*` source if no exact match exists. |
| `getAgentSwimlaneIds()` | Returns the set of swimlane IDs that have `spawn_agent` transitions targeting them |
| `setTransitions(fromId, toId, actionIds)` | Replace all transitions for a given from/to pair. Deletes existing, inserts new with execution_order from array index. |

### SessionRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `insert(record)` | Insert a new session record (ID is auto-generated) |
| `updateStatus(id, status, extra?)` | Update session status with optional `exit_code`, `suspended_at`, `exited_at`, `suspended_by` |
| `getResumable()` | Get suspended `claude_agent` sessions that can be resumed |
| `markAllRunningAsOrphaned()` | Mark all `running` sessions as `orphaned` (crash recovery on startup) |
| `markRunningAsOrphanedExcluding(excludeTaskIds)` | Same as above but skips sessions whose task_id is in the exclusion set (prevents HMR re-entrant recovery from orphaning active sessions) |
| `getOrphaned()` | Get orphaned `claude_agent` sessions |
| `deleteByTaskId(taskId)` | Delete all session records for a given task |
| `getLatestForTask(taskId)` | Find the most recent session record for a task (by `started_at` DESC) |
| `getUserPausedTaskIds()` | Get task IDs whose latest session was user-paused (`suspended_by = 'user'`) |
| `listAllClaudeSessionIds()` | Get all distinct `claude_session_id` values (for stale session directory cleanup) |

### AttachmentRepository

Operates on a per-project DB. Manages both database records and files on disk under `<projectPath>/.kangentic/tasks/<taskId>/attachments/`.

| Method | Description |
|--------|-------------|
| `list(taskId)` | All attachments for a task ordered by `created_at` ASC |
| `getById(id)` | Single attachment by ID |
| `add(projectPath, taskId, filename, base64Data, mediaType)` | Decode base64 data, write file to disk, insert DB record. Filename is sanitized and prefixed with the attachment UUID. |
| `remove(id)` | Delete file from disk and DB record |
| `deleteByTaskId(taskId)` | Delete all attachments for a task (files + DB records). Attempts to clean up empty directories. |
| `getPathsForTask(taskId)` | Get file paths for all attachments on a task (for passing to Claude CLI) |
| `getDataUrl(id)` | Read file from disk and return as a `data:` URL with the correct media type |

### BacklogRepository

Operates on a per-project DB. Manages items in the Backlog View staging area.

| Method | Description |
|--------|-------------|
| `list()` | All backlog items ordered by position ASC |
| `getById(id)` | Single backlog item by ID |
| `create(input)` | Insert at the end (next position) |
| `update(input)` | Partial update - only provided fields are changed |
| `delete(id)` | Delete and shift positions to keep them contiguous |
| `reorder(ids)` | Set positions from ordered array of IDs |
| `bulkDelete(ids)` | Delete multiple items and reindex positions |
| `renameLabel(oldName, newName)` | Rename a label across all items |
| `deleteLabel(name)` | Remove a label from all items |
| `remapPriorities(mapping)` | Remap priority values across all items using a mapping |

## Connection Management

- `getGlobalDb()` -- singleton, created on first access.
- `getProjectDb(projectId)` -- cached per project ID, reused across the app lifecycle.
- `closeProjectDb(projectId)` -- close and remove from cache on project delete.
- `closeAll()` -- close all connections on app shutdown.

## Default Seed Data

New projects are seeded with 7 default swimlanes:

1. **To Do** (role: `todo`)
2. **Planning**
3. **Executing**
4. **Code Review**
5. **Tests**
6. **Ship It**
7. **Done** (role: `done`)

Two default actions are created:

- **Start Planning Agent** (`spawn_agent`) -- wired to transitions into the Planning column.
- **Kill Session** (`kill_session`) -- wired to transitions into the Done column.

Default transitions:

- **`* → Planning`** -- Kill Session (execution_order 0), Start Planning Agent (execution_order 1)
- **`* → Done`** -- Kill Session (execution_order 0)
