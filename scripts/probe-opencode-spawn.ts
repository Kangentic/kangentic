/**
 * Empirical PTY-style probe of OpenCode startup output.
 *
 * Spawns `opencode --prompt <text> --log-level DEBUG`, captures stdout
 * and stderr for ~4 seconds, then SIGTERM. Reports:
 *
 *   - Whether the cursor-hide ESC sequence (\x1b[?25l) appears in
 *     stdout (validates `detectFirstOutput`)
 *   - Whether the prompt text is referenced in stderr debug logs
 *     (validates `--prompt` is parsed and delivered)
 *   - First 4 KiB of stdout and stderr for human review
 *
 * Run: npx tsx scripts/probe-opencode-spawn.ts
 */
import { spawn } from 'node:child_process';

const PROMPT = 'kangentic-empirical-probe-12345';
const TIMEOUT_MS = 4_000;

function summarize(buffer: Buffer): {
  hasCursorHide: boolean;
  hasPrompt: boolean;
  byteCount: number;
  preview: string;
} {
  const ascii = buffer.toString('utf-8');
  const printable = ascii.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '<ESC>');
  return {
    hasCursorHide: ascii.includes('\x1b[?25l'),
    hasPrompt: ascii.includes(PROMPT),
    byteCount: buffer.length,
    preview: printable.slice(0, 4_096),
  };
}

async function main(): Promise<void> {
  console.log(`Spawning: opencode --prompt "${PROMPT}" --log-level DEBUG`);
  console.log(`Capture window: ${TIMEOUT_MS}ms\n`);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const child = spawn(
    'opencode',
    ['--prompt', PROMPT, '--log-level', 'DEBUG'],
    { shell: false, windowsHide: true },
  );

  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });

  await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
  if (child.exitCode === null) {
    child.kill('SIGTERM');
  }
  const exitCode = await Promise.race([
    exited,
    new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 1_500)),
  ]);

  const stdout = summarize(Buffer.concat(stdoutChunks));
  const stderr = summarize(Buffer.concat(stderrChunks));

  console.log('============================================================');
  console.log('Exit code:', exitCode);
  console.log('============================================================');
  console.log('STDOUT summary:');
  console.log('  bytes captured:           ', stdout.byteCount);
  console.log('  cursor-hide ESC[?25l seen?', stdout.hasCursorHide);
  console.log('  prompt text in stdout?    ', stdout.hasPrompt);
  console.log('--- stdout preview (ANSI replaced with <ESC>) ---');
  console.log(stdout.preview || '(empty)');
  console.log('============================================================');
  console.log('STDERR summary:');
  console.log('  bytes captured:           ', stderr.byteCount);
  console.log('  cursor-hide ESC[?25l seen?', stderr.hasCursorHide);
  console.log('  prompt text in stderr?    ', stderr.hasPrompt);
  console.log('--- stderr preview (ANSI replaced with <ESC>) ---');
  console.log(stderr.preview || '(empty)');
  console.log('============================================================');
}

main().catch((error) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
