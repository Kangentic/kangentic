/**
 * Validate OpenCodeSessionHistoryParser against the live OpenCode DB.
 *
 * Reads the most recent session row, then asks the parser to:
 *   1. captureSessionIdFromFilesystem - given a spawnedAt window that
 *      bracket the session's created timestamp, does it return the
 *      same ID?
 *   2. locate - given the captured ID, does it return the DB path?
 *
 * Run: npx tsx scripts/probe-opencode-parser.ts
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeSessionHistoryParser } from '../src/main/agent/adapters/opencode/session-history-parser';

interface SessionEntry {
  id: string;
  directory: string;
  created: number;
  updated: number;
  title: string;
  projectId: string;
}

async function main(): Promise<void> {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const sessions = db
    .prepare<[], { id: string; directory: string; time_created: number; time_updated: number; title: string; project_id: string }>(
      'SELECT id, directory, time_created, time_updated, title, project_id FROM session ORDER BY time_created DESC LIMIT 1',
    )
    .all()
    .map<SessionEntry>((row) => ({
      id: row.id,
      directory: row.directory,
      created: row.time_created,
      updated: row.time_updated,
      title: row.title,
      projectId: row.project_id,
    }));
  db.close();

  if (sessions.length === 0) {
    console.log('No sessions in DB. Run `opencode --prompt "hello"` once and re-run this probe.');
    process.exit(1);
  }

  const target = sessions[0];
  console.log('Target session row from `opencode session list`:');
  console.log('  id:        ', target.id);
  console.log('  directory: ', target.directory);
  console.log('  created:   ', new Date(target.created).toISOString());
  console.log();

  // Test 1: captureSessionIdFromFilesystem with a spawn window that
  // brackets the target's `created` timestamp. Use 1 attempt + 0
  // polling so it's a quick smoke test, not a 10s wait.
  console.log('--- Test 1: captureSessionIdFromFilesystem ---');
  const captured = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
    spawnedAt: new Date(target.created), // exact match - within our floor/ceil
    cwd: target.directory,
    maxAttempts: 1,
  });
  console.log('  captured:  ', captured);
  console.log('  match:     ', captured === target.id ? 'YES (parser returned the right ID)' : 'NO');

  // Test 2: locate with the captured ID
  console.log('\n--- Test 2: locate ---');
  const located = await OpenCodeSessionHistoryParser.locate({
    agentSessionId: target.id,
    cwd: target.directory,
  });
  console.log('  located:   ', located);
  const looksLikeDb = located?.endsWith('opencode.db') ?? false;
  console.log('  match:     ', looksLikeDb ? 'YES (got opencode.db path)' : 'NO');

  // Test 3: locate with a bogus ID
  console.log('\n--- Test 3: locate (negative case - bogus ID) ---');
  const bogus = await OpenCodeSessionHistoryParser.locate({
    agentSessionId: 'ses_bogus_does_not_exist_xx',
    cwd: target.directory,
  });
  console.log('  located:   ', bogus);
  console.log('  match:     ', bogus === null ? 'YES (correctly returned null)' : 'NO');

  // Test 4: capture with a spawnedAt before our window (should miss)
  console.log('\n--- Test 4: captureSessionIdFromFilesystem (out-of-window) ---');
  const tooOld = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
    spawnedAt: new Date(target.created + 60_000 + 1), // outside +30s ceil
    cwd: target.directory,
    maxAttempts: 1,
  });
  console.log('  captured:  ', tooOld);
  console.log('  match:     ', tooOld === null ? 'YES (correctly returned null)' : 'NO');

  // Test 5: capture with a non-matching cwd (should miss)
  console.log('\n--- Test 5: captureSessionIdFromFilesystem (wrong cwd) ---');
  const wrongCwd = await OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
    spawnedAt: new Date(target.created),
    cwd: 'C:/no/such/path',
    maxAttempts: 1,
  });
  console.log('  captured:  ', wrongCwd);
  console.log('  match:     ', wrongCwd === null ? 'YES (correctly returned null)' : 'NO');

  console.log('\nDone.');
}

main().catch((error) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
