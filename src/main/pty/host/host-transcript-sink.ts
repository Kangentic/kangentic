/**
 * The pty host's own connection to a project's database, for the raw transcript
 * pieces (`TranscriptWriter`). Opened with `fileMustExist` and no migrations
 * (main opened and migrated it first), so a late flush for a deleted project
 * throws and is dropped instead of creating the file again.
 *
 * A database that is there and will not open is another matter. The writer
 * asks for the sink on every flush and gets none, so every chunk of every
 * session in that project is dropped, and no flush ever fails to say so. That
 * open failure is relayed to main once (`transcript_open`).
 *
 * Its own module so a unit test can run it: `pty-host-entry.ts` reads
 * `process.parentPort` when it loads. Host-safe: no `electron`, no analytics.
 */

import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getProjectDb, projectDbPath } from '../../db/database';
import { TranscriptRepository } from '../../db/repositories/transcript-repository';
import type { TranscriptSink } from '../buffer/transcript-writer';
import type { HostHandledErrors } from './host-handled-error';

export function createTranscriptSinkFor(
  handledErrors: Pick<HostHandledErrors, 'report'>,
): (projectId: string) => TranscriptSink | null {
  const transcriptRepositories = new WeakMap<Database.Database, TranscriptRepository>();
  return (projectId) => {
    let db: Database.Database;
    try {
      db = getProjectDb(projectId);
    } catch (error) {
      // No file is a project that was deleted, whose late flush is dropped by
      // design. A file that is there and will not open loses every chunk of the
      // project's sessions to the viewer, search and the token ledger.
      if (fs.existsSync(projectDbPath(projectId))) handledErrors.report('transcript_open', error);
      return null;
    }
    let repository = transcriptRepositories.get(db);
    if (!repository) {
      repository = new TranscriptRepository(db);
      transcriptRepositories.set(db, repository);
    }
    return repository;
  };
}
