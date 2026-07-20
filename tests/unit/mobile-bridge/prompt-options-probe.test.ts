/**
 * Prompt-options probe tests: parsing a pending prompt's numbered option
 * labels out of a serialized PTY frame (the read-stream mobile seed).
 *
 * The dialog fixtures are AUTHORED, built to mirror the layout Claude Code
 * renders for permission prompts and AskUserQuestion (box-drawing border,
 * ❯ selection marker, `<n>.` rows) - they are plausible reconstructions,
 * not captured scrollback.
 */
import { describe, expect, it } from 'vitest';
import { extractNumberedOptions, extractPromptOptions } from '../../../src/main/mobile-bridge/prompt-options-probe';

/** Wrap a plain-text dialog body in serialized-frame dressing (colors, title, prior output). */
function frameWith(dialogLines: string[]): string {
  return [
    '\x1b]0;Claude Code\x07',
    'Running the requested change...\r\n',
    '\r\n',
    ...dialogLines.map((line) => `\x1b[38;5;180m${line}\x1b[0m\r\n`),
    '\r\n',
  ].join('');
}

const CLAUDE_PERMISSION_DIALOG = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ Bash command                                             │',
  '│                                                          │',
  '│   npm install left-pad                                   │',
  '│   Install the dependency                                 │',
  '│                                                          │',
  '│ Do you want to proceed?                                  │',
  '│ ❯ 1. Yes                                                 │',
  "│   2. Yes, and don't ask again for this command           │",
  '│   3. No, and tell Claude what to do differently          │',
  '╰──────────────────────────────────────────────────────────╯',
];

const ASK_USER_QUESTION_DIALOG = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ Which storage backend should the cache use?              │',
  '│                                                          │',
  '│ ❯ 1. SQLite (single file, zero config)                   │',
  '│   2. Redis (shared across workers)                       │',
  '│   3. In-memory only                                      │',
  '│   4. Let me type something else                          │',
  '╰──────────────────────────────────────────────────────────╯',
];

describe('extractPromptOptions', () => {
  it('parses a three-option Claude permission dialog out of a colored, bordered frame', () => {
    expect(extractPromptOptions(frameWith(CLAUDE_PERMISSION_DIALOG))).toEqual([
      'Yes',
      "Yes, and don't ask again for this command",
      'No, and tell Claude what to do differently',
    ]);
  });

  it('parses an AskUserQuestion-style numbered dialog', () => {
    expect(extractPromptOptions(frameWith(ASK_USER_QUESTION_DIALOG))).toEqual([
      'SQLite (single file, zero config)',
      'Redis (shared across workers)',
      'In-memory only',
      'Let me type something else',
    ]);
  });

  it('returns null for a frame with no numbered dialog', () => {
    const frame = 'Compiling...\r\n\x1b[32m✓\x1b[0m 412 modules transformed\r\nDone in 3.2s\r\n';
    expect(extractPromptOptions(frame)).toBeNull();
  });

  it('returns null for an empty frame (unknown session)', () => {
    expect(extractPromptOptions('')).toBeNull();
  });

  it('lays the frame out for the supplied PTY grid', () => {
    // At 30 cols the border rows would wrap and shear the dialog apart if
    // the probe ignored dimensions; at the real 80-col grid it parses.
    const frame = frameWith(CLAUDE_PERMISSION_DIALOG);
    expect(extractPromptOptions(frame, { cols: 80, rows: 24 })).toEqual([
      'Yes',
      "Yes, and don't ask again for this command",
      'No, and tell Claude what to do differently',
    ]);
  });

  it('keeps a bottom-of-screen dialog even when scrollback rows above overflow the grid', () => {
    const scrollback = Array.from({ length: 120 }, (_, index) => `line ${index}\r\n`).join('');
    const frame = scrollback + frameWith(CLAUDE_PERMISSION_DIALOG);
    expect(extractPromptOptions(frame, { cols: 80, rows: 24 })).toEqual([
      'Yes',
      "Yes, and don't ask again for this command",
      'No, and tell Claude what to do differently',
    ]);
  });
});

describe('extractNumberedOptions', () => {
  it('requires at least two options - a lone numbered row is prose, not a dialog', () => {
    expect(extractNumberedOptions('Step summary:\n1. Install the dependency\nDone.')).toBeNull();
  });

  it('requires consecutive numbering starting at 1', () => {
    expect(extractNumberedOptions('2. Second\n3. Third')).toBeNull();
    expect(extractNumberedOptions('1. First\n3. Third')).toBeNull();
  });

  it('prefers the last complete run, so a numbered list in older output never shadows the dialog', () => {
    const screen = [
      'The plan:',
      '1. Add the parser',
      '2. Wire the handler',
      '3. Ship it',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently',
    ].join('\n');
    expect(extractNumberedOptions(screen)).toEqual(['Yes', 'No, and tell Claude what to do differently']);
  });

  it('a repeated "1." row starts a fresh run instead of corrupting the previous one', () => {
    const screen = ['1. Old first', '2. Old second', '1. New first', '2. New second', '3. New third'].join('\n');
    expect(extractNumberedOptions(screen)).toEqual(['New first', 'New second', 'New third']);
  });

  it('strips the box-drawing border and the ❯ selection marker', () => {
    const screen = ['│ ❯ 1. Approve   │', '│   2. Deny      │'].join('\n');
    expect(extractNumberedOptions(screen)).toEqual(['Approve', 'Deny']);
  });

  it('an unbordered, markerless numbered dialog still parses', () => {
    expect(extractNumberedOptions('1. Continue\n2. Abort')).toEqual(['Continue', 'Abort']);
  });

  it('a wrapped option label rejects the parse instead of truncating the list', () => {
    // On a narrow grid the second label wraps onto a continuation row; a
    // naive parser closes the run there and publishes an affirmative-only
    // two-option list for a three-option consent prompt.
    const screen = [
      '│ ❯ 1. Yes                                  │',
      "│   2. Yes, and don't ask again for this    │",
      '│      command                              │',
      '│   3. No, and tell Claude what to do       │',
      '│      differently                          │',
    ].join('\n');
    expect(extractNumberedOptions(screen)).toBeNull();
  });

  it('a wrapped dialog below a prose list rejects the parse instead of publishing the prose', () => {
    const screen = [
      'The plan:',
      '1. Add the parser',
      '2. Wire the handler',
      '3. Ship it',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes, run the full suite and report every failure it',
      '     finds',
      '  2. No',
    ].join('\n');
    expect(extractNumberedOptions(screen)).toBeNull();
  });

  it('a numbered list far above the rendered bottom is prose, not the dialog', () => {
    const buildOutput = Array.from({ length: 20 }, (_, index) => `compiling module ${index}`);
    const screen = ['1. Add the parser', '2. Wire the handler', ...buildOutput].join('\n');
    expect(extractNumberedOptions(screen)).toBeNull();
  });

  it('a dialog with a few chrome rows below it still parses', () => {
    const screen = [
      '❯ 1. Approve',
      '  2. Deny',
      '╰──────────╯',
      '',
      'Esc to cancel',
    ].join('\n');
    expect(extractNumberedOptions(screen)).toEqual(['Approve', 'Deny']);
  });
});
