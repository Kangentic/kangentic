---
type: Reference
title: Storage model
description: The two-database split, where index.db and each project database live (KANGENTIC_DATA_DIR override), the WAL pragmas and checkpoint policy, the dialog and softly() fallback when index.db cannot be read, the global tables, connection helpers and the seven default swimlanes.
tags: [database, sqlite, wal, storage]
sources:
  - resource: src/main/db/database.ts
  - resource: src/main/db/global-db-dialog.ts
  - resource: src/main/db/soft-db.ts
  - resource: src/main/db/migrations/global-schema.ts
  - resource: src/main/db/migrations/default-data.ts
  - resource: src/main/retrieval/checkpoint-driver.ts
  - resource: src/main/retrieval/worker/checkpoint-pacing.ts
---
# Storage model

## Two-Database Architecture

Kangentic uses a two-database design:

- **Global DB** (`<configDir>/index.db`) -- stores the project list, global configuration, and dev-server port reservations.
- **Per-project DB** (`<configDir>/projects/<projectId>.db`) -- stores tasks, swimlanes, actions, and sessions for a single project.

This separation keeps project data isolated. Deleting a project removes its database file. First it
takes its tasks out of the workflows other databases hold (`detachProjectFromWorkflows`): links in
other homes that name its tasks go, tasks on other boards in a workflow it was home to become
ordinary tasks, and a running or paused workflow homed elsewhere that is left with no task is
deleted from its home database (only when every board could be read). Nothing else in another
project's database changes.

## Database Locations

The config directory is platform-dependent:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%/kangentic/` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`) |

Overridable via the `KANGENTIC_DATA_DIR` environment variable. When set, all database files are stored under that directory instead of the platform default.

## Configuration

All database connections are opened with three pragmas, in this order:

- `busy_timeout = 5000` -- wait up to 5 seconds on locked databases before returning SQLITE_BUSY
- `journal_mode = WAL` -- concurrent reads without blocking writers
- `foreign_keys = ON` -- enforce referential integrity on all foreign key constraints

`synchronous` is left unset on purpose. better-sqlite3 compiles SQLite with
`SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so a connection in WAL mode already runs at NORMAL: a commit
appends to the WAL without syncing it to disk, and the sync happens at checkpoint. Measured with
the app's build, thirty commits take 0.4 ms at that default and 26 ms at FULL. NORMAL in WAL mode
keeps the database consistent and gives up only the last few commits on a power cut or OS crash.
The switch to WAL fails silently where the filesystem cannot support it (the pragma returns the old
mode rather than throwing), and such a database keeps the FULL default, which is the safe setting
for a rollback journal. Setting NORMAL explicitly would take that fallback away, which is why
`tests/unit/global-db-degradation.test.ts` pins the exact three.

A project connection adds two more after those. `journal_size_limit = 67108864` truncates a WAL
that grew past 64 MB in a burst back to that size when a checkpoint resets it. `wal_autocheckpoint`
decides who checkpoints. SQLite runs an auto-checkpoint on the connection whose commit crosses the
limit, so on main it put the copy into the database file, and its sync, on the main thread (a sums
write that normally takes a few ms reached 19 ms). While the retrieval worker is up, main sets it to
0 and the worker runs a PASSIVE checkpoint of every project database main has open every 5 s
(`src/main/retrieval/checkpoint-driver.ts`, the worker's `db.checkpoint` method), skipping a tick
while the last one is still running. PASSIVE never waits for or blocks a writer, which is why it is
the only mode used: FULL, RESTART and TRUNCATE wait on writers and would make main wait. The
worker's and the pty host's connections set 0 too, so no checkpoint runs inside a commit. With the
default of 1000 pages on the worker, its next commit after a terminal flood also checkpointed every
page the pty host had written since the last checkpoint, 363 to 479 ms inside a 16-row commit, and
every request behind it waited. At 5 s a checkpoint copies at most 5 s of writes; on a 30 s interval
the same flood made one 476 ms step of 65,897 pages. The 5 s request waits behind a long worker
job, so the worker also checkpoints a connection after its own commits, at most once a second
(`src/main/retrieval/worker/checkpoint-pacing.ts`, run by `writeTransaction`'s after-commit hook):
during the Source code fill its checkpoints stayed at 19 ms or less. The bulk upkeep jobs write
through the same transactions, so the same pacer covers them. When the worker goes down
(restarting, or latched off after repeated crashes), main sets 1000 back at once, so no WAL grows
unchecked.

The order matters. `busy_timeout` is a connection setting that covers only the statements after
it, and `journal_mode = WAL` takes a lock: it creates the `-wal` and `-shm` sidecars. Setting the
timeout second would leave the WAL switch, the one statement most likely to collide, with no retry
window at all.

All queries are synchronous via **better-sqlite3** -- they block the Node.js event loop briefly but avoid callback complexity.

A connection is published to its module cache only after the pragmas and migrations have both
succeeded. On failure the half-built handle is closed and the error is rethrown, so a retry
reopens rather than reusing a connection that never ran migrations. `resetGlobalDb()` drops the
cached global connection deliberately, which is what the Retry button below reopens through.

## When the global database cannot be read

`SQLITE_IOERR`, `SQLITE_READONLY`, and `SQLITE_BUSY` on `index.db` are environmental: an antivirus
scan, a OneDrive or Dropbox sync lock, a read-only or full volume, or failing storage. There is
nothing to fix in the query, so the policy is to say so rather than to retry silently or fail
opaquely.

**At startup.** `ensureGlobalDbReadable()` (`src/main/db/global-db-dialog.ts`) opens the database
early in the `app.whenReady()` body, before the MCP server starts and before any window exists. A
failure shows a modal naming the resolved file path, the SQLite code (or the plain error message
when the failure carries no `SQLITE_*` code, such as a native addon that will not load), and the
likely causes, with Retry and Quit. Retry drops the cached connection and reopens; a lock is usually over within
seconds, so this recovers without a relaunch. Quit counts an `app_error` and calls `app.exit(0)`,
which is correct rather than `app.quit()` because `registerAllIpc` has not run yet and
`performShutdown` would throw reaching for a board config manager that does not exist. Under
`NODE_ENV=test` the dialog is skipped so the E2E tier never hangs on a modal nobody can click.

**While running.** Global-database reads go through `softly()` (`src/main/db/soft-db.ts`), which
returns a fallback instead of throwing and logs once per operation. Four operations are softened:
`project:list`, `projectGroup:list` and `project:getCurrent` in
`src/main/ipc/handlers/projects.ts`, plus `lastOpenedProject`, which is read at two call sites
inside `createWindow()`: once to resolve the boot project path, and again inside the
`preloadPromise` catch block when that path turns out to be missing. Neither is an IPC handler,
and the first is the first global-database touch on the whole boot path, which is exactly where
DESKTOP-9 threw. Both share the one operation name, so a failure at either logs once for the pair.

Only the two list reads raise the dialog, once per incident: a successful Retry re-arms it, so a
later outage can still speak. `project:getCurrent` does not, because `project:list` already speaks
for the pair and it answers null on the cold-boot path anyway.

`createWindow()` is additionally wrapped in `try`/`finally`, because the `lastOpenedProject` read
sits below its own `loadURL` call. A throw there used to skip `initUpdater`, `initAnnouncements`
and `markStartupComplete`, leaving a live renderer invoking `announcements:get` with nobody
listening (Sentry DESKTOP-3/4, the Windows event). Softening the read and making the block
throw-proof are two layers against the same failure, not separate concerns.

Writes are never softened: a mutation that swallows its failure reports a success that did not
happen (see `.claude/rules/project-scoped-ipc.md`).

Advisory tables opt out of the notification. The dev-port lease ledger degrades on every unit-tier
CI run by design, so it passes `level: 'warn'` and no `notify`; wiring the dialog into the
combinator itself would show it to production users and consume the one notification the project
list needs.

## Global DB Schema

### projects table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| path | TEXT | NOT NULL | |
| github_url | TEXT | | NULL |
| default_agent | TEXT | NOT NULL | 'claude' |
| default_model | TEXT | | NULL |
| default_effort | TEXT | | NULL |
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

### dev_ports table

Dev-server port reservations. GLOBAL rather than per-project by necessity, not
by policy: ports are a machine-wide resource, so two projects both defaulting to
5173 is exactly the collision a per-project table could not see.

| Column | Type | Constraints |
|--------|------|-------------|
| port | INTEGER | PRIMARY KEY |
| project_id | TEXT | NOT NULL |
| task_id | TEXT | NOT NULL |
| allocated_at | TEXT | NOT NULL |

Indexes: `idx_dev_ports_project` on `project_id`, and `idx_dev_ports_task` on
`task_id`. The `task_id` index is deliberately **NOT unique** -- a task may hold
several ports (an API, a frontend, a mock server), reserved together so a
sibling task cannot be handed one in between. `port` stays the primary key, so a
PORT still cannot be held twice.

A row is ADVISORY, never authoritative: whether a port is actually usable is
answered by a bind-and-connect probe (`src/main/dev-ports/dev-port-allocator.ts`),
which is what lets a stale reservation self-correct instead of permanently
burning a port. Rows are released when the task is deleted
(`TaskRepository.delete`) or its project is removed (`ProjectRepository.delete`);
there is no background reclaim.

## Connection Management

- `getGlobalDb()` -- singleton, created on first access.
- `getProjectDb(projectId)` -- cached per project ID, reused across the app lifecycle. On main it
  creates, migrates and seeds a database that is not there.
- `getExistingProjectDb(projectId)` reads an id another record stored (a workflow's home, a link's
  far end, a planned task's board), which can outlive its project. It returns the open connection,
  or opens one only when the file is there, and returns null otherwise. It never creates a file.
- `getOpenProjectDb(projectId)` returns the open connection and never opens one, for a late
  transcript flush.
- `peekProjectDb(projectId, read)` runs `read` on a throwaway connection: no WAL switch (only a
  100 ms busy timeout), no migrations, no cached handle, closed after. It returns null when the
  file does not exist. The workflow engine looks at an unopened board through it. The connection
  is read-write but only reads, since closing a read-only connection to a WAL database leaves its
  `-wal` and `-shm` behind.
- `closeProjectDb(projectId)` -- close and remove from cache on project delete.
- `closeAll()` -- close all connections on app shutdown.

## Default Seed Data

New projects are seeded with 7 default swimlanes:

1. **To Do** (role: `todo`)
2. **Planning**
3. **Executing**
4. **Code Review**
5. **Testing**
6. **Merge**
7. **Done** (role: `done`, seeded `is_archived = 1`)

Done is the one lane seeded archived, and that is structural rather than a user choice: the board
renders it as the collapsed `DoneSwimlane` instead of a normal column, and `apply-config.ts` forces
the flag back on for the `done` role on every board-config apply. Anything that filters swimlanes on
`is_archived` therefore drops Done unless it carves the role out, which is why the MCP read tools
have explicit done-column handling. See
[kangentic_list_columns](../integrations/mcp-server/column-tools.md#kangentic_list_columns).

No lane is seeded with a `description`: it is left empty for the user to fill in, because a
`description` round-trips into the project's committed `kangentic.json` and a prefilled one would
land in every user's repo. The seed is bound to the UI tier's mock copy by
`tests/unit/default-swimlanes-seed-parity.test.ts`.

**No automations are seeded either, and no actions or transitions.** A fresh board starts with an
empty automations list on every column, which is also how the old seed behaved: each of the three
rows it created was a no-op or a duplicate of the move path. Kill Session found no active session
at Priority 4, and Start Planning Agent carried exactly the prompt template the fallback spawn
already uses. `seedActionsAndTransitions` and `seedDefaultActions` are gone with them.

Planning still opens its agent in plan mode. That comes from the column's own `permission_mode`,
not from a seeded row.
