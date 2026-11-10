/**
 * The launch failure report. Most of these failures throw nothing, so this is
 * the only signal they have. What a person loses without these tests is the one
 * event that says why a terminal never started, and the promise that the event
 * carries no prompt, output or path. `session-manager-agent-absence.test.ts` pins
 * which endings reach it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportHandledError = vi.hoisted(() => vi.fn());
const shuttingDown = vi.hoisted(() => ({ value: false }));
const existsSync = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: () => shuttingDown.value }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync } };
});

import {
  classifyLaunchOutput,
  isLaunchRetryPointless,
  hasAgentRunEvidence,
  launchNeverStarted,
  launchTagsOf,
  launchVersionTag,
  lineTooLongSentence,
  logLaunchStep,
  preflightTagsOf,
  reportLaunchFailure,
  reportLaunchRecovered,
  reportPreflightFailure,
  reportPtyPortFailure,
  reportSessionLaunchFailure,
  resetLaunchReports,
} from '../../src/main/pty/agent-launch-report';
import { AgentCliNotFoundError } from '../../src/main/agent/shared/agent-cli-not-found';
import { recordDetectedCliIdentity, resetDetectedCliIdentities } from '../../src/main/agent/shared/cli-identity';
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import conptyCaptures from '../fixtures/conpty-cmd-failures.json';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { AgentParser } from '../../src/shared/types';

const STARTED_AT = '2026-11-04T12:00:00.000Z';
const STARTED_AT_MS = Date.parse(STARTED_AT);
const NOW = STARTED_AT_MS + 36_000;

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'session-1-long-id',
    taskId: 'task-1',
    projectId: 'project-1',
    pty: null,
    status: 'running',
    shell: '/bin/zsh',
    cwd: '/mock/project',
    commandCwd: '/mock/project',
    startedAt: STARTED_AT,
    exitCode: null,
    resuming: true,
    transient: false,
    exitSequence: ['\x03'],
    reportsAgentStart: true,
    typedLineBytes: 1024,
    launcherUsed: false,
    agentName: 'claude',
    agentCliVersion: '2.1.302 (Claude Code)',
    startPath: 'board',
    ...overrides,
  };
}

beforeEach(() => {
  reportHandledError.mockClear();
  existsSync.mockReturnValue(true);
  shuttingDown.value = false;
  resetLaunchReports();
  resetDetectedCliIdentities();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('launchNeverStarted', () => {
  it('holds for an agent that reports its start and showed none', () => {
    expect(launchNeverStarted(session())).toBe(true);
  });

  it.each([
    { label: 'a SessionStart', overrides: { agentStartObservedAt: NOW } },
    { label: 'an alt-screen entry', overrides: { altScreenEnteredAt: NOW } },
    { label: 'a SessionEnd', overrides: { agentEndSignaledAt: NOW } },
    { label: 'any other hook', overrides: { agentHookObservedAt: NOW } },
    { label: 'a session id the agent gave', overrides: { agentIdReportedAt: NOW } },
  ])('does not hold after $label', ({ overrides }) => {
    expect(launchNeverStarted(session(overrides))).toBe(false);
    expect(hasAgentRunEvidence(session(overrides))).toBe(true);
  });

  it('leaves out an adapter that reports neither signal, whose silence proves nothing', () => {
    expect(launchNeverStarted(session({ reportsAgentStart: false }))).toBe(false);
    expect(launchNeverStarted(session({ reportsAgentStart: undefined }))).toBe(false);
  });

  it('takes no evidence from the shell having run the typed line', () => {
    // A shell's "command not found" lands as agentOutput too.
    expect(hasAgentRunEvidence(session({ agentOutputAt: NOW, firstOutputAt: NOW }))).toBe(false);
  });
});

describe('launchVersionTag', () => {
  it.each([
    ['2.1.302', '2.1.302'],
    ['2.1.302 (Claude Code)', '2.1.302'],
    ['2026.04.29-c83a488', '2026.04.29-c83a488'],
    ['v0.2026.04.08.08.36.stable_02', 'v0.2026.04.08.08.36.stable_02'],
    ['  1.2.3\n', '1.2.3'],
  ])('keeps %j as %j', (raw, tag) => {
    expect(launchVersionTag(raw)).toBe(tag);
  });

  it.each([
    [null], [undefined], [''],
    ['/Users/dev/.local/bin/claude'],
    ['C:\\Users\\dev\\bin\\claude.exe'],
    ['Error: cannot read config at /Users/dev'],
    ['a-very-private-branch-name'],
  ])('reads %j as unknown', (raw) => {
    expect(launchVersionTag(raw)).toBe('unknown');
  });
});

describe('launchTagsOf', () => {
  it('names the agent, its version, the start path and the shell', () => {
    expect(launchTagsOf(session(), NOW)).toMatchObject({
      agent: 'claude',
      agent_cli_version: '2.1.302',
      start_path: 'board',
      shell: 'zsh',
      attempt: '1',
    });
  });

  it('counts a retry as the second attempt', () => {
    expect(launchTagsOf(session({ startPath: 'retry' }), NOW).attempt).toBe('2');
  });

  it('buckets the times, so a tag is a fixed value and not a number per event', () => {
    const tags = launchTagsOf(session({ firstOutputAt: STARTED_AT_MS + 7_000 }), NOW);
    expect(tags.first_output_s).toBe('5-15');
    expect(tags.session_age_s).toBe('30-60');
  });

  it.each([
    { overrides: {}, printed: 'none', firstOutput: 'none' },
    { overrides: { firstOutputAt: STARTED_AT_MS + 500 }, printed: 'before_launch', firstOutput: '<1' },
    { overrides: { firstOutputAt: STARTED_AT_MS + 500, agentOutputAt: STARTED_AT_MS + 900 }, printed: 'after_launch', firstOutput: '<1' },
  ])('reads shell_printed as $printed', ({ overrides, printed, firstOutput }) => {
    const tags = launchTagsOf(session(overrides), NOW);
    expect(tags.shell_printed).toBe(printed);
    expect(tags.first_output_s).toBe(firstOutput);
  });

  it('says whether the launcher file is still there, never where', () => {
    const launcherPath = '/Users/dev/secret-project/.kangentic/sessions/abc/launch.sh';
    existsSync.mockReturnValue(true);
    expect(launchTagsOf(session({ launcherPath }), NOW).launcher).toBe('present');
    existsSync.mockReturnValue(false);
    expect(launchTagsOf(session({ launcherPath }), NOW).launcher).toBe('missing');
    expect(launchTagsOf(session(), NOW).launcher).toBe('none');
  });

  it('says whether the command\'s head path exists, never what it is', () => {
    const agentCliPath = '/Users/dev/.local/bin/claude';
    existsSync.mockReturnValue(true);
    expect(launchTagsOf(session({ agentCliPath }), NOW).command_head).toBe('present');
    existsSync.mockReturnValue(false);
    expect(launchTagsOf(session({ agentCliPath }), NOW).command_head).toBe('missing');
    expect(JSON.stringify(launchTagsOf(session({ agentCliPath }), NOW))).not.toContain('/Users/dev');
  });

  it.each([
    { label: 'no path', overrides: {} },
    { label: 'a bare command name the shell looks up', overrides: { agentCliPath: 'claude' } },
    { label: 'a WSL shell, whose paths this process cannot read', overrides: { agentCliPath: '/home/dev/.local/bin/claude', shell: 'wsl -d Ubuntu' } },
  ])('reads the head as unknown with $label', ({ overrides }) => {
    existsSync.mockReturnValue(false);
    expect(launchTagsOf(session(overrides), NOW).command_head).toBe('unknown');
    expect(launchTagsOf(session(overrides), NOW).command_head_since_detection).toBe('unknown');
  });

  it('says whether the head still resolves to the file detection found, never what it is', () => {
    const root = realFs.mkdtempSync(path.join(os.tmpdir(), 'launch-head-'));
    try {
      const agentCliPath = path.join(root, 'claude');
      realFs.writeFileSync(agentCliPath, '#!/bin/sh\n', { mode: 0o755 });
      expect(launchTagsOf(session({ agentCliPath }), NOW).command_head_since_detection).toBe('unknown');

      recordDetectedCliIdentity(agentCliPath);
      expect(launchTagsOf(session({ agentCliPath }), NOW).command_head_since_detection).toBe('same');

      const replacement = path.join(root, 'claude.new');
      realFs.writeFileSync(replacement, '#!/bin/sh\necho newer\n', { mode: 0o755 });
      realFs.renameSync(replacement, agentCliPath);
      const tags = launchTagsOf(session({ agentCliPath }), NOW);
      expect(tags.command_head_since_detection).toBe('changed');
      expect(JSON.stringify(tags)).not.toContain(root);
    } finally {
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks an overlay that gave up waiting', () => {
    expect(launchTagsOf(session(), NOW).overlay_ceiling).toBe('no');
    expect(launchTagsOf(session({ readyCeilingAt: NOW }), NOW).overlay_ceiling).toBe('tripped');
  });

  it.each([
    { shell: '/Users/dev/bin/my-custom-shell', label: 'other' },
    { shell: 'wsl -d Private-Distro', label: 'other' },
    { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', label: 'pwsh' },
    { shell: '/Users/dev/.nix-profile/bin/zsh', label: 'zsh' },
  ])('reports $shell as $label', ({ shell, label }) => {
    expect(launchTagsOf(session({ shell }), NOW).shell).toBe(label);
  });

  it('sends an agent name it does not recognize the shape of as other', () => {
    expect(launchTagsOf(session({ agentName: '/Users/dev/agent' }), NOW).agent).toBe('other');
  });

  // DESKTOP-2M: a resume that found no conversation after the check answered
  // `unknown`. These say which of the check's paths it took.
  it('sends what the resume check read on a resuming session', () => {
    const resumeEvidence = { turns: 'yes', agentReport: 'status', transcript: 'on_disk', cwd: 'moved' } as const;

    expect(launchTagsOf(session({ resuming: true, resumeEvidence }), NOW)).toMatchObject({
      resume_turns: 'yes',
      resume_agent_report: 'status',
      resume_transcript: 'on_disk',
      resume_cwd: 'moved',
    });
  });

  it('sends resume_account only once the chokepoint compared the accounts', () => {
    const resumeEvidence = { turns: 'yes', agentReport: 'status', transcript: 'on_disk', cwd: 'same' } as const;

    expect(launchTagsOf(session({ resumeEvidence: { ...resumeEvidence, account: 'changed' } }), NOW).resume_account).toBe('changed');
    expect(launchTagsOf(session({ resumeEvidence }), NOW)).not.toHaveProperty('resume_account');
  });

  it('sends no resume tags on a fresh session, or a resume with no evidence', () => {
    const resumeEvidence = { turns: 'no', agentReport: 'none', transcript: 'not_reported', cwd: 'unknown' } as const;

    for (const tags of [
      launchTagsOf(session({ resuming: false, resumeEvidence }), NOW),
      launchTagsOf(session({ resuming: true, resumeEvidence: null }), NOW),
    ]) {
      expect(Object.keys(tags).filter((name) => name.startsWith('resume_'))).toEqual([]);
    }
  });
});

describe('classifyLaunchOutput', () => {
  it.each([
    ['zsh: command not found: claude', 'command_not_found'],
    ['bash: claude: command not found', 'command_not_found'],
    ['/bin/bash: line 1: claude: command not found', 'command_not_found'],
    ['sh: 1: claude: not found', 'command_not_found'],
    ["'claude' is not recognized as an internal or external command,", 'command_not_found'],
    ["claude : The term 'claude' is not recognized as a name of a cmdlet", 'command_not_found'],
    ['fish: Unknown command: claude', 'command_not_found'],
    ['zsh: permission denied: claude', 'permission_denied'],
    ['bash: /usr/local/bin/claude: Permission denied', 'permission_denied'],
    ['zsh: no such file or directory: /opt/claude', 'no_such_file'],
    ['bash: /opt/claude: No such file or directory', 'no_such_file'],
    ['/bin/bash: line 1: /opt/claude: No such file or directory', 'no_such_file'],
    ['The system cannot find the path specified.', 'no_such_file'],
    // A shebang names a second path, and the line holds both phrases: the
    // command exists, its interpreter does not.
    ['bash: /opt/claude: /usr/bin/node: bad interpreter: No such file or directory', 'bad_interpreter'],
    ['zsh: /opt/claude: bad interpreter: /usr/bin/node: no such file or directory', 'bad_interpreter'],
    ['/bin/bash: line 1: /opt/claude: /usr/bin/node: bad interpreter: No such file or directory', 'bad_interpreter'],
    ['bash: /opt/claude: /usr/bin/node: bad interpreter: Permission denied', 'bad_interpreter'],
    ["error: unknown option '--session-id'", 'unknown_option'],
    ["error: unexpected argument '--foo' found", 'unknown_option'],
  ])('reads %j as %s', (line, outputClass) => {
    expect(classifyLaunchOutput(`$ claude --print\r\n${line}\r\n$ `)).toBe(outputClass);
  });

  it('reads through escape sequences', () => {
    expect(classifyLaunchOutput('\x1b[1;31mzsh: command not found: claude\x1b[0m\r\n')).toBe('command_not_found');
  });

  /**
   * Each line as a real shell printed it on a real pty, with the bracketed-paste
   * switches, clears and carriage returns around it: bash 5.2, dash, zsh 5.9,
   * fish 3.7.0 and nushell 0.116.0 on Ubuntu 24.04 (typed whole and through the
   * launcher alike), PowerShell 7. Only the temp folder is renamed, and nu's box
   * rules are cut short. `typed-launch-round-trip.test.ts` pins them again in
   * each shell CI runs.
   */
  it.each([
    // Measured on a macOS runner: BSD cat leaves the path unquoted, and the long
    // temp path wraps zsh's job line, leaving just the message once zsh's redraw
    // is read out. The wrapped tail and the redrawn prompt sit around it.
    ['cat: /tmp/p/project  one/.kangentic/sessions/session-1/launch.sh: No such file or directory\r\n', 'launcher_unreadable'],
    ['runner@host ~ %\r\n%\r\nzsh: killed\r\ngl5gw3l_w0000gn/T/kng-typed-launch-v3enVY/agent dir/signal-kill\'\r\ng\r\nrunner@host ~ % cclear; \'/private/var/folders/h5/t85nd63d71x27_8\r\n', 'killed'],
    ['runner@host ~ %\r\n%\r\nzsh: segmentation fault\r\ngl5gw3l_w0000gn/T/kng-typed-launch-7WnXYp/agent dir/signal-segv\'\r\ng\r\n', 'crashed'],
    ['runner@host ~ %\r\n%\r\nzsh: bad CPU type in executable: /tmp/p/agent dir/wrong-cpu\r\ngl5gw3l_w0000gn/T/kng-typed-launch-lVCIBO/agent dir/wrong-cpu\'\r\n', 'bad_cpu_type'],
    ["\x1b[H\x1b[2J\x1b[3Jzsh: killed     '/tmp/p/agent dir/signal-kill'\r\n", 'killed'],
    ["\x1b[H\x1b[2J\x1b[3Jzsh: segmentation fault (core dumped)  '/tmp/p/agent dir/signal-segv'\r\n", 'crashed'],
    ['\x1b[H\x1b[2J\x1b[3Jzsh: exec format error: /tmp/p/agent dir/not-a-program\r\n', 'exec_format'],
    ["\rsource: Error encountered while sourcing file ''/tmp/p/project  one/.kangentic/sessions/s1/launch.fish'':\r\nsource: No such file or directory\r\n", 'launcher_unreadable'],
    ["\x1b[H\x1b[2J\x1b[3Jfish: Job 1, ''/tmp/p/agent dir/…' terminated by signal SIGKILL (Forced quit)\r\n", 'killed'],
    ["\x1b[H\x1b[2J\x1b[3Jfish: Job 1, ''/tmp/p/agent dir/…' terminated by signal SIGSEGV (Address boundary error)\r\n", 'crashed'],
    ["\x1b[H\x1b[2J\x1b[3Jexec: Failed to execute process: '/tmp/p/agent dir/not-a-program' the file could not be run by the operating system.\r\n", 'exec_format'],
    [[
      '\x1b]2;/p> source\x07Error: \x1b[31mnu::parser::sourced_file_not_found\x1b[0m\r\n\r\n',
      '  \x1b[31m×\x1b[0m File not found\r\n',
      '   ╭─[repl_entry #1:1:8]\r\n',
      " 1 │ source '/tmp/p/project  one/.kangentic/sessions/s1/launch.nu'\r\n",
      '   ·          ──────\r\n',
      '   ·          ╰── File not found: /tmp/p/project  one/.kangentic/sessions/s1/launch.nu\r\n',
      '   ╰────\r\n',
      '  help: sourced files need to be available before your script is run\r\n',
    ].join(''), 'launcher_unreadable'],
    [[
      '\x1b[1;1H\x1b[2J\x1b[3JError: \x1b[31mnu::shell::terminated_by_signal\x1b[0m\r\n',
      '  \x1b[31m×\x1b[0m External command was terminated by a signal\r\n',
      " 1 │ clear; ^'/tmp/p/agent dir/signal-kill'\r\n",
      '   ·                              ╰── terminated by SIGKILL (9)\r\n',
    ].join(''), 'killed'],
    [[
      '\x1b[1;1H\x1b[2J\x1b[3JError: \x1b[31mnu::shell::core_dumped\x1b[0m\r\n\r\n',
      '  \x1b[31m×\x1b[0m External command core dumped\r\n',
      " 1 │ clear; ^'/tmp/p/agent dir/signal-segv'\r\n",
      '   ·                                  ╰── core dumped with SIGSEGV (11)\r\n',
      '   ╰────\r\n',
    ].join(''), 'crashed'],
    ["\x1b[?2004l\rcat: '/tmp/p/project  one/.kangentic/sessions/s1/launch.sh': No such file or directory\r\n", 'launcher_unreadable'],
    ["\x1b[?2004l\rcat: '/tmp/p/project  one/.kangentic/sessions/s1/launch.sh': Permission denied\r\n", 'launcher_unreadable'],
    ['cat: /tmp/p/project/.kangentic/sessions/s1/launch.sh: No such file or directory\r\n', 'launcher_unreadable'],
    [".: The term 'C:\\Users\\dev\\kng probe dir\\launch.ps1' is not recognized as a name of a cmdlet, function, script file, or executable program.\r\n", 'launcher_unreadable'],
    ['\x1b[?2004l\rKilled\r\n\x1b[?2004hbash-5.2$ ', 'killed'],
    ['\x1b[?2004l\rSegmentation fault (core dumped)\r\n\x1b[?2004hbash-5.2$ ', 'crashed'],
    ['\x1b[?2004l\rBus error (core dumped)\r\n', 'crashed'],
    ['\x1b[?2004l\rAborted (core dumped)\r\n', 'crashed'],
    ['\x1b[?2004l\rIllegal instruction (core dumped)\r\n', 'crashed'],
    ['Segmentation fault\r\n', 'crashed'],
    ['\x1b[?2004l\rbash: /tmp/p/agent-elf: cannot execute binary file: Exec format error\r\n', 'exec_format'],
    ['dash: 1: /tmp/p/agent-elf: Exec format error\r\n', 'exec_format'],
  ])('reads the real shell output %j as %s', (output, outputClass) => {
    expect(classifyLaunchOutput(output)).toBe(outputClass);
  });

  it.each([
    // The same words, echoed on a typed line that quotes them.
    ["$ claude 'Killed'"],
    ['$ claude "Segmentation fault (core dumped)"'],
    ["bash-5.2$ claude 'cat: /p/launch.sh: No such file or directory'"],
    ["claude 'bash: /opt/x: cannot execute binary file: Exec format error'"],
    ["$ claude 'zsh: killed and fish: Job 1, done'"],
    ["claude '╰── terminated by SIGKILL (9) twice'"],
    // A `cat` failure about some other file is not the launcher's.
    ['cat: /tmp/p/notes.txt: No such file or directory'],
    ["The term 'launch.ps1' is not recognized"],
    // nushell hands a file it cannot run to /bin/sh, which reads its bytes as a
    // command: a line that names no cause, so it stays unclassified.
    ["/tmp/p/agent dir/not-a-program: 1: \x7fELF\x02\x01\x01!!: not found"],
  ])('does not take the quoted words %j for the new classes', (text) => {
    expect(classifyLaunchOutput(`${text}\r\n`)).toBe('other');
  });

  it.each([
    // The typed line holds the task's prompt, echoed by the shell.
    ["claude 'fix the permission denied error in zsh: command not found: foo'"],
    ['$ claude "why do I get: No such file or directory"'],
    ['Working on: bash: claude: Permission denied handling'],
    [''],
    ['$ '],
  ])('does not take %j for a failure', (text) => {
    expect(classifyLaunchOutput(text)).toBe('other');
  });

  it('lets the adapter speak first, since only it knows its CLI\'s words', () => {
    const adapter = { identifyUserSetupFailure: () => ({ failure: 'login_required', line: 'Not logged in' }) } as unknown as AgentParser;
    expect(classifyLaunchOutput('zsh: command not found: claude', adapter)).toBe('login_required');
  });

  it('falls through to the shell\'s shapes when the adapter names nothing', () => {
    const adapter = { identifyUserSetupFailure: () => null } as unknown as AgentParser;
    expect(classifyLaunchOutput('zsh: command not found: claude', adapter)).toBe('command_not_found');
  });

  it('prefers the newest line', () => {
    const output = 'zsh: permission denied: old\r\nzsh: command not found: claude\r\n';
    expect(classifyLaunchOutput(output)).toBe('command_not_found');
  });

  it('looks only at the last lines, so an old failure cannot speak for this launch', () => {
    const filler = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\r\n');
    expect(classifyLaunchOutput(`zsh: command not found: old\r\n${filler}`)).toBe('other');
  });
});

describe('classifyLaunchOutput on real ConPTY output under cmd', () => {
  const { claudeResumeMiss, cmdInputLineTooLong, resumedId } = conptyCaptures;
  const namesMiss = {
    namesMissingConversation: (output: string, id: string) => output.includes(`No conversation found with session ID: ${id}`),
  } as unknown as AgentParser;

  it('names a line cmd refused, under its wrapped echo', () => {
    expect(classifyLaunchOutput(cmdInputLineTooLong)).toBe('line_too_long');
  });

  it('names a line refused for a command cmd runs for another shell', () => {
    expect(classifyLaunchOutput('PS C:\\project> & agent.cmd\r\nThe command line is too long.\r\n')).toBe('line_too_long');
  });

  it('reads the refusal a spawn types, whose prompt follows it by a cursor move with no newline', () => {
    const output = '\x1b[3J\x1b[HThe command line is too long.\x1b[3;1HC:\\Users\\dev\\project>\x1b[?25h';
    expect(classifyLaunchOutput(output)).toBe('line_too_long');
  });

  it('does not read a prompt that quotes the sentence as the refusal', () => {
    expect(classifyLaunchOutput('C:\\project>claude "The input line is too long."\r\n')).toBe('other');
  });

  it('names a conversation the CLI could not find, for a launch that resumed it', () => {
    expect(classifyLaunchOutput(claudeResumeMiss, namesMiss, resumedId)).toBe('conversation_missing');
  });

  it('never calls a fresh launch a missing conversation, since it resumed nothing', () => {
    expect(classifyLaunchOutput(claudeResumeMiss, namesMiss, null)).toBe('other');
  });

  it('asks only an adapter that knows its CLI\'s words', () => {
    expect(classifyLaunchOutput(claudeResumeMiss, undefined, resumedId)).toBe('other');
  });

  it('lets the adapter speak before a later shell-shaped line', () => {
    const output = `${claudeResumeMiss}\r\nzsh: permission denied: x\r\n`;
    expect(classifyLaunchOutput(output, namesMiss, resumedId)).toBe('conversation_missing');
    // Without the adapter's word the shell's line is what the output holds.
    expect(classifyLaunchOutput(output)).toBe('permission_denied');
  });

  it.each(['powershellShimLineTooLong', 'cmdSpawnRefusal'] as const)('names %s as a line too long, and quotes the shell\'s sentence', (key) => {
    expect(classifyLaunchOutput(conptyCaptures[key])).toBe('line_too_long');
    expect(lineTooLongSentence(conptyCaptures[key])).toBe('The command line is too long.');
  });

  it('lets the user\'s own setup speak first', () => {
    const adapter = {
      ...namesMiss,
      identifyUserSetupFailure: () => ({ failure: 'login_required', line: 'x' }),
    } as unknown as AgentParser;
    expect(classifyLaunchOutput(claudeResumeMiss, adapter, resumedId)).toBe('login_required');
  });
});

describe('isLaunchRetryPointless', () => {
  it.each(['line_too_long', 'login_required', 'bad_configuration'] as const)('answers yes for %s', (outputClass) => {
    expect(isLaunchRetryPointless(outputClass)).toBe(true);
  });

  it.each(['other', 'not_read', 'unreadable', 'conversation_missing', 'command_not_found'] as const)('answers no for %s', (outputClass) => {
    expect(isLaunchRetryPointless(outputClass)).toBe(false);
  });

  // The shell classes stay retryable on purpose: a launch that died of its own
  // accord or on a transient file state can succeed on the next try.
  it.each(['exec_format', 'killed', 'crashed', 'launcher_unreadable', 'bad_cpu_type'] as const)('answers no for the shell class %s', (outputClass) => {
    expect(isLaunchRetryPointless(outputClass)).toBe(false);
  });
});

describe('reportLaunchFailure', () => {
  const tags = { agent: 'claude', attempt: '1' };

  it('sends a fixed message under the stage name, with a fingerprint per cause', () => {
    reportLaunchFailure({ stage: 'shell_exit', cause: 'command_not_found', tags });

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, eventTags, contexts, fingerprint] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('AgentLaunchShellExitError');
    expect((error as Error).message).toBe('Agent launch failed: shell_exit (command_not_found)');
    expect(eventTags).toMatchObject({ source: 'agent_launch', stage: 'shell_exit', cause: 'command_not_found', platform: process.platform, agent: 'claude' });
    expect(contexts).toEqual({});
    expect(fingerprint).toEqual(['agent-launch', 'shell_exit', 'command_not_found']);
  });

  it('gives each cause its own issue', () => {
    reportLaunchFailure({ stage: 'never_started', cause: 'command_not_found', tags });
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags });

    const fingerprints = reportHandledError.mock.calls.map((call) => call[3]);
    expect(fingerprints[0]).not.toEqual(fingerprints[1]);
  });

  it('reports a class once per run, so one broken machine cannot use up the quota', () => {
    for (let index = 0; index < 5; index += 1) {
      reportLaunchFailure({ stage: 'never_started', cause: 'other', tags });
    }
    expect(reportHandledError).toHaveBeenCalledTimes(1);
  });

  it('keeps the local line for a report the latch held back', () => {
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags });
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags });
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(2);
  });

  it('sends one event per agent for the same stage, cause and attempt', () => {
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags: { agent: 'claude', attempt: '1' } });
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags: { agent: 'codex', attempt: '1' } });
    expect(reportHandledError).toHaveBeenCalledTimes(2);
    expect(reportHandledError.mock.calls.map((call) => call[1].agent)).toEqual(['claude', 'codex']);
  });

  it('sends one event when the same agent fails twice, and logs both', () => {
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags: { agent: 'codex', attempt: '1' } });
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags: { agent: 'codex', attempt: '1' } });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(2);
  });

  it('lets a retry that failed through the latch of the attempt before it', () => {
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags: { attempt: '1' } });
    reportLaunchFailure({ stage: 'never_started', cause: 'other', tags: { attempt: '2' } });
    expect(reportHandledError).toHaveBeenCalledTimes(2);
  });

  it('strips paths from an error it was handed, and keeps its name and frames', () => {
    const error = new TypeError('cannot read /Users/dev/secret-project/launch.sh');
    const frames = error.stack;
    reportLaunchFailure({ stage: 'preflight', cause: 'agent_start', tags, error });

    const sent = reportHandledError.mock.calls[0][0] as Error;
    expect(sent.name).toBe('TypeError');
    expect(sent.message).not.toContain('/Users/dev');
    expect(sent.stack).toBe(frames);
  });

  it('hands a missing CLI to the filter as its own type, which is what excludes it', () => {
    const error = new AgentCliNotFoundError('claude', 'Claude Code');
    reportLaunchFailure({ stage: 'preflight', cause: 'agent_start', tags, error });
    // A copy would lose the type. launch-user-setup-exclusion.test.ts runs the real filter.
    expect(reportHandledError.mock.calls[0][0]).toBe(error);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });
});

describe('reportSessionLaunchFailure', () => {
  const COMMAND = "claude --session-id abc 'ship the Acme secret migration'";
  const OUTPUT = `$ ${COMMAND}\r\nzsh: command not found: claude\r\n$ `;

  it('sends the class of the output and none of its text', async () => {
    const target = session({ cwd: '/Users/dev/secret-project', launcherPath: '/Users/dev/secret-project/launch.sh' });
    reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: async () => OUTPUT });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    const [error, eventTags] = reportHandledError.mock.calls[0];
    expect(eventTags.output_class).toBe('command_not_found');
    expect(eventTags.cause).toBe('command_not_found');
    const sent = JSON.stringify([(error as Error).message, eventTags]);
    expect(sent).not.toContain('Acme');
    expect(sent).not.toContain('claude --session-id');
    expect(sent).not.toContain('/Users/dev');
  });

  describe('a resumed conversation the CLI says does not exist', () => {
    const resumedId = conptyCaptures.resumedId;
    const namesMiss = {
      namesMissingConversation: (output: string, id: string) => output.includes(`No conversation found with session ID: ${id}`),
    } as unknown as AgentParser;

    it('is reported as conversation_missing when the launch resumed', async () => {
      const target = session({ agentParser: namesMiss, resuming: true, agentSessionId: resumedId });
      reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: async () => conptyCaptures.claudeResumeMiss });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      expect(reportHandledError.mock.calls[0][1].output_class).toBe('conversation_missing');
    });

    it('is not reported as one when the launch was fresh, which resumed nothing', async () => {
      const target = session({ agentParser: namesMiss, resuming: false, agentSessionId: resumedId });
      reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: async () => conptyCaptures.claudeResumeMiss });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      expect(reportHandledError.mock.calls[0][1].output_class).not.toBe('conversation_missing');
    });
  });

  it('posts the read before it returns, ahead of the kill a caller does next', () => {
    const readOutput = vi.fn(async () => OUTPUT);
    reportSessionLaunchFailure({ session: session(), stage: 'never_started', readOutput });
    expect(readOutput).toHaveBeenCalledTimes(1);
  });

  it('takes the tags now, so a later change to the session does not reach the event', async () => {
    const target = session({ shell: '/bin/zsh' });
    reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: async () => '' });
    target.shell = '/bin/bash';
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(reportHandledError.mock.calls[0][1].shell).toBe('zsh');
  });

  it('reports a session once', async () => {
    const target = session();
    reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: null });
    reportSessionLaunchFailure({ session: target, stage: 'shell_exit', readOutput: null });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(target.launchFailureNoted).toBe(true);
  });

  it('says when the ring was gone, and keeps that out of the issue', () => {
    reportSessionLaunchFailure({ session: session(), stage: 'abandoned', readOutput: null });
    const [, eventTags, , fingerprint] = reportHandledError.mock.calls[0];
    expect(eventTags.output_class).toBe('not_read');
    expect(fingerprint).toEqual(['agent-launch', 'abandoned', 'unknown']);
  });

  it('says when the read failed', async () => {
    reportSessionLaunchFailure({ session: session(), stage: 'never_started', readOutput: async () => { throw new Error('host gone'); } });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(reportHandledError.mock.calls[0][1].output_class).toBe('unreadable');
  });

  it('sends nothing once the quit has started, since nothing would land', async () => {
    const reading = Promise.resolve(OUTPUT);
    reportSessionLaunchFailure({ session: session(), stage: 'never_started', readOutput: () => reading });
    shuttingDown.value = true;
    await reading;
    await Promise.resolve();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('asks for a shell failure before it speaks for an adapter that reports no start', async () => {
    const silent = session({ reportsAgentStart: false });
    reportSessionLaunchFailure({ session: silent, stage: 'never_started', readOutput: async () => 'Goodbye\r\n$ ', onlyWhenIdentified: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reportHandledError).not.toHaveBeenCalled();

    const failed = session({ reportsAgentStart: false });
    reportSessionLaunchFailure({ session: failed, stage: 'never_started', readOutput: async () => OUTPUT, onlyWhenIdentified: true });
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
  });

  it('adds what the caller knows', () => {
    reportSessionLaunchFailure({
      session: session(),
      stage: 'shell_exit',
      readOutput: null,
      extraTags: { exit_code: '1', exit_signal: 'none' },
    });
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ exit_code: '1', exit_signal: 'none' });
  });
});

describe('reportLaunchRecovered', () => {
  it('sends one event, so a recovered failure still shows', () => {
    const target = session({ startPath: 'retry' });
    reportLaunchRecovered(target);
    reportLaunchRecovered(target);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, eventTags] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('AgentLaunchRecoveredError');
    expect(eventTags).toMatchObject({ retry: 'recovered', attempt: '2' });
  });
});

describe('reportPtyPortFailure', () => {
  it('opens its own issue under its own error name, with no session to describe', () => {
    reportPtyPortFailure();

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, eventTags, , fingerprint] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('PtyPortDeliveryError');
    expect(eventTags).toMatchObject({ source: 'agent_launch', stage: 'pty_port', cause: 'not_delivered' });
    expect(fingerprint).toEqual(['agent-launch', 'pty_port', 'not_delivered']);
  });

  it('reports once per run, so a window that keeps asking cannot fill the quota', () => {
    reportPtyPortFailure();
    reportPtyPortFailure();
    expect(reportHandledError).toHaveBeenCalledTimes(1);
  });
});

describe('reportPreflightFailure', () => {
  const base = { cause: 'worktree', agent: 'claude', startPath: 'board' } as const;

  it('names the kind of error and its errno, which are fixed shapes', () => {
    const error = Object.assign(new TypeError('boom'), { code: 'EBUSY' });
    reportPreflightFailure({ ...base, error });

    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ error_type: 'TypeError', errno: 'EBUSY', cause: 'worktree' });
  });

  it('leaves out a code or a name that carries text, since a branch is named after a task', () => {
    const error = Object.assign(new Error('boom'), { code: 'fix-acme-billing', name: 'fix: the Acme billing export' });
    reportPreflightFailure({ ...base, error });

    const eventTags = reportHandledError.mock.calls[0][1];
    expect(eventTags).not.toHaveProperty('errno');
    expect(eventTags).not.toHaveProperty('error_type');
    expect(JSON.stringify(eventTags)).not.toContain('Acme');
    expect(JSON.stringify(eventTags)).not.toContain('acme');
  });

  it('sends a fixed message for an error whose text it was not told to keep', () => {
    reportPreflightFailure({ ...base, error: new Error("fatal: cannot lock ref 'refs/heads/fix-acme-billing'") });

    const sent = reportHandledError.mock.calls[0][0] as Error;
    expect(sent.name).toBe('AgentLaunchPreflightError');
    expect(sent.message).toBe('Agent launch failed: preflight (worktree)');
  });

  it('keeps the message when told to, with its paths redacted', () => {
    reportPreflightFailure({ ...base, error: new Error('cannot read /Users/dev/secret-project/launch.sh'), keepMessage: true });

    const sent = reportHandledError.mock.calls[0][0] as Error;
    expect(sent.message).toContain('cannot read');
    expect(sent.message).not.toContain('/Users/dev');
  });

  it('reports a step that failed with a return value rather than a throw', () => {
    reportPreflightFailure({ ...base, error: null });

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect((reportHandledError.mock.calls[0][0] as Error).name).toBe('AgentLaunchPreflightError');
  });

  it('does not count a start that was taken over', () => {
    reportPreflightFailure({ ...base, error: new DOMException('aborted', 'AbortError') });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('never throws, so a failed report cannot replace the failure it reports', () => {
    reportHandledError.mockImplementationOnce(() => { throw new Error('sentry is down'); });

    expect(() => reportPreflightFailure({ ...base, error: new Error('git failed') })).not.toThrow();
  });
});

describe('logLaunchStep', () => {
  it('logs the session, the step, and an agent and shell from fixed lists, nothing else', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const target = session({
      id: 'abcdef12-0000-0000-0000-000000000000',
      shell: '/Users/dev/bin/my-custom-shell',
      cwd: '/Users/dev/secret-project',
      launcherPath: '/Users/dev/secret-project/launch.sh',
    });

    logLaunchStep(target, 'first_output');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[AGENT-LAUNCH] session=abcdef12 step=first_output agent=claude shell=other');
  });
});

describe('preflightTagsOf', () => {
  it('needs no session', () => {
    expect(preflightTagsOf({ agent: 'codex', agentCliVersion: '0.163.0', startPath: 'phone' })).toEqual({
      agent: 'codex',
      agent_cli_version: '0.163.0',
      start_path: 'phone',
      attempt: '1',
    });
  });
});
