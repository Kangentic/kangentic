import { stripAnsiEscapes } from '../../../../shared/ansi-strip';

/**
 * Claude Code's own account of a `--resume <id>` it could not honour. Printed
 * as the CLI's last line before it exits with code 1 (verified on 2.1.276:
 * `claude --resume 00000000-0000-0000-0000-000000000000 -p hi`). The id is
 * optional in the match so a future wording that drops it still reads as the
 * same failure.
 */
const RESUME_NOT_FOUND = /No conversation found with session ID:?\s*([0-9a-fA-F-]{8,})?/;

/**
 * Only the tail of the output is read. The failure is the CLI's last word,
 * and a long session's ring buffer can hold hundreds of kilobytes of TUI
 * repaint that has nothing to do with how it ended.
 */
const TAIL_CHARS = 20_000;

/**
 * Read a startup failure out of the CLI's final output. See
 * `AgentAdapter.describeStartupFailure` for the contract and for why this is
 * a notice after the fact rather than a guard before the spawn.
 *
 * The exit code is accepted for parity with the contract but not required to
 * match: the wording is the evidence, and an unreadable transcript has been
 * seen to end the CLI with code 0 while a missing one ends it with code 1.
 */
export function describeClaudeStartupFailure(finalOutput: string, _exitCode: number): string | null {
  const text = stripAnsiEscapes(finalOutput.slice(-TAIL_CHARS));
  const resumeMiss = RESUME_NOT_FOUND.exec(text);
  if (resumeMiss) {
    const sessionId = resumeMiss[1];
    const which = sessionId ? ` (session ${sessionId.slice(0, 8)})` : '';
    // Three sentences under the notice's 200-character cap (task-git.ts
    // `describeSpawnFailure`), which trims at a sentence boundary: the remedy
    // is the sentence the user acts on, so it must survive the trim.
    return `Claude Code found no conversation to resume${which}. Its transcript was cleaned up `
      + 'or the project folder moved. Move the task to To Do and back to start fresh.';
  }
  return null;
}
