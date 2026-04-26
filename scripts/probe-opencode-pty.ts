/**
 * PTY-based empirical probe for OpenCode startup. Spawns OpenCode
 * inside a real node-pty session (the same library Kangentic uses at
 * runtime) and captures the first ~5 seconds of output before sending
 * Ctrl+C and /exit to validate the graceful-quit sequence.
 *
 * Validates the four runtime claims that pure unit tests can't reach:
 *   - cursor-hide ESC[?25l appears as the first-output marker
 *   - --prompt is accepted (no flag-parse error)
 *   - the OpenCode session ID is captured by `opencode session list`
 *   - Ctrl+C + /exit cleanly terminates the session
 *
 * Run: npx tsx scripts/probe-opencode-pty.ts
 */
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const PROMPT = `kangentic-pty-probe-${Date.now()}`;
const CAPTURE_WINDOW_MS = 5_000;
const POST_EXIT_WAIT_MS = 1_500;

interface SessionEntry {
  id: string;
  directory: string;
  created: number;
  updated: number;
  title: string;
  projectId: string;
}

async function listSessions(maxCount: number): Promise<SessionEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      'opencode',
      ['session', 'list', '--format', 'json', '--max-count', String(maxCount)],
      { timeout: 5_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const spawnedAt = Date.now();
  console.log(`Spawning OpenCode in PTY at ${cwd}`);
  console.log(`Capture window: ${CAPTURE_WINDOW_MS}ms`);
  console.log(`Probe prompt:   ${PROMPT}\n`);

  const isWindows = process.platform === 'win32';
  const shellExe = isWindows ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
  const shellArgs = isWindows ? ['-NoLogo'] : ['--login'];

  const ptyProcess = pty.spawn(shellExe, shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });

  const chunks: Buffer[] = [];
  let firstChunkAt: number | null = null;
  let cursorHideAt: number | null = null;

  ptyProcess.onData((data) => {
    const buf = Buffer.from(data, 'binary');
    chunks.push(buf);
    if (firstChunkAt === null) firstChunkAt = Date.now();
    if (cursorHideAt === null && data.includes('\x1b[?25l')) {
      cursorHideAt = Date.now();
    }
  });

  // Build the same command shape our adapter would emit, but inline
  // so this script is self-contained for validation purposes.
  const opencodeBinary = isWindows ? 'opencode' : 'opencode';
  const innerCommand = `${opencodeBinary} --prompt "${PROMPT}"`;

  // Give the shell ~300ms to print its prompt, then send the command.
  await sleep(300);
  ptyProcess.write(innerCommand + '\r');

  await sleep(CAPTURE_WINDOW_MS);

  // Validate exit sequence: Ctrl+C, then /exit\r (matches adapter.getExitSequence()).
  console.log('--- sending Ctrl+C ---');
  ptyProcess.write('\x03');
  await sleep(800);
  console.log('--- sending /exit\\r ---');
  ptyProcess.write('/exit\r');
  await sleep(POST_EXIT_WAIT_MS);

  let exitCode: number | null = null;
  try {
    if (typeof (ptyProcess as unknown as { kill: (signal?: string) => void }).kill === 'function') {
      (ptyProcess as unknown as { kill: (signal?: string) => void }).kill();
    }
  } catch {
    // ignore
  }

  const stdout = Buffer.concat(chunks).toString('utf-8');

  console.log('\n============================================================');
  console.log('OUTPUT SUMMARY');
  console.log('============================================================');
  console.log('  bytes captured:               ', Buffer.byteLength(stdout, 'utf-8'));
  console.log('  first chunk at (ms after t0): ', firstChunkAt ? firstChunkAt - spawnedAt : 'n/a');
  console.log('  cursor-hide ESC[?25l seen?    ', cursorHideAt !== null);
  if (cursorHideAt !== null) {
    console.log('  cursor-hide at (ms after t0): ', cursorHideAt - spawnedAt);
  }
  console.log('  prompt text echoed in PTY?    ', stdout.includes(PROMPT));

  console.log('\n--- first 2 KiB stripped of ANSI ---');
  const stripped = stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log(stripped.slice(0, 2_048));

  console.log('\n============================================================');
  console.log('SESSION CAPTURE');
  console.log('============================================================');
  const sessions = await listSessions(5);
  const matching = sessions.find((entry) => {
    const matchCwd = path.normalize(entry.directory).toLowerCase() === path.normalize(cwd).toLowerCase();
    const matchTime = entry.created >= spawnedAt - 5_000 && entry.created <= spawnedAt + 60_000;
    return matchCwd && matchTime;
  });
  if (matching) {
    console.log('Captured session:');
    console.log('  id:         ', matching.id);
    console.log('  title:      ', matching.title);
    console.log('  created:    ', new Date(matching.created).toISOString());
    console.log('  directory:  ', matching.directory);
    console.log('\nValidates: captureSessionIdFromFilesystem strategy (shell-out) is correct.');
  } else {
    console.log('No matching session found via `opencode session list --format json`.');
    console.log('Sessions present:');
    for (const entry of sessions.slice(0, 5)) {
      console.log(`  ${entry.id} / ${new Date(entry.created).toISOString()} / ${entry.directory}`);
    }
  }

  console.log('\n============================================================');
  console.log('OPENCODE.DB');
  console.log('============================================================');
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  try {
    const fs = await import('node:fs');
    const stat = fs.statSync(dbPath);
    console.log(`  ${dbPath}`);
    console.log(`  size:           ${stat.size} bytes`);
    console.log(`  last modified:  ${new Date(stat.mtimeMs).toISOString()}`);
  } catch (error) {
    console.log(`  ${dbPath} - not found (${(error as Error).message})`);
  }

  console.log('\nDone.');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
