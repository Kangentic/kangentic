/**
 * What a failed launch's last output said, as a fixed value. Only the class
 * leaves the machine: scrollback can hold secrets, and a typed line holds the
 * task's prompt.
 *
 * Kept apart from `agent-launch-report.ts`, which reaches `electron` through the
 * analytics modules, so the real-shell round trip can classify what a real
 * shell printed (`typed-launch-round-trip.test.ts`) on a job with no Electron.
 */

import type { UserSetupFailure } from '../../shared/user-configuration-error';
import type { AgentParser } from '../../shared/types';
import { finalLinesOf } from '../agent/shared/user-setup-failure';

/** What the last output said, as a fixed value. */
export type LaunchOutputClass =
  | 'command_not_found'
  | 'permission_denied'
  /** The command's own path does not exist. */
  | 'no_such_file'
  /** The command exists, and the interpreter its shebang names does not. */
  | 'bad_interpreter'
  /** The shell could not read the launcher file its typed line names. */
  | 'launcher_unreadable'
  /** The command's file is not a program this machine can run. */
  | 'exec_format'
  /** macOS refused the command's binary for its CPU type. */
  | 'bad_cpu_type'
  /** The shell says the command was killed (SIGKILL). */
  | 'killed'
  /** The shell says the command died of a crash signal: a segmentation fault, bus error, abort or illegal instruction. */
  | 'crashed'
  | 'unknown_option'
  /** cmd refused a line past its limit. The same line gets the same answer, so it is never retried. */
  | 'line_too_long'
  /** The CLI said the conversation this launch resumes does not exist. */
  | 'conversation_missing'
  /** The adapter identified the user's own setup. These two never reach Sentry. */
  | UserSetupFailure
  | 'other'
  /** The session's ring is gone, or nothing asked for it. */
  | 'not_read'
  /** The read failed. */
  | 'unreadable';

const LINE_TOO_LONG_SENTENCES: readonly RegExp[] = [
  /^The input line is too long\.$/,
  /^The command line is too long\.$/,
];

/**
 * The shapes each class takes, anchored on how a shell words the failure so text
 * the shell merely echoed cannot match: a task titled "fix permission denied"
 * sits in the typed line when no launcher was used. Each pattern needs the
 * shell's own framing, not just the phrase.
 *
 * Every line below was printed by a real shell on a real pty, never written from
 * memory: bash 5.2, dash, zsh 5.9, fish 3.7.0 and nushell 0.116.0 on Ubuntu
 * 24.04, zsh 5.9 and BSD cat on a macOS runner, PowerShell 7 on Windows.
 * `typed-launch-round-trip.test.ts` pins the line each shell CI runs printed.
 */
const OUTPUT_SHAPES: ReadonlyArray<{ outputClass: LaunchOutputClass; shapes: readonly RegExp[] }> = [
  {
    // First: the launcher's own failure names a path a later shape would read
    // as the command's. Each needs the launcher's fixed file name, or, for
    // nushell, a `source` failure, which only the launcher's line can make.
    outputClass: 'launcher_unreadable',
    shapes: [
      // `eval "$(cat <dir>/launch.sh)"` (`typed-launch.ts`). GNU cat quotes a
      // path holding a space: `cat: '/p/project  one/.../launch.sh': No such
      // file or directory`.
      /^cat: '?.*\/launch\.sh'?: (?:No such file or directory|Permission denied)$/,
      // fish: `source: Error encountered while sourcing file ''/p/launch.fish'':`,
      // with its own doubled quotes, under `source: No such file or directory`.
      /^source: Error encountered while sourcing file '+.*\/launch\.fish'+:$/,
      // nushell, whose `source` reads its file while the line parses. The
      // header names no path, and `source` of a file is a line only the
      // launcher types.
      /^Error: nu::parser::sourced_file_not_found$/,
      // PowerShell's dot-source of a missing `launch.ps1`: `.: The term
      // '/p/launch.ps1' is not recognized as a name of a cmdlet, ...`. Ahead of
      // `command_not_found`, whose PowerShell shape matches it too. Measured on
      // PowerShell 7 on Windows, which types every line and never uses the
      // launcher. Only POSIX pwsh does, and no CI job runs its round trip yet.
      /^\.\s?: The term '[^']*[\\/]launch\.ps1' is not recognized/,
    ],
  },
  {
    outputClass: 'command_not_found',
    shapes: [
      // zsh: `zsh: command not found: claude`
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:\d+:\s)?command not found:/,
      // bash, dash: `bash: claude: command not found`, `sh: 1: claude: not found`
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:line \d+:\s)?(?:\d+:\s)?[^:]+:\s(?:command )?not found$/,
      // cmd
      /^'[^']+' is not recognized as an internal or external command/,
      // PowerShell
      /^[^:]+\s?: The term '[^']+' is not recognized/,
      // fish
      /^fish: Unknown command/,
      // nushell
      /^Error: nu::shell::external_command/,
    ],
  },
  {
    // Ahead of `permission_denied`, whose `cannot execute` matches bash's line.
    // bash: `bash: /opt/claude: cannot execute binary file: Exec format error`;
    // dash: `dash: 1: /opt/claude: Exec format error`. nushell names none: it
    // hands such a file to /bin/sh, which reads its first bytes as a command.
    outputClass: 'exec_format',
    shapes: [
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:line \d+:\s)?(?:\d+:\s)?[^:]+:\s(?:cannot execute binary file:\s)?Exec format error$/,
      // zsh: `zsh: exec format error: /opt/claude`
      /^(?:[\w./-]*\/)?zsh:\s(?:\d+:\s)?exec format error:\s/,
      // fish: `exec: Failed to execute process: '/opt/claude' the file could not be run by the operating system.`
      /^exec: Failed to execute process: '.*' the file could not be run by the operating system\.$/,
    ],
  },
  {
    // macOS refused the command's binary for its CPU type, as it does an
    // Intel-only CLI on an Apple silicon Mac with no Rosetta. zsh:
    // `zsh: bad CPU type in executable: /opt/claude`, measured on a macOS runner.
    outputClass: 'bad_cpu_type',
    shapes: [
      /^(?:[\w./-]*\/)?zsh:\s(?:\d+:\s)?bad CPU type in executable:\s/,
    ],
  },
  {
    outputClass: 'permission_denied',
    shapes: [
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:\d+:\s)?permission denied:/,
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:line \d+:\s)?(?:\d+:\s)?[^:]+:\s(?:Permission denied|cannot execute)/,
      /^fish: The file .* is not executable/,
    ],
  },
  {
    // Ahead of `no_such_file`: the line holds that phrase too, after the
    // interpreter's path. bash: `bash: /opt/claude: /usr/bin/node: bad
    // interpreter: No such file or directory`; zsh: `zsh: /opt/claude: bad
    // interpreter: /usr/bin/node: no such file or directory`.
    outputClass: 'bad_interpreter',
    shapes: [
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:line \d+:\s)?(?:\d+:\s)?[^:]+:\s(?:[^:]+:\s)?bad interpreter\b/,
    ],
  },
  {
    outputClass: 'no_such_file',
    shapes: [
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:\d+:\s)?no such file or directory:/,
      /^(?:[\w./-]*\/)?[a-z]*sh:\s(?:line \d+:\s)?(?:\d+:\s)?[^:]+:\s(?:[^:]+:\s)?No such file or directory/,
      /^The system cannot find the (?:path|file) specified/,
    ],
  },
  {
    outputClass: 'killed',
    shapes: [
      // An interactive bash or dash reports a foreground job a signal ended on
      // a line of its own, so the whole line is the shape.
      /^Killed$/,
      // zsh: `zsh: killed     '/opt/claude'`. On macOS the long temp path wraps
      // the line, and zsh's redraw leaves just `zsh: killed` once the cursor moves
      // are read out, so the command text is optional.
      /^(?:[\w./-]*\/)?zsh:\s(?:\d+:\s)?killed(?:\s|$)/,
      // fish: `fish: Job 1, ''/opt/cl…' terminated by signal SIGKILL (Forced quit)`
      /^fish: Job \d+, '.*' terminated by signal SIGKILL\b/,
      // nushell, inside its error box under `Error: nu::shell::terminated_by_signal`:
      // `·   ╰── terminated by SIGKILL (9)`
      /(?:^|\s)╰── terminated by SIGKILL \(\d+\)$/,
    ],
  },
  {
    outputClass: 'crashed',
    shapes: [
      /^(?:Segmentation fault|Bus error|Aborted|Illegal instruction)(?: \(core dumped\))?$/,
      // zsh: `zsh: segmentation fault (core dumped)  '/opt/claude'`. macOS prints
      // no `(core dumped)`, and the wrapped line ends after `segmentation fault`.
      /^(?:[\w./-]*\/)?zsh:\s(?:\d+:\s)?segmentation fault(?: \(core dumped\))?(?:\s|$)/,
      // fish: `fish: Job 1, ''/opt/cl…' terminated by signal SIGSEGV (Address boundary error)`
      /^fish: Job \d+, '.*' terminated by signal SIG(?:SEGV|BUS|ABRT|ILL)\b/,
      // nushell: `Error: nu::shell::core_dumped`, or a crash signal in the box
      // of `nu::shell::terminated_by_signal`.
      /^Error: nu::shell::core_dumped$/,
      /(?:^|\s)╰── (?:terminated by|core dumped with) SIG(?:SEGV|BUS|ABRT|ILL) \(\d+\)$/,
    ],
  },
  {
    outputClass: 'unknown_option',
    shapes: [
      /^error: unknown (?:option|command)\b/i,
      /^error: unexpected argument\b/i,
      /^(?:[\w.-]+:\s)?(?:unknown|unrecognized|invalid) (?:option|argument|flag)\b/i,
    ],
  },
  {
    outputClass: 'line_too_long',
    // cmd's two words for it: a typed line past 8190 characters, and a command
    // line a `.cmd` runs through cmd.exe under PowerShell or Git Bash. The second
    // is also what a spawn types for a shim it cannot get past (`typed-launch.ts`).
    // English only, like every shape here: cmd words its own refusal in the
    // system's language, and on another one that reads as `other` and retries.
    shapes: LINE_TOO_LONG_SENTENCES,
  },
];

/**
 * The shell's own refusal of a line as too long, as it printed it, for the
 * notice. Null when the last output holds none.
 */
export function lineTooLongSentence(rawScrollback: string): string | null {
  return finalLinesOf(rawScrollback).find((line) => LINE_TOO_LONG_SENTENCES.some((sentence) => sentence.test(line))) ?? null;
}

/**
 * Classify the last output into a fixed value. Only the class leaves this
 * process. The adapter speaks first, since only it knows its own CLI's words.
 * Then the shell's shapes, newest line first, so the failure that ended the
 * launch wins over an older line of the same session.
 *
 * `resumedAgentSessionId` is the conversation a resuming launch asked for, and
 * null for a fresh one, which has no conversation to miss.
 */
export function classifyLaunchOutput(
  rawScrollback: string,
  agentParser?: AgentParser,
  resumedAgentSessionId?: string | null,
): LaunchOutputClass {
  const userSetupFailure = agentParser?.identifyUserSetupFailure?.(rawScrollback);
  if (userSetupFailure) return userSetupFailure.failure;
  if (resumedAgentSessionId && agentParser?.namesMissingConversation?.(rawScrollback, resumedAgentSessionId)) {
    return 'conversation_missing';
  }
  for (const line of finalLinesOf(rawScrollback)) {
    for (const { outputClass, shapes } of OUTPUT_SHAPES) {
      if (shapes.some((shape) => shape.test(line))) return outputClass;
    }
  }
  return 'other';
}
