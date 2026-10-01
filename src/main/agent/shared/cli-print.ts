import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawnOffMainCli, toHostEnvironment, type CliChildProcess } from '../../utility-process/off-main-cli';
import { childHasExited, killChildTreeByPid, stopChildTree } from '../../shared/child-tree-stop';

/**
 * One headless run of an agent CLI: prompt in, output out, no PTY and no
 * `sessions` row. Every one-shot run goes through here, shaped by its caller:
 * a task title (`auto-name.ts`), an answer (`cli-answer.ts`). The warm answer
 * session spawns its CLI here too (`spawnCli`), and every run is tracked so a
 * chat that ends, or the app quitting, can stop it.
 */

export interface RunCliPrintOptions {
  cliPath: string;
  /** Fixed CLI args (subcommand, flags). When `promptVia: 'arg'`, the prompt is appended
   *  to this list as the final positional argument. */
  args: string[];
  /** The prompt, already wrapped for its shape (`buildSummarizePrompt` for a title). */
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * How the prompt is delivered to the CLI:
   *   - 'stdin' (default): piped via the child's stdin, args are unchanged.
   *   - 'arg': appended to args as the final positional argument; stdin is closed empty.
   *   - 'file': written to a file in `cwd` whose path follows `promptFileFlag`, for a
   *     CLI that reads its prompt from a file and not from stdin.
   * Use 'arg' only for a short prompt (a title): Windows caps a command line at
   * 32,767 characters, and 8,191 through cmd.exe, so an answer-sized prompt must
   * use 'stdin' or 'file'.
   */
  promptVia?: 'stdin' | 'arg' | 'file';
  /** The flag that names the prompt file, when `promptVia` is 'file'
   *  (`--prompt-file`, `--message-file`). */
  promptFileFlag?: string;
  /** Where a `promptVia: 'file'` run writes its prompt. Defaults to `cwd`; an
   *  answer run passes its run directory, since its `cwd` is shared. */
  promptDirectory?: string;
  /**
   * Optional pre-cleanup transform: receives raw stdout, returns the candidate text to
   * feed into `shape`. Useful when the CLI emits NDJSON / stream-json: the adapter
   * parses each line, picks the final assistant message, and returns its `text` field.
   * Returning empty string (or throwing) marks the run as a failure.
   */
  extractRaw?: (stdout: string) => string;
  /**
   * Optional environment variables merged into the spawn. Adapters that need to disable
   * a TUI banner via env var (e.g. `NO_COLOR=1`, custom analytics opt-out) supply them here.
   */
  env?: Record<string, string>;
  /** Bytes of stdout accepted before the child is terminated. */
  outputBudget?: number;
  /**
   * Turns captured stdout (after `extractRaw`) into the returned value: one
   * line for a title (`cleanSummarizeOutput`), the whole text for an answer
   * (`cleanAnswerOutput`). One spawn, several output shapes, rather than a copy
   * of the spawn per shape.
   */
  shape?: (candidate: string) => string;
  /**
   * Called for each stdout chunk as it arrives, BEFORE the buffered result is
   * assembled. The streaming answer path uses this to forward text deltas to
   * the renderer while the CLI is still writing; the buffered result is still
   * returned whole at the end so nothing structural is parsed off a partial.
   */
  onChunk?: (chunk: string) => void;
}

/** What a shape's wrapper must decide; the rest of `RunCliPrintOptions` is the adapter's. */
export type ShapedCliPrintOptions = RunCliPrintOptions & {
  timeoutMs: number;
  outputBudget: number;
  shape: (candidate: string) => string;
};

/** The file a `promptVia: 'file'` run writes into its `cwd`. */
const PROMPT_FILE_NAME = 'kangentic-prompt.md';

/**
 * Spawn the CLI, deliver the prompt, capture up to `outputBudget` bytes of
 * stdout, run `extractRaw` when given, and return what `shape` makes of it.
 * Rejects on a non-zero exit, a timeout, or empty output.
 */
export async function runCliPrint(options: ShapedCliPrintOptions): Promise<string> {
  const {
    cliPath,
    args,
    prompt,
    cwd,
    timeoutMs,
    promptVia = 'stdin',
    promptFileFlag,
    promptDirectory = cwd,
    extractRaw,
    env,
    outputBudget,
    shape,
    onChunk,
  } = options;

  // Written before the spawn and removed when the call ends, whatever the
  // outcome. The caller owns the directory; this owns only the one file it
  // wrote there.
  let promptFilePath: string | null = null;
  if (promptVia === 'file') {
    if (!promptFileFlag) throw new Error('promptVia "file" needs a promptFileFlag');
    promptFilePath = path.join(promptDirectory, PROMPT_FILE_NAME);
    // sync-write-ok: the CLI cannot run without its prompt file, so a failed
    // write rejects this call, and its caller reports it to the user.
    fs.writeFileSync(promptFilePath, prompt, 'utf-8');
  }

  try {
    return await runResolvedCliPrint({
      cliPath, args, prompt, cwd, timeoutMs, promptVia, promptFilePath, promptFileFlag,
      extractRaw, env, outputBudget, shape, onChunk,
    });
  } finally {
    // `force` covers a file already gone. A Windows handle the CLI still holds
    // (a timed-out run is still alive) throws EBUSY or EPERM instead, and a
    // throw here would replace the answer or the real error with a cleanup
    // one. The next run overwrites the file, and its owner removes the folder.
    if (promptFilePath) {
      try {
        fs.rmSync(promptFilePath, { force: true });
      } catch {
        // Left for the directory's owner.
      }
    }
  }
}

/** `RunCliPrintOptions` with every default applied and the prompt file resolved. */
interface ResolvedPrintOptions {
  cliPath: string;
  args: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  promptVia: 'stdin' | 'arg' | 'file';
  promptFilePath: string | null;
  promptFileFlag: string | undefined;
  extractRaw: ((stdout: string) => string) | undefined;
  env: Record<string, string> | undefined;
  outputBudget: number;
  shape: (candidate: string) => string;
  onChunk: ((chunk: string) => void) | undefined;
}

function runResolvedCliPrint(resolved: ResolvedPrintOptions): Promise<string> {
  const {
    cliPath,
    args,
    prompt,
    cwd,
    timeoutMs,
    promptVia,
    promptFilePath,
    promptFileFlag,
    extractRaw,
    env,
    outputBudget,
    shape,
    onChunk,
  } = resolved;

  return new Promise<string>((resolve, reject) => {
    const finalArgs = promptVia === 'arg'
      ? [...args, prompt]
      : promptVia === 'file' && promptFilePath && promptFileFlag
        ? [...args, promptFileFlag, promptFilePath]
        : args;
    const child = spawnCli(cliPath, finalArgs, cwd, env);

    let stdoutSize = 0;
    const stdoutChunks: Buffer[] = [];
    // Holds a character split across two pipe reads until its last byte lands,
    // so the streamed text never shows U+FFFD where the buffered copy is whole.
    const chunkDecoder = new StringDecoder('utf8');
    const stderrChunks: Buffer[] = [];
    let terminated = false;
    let timedOut = false;
    let exitWait: ReturnType<typeof setTimeout> | null = null;

    // A timed-out run rejects once the CLI is gone, or after EXIT_WAIT_MS if it
    // will not go. Rejecting at once let the caller remove the run directory
    // while the CLI still held it, and a directory Windows cannot remove keeps
    // the MCP config and its live token on disk.
    const timer = setTimeout(() => {
      timedOut = true;
      terminated = true;
      stopCli(child);
      exitWait = setTimeout(() => reject(new Error('the agent timed out')), EXIT_WAIT_MS);
      exitWait.unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > outputBudget) {
        // Stopped once: every chunk past the budget lands here, and on Windows
        // it would otherwise start one taskkill per chunk.
        if (!terminated) stopCli(child);
        terminated = true;
      } else {
        stdoutChunks.push(chunk);
        // Forwarded as it lands, so a streaming consumer sees the text while
        // the CLI is still writing. The buffered copy above is still what the
        // returned value is assembled from.
        if (onChunk) {
          const text = chunkDecoder.write(chunk);
          if (text) onChunk(text);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const finish = (rawStdout: string, code: number | null, partial: boolean): void => {
      let candidate = rawStdout;
      if (extractRaw) {
        try {
          candidate = extractRaw(rawStdout);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      const cleaned = shape(candidate);
      if (cleaned) {
        resolve(cleaned);
        return;
      }
      if (partial) {
        reject(new Error('the agent terminated before producing output'));
        return;
      }
      if (code !== 0) {
        const stderr = stderrExcerpt(Buffer.concat(stderrChunks).toString('utf-8'));
        reject(new Error(`the agent exited ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      reject(new Error('the agent produced empty output'));
    };

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // A timeout is a failure whatever the CLI wrote before it was stopped.
        if (exitWait) clearTimeout(exitWait);
        reject(new Error('the agent timed out'));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      finish(stdout, code, terminated);
    });

    // A CLI that exits before reading its stdin (a rejected flag, a failed
    // login) closes the pipe under an answer prompt tens of thousands of
    // characters long, and the write fails as an EPIPE event on the stream. With
    // no listener that is an uncaught exception in main. The exit code and
    // stderr already report the failure through `close`.
    child.stdin.on('error', () => undefined);
    try {
      if (promptVia === 'stdin') {
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** One line of a CLI's NDJSON output as an object, or null for anything else. */
export function parseJsonLine(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.trim();
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return parsed as Record<string, unknown>;
}

/** A non-blank string field of a parsed line, or null. */
export function pickStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Whether `spawnCli` runs this CLI through cmd.exe: a Windows `.cmd` or `.bat` shim. */
export function cliRunsThroughShell(cliPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
}

/** How long a timed-out run waits for its CLI to exit before rejecting anyway. */
const EXIT_WAIT_MS = 3_000;

/**
 * The children `spawnCli` started as the leader of their own process group
 * (POSIX), so `stopCli` can signal the group. Only these: a child from anywhere
 * else never has its pid negated into a group signal.
 */
const processGroupLeaders = new WeakSet<CliChildProcess>();

/**
 * Every CLI `spawnCli` started that has not exited yet, so the quit path can
 * stop them (`stopAllCliRuns`). A CLI runs detached from the app on POSIX and
 * outlives it on Windows, so one left running at quit kept answering, and
 * holding its run directory, after the app was gone. The value is the chat a
 * one-shot answer run was started for, or null.
 */
const liveCliRuns = new Map<CliChildProcess, string | null>();

/**
 * The chat a one-shot answer run belongs to, set around the run by the answer
 * handler (`runCliForChat`) and read where `spawnCli` records the child. Ending
 * a chat can then stop its run without every adapter passing the chat through
 * to `runCliPrint`.
 */
const cliRunChat = new AsyncLocalStorage<string>();

/** Run `work` with every CLI it spawns recorded as `chatId`'s. */
export function runCliForChat<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  return cliRunChat.run(chatId, work);
}

/**
 * Stop every CLI still running. Synchronous, for the quit path: each stop is a
 * signal or a `taskkill` started in place (`stopCli`). A run in the pty host is
 * also stopped from here by pid: with no terminal open the quit does not wait
 * for the host, which can be torn down before it reads its stop.
 */
export function stopAllCliRuns(): void {
  for (const child of [...liveCliRuns.keys()]) {
    liveCliRuns.delete(child);
    stopCli(child);
    if (child.stopTree && child.pid) killChildTreeByPid(child.pid);
  }
}

/**
 * Stop the one-shot answer runs a chat started. The chat ended with its answer
 * still coming, so nobody is waiting for it, and an agent without a warm session
 * would otherwise keep answering, and spending, until it finished.
 */
export function stopCliRunsForChat(chatId: string): void {
  for (const [child, owner] of [...liveCliRuns]) {
    if (owner !== chatId) continue;
    liveCliRuns.delete(child);
    stopCli(child);
  }
}

/**
 * Stop a CLI `spawnCli` started, and what it launched (`stopChildTree`, which
 * says why it takes the whole tree). A run in the pty host is stopped there,
 * the same way (`host-cli-processes.ts`).
 */
export function stopCli(child: CliChildProcess): void {
  if (childHasExited(child)) return;
  if (child.stopTree) {
    child.stopTree();
    return;
  }
  stopChildTree(child, { leadsGroup: processGroupLeaders.has(child) });
}

/**
 * Spawn an agent CLI with piped stdio, the way every headless run does.
 *
 * A Windows `.cmd` or `.bat` shim (an npm-installed CLI) runs through cmd.exe,
 * so its args are interpolated into one command string and each is quoted for
 * cmd.exe (`quoteForCmdShell`). Everything else gets its args passed literally.
 *
 * On POSIX the CLI leads a process group of its own (`detached`), so `stopCli`
 * reaches whatever it started. Never on Windows, where `detached` opens a
 * console of its own and `taskkill /T` already takes the tree.
 *
 * The run starts in the pty host when one is registered (`off-main-cli.ts`):
 * on Windows a spawn's CreateProcess blocks the calling thread, 13 to 67 ms a
 * run on main during the summary backfill. With no host it starts here.
 */
export function spawnCli(cliPath: string, args: string[], cwd: string, env?: Record<string, string>): CliChildProcess {
  const useShell = cliRunsThroughShell(cliPath);
  const command = useShell ? `"${cliPath}" ${args.map(quoteForCmdShell).join(' ')}` : cliPath;
  const commandArgs = useShell ? [] : args;
  const leadsGroup = process.platform !== 'win32';
  const childEnv = env ? { ...process.env, ...env } : process.env;
  const child: CliChildProcess = spawnOffMainCli(command, commandArgs, {
    cwd,
    shell: useShell,
    env: toHostEnvironment(childEnv),
    detached: leadsGroup,
  }) ?? spawn(command, commandArgs, {
    cwd,
    shell: useShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    ...(leadsGroup ? { detached: true } : {}),
  });
  if (typeof child === 'object' && child !== null) {
    // A run in the host is stopped there, which signals its group itself.
    if (leadsGroup && !child.stopTree) processGroupLeaders.add(child);
    // Tracked until it exits, so the quit path can reach it. `exit` fires even
    // when stdio stays open; an `error` means it never started.
    liveCliRuns.set(child, cliRunChat.getStore() ?? null);
    const forget = (): void => { liveCliRuns.delete(child); };
    child.once?.('exit', forget);
    child.once?.('error', forget);
  }
  return child;
}

/** Longest stderr excerpt a failure message carries. */
const STDERR_EXCERPT_CHARS = 240;

/**
 * The part of a failed CLI's stderr worth showing: its last line that names an
 * error, else its last few lines.
 *
 * The first 200 characters, which is what this used to show, are usually a
 * banner. Codex prints its version, working directory, model and sandbox before
 * the 401 that explains the failure, so the message cut off at "sandbox:
 * read-only reason" and named everything but the cause.
 * @internal Exported for unit tests only; not part of the public API.
 */
export function stderrExcerpt(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /error|denied|unauthori[sz]ed|forbidden|not (?:found|available)|limit/i.test(line));
  const chosen = errorLine ?? lines.slice(-3).join(' ');
  return chosen.length > STDERR_EXCERPT_CHARS ? `${chosen.slice(0, STDERR_EXCERPT_CHARS - 3)}...` : chosen;
}

/**
 * Quote an arbitrary argument for cmd.exe parsing when invoking via `shell: true` on
 * Windows. Wraps the value in double quotes and escapes:
 *   - embedded double quotes by doubling them ("" is the cmd convention)
 *   - percent signs by doubling them (cmd expands %VAR% inside any string, even
 *     inside double quotes; %% prevents expansion when the prompt contains
 *     env-var-like text such as a user pasting a Windows path with %APPDATA%)
 * We never run our prompt through cmd-builtin redirection or pipes, so backticks
 * and `^` need no special handling.
 * @internal Exported for unit tests only; not part of the public API.
 */
export function quoteForCmdShell(value: string): string {
  if (!/[\s"&<>|^()%]/.test(value) && value.length > 0) return value;
  const escaped = value.replace(/"/g, '""').replace(/%/g, '%%');
  return `"${escaped}"`;
}
