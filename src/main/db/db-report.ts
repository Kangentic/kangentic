/**
 * Database-layer failures that are caught where they happen and answered with a default.
 *
 * A database that will not OPEN or MIGRATE reports from the open path
 * (`notifyOpenFailure` in `database.ts`, wired to `dbOpenReporter` and
 * `dbMigrationReporter` in `src/main/index.ts`). This reporter is for what happens
 * on a database that did open: a soft read that degraded with nobody told, a stored
 * value only Kangentic writes that will not parse, a listener of a table's changes
 * throwing, the failure dialog itself failing to show.
 *
 * A SQLite failure is an environment failure and groups by its code
 * (`['handled-env', name, code]`), so a locked or full disk is one issue however
 * many reads met it. Each site names its step in `stage`, a fixed word. No row
 * value, table content, file path or project name rides a tag.
 *
 * A leaf module, importable from anything under `src/main/db` with no cycle.
 * The retrieval worker opens databases too and cannot report: it never imports
 * this, and answers main with a fixed code instead.
 */

import { createChokepointReporter, type ChokepointReporter } from '../analytics/handled-report';

export const dbReporter: ChokepointReporter = createChokepointReporter('db');
