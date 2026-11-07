/**
 * Claude's startup-failure recognizer (`describeStartupFailure`).
 *
 * The one case it names: a `--resume <id>` of a conversation the CLI can no
 * longer find. Verified wording and exit code on Claude Code 2.1.276:
 * `claude --resume 00000000-0000-0000-0000-000000000000 -p hi` prints
 * `No conversation found with session ID: 00000000-...` and exits 1. In the
 * wild that is a transcript Claude's own cleanup removed, or a project folder
 * that moved; the card simply went quiet with no notice (#682 follow-up).
 *
 * Why it is the only case. Six startup shapes were probed on the INTERACTIVE
 * CLI (node-pty, 2.1.276, 2026-09-18), since a recognizer only ever runs on
 * a session that ended. Three do not end it: a bad `ANTHROPIC_API_KEY` opens
 * a use-this-key dialog and then the TUI; a `--settings` file with invalid
 * JSON opens the TUI and auto-submits a "fix these settings issues" prompt;
 * an unknown `--model` warns and opens the TUI. Two end it besides the resume
 * miss: an invalid `--permission-mode` (commander's usage error, which the
 * command builder cannot produce), and a missing `--settings` file (`Error:
 * Settings file not found: <path>`, exit 1). The last was left out on
 * purpose: Kangentic writes that file moments before launch and guards the
 * one deletion race (`SessionFileManager.nullifyPaths`), and its wording is
 * a plausible thing for an agent working in THIS repo to print before a
 * normal `/exit`, which would toast a false notice. Add a recognizer when a
 * shape is seen on a real card, with the wording it printed.
 */
import { describe, it, expect } from 'vitest';
import {
  claudeNamesMissingConversation,
  describeClaudeStartupFailure,
  identifyClaudeUserSetupFailure,
} from '../../src/main/agent/adapters/claude/startup-failure';
import conptyCaptures from '../fixtures/conpty-cmd-failures.json';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

const MISSING_ID = '2451ea6b-0035-47a3-bf0c-d2371074312c';

/**
 * A captured line with its spaces written as cursor moves, the way ConPTY writes
 * a row it repaints as a cell diff. Built from the real bytes, not captured: every
 * capture of these lines from a fresh cmd held real spaces (conpty-cmd-failures.json),
 * and the shape was only seen on repainted TUI rows. A ring that holds it must
 * still read.
 */
function asRepaintedRow(output: string, sentence: string): string {
  expect(output).toContain(sentence);
  return output.replace(sentence, sentence.replaceAll(' ', '\x1b[1C'));
}

describe('real ConPTY output under cmd', () => {
  const { claudeResumeMiss, claudeNotLoggedIn, resumedId } = conptyCaptures;
  const missSentence = `No conversation found with session ID: ${resumedId}`;

  it('names the miss on the captured stream', () => {
    expect(describeClaudeStartupFailure(claudeResumeMiss, 0)).toContain('found no conversation to resume');
  });

  it('names the miss on a repainted row, whose spaces are cursor moves', () => {
    const repainted = asRepaintedRow(claudeResumeMiss, missSentence);
    expect(describeClaudeStartupFailure(repainted, 0)).toContain('(session 2451ea6b)');
  });

  it('identifies a login line on the captured stream, under the line Claude prints ahead of it', () => {
    expect(identifyClaudeUserSetupFailure(claudeNotLoggedIn)?.failure).toBe('login_required');
  });

  it('identifies a login line on a repainted row', () => {
    const repainted = asRepaintedRow(claudeNotLoggedIn, 'Not logged in · Please run /login');
    expect(identifyClaudeUserSetupFailure(repainted)?.line).toBe('Not logged in · Please run /login');
  });
});

describe('claudeNamesMissingConversation', () => {
  const { claudeResumeMiss, resumedId } = conptyCaptures;

  it('reads the captured miss for the id being resumed', () => {
    expect(claudeNamesMissingConversation(claudeResumeMiss, resumedId)).toBe(true);
  });

  it('says nothing of a line about another conversation', () => {
    expect(claudeNamesMissingConversation(claudeResumeMiss, '11111111-0000-4000-8000-000000000000')).toBe(false);
  });

  it('says nothing of a typed line that quotes the sentence', () => {
    const echoed = `C:\\project>claude "fix: No conversation found with session ID: ${resumedId}"\r\nC:\\project>`;
    expect(claudeNamesMissingConversation(echoed, resumedId)).toBe(false);
  });

  it('is what the adapter exposes through the generic capability', () => {
    expect(new ClaudeAdapter().namesMissingConversation(claudeResumeMiss, resumedId)).toBe(true);
  });
});

describe('describeClaudeStartupFailure', () => {
  it('names a resume of a conversation the CLI could not find, with the id it printed', () => {
    const output = `\x1b[?25l\x1b[2J\x1b[HNo conversation found with session ID: ${MISSING_ID}\r\n`;

    const description = describeClaudeStartupFailure(output, 1);

    expect(description).not.toBeNull();
    expect(description).toContain('found no conversation to resume');
    expect(description).toContain('(session 2451ea6b)');
    expect(description).toContain('Move the task to To Do');
    // `describeSpawnFailure` (task-git.ts) trims a notice past 200 characters
    // at a sentence boundary. The remedy is the last sentence, so the whole
    // description has to fit or the user is told what broke and not what to do.
    expect((description ?? '').length).toBeLessThanOrEqual(200);
  });

  it('still names the failure when the wording carries no id', () => {
    expect(describeClaudeStartupFailure('No conversation found with session ID\n', 1)).toContain('no conversation to resume');
  });

  it('does not depend on the exit code', () => {
    // An unreadable transcript has been seen to end the CLI with code 0 and a
    // different message; a missing one ends it with code 1. The wording is
    // the evidence, so the same line reads the same whatever the code.
    expect(describeClaudeStartupFailure(`No conversation found with session ID: ${MISSING_ID}`, 0)).not.toBeNull();
  });

  it('reads only the tail, and finds the line there in a long ring', () => {
    const filler = 'x'.repeat(200_000);
    expect(describeClaudeStartupFailure(`${filler}\nNo conversation found with session ID: ${MISSING_ID}\n`, 1)).not.toBeNull();
    // The same line buried past the tail window is not this session's last word.
    expect(describeClaudeStartupFailure(`No conversation found with session ID: ${MISSING_ID}\n${filler}`, 1)).toBeNull();
  });

  it('returns null for a normal exit and for a crash it cannot name', () => {
    expect(describeClaudeStartupFailure('Goodbye!\n', 0)).toBeNull();
    expect(describeClaudeStartupFailure('TypeError: cannot read properties of undefined\n    at main\n', 1)).toBeNull();
    expect(describeClaudeStartupFailure('', 1)).toBeNull();
  });

  it('is what the adapter exposes through the generic capability', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.describeStartupFailure?.(`No conversation found with session ID: ${MISSING_ID}`, 1))
      .toBe(describeClaudeStartupFailure(`No conversation found with session ID: ${MISSING_ID}`, 1));
  });

  it('finds the phrase across a ConPTY repaint that splits it with a cursor move and an erase-to-end-of-line', () => {
    // A real ConPTY redraw of a row: the cursor jumps mid-line and erases to
    // the end of it, landing between two words of the phrase rather than
    // before the whole line like the screen-clear fixture above.
    const output = 'No conversation \x1b[3;17H\x1b[Kfound with session ID: 12345678-1234-1234-1234-123456789abc\r\n';

    const description = describeClaudeStartupFailure(output, 1);

    expect(description).not.toBeNull();
    expect(description).toContain('found no conversation to resume');
    expect(description).toContain('(session 12345678)');
  });

  it('does not read the same cursor-move-and-erase interleaving as the phrase on an unrelated line', () => {
    // Same escape sequences, different words: proves the stripped text has to
    // actually contain the phrase, not just survive ANSI stripping.
    const output = 'Reading configuration \x1b[3;17H\x1b[Kfrom disk, please wait...\r\n';

    expect(describeClaudeStartupFailure(output, 1)).toBeNull();
  });
});
