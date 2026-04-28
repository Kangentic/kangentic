/**
 * Empirically validates which exit-sequence variants actually trigger
 * graceful shutdown of the OpenCode TUI. Spawns OpenCode four separate
 * times (one per variant) inside a thin `cmd /c` (Windows) or `sh -c`
 * (Unix) wrapper so the PTY's `onExit` event fires exactly when OpenCode
 * itself terminates - giving accurate latency measurements rather than
 * the time-based force-kill the existing probes use.
 *
 * Variants:
 *   1. ctrl-c-only       - \x03
 *   2. ctrl-c-then-exit  - \x03, /exit\r  (current production sequence)
 *   3. exit-only         - /exit\r        (no Ctrl+C first)
 *   4. ctrl-c-then-quit  - \x03, /quit\r  (Gemini / Droid family)
 *   5. quit-only         - /quit\r        (no Ctrl+C first)
 *
 * Each variant prints exit latency, exit code / signal, and the last few
 * hundred bytes of ANSI-stripped output so we can see banners like
 * "Goodbye", "Unknown command", or the slash command sitting unconsumed
 * in the prompt buffer. After all variants finish the probe prints a
 * one-line verdict from a hard-coded decision matrix.
 *
 * Run: npx tsx scripts/probe-opencode-exit.ts
 */
import * as pty from 'node-pty';

const READY_TIMEOUT_MS = 5_000;
const POST_READY_SETTLE_MS = 400;
const EXIT_TIMEOUT_MS = 4_000;
const POST_KILL_DRAIN_MS = 300;

interface Variant {
  name: string;
  description: string;
  keys: string[];
  interKeyDelayMs?: number;
}

interface VariantResult {
  name: string;
  description: string;
  reachedReady: boolean;
  exitedNaturally: boolean;
  latencyMs: number | null;
  exitCode: number | null;
  signal: number | null;
  tail: string;
  notes: string[];
}

const VARIANTS: Variant[] = [
  {
    name: 'ctrl-c-only',
    description: 'write \\x03 only',
    keys: ['\x03'],
  },
  {
    name: 'ctrl-c-then-exit',
    description: 'write \\x03, settle 250ms, then /exit\\r (current production sequence)',
    keys: ['\x03', '/exit\r'],
    interKeyDelayMs: 250,
  },
  {
    name: 'exit-only',
    description: 'write /exit\\r directly with no Ctrl+C first',
    keys: ['/exit\r'],
  },
  {
    name: 'ctrl-c-then-quit',
    description: 'write \\x03, settle 250ms, then /quit\\r (Gemini / Droid family)',
    keys: ['\x03', '/quit\r'],
    interKeyDelayMs: 250,
  },
  {
    name: 'quit-only',
    description: 'write /quit\\r directly with no Ctrl+C first',
    keys: ['/quit\r'],
  },
];

function spawnOpencode(cwd: string): pty.IPty {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    // /d skips AutoRun, /c runs the command and exits when it returns.
    // PATHEXT resolution picks up opencode.cmd / opencode.exe automatically.
    return pty.spawn('cmd.exe', ['/d', '/c', 'opencode'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env } as Record<string, string>,
    });
  }
  const shell = process.env.SHELL ?? '/bin/sh';
  return pty.spawn(shell, ['-c', 'opencode'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });
}

async function runVariant(variant: Variant, cwd: string): Promise<VariantResult> {
  const ptyProcess = spawnOpencode(cwd);

  const chunks: Buffer[] = [];
  let cursorHideAt: number | null = null;
  let exitInfo: { exitCode: number; signal?: number } | null = null;
  let exitFiredAt: number | null = null;

  ptyProcess.onData((data) => {
    chunks.push(Buffer.from(data, 'binary'));
    if (cursorHideAt === null && data.includes('\x1b[?25l')) {
      cursorHideAt = Date.now();
    }
  });
  ptyProcess.onExit((event) => {
    exitInfo = event;
    exitFiredAt = Date.now();
  });

  const result: VariantResult = {
    name: variant.name,
    description: variant.description,
    reachedReady: false,
    exitedNaturally: false,
    latencyMs: null,
    exitCode: null,
    signal: null,
    tail: '',
    notes: [],
  };

  const readyDeadline = Date.now() + READY_TIMEOUT_MS;
  while (cursorHideAt === null && exitInfo === null && Date.now() < readyDeadline) {
    await sleep(50);
  }

  if (exitInfo !== null) {
    result.notes.push('PTY exited before TUI reached ready state - opencode may have failed to launch');
  } else if (cursorHideAt === null) {
    result.notes.push('TUI never reached ready state (no cursor-hide ESC[?25l within 5s)');
  } else {
    result.reachedReady = true;
    // Let the TUI fully draw before typing.
    await sleep(POST_READY_SETTLE_MS);
  }

  let sequenceWrittenAt: number | null = null;

  if (exitInfo === null) {
    const interDelay = variant.interKeyDelayMs ?? 0;
    for (let index = 0; index < variant.keys.length; index++) {
      ptyProcess.write(variant.keys[index]);
      if (index < variant.keys.length - 1 && interDelay > 0) {
        await sleep(interDelay);
      }
    }
    sequenceWrittenAt = Date.now();

    const exitDeadline = Date.now() + EXIT_TIMEOUT_MS;
    while (exitInfo === null && Date.now() < exitDeadline) {
      await sleep(50);
    }
  }

  if (exitInfo !== null && exitFiredAt !== null && sequenceWrittenAt !== null) {
    result.exitedNaturally = true;
    result.latencyMs = exitFiredAt - sequenceWrittenAt;
  }

  if (exitInfo === null) {
    try {
      (ptyProcess as unknown as { kill: (signal?: string) => void }).kill();
    } catch {
      // ignore
    }
    await sleep(POST_KILL_DRAIN_MS);
  }

  if (exitInfo !== null) {
    result.exitCode = exitInfo.exitCode;
    result.signal = exitInfo.signal ?? null;
  }

  const stdout = Buffer.concat(chunks).toString('utf-8');
  const stripped = stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  result.tail = stripped.slice(-400);
  return result;
}

function decide(results: VariantResult[]): string {
  const byName = new Map(results.map((entry) => [entry.name, entry]));
  const ctrlC = byName.get('ctrl-c-only');
  const ctrlCExit = byName.get('ctrl-c-then-exit');
  const exitOnly = byName.get('exit-only');
  const ctrlCQuit = byName.get('ctrl-c-then-quit');
  const quitOnly = byName.get('quit-only');
  if (!ctrlC || !ctrlCExit || !exitOnly || !ctrlCQuit || !quitOnly) {
    return 'INCOMPLETE: at least one variant did not produce a result.';
  }

  // Production grace period in gracefulPtyShutdown is 1500ms. Anything
  // faster than that is "Ctrl+C did its job before /exit could matter".
  const ctrlCSufficient = ctrlC.exitedNaturally && (ctrlC.latencyMs ?? Number.POSITIVE_INFINITY) < 1_500;
  const exitIsRealCommand = exitOnly.exitedNaturally;
  const quitIsRealCommand = quitOnly.exitedNaturally;

  if (ctrlCSufficient && !exitIsRealCommand && !quitIsRealCommand) {
    return 'REDUCE to [\\x03]: neither /exit nor /quit is a recognised command (typed into prompt buffer); Ctrl+C alone closes OpenCode within the grace period.';
  }

  if (exitIsRealCommand && ctrlCExit.exitedNaturally) {
    return 'KEEP [\\x03, /exit\\r]: /exit is a real graceful-close command; Ctrl+C interrupts in-flight work first.';
  }

  if (!exitIsRealCommand && quitIsRealCommand && ctrlCQuit.exitedNaturally) {
    return 'SWITCH to [\\x03, /quit\\r]: /exit is unrecognised but /quit triggers graceful close (Gemini / Droid family).';
  }

  if (!exitIsRealCommand && !quitIsRealCommand && !ctrlCSufficient) {
    return 'NEITHER /exit nor /quit triggered exit and Ctrl+C is slow; REDUCE to [\\x03] and rely on the 1.5s grace + force-kill.';
  }

  return 'AMBIGUOUS: review per-variant results manually.';
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  console.log('OpenCode exit-sequence probe');
  console.log(`cwd:           ${cwd}`);
  console.log(`platform:      ${process.platform}`);
  console.log(`ready timeout: ${READY_TIMEOUT_MS}ms`);
  console.log(`exit timeout:  ${EXIT_TIMEOUT_MS}ms`);
  console.log('');

  const results: VariantResult[] = [];
  for (const variant of VARIANTS) {
    console.log(`============================================================`);
    console.log(`VARIANT: ${variant.name}`);
    console.log(`  ${variant.description}`);
    console.log(`============================================================`);
    const result = await runVariant(variant, cwd);
    results.push(result);
    console.log(`  reached TUI-ready:  ${result.reachedReady}`);
    console.log(`  exited naturally:   ${result.exitedNaturally}`);
    console.log(`  latency:            ${result.latencyMs === null ? 'TIMEOUT' : `${result.latencyMs}ms`}`);
    console.log(`  exit code:          ${result.exitCode}`);
    console.log(`  signal:             ${result.signal}`);
    if (result.notes.length > 0) {
      for (const note of result.notes) console.log(`  note:               ${note}`);
    }
    console.log('  tail (last 400 bytes, ANSI-stripped):');
    console.log('  ----');
    const tailLines = result.tail.split('\n');
    for (const line of tailLines) console.log(`  | ${line}`);
    console.log('  ----');
    console.log('');
  }

  console.log('============================================================');
  console.log('VERDICT');
  console.log('============================================================');
  console.log(decide(results));
  console.log('');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
