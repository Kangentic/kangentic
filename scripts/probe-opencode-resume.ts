/**
 * Empirically verify `opencode --session <id>` actually resumes a
 * prior session.
 *
 * Reads the most recent session row from `opencode.db` directly,
 * then spawns OpenCode with `--session <that_id>` in a node-pty
 * session. Captures the first ~5 seconds of output and looks for
 * evidence that the prior conversation was loaded (the session
 * title, prior message text, or any non-error first frame).
 *
 * Run: npx tsx scripts/probe-opencode-resume.ts
 *
 * Note: requires better-sqlite3 to be rebuilt for system Node first
 * (`npm rebuild better-sqlite3`). Restore via `node scripts/rebuild-native.js`
 * afterwards.
 */
import * as pty from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const CAPTURE_WINDOW_MS = 6_000;

interface SessionRow {
  id: string;
  directory: string;
  time_created: number;
  title: string;
}

function readMostRecent(): SessionRow {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare<[], SessionRow>(
        'SELECT id, directory, time_created, title FROM session ORDER BY time_created DESC LIMIT 1',
      )
      .get();
    if (!row) throw new Error('No sessions in DB.');
    return row;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const target = readMostRecent();
  console.log('Resuming most recent session:');
  console.log('  id:        ', target.id);
  console.log('  title:     ', target.title);
  console.log('  directory: ', target.directory);
  console.log('  created:   ', new Date(target.time_created).toISOString());
  console.log();

  const isWindows = process.platform === 'win32';
  const shellExe = isWindows ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
  const shellArgs = isWindows ? ['-NoLogo'] : ['--login'];

  const ptyProcess = pty.spawn(shellExe, shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: target.directory,
    env: { ...process.env } as Record<string, string>,
  });

  const chunks: Buffer[] = [];
  let cursorHideAt: number | null = null;
  const t0 = Date.now();

  ptyProcess.onData((data) => {
    chunks.push(Buffer.from(data, 'binary'));
    if (cursorHideAt === null && data.includes('\x1b[?25l')) {
      cursorHideAt = Date.now();
    }
  });

  await sleep(300);
  // Build the same shape OpenCodeCommandBuilder emits for resume.
  const command = `opencode --session ${target.id}`;
  console.log('Sending command:');
  console.log(`  ${command}\n`);
  ptyProcess.write(command + '\r');

  await sleep(CAPTURE_WINDOW_MS);

  console.log('--- sending Ctrl+C ---');
  ptyProcess.write('\x03');
  await sleep(800);
  console.log('--- sending /exit\\r ---');
  ptyProcess.write('/exit\r');
  await sleep(1_500);

  try {
    (ptyProcess as unknown as { kill: (signal?: string) => void }).kill();
  } catch {
    // ignore
  }

  const stdout = Buffer.concat(chunks).toString('utf-8');
  const stripped = stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

  console.log('\n============================================================');
  console.log('OUTPUT SUMMARY');
  console.log('============================================================');
  console.log('  bytes captured:                 ', stdout.length);
  console.log('  cursor-hide at (ms after t0):   ', cursorHideAt !== null ? cursorHideAt - t0 : 'not seen');
  console.log('  session ID echoed in scrollback?', stdout.includes(target.id));
  console.log('  session title in scrollback?    ', stdout.includes(target.title));
  console.log('  contains ERROR text?            ', /error|fail|invalid/i.test(stripped));

  console.log('\n--- first 3 KiB stripped ---');
  console.log(stripped.slice(0, 3_072));
  console.log('--- end ---');

  // Verify the resumed session's time_updated changed (i.e. OpenCode
  // actually attached and touched the row, not silently errored).
  const after = readMostRecent();
  console.log('\nDB time_updated:');
  console.log('  before:', new Date(target.time_created).toISOString(), '(time_created of original spawn)');
  console.log('  after :', new Date(after.time_created).toISOString(), '(most recent now)');
  console.log('  same row?', after.id === target.id ? 'YES' : `NO (most recent is now ${after.id})`);

  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
