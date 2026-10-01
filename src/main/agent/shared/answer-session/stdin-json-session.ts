/**
 * A warm answering process that reads one JSON line per user turn on stdin.
 *
 * Claude Code's `--input-format stream-json` is the first CLI on it: the
 * process starts, waits without calling the model, and answers each line it is
 * given, ending every turn with a `result` line. The adapter chooses the flags
 * and the line shapes; this owns the process, the turn bookkeeping, and the
 * bounds a one-shot run already has (a timeout and an output budget per turn).
 *
 * One turn at a time. A second `ask` while one is in flight is refused rather
 * than queued: the chat never asks twice at once, and a queued turn would
 * answer a question the user has moved past.
 */

import { StringDecoder } from 'node:string_decoder';
import type { CliChildProcess } from '../../../utility-process/off-main-cli';
import type { AnswerSession } from '../../agent-adapter';
import {
  ANSWER_STREAM_OUTPUT_BUDGET,
  ANSWER_TIMEOUT_MS,
  cleanAnswerOutput,
  spawnCli,
  stderrExcerpt,
  stopCli,
  type AnswerStreamEvent,
} from '../auto-name';

/**
 * Why a turn failed. Only `exited` before any text is worth a silent retry.
 * `disposed` is a stop someone asked for (the chat ended, the pool let the
 * session go, the app is quitting), so nobody is waiting for its answer and a
 * retry would only spend a fresh run on it.
 */
export type AnswerSessionFailure = 'exited' | 'disposed' | 'timeout' | 'budget' | 'agent' | 'busy';

export class AnswerSessionError extends Error {
  constructor(
    message: string,
    readonly failure: AnswerSessionFailure,
    /** True when no text had reached the reader, so a retry elsewhere is unseen. */
    readonly beforeText: boolean,
  ) {
    super(message);
    this.name = 'AnswerSessionError';
  }
}

export interface StdinJsonSessionOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** One user turn as the single JSON line the CLI reads, without its newline. */
  formatTurn: (prompt: string) => string;
  /** A fresh reducer per turn: one stdout line in, the events it carries out. */
  createReducer: () => (line: string) => AnswerStreamEvent[];
  /** True for the stdout line that ends a turn. */
  isTurnEnd: (line: string) => boolean;
  /** The turn's answer from every line it produced. Throws on an agent error. */
  extractAnswer: (turnStdout: string) => string;
  turnTimeoutMs?: number;
  turnOutputBudget?: number;
  /** Test seam for the spawn. */
  spawnProcess?: (cliPath: string, args: string[], cwd: string, env?: Record<string, string>) => CliChildProcess;
}

interface ActiveTurn {
  lines: string[];
  size: number;
  reduce: (line: string) => AnswerStreamEvent[];
  onEvent: ((event: AnswerStreamEvent) => void) | undefined;
  sawText: boolean;
  resolve: (answer: string) => void;
  reject: (error: AnswerSessionError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Stderr kept for a failure message: the tail, where the cause usually is. */
const STDERR_TAIL_CHARS = 8_192;

export function openStdinJsonSession(options: StdinJsonSessionOptions): AnswerSession {
  const spawnProcess = options.spawnProcess ?? spawnCli;
  const turnTimeoutMs = options.turnTimeoutMs ?? ANSWER_TIMEOUT_MS;
  const turnOutputBudget = options.turnOutputBudget ?? ANSWER_STREAM_OUTPUT_BUDGET;
  const child = spawnProcess(options.cliPath, options.args, options.cwd, options.env);

  let alive = true;
  let disposed = false;
  let stderrTail = '';
  let partialLine = '';
  let turn: ActiveTurn | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (error) => reject(error));
  });
  // A prewarm never awaits this, and a failed start is reported by the first
  // ask instead, so an unobserved rejection must not surface on its own.
  ready.catch(() => undefined);
  // `close` follows both a normal exit and a failed start, once stdio is shut.
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });

  const failTurn = (failure: AnswerSessionFailure, message: string): void => {
    const failed = turn;
    if (!failed) return;
    turn = null;
    clearTimeout(failed.timer);
    failed.reject(new AnswerSessionError(message, failure, !failed.sawText));
  };

  const finishTurn = (): void => {
    const finished = turn;
    if (!finished) return;
    turn = null;
    clearTimeout(finished.timer);
    try {
      const answer = cleanAnswerOutput(options.extractAnswer(finished.lines.join('\n')));
      if (answer) finished.resolve(answer);
      else finished.reject(new AnswerSessionError('the agent returned nothing', 'agent', !finished.sawText));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finished.reject(new AnswerSessionError(message, 'agent', !finished.sawText));
    }
  };

  const handleLine = (line: string): void => {
    // Lines between turns (a start-up banner, a late event) belong to no turn.
    const current = turn;
    if (!current || !line.trim()) return;
    current.lines.push(line);
    current.size += line.length;
    if (current.size > turnOutputBudget) {
      failTurn('budget', 'the answer ran past its output budget');
      dispose();
      return;
    }
    for (const event of current.reduce(line)) {
      if (event.kind === 'text') current.sawText = true;
      current.onEvent?.(event);
    }
    if (options.isTurnEnd(line)) finishTurn();
  };

  // One decoder per stream: a character split across two pipe reads is held
  // until its last byte lands, where decoding each chunk alone made it U+FFFD.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  child.stdout.on('data', (chunk: Buffer) => {
    partialLine += stdoutDecoder.write(chunk);
    let newline = partialLine.indexOf('\n');
    while (newline !== -1) {
      const line = partialLine.slice(0, newline).replace(/\r$/, '');
      partialLine = partialLine.slice(newline + 1);
      handleLine(line);
      newline = partialLine.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-STDERR_TAIL_CHARS);
  });
  // A write to a process that just died raises EPIPE on stdin; the exit
  // handler below is what reports it.
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => {
    alive = false;
    failTurn('exited', error.message);
  });
  child.on('exit', (code) => {
    alive = false;
    const excerpt = stderrExcerpt(stderrTail);
    failTurn('exited', disposed
      ? 'the answering process was stopped'
      : `the agent exited ${code ?? ''}${excerpt ? `: ${excerpt}` : ''}`.trim());
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    alive = false;
    failTurn('disposed', 'the answering process was stopped');
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    // Fire and forget: dispose runs on the quit path.
    stopCli(child);
  }

  return {
    ready,
    exited,
    get alive() {
      return alive;
    },
    get busy() {
      return turn !== null;
    },
    ask(prompt, onEvent) {
      if (!alive) return Promise.reject(new AnswerSessionError('the answering process has ended', disposed ? 'disposed' : 'exited', true));
      if (turn) return Promise.reject(new AnswerSessionError('a question is already in flight', 'busy', true));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          failTurn('timeout', 'the agent timed out');
          dispose();
        }, turnTimeoutMs);
        timer.unref?.();
        turn = { lines: [], size: 0, reduce: options.createReducer(), onEvent, sawText: false, resolve, reject, timer };
        try {
          child.stdin.write(`${options.formatTurn(prompt)}\n`);
        } catch (error) {
          failTurn('exited', error instanceof Error ? error.message : String(error));
        }
      });
    },
    dispose,
  };
}
