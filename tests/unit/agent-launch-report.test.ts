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
// The session-id report's `node` lookup, which would otherwise read this machine's PATH.
const nodeLookup = vi.hoisted(() => vi.fn(async (): Promise<string | null> => 'C:\\Users\\dev\\node\\node.exe'));
vi.mock('which', () => ({ default: Object.assign(nodeLookup, { sync: () => null }) }));

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
  lineTooLongSentence,
  logLaunchStep,
  preflightTagsOf,
  noteSessionIdCaptureWindowPassed,
  placeTagOf,
  reportLaunchFailure,
  reportLaunchRecovered,
  reportPreflightFailure,
  reportPtyPortFailure,
  reportSessionIdCaptureOutcome,
  reportSessionLaunchFailure,
  resetLaunchReports,
} from '../../src/main/pty/agent-launch-report';
import { trackEvent } from '../../src/main/analytics/analytics';
import { isReported } from '../../src/main/analytics/handled-report';
import { AgentUserSetupError } from '../../src/shared/user-configuration-error';
import { cliVersionTag } from '../../src/main/agent/shared/cli-version-tag';
import { AgentCliNotFoundError } from '../../src/main/agent/shared/agent-cli-not-found';
import { WorktreeSetupScriptError } from '../../src/main/git/worktree-errors';
import { AgentBatchShimUnresolvedError } from '../../src/main/pty/spawn/agent-start-refused';
import { recordDetectedCliIdentity, resetDetectedCliIdentities } from '../../src/main/agent/shared/cli-identity';
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import conptyCaptures from '../fixtures/conpty-cmd-failures.json';
import { npmDirectCmdShim } from '../fixtures/npm-shim-fixtures';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import { HostRequestUnansweredError, noteHostRequestWait } from '../../src/main/remote/link/host-request-unanswered-error';
import { fromPtyHostError, toPtyHostError } from '../../src/main/pty/host/protocol';
import { SESSION_ID_CAPTURE_SOURCES } from '../../src/main/pty/lifecycle/session-id-manager';
import type { AgentParser, SessionIdHookLoadEvidence, SessionIdLoginEvidence, SessionIdStoreEvidence, StoredCliTarget } from '../../src/shared/types';

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
  nodeLookup.mockReset();
  nodeLookup.mockResolvedValue('C:\\Users\\dev\\node\\node.exe');
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

describe('cliVersionTag', () => {
  it.each([
    ['2.1.302', '2.1.302'],
    ['2.1.302 (Claude Code)', '2.1.302'],
    ['2026.04.29-c83a488', '2026.04.29-c83a488'],
    ['v0.2026.04.08.08.36.stable_02', 'v0.2026.04.08.08.36.stable_02'],
    ['  1.2.3\n', '1.2.3'],
  ])('keeps %j as %j', (raw, tag) => {
    expect(cliVersionTag(raw)).toBe(tag);
  });

  it.each([
    [null], [undefined], [''],
    ['/Users/dev/.local/bin/claude'],
    ['C:\\Users\\dev\\bin\\claude.exe'],
    ['Error: cannot read config at /Users/dev'],
    ['a-very-private-branch-name'],
  ])('reads %j as unknown', (raw) => {
    expect(cliVersionTag(raw)).toBe('unknown');
  });
});

describe('placeTagOf', () => {
  const sshTarget = { kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'bash', localHome: '' } as StoredCliTarget;
  const wslTarget = { kind: 'wsl', distro: 'Ubuntu' } as StoredCliTarget;

  it.each<[string, Partial<ManagedSession>, string]>([
    ['a host id alone', { hostId: 'host-1' }, 'ssh'],
    ['an ssh CLI target with no host id', { hostId: null, cliTarget: sshTarget }, 'ssh'],
    ['a wsl CLI target under a native shell', { cliTarget: wslTarget, shell: 'pwsh' }, 'wsl'],
    ['a wsl shell spec with no CLI target', { shell: 'wsl -d Ubuntu' }, 'wsl'],
    ['none of them', { shell: '/bin/zsh' }, 'local'],
  ])('reads %s as %s', (_label, overrides, place) => {
    expect(placeTagOf(session(overrides))).toBe(place);
  });

  it('puts the place on an ssh session\'s launch tags', () => {
    expect(launchTagsOf(session({ hostId: 'host-1' }), NOW)).toMatchObject({ place: 'ssh' });
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

  it('sends none of the text of an error it was handed, and keeps its frames', () => {
    const error = new TypeError("cannot read /Users/dev/secret-project/launch.sh on branch 'fix-acme-billing'");
    const frames = error.stack?.slice(error.stack.search(/\n\s+at /)) ?? '';
    reportLaunchFailure({ stage: 'preflight', cause: 'agent_start', tags, error });

    const sent = reportHandledError.mock.calls[0][0] as Error;
    expect(sent.name).toBe('AgentLaunchPreflightError');
    expect(sent.message).toBe('Agent launch failed: preflight (agent_start)');
    expect(sent.stack).toBe(`AgentLaunchPreflightError: Agent launch failed: preflight (agent_start)${frames}`);
    expect(sent.stack).not.toMatch(/secret-project|acme/);
  });

  it('marks the error it was handed, so a later chokepoint skips it', () => {
    const error = new Error('spawn broke');
    reportLaunchFailure({ stage: 'preflight', cause: 'agent_start', tags, error });
    expect(isReported(error)).toBe(true);
  });

  it('hands a missing CLI to the filter as its own type, which is what excludes it', () => {
    const error = new AgentCliNotFoundError('claude', 'Claude Code');
    reportLaunchFailure({ stage: 'preflight', cause: 'agent_start', tags, error });
    // A copy would lose the type. launch-user-setup-exclusion.test.ts runs the real filter.
    expect(reportHandledError.mock.calls[0][0]).toBe(error);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });
});

/** What cmd prints for a quoted program path that is not on disk, under a PowerShell that handed it a `.cmd` head. */
const CMD_PATH_NOT_FOUND = 'PS C:\\project> codex\r\nThe system cannot find the path specified.\r\nPS C:\\project> ';

/** The wrapper's quoted target, which is never on disk. */
const GONE_WRAPPER_TARGET = 'C:\\tools\\codex\\codex.exe';

/**
 * Sentry DESKTOP-4Z's shape: a `.cmd` wrapper on disk whose quoted absolute
 * target is gone, on a platform that reads as Windows. The wrapper is a real
 * file, so the shim reader runs as it does in production, and the head is
 * checked as a Windows path on any host. Registers its own hooks.
 */
function useGoneWrapperShim(): { shimPath: () => string; setPlatform: (platform: NodeJS.Platform) => void } {
  const originalPlatform = process.platform;
  let root = '';
  let shimPath = '';
  beforeEach(() => {
    root = realFs.mkdtempSync(path.join(os.tmpdir(), 'launch-shim-'));
    shimPath = path.join(root, 'codex.cmd');
    realFs.writeFileSync(shimPath, `@echo off\r\n"${GONE_WRAPPER_TARGET}" %*\r\n`);
    existsSync.mockImplementation((candidate: unknown) => candidate !== GONE_WRAPPER_TARGET);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    existsSync.mockReturnValue(true);
    realFs.rmSync(root, { recursive: true, force: true });
  });
  return {
    shimPath: () => shimPath,
    setPlatform: (platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true }),
  };
}

const SHIM_TAG_NAMES = ['batch_shim', 'batch_shim_shape', 'batch_shim_ps1', 'shim_target'] as const;

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

  describe('a launch that never started, whose .cmd head printed cmd\'s cannot-find-the-path', () => {
    const wrapper = useGoneWrapperShim();

    it('reads the head shim and names the target it quotes as gone', async () => {
      const target = session({ shell: 'pwsh', agentCliPath: wrapper.shimPath() });
      reportSessionLaunchFailure({ session: target, stage: 'never_started', readOutput: async () => CMD_PATH_NOT_FOUND });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      const tags = reportHandledError.mock.calls[0][1];
      expect(tags).toMatchObject({ output_class: 'no_such_file', batch_shim: 'unparsed', batch_shim_shape: 'absolute_path', shim_target: 'missing' });
      expect(JSON.stringify(tags)).not.toContain('codex.exe');
    });

    it('reads no shim for a shell_exit, a stage whose no_such_file is not the chain\'s', async () => {
      const target = session({ shell: 'pwsh', agentCliPath: wrapper.shimPath() });
      reportSessionLaunchFailure({ session: target, stage: 'shell_exit', readOutput: async () => CMD_PATH_NOT_FOUND });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      for (const name of SHIM_TAG_NAMES) expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty(name);
    });

    async function sentShimTags(overrides: Partial<ManagedSession>, stage: 'never_started' | 'abandoned' = 'never_started'): Promise<Record<string, string>> {
      reportSessionLaunchFailure({ session: session({ shell: 'pwsh', ...overrides }), stage, readOutput: async () => CMD_PATH_NOT_FOUND });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      return reportHandledError.mock.calls[0][1];
    }

    it('says the target is present when the wrapper\'s quoted target is on disk', async () => {
      existsSync.mockReturnValue(true);
      const tags = await sentShimTags({ agentCliPath: wrapper.shimPath() });
      expect(tags).toMatchObject({ output_class: 'no_such_file', batch_shim: 'unparsed', batch_shim_shape: 'absolute_path', shim_target: 'present' });
    });

    it('names a .ps1 target the shim calls with no program, and sends no shim_target for it', async () => {
      realFs.writeFileSync(wrapper.shimPath(), npmDirectCmdShim('claude.ps1'));
      const tags = await sentShimTags({ agentCliPath: wrapper.shimPath() });
      expect(tags).toMatchObject({ output_class: 'no_such_file', batch_shim: 'target_ps1', batch_shim_ps1: 'no_program' });
      expect(tags).not.toHaveProperty('shim_target');
    });

    // The shim is read inside the send, so a head gone by then must cost the
    // report its shim tags at most, never the report itself.
    it('still sends the report when the head shim cannot be read, and names it unreadable', async () => {
      realFs.rmSync(wrapper.shimPath(), { force: true });
      const tags = await sentShimTags({ agentCliPath: wrapper.shimPath() });
      expect(tags).toMatchObject({ output_class: 'no_such_file', batch_shim: 'unreadable' });
      expect(tags).not.toHaveProperty('shim_target');
    });

    it.each([
      ['a WSL shell', { shell: 'wsl.exe -d Ubuntu' }],
      ['a session on an SSH host', { hostId: 'host-1' }],
      ['a CLI that runs in a WSL distro', { cliTarget: { kind: 'wsl', distro: 'Ubuntu' } as StoredCliTarget }],
      ['a relative head', { agentCliPath: 'codex.cmd' }],
      ['no head at all', { agentCliPath: undefined }],
    ])('reads no shim for %s, whose head is not this disk\'s Windows shim', async (_label, overrides) => {
      const tags = await sentShimTags({ agentCliPath: wrapper.shimPath(), ...overrides });
      expect(tags.output_class).toBe('no_such_file');
      for (const name of SHIM_TAG_NAMES) expect(tags).not.toHaveProperty(name);
    });

    it('reads no shim for an abandoned launch, whose no_such_file is not the chain\'s', async () => {
      const tags = await sentShimTags({ agentCliPath: wrapper.shimPath() }, 'abandoned');
      expect(tags.output_class).toBe('no_such_file');
      for (const name of SHIM_TAG_NAMES) expect(tags).not.toHaveProperty(name);
    });
  });

  // Sentry DESKTOP-2J: a launch whose output matched no class ended with
  // `output_class=other`, and a shell refusing the typed line reads the same as
  // an agent that started and left. Only the shell's own error record tells them
  // apart, and only a fixed word leaves.
  describe('output that named no cause', () => {
    const POWERSHELL_PARSER_ERROR = [
      '$ claude --resume Acme-migration-token',
      "At line:1 char:19",
      '+ claude --resume Acme-migration-token',
      '+                 ~~~~~~~~~~~~~~~~~~~~',
      "Unexpected token 'Acme-migration-token' in expression or statement.",
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
      '    + FullyQualifiedErrorId : UnexpectedToken',
      'PS C:\\project> ',
    ].join('\r\n');

    async function sentTags(output: string): Promise<Record<string, string>> {
      reportSessionLaunchFailure({ session: session(), stage: 'never_started', readOutput: async () => output });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      return reportHandledError.mock.calls[0][1];
    }

    it('says the shell wrote it when a PowerShell error record is there, and sends none of its text', async () => {
      const tags = await sentTags(POWERSHELL_PARSER_ERROR);
      expect(tags).toMatchObject({ output_class: 'other', other_from: 'shell' });
      expect(JSON.stringify(tags)).not.toContain('Acme');
    });

    it('says unknown for output with no such record', async () => {
      const tags = await sentTags('$ claude\r\nsomething the agent printed before it left\r\n$ ');
      expect(tags).toMatchObject({ output_class: 'other', other_from: 'unknown' });
    });

    it('does not take prose that names a record field for the record', async () => {
      const tags = await sentTags('$ claude\r\nlook for CategoryInfo : in the docs\r\n$ ');
      expect(tags).toMatchObject({ output_class: 'other', other_from: 'unknown' });
    });

    it('adds nothing when the output named a cause, which already says who wrote it', async () => {
      const tags = await sentTags(OUTPUT);
      expect(tags.output_class).toBe('command_not_found');
      expect(tags).not.toHaveProperty('other_from');
    });

    it('adds nothing when the ring could not be read', () => {
      reportSessionLaunchFailure({ session: session(), stage: 'abandoned', readOutput: null });
      expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty('other_from');
    });

    it('sits beside agent_process when the sweep asked for it', async () => {
      reportSessionLaunchFailure({
        session: session(),
        stage: 'never_started',
        readOutput: async () => POWERSHELL_PARSER_ERROR,
        agentProcess: Promise.resolve('absent'),
      });
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ other_from: 'shell', agent_process: 'absent' });
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

describe('the session id capture reports', () => {
  const never = { kind: 'never', settledBy: 'removed', settledAt: STARTED_AT_MS + 90_000, filesystemScan: 'empty' } as const;
  const atCeiling = { kind: 'never', settledBy: 'ceiling', settledAt: STARTED_AT_MS + 300_000, filesystemScan: 'empty' } as const;
  const late ={ kind: 'late', capturedAfterMs: 42_000, capturedAt: STARTED_AT_MS + 42_000, capturedBy: 'scrollback', filesystemScan: 'pending' } as const;

  /** A session past the capture window, then its outcome, and what was sent. */
  async function settle(
    sessionOverrides: Partial<ManagedSession>,
    outcome: Parameters<typeof reportSessionIdCaptureOutcome>[1],
    storeCheck: (() => Promise<SessionIdStoreEvidence>) | null = null,
  ): Promise<void> {
    const pastWindow = session({ resuming: false, ...sessionOverrides });
    noteSessionIdCaptureWindowPassed(pastWindow, storeCheck);
    reportSessionIdCaptureOutcome(pastWindow.id, outcome, 'running');
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
  }

  /** Past every microtask the report's store-check chain takes, so a report that was going to fire has. */
  async function flushReportChain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('sends a never-captured session under a fixed message, grouped per agent, with fixed facts', async () => {
    await settle(
      {
        agentName: 'codex',
        agentCliVersion: '0.163.0 (Codex CLI)',
        openingPrompt: 'typed',
        sessionIdCreation: 'not_asked',
        agentHookObservedAt: STARTED_AT_MS + 2_000,
        agentHookLineAt: STARTED_AT_MS + 2_000,
        promptObservedAt: STARTED_AT_MS + 2_500,
        firstOutputAt: STARTED_AT_MS + 900,
      },
      never,
      async () => 'present',
    );

    const [error, eventTags, contexts, fingerprint] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('AgentSessionIdNotCapturedError');
    expect((error as Error).message).toBe('Agent session id not captured (codex)');
    expect(eventTags).toEqual({
      source: 'agent_session_id',
      agent: 'codex',
      agent_cli_version: '0.163.0',
      start_path: 'board',
      shell: 'zsh',
      opening_prompt: 'typed',
      create_chat: 'not_asked',
      prompt_seen: 'yes',
      hook_seen: 'yes',
      agent_started: 'no',
      first_output: 'yes',
      settled_by: 'removed',
      session_status: 'running',
      agent_ran_for_s: 'not_run',
      agent_life_s: 'not_run',
      fs_scan: 'empty',
      id_store: 'present',
      login: 'unknown',
      node_on_path: 'yes',
      hook_load: 'unknown',
    });
    expect(contexts).toEqual({});
    expect(fingerprint).toEqual(['agent-session-id-not-captured', 'codex']);
  });

  // Sentry DESKTOP-3A came back from OpenCode 2 on macOS with hook_seen=no, which
  // reads the same whether the plugin never loaded or loaded and heard nothing.
  // The agent's own check of its hook layer says which.
  describe('the hook load evidence', () => {
    async function settleWithHookLoad(
      hookLoadCheck: (() => Promise<SessionIdHookLoadEvidence>) | null,
      overrides: Partial<ManagedSession> = {},
    ): Promise<void> {
      const pastWindow = session({ agentName: 'opencode', resuming: false, ...overrides });
      noteSessionIdCaptureWindowPassed(pastWindow, null, null, hookLoadCheck);
      reportSessionIdCaptureOutcome(pastWindow.id, never, null);
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
    }

    it.each<SessionIdHookLoadEvidence>(['events', 'setup', 'none'])('sends the check\'s answer %s as hook_load', async (answer) => {
      await settleWithHookLoad(async () => answer);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ agent: 'opencode', hook_load: answer });
    });

    it('asks at the outcome, so a hook layer that loaded after the window counts', async () => {
      let loaded = false;
      const pastWindow = session({ agentName: 'opencode', resuming: false });
      noteSessionIdCaptureWindowPassed(pastWindow, null, null, async () => (loaded ? 'events' : 'none'));
      loaded = true;
      reportSessionIdCaptureOutcome(pastWindow.id, never, null);
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ hook_load: 'events' });
    });

    it.each<[string, (() => Promise<SessionIdHookLoadEvidence>) | null]>([
      ['has no check', null],
      ['throws', async () => { throw new Error('EACCES C:\\Users\\dev\\project\\.kangentic\\sessions\\a\\opencode-plugin.json'); }],
      ['answers something else', async () => 'C:\\Users\\dev\\project' as SessionIdHookLoadEvidence],
    ])('reads unknown when the check %s, with nothing of it in the tags', async (_label, check) => {
      await settleWithHookLoad(check);
      const eventTags = reportHandledError.mock.calls[0][1];
      expect(eventTags).toMatchObject({ hook_load: 'unknown' });
      expect(JSON.stringify(eventTags)).not.toContain('Users');
    });

    it('stops waiting on a check that hangs', async () => {
      vi.useFakeTimers();
      try {
        noteSessionIdCaptureWindowPassed(session({ agentName: 'opencode', resuming: false }), null, null, () => new Promise(() => undefined));
        reportSessionIdCaptureOutcome('session-1-long-id', never, null);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(reportHandledError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ hook_load: 'unknown' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // A signed-out Codex opens on its sign-in screen. It draws a frame, so the
  // agent reads as having run, and it never makes a conversation, so no id comes.
  // Measured on Codex 0.163.0, and the shape of Sentry DESKTOP-36's recurrence:
  // the user's setup, which no capture path could fix.
  describe('a session whose CLI holds no login', () => {
    const signedOut = async (): Promise<SessionIdLoginEvidence> => 'signed_out';

    /** A session past the window with both checks, then its outcome. Resolves once the report chain has run. */
    async function settleWithLogin(
      overrides: Partial<ManagedSession>,
      outcome: Parameters<typeof reportSessionIdCaptureOutcome>[1],
      store: SessionIdStoreEvidence,
      loginCheck: (() => Promise<SessionIdLoginEvidence>) | null,
    ): Promise<void> {
      const pastWindow = session({ agentName: 'codex', resuming: false, ...overrides });
      noteSessionIdCaptureWindowPassed(pastWindow, async () => store, loginCheck);
      reportSessionIdCaptureOutcome(pastWindow.id, outcome, 'exited');
      await flushReportChain();
    }

    it('sends nothing when it also wrote no store and took no prompt, and keeps the agent\'s one report', async () => {
      await settleWithLogin({ agentRanAt: STARTED_AT_MS + 2_700, exitedAt: STARTED_AT_MS + 180_000 }, atCeiling, 'absent', signedOut);
      expect(reportHandledError).not.toHaveBeenCalled();
      // The local log is the only trace of the drop, so it says a session ID never came.
      expect(vi.mocked(console.warn).mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining('gave no session ID for session'),
      ]);

      // Not spent on it: a signed-in session of the same agent that misses its id still reports.
      await settleWithLogin({ id: 'session-2-long-id' }, atCeiling, 'absent', async () => 'signed_in');
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ login: 'signed_in', id_store: 'absent' });
    });

    it('sends nothing for the late id of a session that was signed out at the window', async () => {
      await settleWithLogin({}, late, 'absent', signedOut);
      expect(reportHandledError).not.toHaveBeenCalled();
      // The id did arrive, so the local log must not say none was given (task #1182).
      const warnings = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
      expect(warnings).toEqual([expect.stringContaining('gave its session ID late for session')]);
      expect(warnings[0]).not.toContain('gave no session ID');
    });

    // Sentry DESKTOP-4C on 0.62.0: Codex sat on its sign-in screen with its prompt
    // on the command line, and the id came by the hook minutes later, once someone
    // signed in. Codex's store reads `present` whenever any rollout of today or
    // yesterday exists, so an earlier run that day said nothing about this session.
    it('sends nothing for a late id whose CLI was signed out at the window, whatever the store says', async () => {
      const signInThenPrompt = {
        kind: 'late', capturedAfterMs: 90_000, capturedAt: STARTED_AT_MS + 90_000, capturedBy: 'hook', filesystemScan: 'pending',
      } as const;
      await settleWithLogin({ openingPrompt: 'command_line' }, signInThenPrompt, 'present', signedOut);
      expect(reportHandledError).not.toHaveBeenCalled();

      await settleWithLogin({ id: 'session-2-long-id', openingPrompt: 'command_line' }, signInThenPrompt, 'present', async () => 'signed_in');
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ login: 'signed_in', id_store: 'present', captured_by: 'hook' });
    });

    // A CLI that took a prompt is working, whatever its login check answered, so
    // its late id is a real delay. The opening prompt came on the command line,
    // so the capture is not on time by its first prompt (`capturedOnTime`), and
    // the report can only be skipped by the signed-out reading this pins.
    it('still reports a late id of a signed-out CLI that took a prompt', async () => {
      const lateAfterPrompt = {
        kind: 'late', capturedAfterMs: 90_000, capturedAt: STARTED_AT_MS + 90_000, capturedBy: 'hook', filesystemScan: 'pending',
      } as const;
      await settleWithLogin(
        { openingPrompt: 'command_line', promptObservedAt: STARTED_AT_MS + 60_000 },
        lateAfterPrompt,
        'present',
        signedOut,
      );
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ login: 'signed_out', id_store: 'present', captured_by: 'hook' });
    });

    // A CLI can answer "not logged in" and still work, on a key in its
    // environment or a model provider of its own. That one takes prompts and
    // writes its store, so its miss is a miss.
    it.each<[string, Partial<ManagedSession>, SessionIdStoreEvidence]>([
      ['took a prompt', { promptObservedAt: STARTED_AT_MS + 4_000 }, 'absent'],
      ['wrote its store', {}, 'present'],
    ])('still reports a signed-out CLI that %s, and says what the CLI answered', async (_label, overrides, store) => {
      await settleWithLogin(overrides, atCeiling, store, signedOut);
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ login: 'signed_out', id_store: store });
    });

    it.each<[string, (() => Promise<SessionIdLoginEvidence>) | null]>([
      ['has no check', null],
      ['throws', async () => { throw new Error('spawn C:\\Users\\dev\\codex ENOENT'); }],
      ['answers something else', async () => 'C:\\Users\\dev\\.codex' as SessionIdLoginEvidence],
    ])('reads unknown, and reports, when the login check %s', async (_label, loginCheck) => {
      await settleWithLogin({}, atCeiling, 'absent', loginCheck);
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      const eventTags = reportHandledError.mock.calls[0][1];
      expect(eventTags).toMatchObject({ login: 'unknown' });
      expect(JSON.stringify(eventTags)).not.toContain('Users');
    });

    it('stops waiting on a login check that hangs, and reports', async () => {
      vi.useFakeTimers();
      try {
        noteSessionIdCaptureWindowPassed(session({ agentName: 'codex', resuming: false }), null, () => new Promise(() => undefined));
        reportSessionIdCaptureOutcome('session-1-long-id', atCeiling, 'running');
        await vi.advanceTimersByTimeAsync(24_999);
        expect(reportHandledError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ login: 'unknown' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('sends a late capture as an issue of its own, with how late', async () => {
    await settle({ agentName: 'opencode' }, late);

    const [error, eventTags, , fingerprint] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('AgentSessionIdCapturedLateError');
    expect(eventTags).toMatchObject({
      agent: 'opencode',
      captured_after_s: '30-60',
      fs_scan: 'pending',
      id_store: 'unknown',
      opening_prompt: 'unknown',
      create_chat: 'unknown',
      prompt_seen: 'no',
      after_prompt_s: 'none',
      captured_by: 'scrollback',
    });
    expect(eventTags).not.toHaveProperty('settled_by');
    expect(eventTags).not.toHaveProperty('agent_ran_for_s');
    expect(fingerprint).toEqual(['agent-session-id-captured-late', 'opencode']);
  });

  // Sentry DESKTOP-4J: agy's id came minutes late with `hook_seen=yes`, and that
  // `yes` came from the PTY tracker's first-frame Prompt, which stamps the event
  // stream's `agentHookObservedAt` like any hook. So the report could not say
  // whether a single agy hook had fired, or which path finally gave the id.
  describe('a late capture says which path delivered it, and whether a real hook fired', () => {
    it.each(SESSION_ID_CAPTURE_SOURCES)('sends captured_by %s', async (capturedBy) => {
      // Output seen at 2 s, 40 s before the id: late by the output too, and an
      // id the output gave waits on no output still to come.
      await settle({ agentName: 'antigravity', agentOutputAt: STARTED_AT_MS + 2_000 }, { ...late, capturedBy });
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ captured_by: capturedBy });
    });

    it('sends unknown for a path it does not know, never the value', async () => {
      await settle({ agentName: 'antigravity' }, { ...late, capturedBy: 'C:\\Users\\dev\\x' as unknown as 'hook' });
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ captured_by: 'unknown' });
    });

    it('reads hook_seen no when only a stand-in reached the event stream', async () => {
      await settle(
        { agentName: 'antigravity', agentHookObservedAt: STARTED_AT_MS + 900, firstOutputAt: STARTED_AT_MS + 900 },
        late,
      );
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ hook_seen: 'no', first_output: 'yes', captured_by: 'scrollback' });
    });

    // Every command hook Kangentic installs starts the bridge as a bare `node`,
    // so with none on PATH no hook reaches Kangentic and the id comes only from
    // the output.
    it('says no node was found on PATH, with no path in the tag', async () => {
      nodeLookup.mockResolvedValue(null);
      await settle({ agentName: 'antigravity' }, late);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ node_on_path: 'no', hook_seen: 'no', captured_by: 'scrollback' });
    });

    it('reads node_on_path unknown for a lookup that fails, with nothing of the error in the tags', async () => {
      nodeLookup.mockRejectedValue(new Error('EACCES C:\\Users\\dev\\bin'));
      await settle({ agentName: 'antigravity' }, late);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ node_on_path: 'unknown' });
      expect(JSON.stringify(reportHandledError.mock.calls[0][1])).not.toContain('Users');
    });

    it('never asks for node for a session whose hooks run on a host, and reads unknown', async () => {
      await settle({ agentName: 'antigravity', hostId: 'host-1' }, late);
      expect(nodeLookup).not.toHaveBeenCalled();
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ node_on_path: 'unknown' });
    });

    // Hooks that run in a distro or behind an SSH target never use this
    // computer's PATH, so a lookup here would answer for the wrong machine.
    it.each([
      ['a WSL CLI target', { cliTarget: { kind: 'wsl', distro: 'Ubuntu' } as StoredCliTarget }],
      ['a WSL shell', { shell: 'wsl.exe -d Ubuntu' }],
    ])('never asks for node for %s, and reads unknown', async (_label, overrides) => {
      await settle({ agentName: 'antigravity', ...overrides }, late);
      expect(nodeLookup).not.toHaveBeenCalled();
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ node_on_path: 'unknown' });
    });

    it('stops waiting on a node lookup that hangs, and reports unknown', async () => {
      vi.useFakeTimers();
      try {
        nodeLookup.mockReturnValue(new Promise(() => undefined));
        noteSessionIdCaptureWindowPassed(session({ agentName: 'antigravity', resuming: false }), null);
        reportSessionIdCaptureOutcome('session-1-long-id', late, 'running');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ node_on_path: 'unknown' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reads hook_seen yes once a line the agent\'s hooks wrote arrived by the window', async () => {
      await settle({ agentName: 'antigravity', agentHookLineAt: STARTED_AT_MS + 3_000 }, { ...late, capturedBy: 'hook' });
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ hook_seen: 'yes', captured_by: 'hook' });
    });
  });

  // Sentry DESKTOP-4C: a Codex terminal started with no prompt. Its first prompt
  // came minutes in, the id right behind it, and the report counted that late
  // against the spawn. An agent may have no conversation until someone types.
  describe('a late capture, counted from the first prompt', () => {
    const PROMPT_AT = STARTED_AT_MS + 100_000;
    const capturedAt = (at: number) => ({ kind: 'late', capturedAfterMs: at - STARTED_AT_MS, capturedAt: at, capturedBy: 'hook', filesystemScan: 'empty' } as const);

    it('sends nothing for a session started with no prompt whose id came soon after its first one, and keeps the agent\'s one late report', async () => {
      const onTime = session({ agentName: 'codex', resuming: false, openingPrompt: 'none' });
      noteSessionIdCaptureWindowPassed(onTime, null);
      onTime.promptObservedAt = PROMPT_AT;
      reportSessionIdCaptureOutcome(onTime.id, capturedAt(PROMPT_AT + 3_000), 'running');
      await flushReportChain();
      expect(reportHandledError).not.toHaveBeenCalled();

      // Not spent on it: a capture that is late by its prompt as well still reports.
      await settle(
        { agentName: 'codex', id: 'session-2-long-id', openingPrompt: 'none', promptObservedAt: PROMPT_AT },
        capturedAt(PROMPT_AT + 120_000),
      );
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({
        opening_prompt: 'none',
        prompt_seen: 'yes',
        captured_after_s: '60-300',
        after_prompt_s: '60-300',
      });
    });

    // Main reads a batch's ids ahead of its events, so the id of a conversation
    // that starts at the first prompt lands before that prompt does.
    it('waits for a prompt that lands just after the id, and reports when none does', async () => {
      vi.useFakeTimers();
      try {
        const promptFollows = session({ agentName: 'codex', resuming: false, openingPrompt: 'none' });
        noteSessionIdCaptureWindowPassed(promptFollows, null);
        reportSessionIdCaptureOutcome(promptFollows.id, capturedAt(PROMPT_AT), 'running');
        promptFollows.promptObservedAt = PROMPT_AT + 400;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reportHandledError).not.toHaveBeenCalled();

        const noPrompt = session({ agentName: 'codex', resuming: false, openingPrompt: 'none', id: 'session-2-long-id' });
        noteSessionIdCaptureWindowPassed(noPrompt, null);
        reportSessionIdCaptureOutcome(noPrompt.id, capturedAt(PROMPT_AT), 'running');
        await vi.advanceTimersByTimeAsync(1_999);
        expect(reportHandledError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(reportHandledError).toHaveBeenCalledTimes(1);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ prompt_seen: 'no', after_prompt_s: 'none' });
      } finally {
        vi.useRealTimers();
      }
    });

    // On time is "no more than the window", so the edge itself is still on time.
    it('counts a capture exactly one window after the prompt as on time, and one millisecond more as late', async () => {
      const atEdge = session({ agentName: 'codex', resuming: false, openingPrompt: 'none', promptObservedAt: PROMPT_AT });
      noteSessionIdCaptureWindowPassed(atEdge, null);
      reportSessionIdCaptureOutcome(atEdge.id, capturedAt(PROMPT_AT + 30_000), 'running');
      await flushReportChain();
      expect(reportHandledError).not.toHaveBeenCalled();

      const pastEdge = session({ agentName: 'codex', resuming: false, openingPrompt: 'none', promptObservedAt: PROMPT_AT, id: 'session-2-long-id' });
      noteSessionIdCaptureWindowPassed(pastEdge, null);
      reportSessionIdCaptureOutcome(pastEdge.id, capturedAt(PROMPT_AT + 30_001), 'running');
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      expect((reportHandledError.mock.calls[0][0] as Error).name).toBe('AgentSessionIdCapturedLateError');
    });

    it('sends nothing for a quit during the wait for the first prompt, and keeps the agent\'s one late report', async () => {
      vi.useFakeTimers();
      try {
        const waiting = session({ agentName: 'codex', resuming: false, openingPrompt: 'none' });
        noteSessionIdCaptureWindowPassed(waiting, null);
        reportSessionIdCaptureOutcome(waiting.id, capturedAt(PROMPT_AT), 'running');
        shuttingDown.value = true;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reportHandledError).not.toHaveBeenCalled();

        // Not spent on it: once the quit flag is clear, the agent's next real late capture reports.
        shuttingDown.value = false;
        const next = session({ agentName: 'codex', resuming: false, openingPrompt: 'none', id: 'session-2-long-id' });
        noteSessionIdCaptureWindowPassed(next, null);
        reportSessionIdCaptureOutcome(next.id, capturedAt(PROMPT_AT), 'running');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reportsNamedLate()).toBe(1);
      } finally {
        shuttingDown.value = false;
        vi.useRealTimers();
      }
    });

    it('does not wait on the checks of an agent that already sent its late report', async () => {
      await settle({ agentName: 'codex' }, capturedAt(PROMPT_AT));
      reportHandledError.mockClear();
      vi.mocked(console.warn).mockClear();

      // A signed-out answer would log its "held no login at launch" line if the second outcome waited for it.
      const loginCheck = vi.fn(async (): Promise<SessionIdLoginEvidence> => 'signed_out');
      const second = session({ agentName: 'codex', resuming: false, id: 'session-2-long-id' });
      noteSessionIdCaptureWindowPassed(second, null, loginCheck);
      reportSessionIdCaptureOutcome(second.id, capturedAt(PROMPT_AT), 'running');
      await flushReportChain();

      expect(reportHandledError).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });

    function reportsNamedLate(): number {
      return reportHandledError.mock.calls.filter((call) => (call[0] as Error).name === 'AgentSessionIdCapturedLateError').length;
    }

    it.each(['command_line', 'typed'] as const)('still reports a session whose opening prompt was %s, however close its prompt is', async (openingPrompt) => {
      await settle({ agentName: 'codex', openingPrompt, promptObservedAt: PROMPT_AT }, capturedAt(PROMPT_AT + 3_000));
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ opening_prompt: openingPrompt, after_prompt_s: '1-5' });
    });
  });

  // Sentry DESKTOP-4W: a Cursor print run (`-p`, stream-json) printed nothing
  // visible for about a minute, and its session id came with its first line.
  // No capture path could have been faster, so the window is counted from that
  // output. An agent that drew early and gave its id late still reports.
  describe('a late capture, counted from the agent\'s first output', () => {
    const silentPrintRun = {
      agentName: 'cursor',
      agentCliVersion: '2026.11.19-f005e9d',
      shell: 'bash',
      openingPrompt: 'command_line',
      sessionIdCreation: 'not_asked',
      firstOutputAt: STARTED_AT_MS + 400,
      agentRanAt: STARTED_AT_MS + 4_000,
    } as const satisfies Partial<ManagedSession>;
    const capturedAt = (at: number) => ({ kind: 'late', capturedAfterMs: at - STARTED_AT_MS, capturedAt: at, capturedBy: 'output', filesystemScan: 'none' } as const);

    it('sends nothing for an id that came with the agent\'s first output a minute in, and keeps the agent\'s one late report', async () => {
      const silent = session({ ...silentPrintRun, resuming: false, agentOutputAt: STARTED_AT_MS + 63_000 });
      noteSessionIdCaptureWindowPassed(silent, null);
      reportSessionIdCaptureOutcome(silent.id, capturedAt(STARTED_AT_MS + 64_000), 'running');
      await flushReportChain();
      expect(reportHandledError).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('on time by that output'));

      // Not spent on it: the same agent's id a minute after output it drew at 4 s still reports.
      await settle(
        { ...silentPrintRun, id: 'session-2-long-id', agentOutputAt: STARTED_AT_MS + 4_000 },
        capturedAt(STARTED_AT_MS + 64_000),
      );
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect((reportHandledError.mock.calls[0][0] as Error).name).toBe('AgentSessionIdCapturedLateError');
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({
        agent: 'cursor',
        opening_prompt: 'command_line',
        create_chat: 'not_asked',
        prompt_seen: 'no',
        captured_by: 'output',
        captured_after_s: '60-300',
        after_prompt_s: 'none',
        after_output_s: '60-300',
      });
    });

    it('tags a late id with no output seen as after_output_s none', async () => {
      await settle({ agentName: 'codex' }, { kind: 'late', capturedAfterMs: 64_000, capturedAt: STARTED_AT_MS + 64_000, capturedBy: 'hook', filesystemScan: 'none' });
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ after_output_s: 'none' });
    });

    // On time is "no more than the window", so the edge itself is still on time.
    it('counts a capture exactly one window after the output as on time, and one millisecond more as late', async () => {
      const outputAt = STARTED_AT_MS + 40_000;
      const atEdge = session({ ...silentPrintRun, resuming: false, agentOutputAt: outputAt });
      noteSessionIdCaptureWindowPassed(atEdge, null);
      reportSessionIdCaptureOutcome(atEdge.id, capturedAt(outputAt + 30_000), 'running');
      await flushReportChain();
      expect(reportHandledError).not.toHaveBeenCalled();

      await settle({ ...silentPrintRun, id: 'session-2-long-id', agentOutputAt: outputAt }, capturedAt(outputAt + 30_001));
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ after_output_s: '30-60' });
    });

    // The host's output event and the id scanner read the same chunk, and
    // either can reach main first.
    it('waits for output that lands just after an id the output gave, and reports when none does', async () => {
      vi.useFakeTimers();
      try {
        const outputFollows = session({ ...silentPrintRun, resuming: false });
        noteSessionIdCaptureWindowPassed(outputFollows, null);
        reportSessionIdCaptureOutcome(outputFollows.id, capturedAt(STARTED_AT_MS + 64_000), 'running');
        outputFollows.agentOutputAt = STARTED_AT_MS + 64_300;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reportHandledError).not.toHaveBeenCalled();

        const noOutput = session({ ...silentPrintRun, resuming: false, id: 'session-2-long-id' });
        noteSessionIdCaptureWindowPassed(noOutput, null);
        reportSessionIdCaptureOutcome(noOutput.id, capturedAt(STARTED_AT_MS + 64_000), 'running');
        await vi.advanceTimersByTimeAsync(1_999);
        expect(reportHandledError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(reportHandledError).toHaveBeenCalledTimes(1);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ after_output_s: 'none' });
      } finally {
        vi.useRealTimers();
      }
    });

    // Output up to the settle after the id is still the output that carried it.
    // Past that it is a later line, so the id was late against it too. The opening
    // prompt is a command line so the prompt rule cannot be what makes it on time.
    it('counts output up to 2 s after the id as the output that carried it, and output 1 ms later as not', async () => {
      vi.useFakeTimers();
      try {
        const captureAt = STARTED_AT_MS + 64_000;
        const atSettleEdge = session({ ...silentPrintRun, resuming: false });
        noteSessionIdCaptureWindowPassed(atSettleEdge, null);
        reportSessionIdCaptureOutcome(atSettleEdge.id, capturedAt(captureAt), 'running');
        atSettleEdge.agentOutputAt = captureAt + 2_000;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reportHandledError).not.toHaveBeenCalled();

        const pastSettleEdge = session({ ...silentPrintRun, resuming: false, id: 'session-2-long-id' });
        noteSessionIdCaptureWindowPassed(pastSettleEdge, null);
        reportSessionIdCaptureOutcome(pastSettleEdge.id, capturedAt(captureAt), 'running');
        pastSettleEdge.agentOutputAt = captureAt + 2_001;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reportHandledError).toHaveBeenCalledTimes(1);
        // The output is after the id, so the distance clamps to zero: the lowest bucket, not 'none'.
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ after_output_s: '<1' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Sentry DESKTOP-36 recurred on three days for one install's Codex 0.163.0: it
  // ran with its prompt on the command line, exited seconds later on its own, took
  // no prompt and wrote no rollout. That run had no conversation to capture, so it
  // is a launch that died at start and goes to the launch report, not a missed id.
  describe('an agent that exited at start with no conversation', () => {
    /** What a case changes past the session. A store of `unknown` is a store check that could not run. */
    type SettleOptions = {
      outcome?: Parameters<typeof reportSessionIdCaptureOutcome>[1];
      store?: SessionIdStoreEvidence | 'unknown';
      sessionStatus?: string;
      /** The read of what the launch printed. Null, the default, is a row that is gone. */
      readOutput?: (() => Promise<string>) | null;
    };

    /** The DESKTOP-36 shape, with one thing changed per case. Resolves once the report chain has run. */
    async function settleAtCeiling(overrides: Partial<ManagedSession> = {}, options: SettleOptions = {}): Promise<ManagedSession> {
      const diedAtStart = session({
        agentName: 'codex',
        agentCliVersion: '0.163.0 (Codex CLI)',
        resuming: false,
        status: 'exited',
        shell: 'pwsh',
        openingPrompt: 'command_line',
        sessionIdCreation: 'not_asked',
        firstOutputAt: STARTED_AT_MS + 900,
        agentRanAt: STARTED_AT_MS + 5_000,
        exitedAt: STARTED_AT_MS + 34_000,
        ...overrides,
      });
      const store = options.store ?? 'absent';
      noteSessionIdCaptureWindowPassed(diedAtStart, store === 'unknown' ? null : async () => store, async () => 'signed_in');
      reportSessionIdCaptureOutcome(
        diedAtStart.id,
        options.outcome ?? atCeiling,
        options.sessionStatus ?? 'exited',
        () => options.readOutput ?? null,
      );
      await flushReportChain();
      return diedAtStart;
    }

    function sentNames(): string[] {
      return reportHandledError.mock.calls.map((call) => (call[0] as Error).name);
    }

    it('sends one launch report under agent_exited, with the session-id tags, and no capture report', async () => {
      await settleAtCeiling({ exitCode: 1 }, { readOutput: async () => '$ codex\r\nsomething Codex printed before it left\r\n$ ' });

      expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);
      const [error, eventTags, contexts, fingerprint] = reportHandledError.mock.calls[0];
      expect((error as Error).message).toBe('Agent launch failed: agent_exited (no_conversation)');
      expect(eventTags).toEqual({
        source: 'agent_launch',
        stage: 'agent_exited',
        cause: 'no_conversation',
        platform: process.platform,
        agent: 'codex',
        attempt: '1',
        agent_cli_version: '0.163.0',
        start_path: 'board',
        shell: 'pwsh',
        opening_prompt: 'command_line',
        create_chat: 'not_asked',
        hook_seen: 'no',
        agent_started: 'no',
        first_output: 'yes',
        prompt_seen: 'no',
        settled_by: 'ceiling',
        session_status: 'exited',
        agent_ran_for_s: '15-30',
        agent_life_s: '15-30',
        fs_scan: 'empty',
        id_store: 'absent',
        login: 'signed_in',
        node_on_path: 'yes',
        hook_load: 'unknown',
        exit_code: '1',
        exit_by: 'pty',
        output_class: 'other',
        other_from: 'unknown',
        place: 'local',
        launcher: 'none',
        command_head: 'unknown',
        command_head_since_detection: 'unknown',
        shell_printed: 'before_launch',
        first_output_s: '<1',
        session_age_s: '>300',
        typed_line_bytes: '1024',
        overlay_ceiling: 'no',
      });
      expect(contexts).toEqual({});
      expect(fingerprint).toEqual(['agent-launch', 'agent_exited', 'no_conversation']);
    });

    // Sentry DESKTOP-4Z: this was the one launch report that said nothing about
    // what the agent printed or how it ended, so it could not say why.
    describe('says what the launch printed and how it ended', () => {
      function sentTags(): Record<string, string> {
        expect(reportHandledError).toHaveBeenCalledTimes(1);
        return reportHandledError.mock.calls[0][1];
      }

      it('sends the class of output that names a cause, under the same issue, and none of its text', async () => {
        await settleAtCeiling({ exitCode: 139 }, { readOutput: async () => 'running the Acme migration\r\nSegmentation fault\r\n' });
        const tags = sentTags();
        expect(tags).toMatchObject({ cause: 'no_conversation', output_class: 'crashed', exit_code: '139', exit_by: 'pty' });
        expect(tags).not.toHaveProperty('other_from');
        expect(reportHandledError.mock.calls[0][3]).toEqual(['agent-launch', 'agent_exited', 'no_conversation']);
        expect(JSON.stringify([(reportHandledError.mock.calls[0][0] as Error).message, tags])).not.toContain('Acme');
      });

      it('says the shell wrote output that matched no class', async () => {
        await settleAtCeiling({}, { readOutput: async () => '    + CategoryInfo          : ParserError: (:) []\r\nPS C:\\project> ' });
        expect(sentTags()).toMatchObject({ output_class: 'other', other_from: 'shell' });
      });

      // DESKTOP-4Z on 0.64.0: `command_head=present` and cmd's cannot-find-the-path,
      // so a path the head's `.cmd` chain names was gone, and nothing read the shim.
      describe('a .cmd head whose wrapper quotes a target that is gone', () => {
        const wrapper = useGoneWrapperShim();

        it('names the shim\'s shape and that its target is missing, never the path', async () => {
          await settleAtCeiling({ agentCliPath: wrapper.shimPath() }, { readOutput: async () => CMD_PATH_NOT_FOUND });
          const tags = sentTags();
          expect(tags).toMatchObject({
            cause: 'no_conversation',
            output_class: 'no_such_file',
            batch_shim: 'unparsed',
            batch_shim_shape: 'absolute_path',
            shim_target: 'missing',
          });
          expect(JSON.stringify(tags)).not.toContain('codex.exe');
        });

        it('says a shim this would start resolves, with no shape', async () => {
          realFs.writeFileSync(wrapper.shimPath(), '@echo off\r\n"%~dp0codex.exe" %*\r\n');
          await settleAtCeiling({ agentCliPath: wrapper.shimPath() }, { readOutput: async () => CMD_PATH_NOT_FOUND });
          const tags = sentTags();
          expect(tags).toMatchObject({ batch_shim: 'resolves' });
          expect(tags).not.toHaveProperty('batch_shim_shape');
          expect(tags).not.toHaveProperty('shim_target');
        });

        it('reads nothing for a head that is not a batch shim', async () => {
          await settleAtCeiling({ agentCliPath: path.join(os.tmpdir(), 'codex.exe') }, { readOutput: async () => CMD_PATH_NOT_FOUND });
          for (const name of SHIM_TAG_NAMES) expect(sentTags()).not.toHaveProperty(name);
        });

        it('reads nothing off Windows', async () => {
          wrapper.setPlatform('linux');
          await settleAtCeiling({ agentCliPath: wrapper.shimPath() }, { readOutput: async () => CMD_PATH_NOT_FOUND });
          for (const name of SHIM_TAG_NAMES) expect(sentTags()).not.toHaveProperty(name);
        });

        it('reads nothing for output that is not no_such_file', async () => {
          await settleAtCeiling({ agentCliPath: wrapper.shimPath() }, { readOutput: async () => 'Segmentation fault\r\n' });
          for (const name of SHIM_TAG_NAMES) expect(sentTags()).not.toHaveProperty(name);
        });
      });

      // The sweep's retirement masks the code to 0, so the code alone would read as a clean end.
      it('says the sweep ended it, beside the code that retirement masked', async () => {
        await settleAtCeiling({ intentionalExit: true, overrideExitCode: 0, exitCode: 0 });
        expect(sentTags()).toMatchObject({ exit_code: '0', exit_by: 'sweep' });
      });

      // The host can lose the code (a PTY that vanished), and the tag must still say so.
      it('says the code is unknown when the PTY left none, and that the PTY ended it', async () => {
        await settleAtCeiling({ exitCode: null });
        expect(sentTags()).toMatchObject({ exit_code: 'unknown', exit_by: 'pty' });
      });

      // Sentry DESKTOP-4Z printed cmd's "cannot find the path" and could not say
      // whether the path was the CLI's own or one the CLI runs. Every other
      // launch report says that with these tags.
      it('says whether the command head and the launcher are still there, never where', async () => {
        existsSync.mockReturnValue(false);
        await settleAtCeiling(
          { agentCliPath: '/Users/dev/.npm-global/bin/codex', launcherPath: '/Users/dev/secret-project/launch.sh' },
          { readOutput: async () => 'The system cannot find the path specified.\r\n' },
        );
        const tags = sentTags();
        expect(tags).toMatchObject({
          output_class: 'no_such_file',
          command_head: 'missing',
          command_head_since_detection: 'unknown',
          launcher: 'missing',
          shell_printed: 'before_launch',
        });
        expect(JSON.stringify(tags)).not.toContain('/Users/dev');
      });

      it('keeps what the capture window recorded where the launch tags name the same thing', async () => {
        const diedAtStart = session({
          agentName: 'codex',
          agentCliVersion: '0.163.0 (Codex CLI)',
          resuming: false,
          status: 'exited',
          shell: 'pwsh',
          openingPrompt: 'command_line',
          sessionIdCreation: 'not_asked',
          firstOutputAt: STARTED_AT_MS + 900,
          agentRanAt: STARTED_AT_MS + 5_000,
          exitedAt: STARTED_AT_MS + 34_000,
        });
        noteSessionIdCaptureWindowPassed(diedAtStart, async () => 'absent', async () => 'signed_in');
        // Facts that changed on the row after the window read them.
        diedAtStart.shell = '/bin/zsh';
        diedAtStart.startPath = 'retry';
        reportSessionIdCaptureOutcome(diedAtStart.id, atCeiling, 'exited');
        await flushReportChain();

        expect(sentTags()).toMatchObject({ shell: 'pwsh', start_path: 'board', agent: 'codex', agent_cli_version: '0.163.0' });
      });

      it('still sends the report when the read fails', async () => {
        await settleAtCeiling({}, { readOutput: async () => { throw new Error('host gone'); } });
        const tags = sentTags();
        expect(tags.output_class).toBe('unreadable');
        expect(tags).not.toHaveProperty('other_from');
      });

      it.each<[string, (() => Promise<string>) | null]>([
        ['a row that is gone', null],
        // What the host answers for a session it no longer holds, after a restart.
        ['a ring the host no longer holds', async () => ''],
      ])('reads not_read for %s', async (_label, readOutput) => {
        await settleAtCeiling({}, { readOutput });
        const tags = sentTags();
        expect(tags.output_class).toBe('not_read');
        expect(tags).not.toHaveProperty('other_from');
      });

      it('treats a cause that is the user\'s own setup as every launch report does', async () => {
        vi.mocked(trackEvent).mockClear();
        const signedOut = {
          identifyUserSetupFailure: () => ({ failure: 'login_required', line: 'Not logged in as dev@example.test' }),
        } as unknown as AgentParser;
        await settleAtCeiling({ agentParser: signedOut }, { readOutput: async () => 'Not logged in as dev@example.test' });

        // The error's type is what keeps it out of Sentry (launch-user-setup-exclusion.test.ts).
        const [error, tags] = reportHandledError.mock.calls[0];
        expect(error).toBeInstanceOf(AgentUserSetupError);
        expect(tags).toMatchObject({ cause: 'no_conversation', output_class: 'login_required' });
        expect(JSON.stringify(tags)).not.toContain('dev@example.test');
        expect(trackEvent).toHaveBeenCalledWith('spawn_failed', { agent: 'codex', reason: 'login_required' });
      });

      it('posts the read as the outcome lands, ahead of the waits a removal could win', async () => {
        const readOutput = vi.fn(async () => 'output');
        const diedAtStart = session({
          agentName: 'codex',
          resuming: false,
          status: 'exited',
          agentRanAt: STARTED_AT_MS + 5_000,
          exitedAt: STARTED_AT_MS + 10_000,
        });
        noteSessionIdCaptureWindowPassed(diedAtStart, async () => 'absent', async () => 'signed_in');
        reportSessionIdCaptureOutcome(diedAtStart.id, atCeiling, 'exited', () => readOutput);
        expect(readOutput).toHaveBeenCalledTimes(1);
        // So this report lands in its own test.
        await flushReportChain();
      });

      it('reads no output for a session that is no death at start', async () => {
        const readOutput = vi.fn(async () => 'output');
        await settleAtCeiling({ promptObservedAt: STARTED_AT_MS + 6_000 }, { readOutput });
        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
        expect(readOutput).not.toHaveBeenCalled();
      });

      it('sends one event when another launch report comes while the read is out', async () => {
        let answer: (output: string) => void = () => undefined;
        const diedAtStart = await settleAtCeiling({}, { readOutput: () => new Promise<string>((resolve) => { answer = resolve; }) });
        expect(reportHandledError).not.toHaveBeenCalled();
        reportSessionLaunchFailure({ session: diedAtStart, stage: 'shell_exit', readOutput: null });
        answer('Segmentation fault');
        await flushReportChain();
        expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);
        expect(sentTags().output_class).toBe('crashed');
      });

      it('sends nothing once the quit has started, since nothing would land', async () => {
        let answer: (output: string) => void = () => undefined;
        await settleAtCeiling({}, { readOutput: () => new Promise<string>((resolve) => { answer = resolve; }) });
        shuttingDown.value = true;
        answer('Segmentation fault');
        await flushReportChain();
        expect(reportHandledError).not.toHaveBeenCalled();
      });
    });

    it('sends it with a store check that could not answer', async () => {
      await settleAtCeiling({}, { store: 'unknown' });
      expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);
    });

    // A shell outlives the CLI it ran, so the agent-absence sweep is often what
    // ends the PTY. It kills through kill(), and its exit code override is its mark.
    it('sends it for a session the agent-absence sweep retired', async () => {
      await settleAtCeiling({ intentionalExit: true, overrideExitCode: 0 });
      expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);
    });

    it.each<[string, Partial<ManagedSession>, SettleOptions]>([
      // A person who moved the task away 20 s in did not watch it die at start.
      ['settled by a removal', {}, { outcome: { ...atCeiling, settledBy: 'removed' } }],
      // Nor did one whose move ran cleanup_worktree, which kills and keeps the row.
      ['was stopped by a kill that kept its row', { intentionalExit: true }, {}],
      ['settled at the ceiling still running', { status: 'running', exitedAt: undefined }, { sessionStatus: 'running' }],
      ['ran a full minute', { exitedAt: STARTED_AT_MS + 65_000 }, {}],
      ['never showed it ran', { agentRanAt: undefined }, {}],
      ['ended with no exit recorded', { exitedAt: undefined }, {}],
      ['took a prompt', { promptObservedAt: STARTED_AT_MS + 6_000 }, {}],
      ['wrote its store', {}, { store: 'present' }],
    ])('keeps the capture report for one that %s', async (_label, overrides, options) => {
      await settleAtCeiling(overrides, options);
      expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
    });

    it('sends nothing more for a session whose launch already reported, so one run never sends both', async () => {
      await settleAtCeiling({ launchFailureNoted: true });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    // Measured on Codex 0.171.0 (task #1182), with no failure named: the sweep's
    // kill landed 116 s after the agent ran, and the shell's prompt, the last
    // output, 0.5 s after it died.
    it('times a session the sweep retired by its last output, not by the sweep\'s kill', async () => {
      await settleAtCeiling({
        agentRanAt: STARTED_AT_MS + 6_000,
        lastOutputAt: STARTED_AT_MS + 6_500,
        exitedAt: STARTED_AT_MS + 122_000,
        intentionalExit: true,
        overrideExitCode: 0,
      });
      expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);
    });

    it.each<[string, Partial<ManagedSession>]>([
      ['printed for a minute before the sweep found it gone', { lastOutputAt: STARTED_AT_MS + 70_000, intentionalExit: true, overrideExitCode: 0 }],
      ['ended on its own, whatever it printed last', { lastOutputAt: STARTED_AT_MS + 6_500 }],
      // Its last output came before the agent ran, so it says nothing of the agent's end.
      ['printed nothing after its agent ran before the sweep found it gone', { lastOutputAt: STARTED_AT_MS + 5_000, intentionalExit: true, overrideExitCode: 0 }],
    ])('keeps the capture report for a session that %s', async (_label, overrides) => {
      await settleAtCeiling({ agentRanAt: STARTED_AT_MS + 6_000, exitedAt: STARTED_AT_MS + 122_000, ...overrides });
      expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
    });

    // Sentry DESKTOP-36 on 0.64.0: a Codex dead at start whose shell the sweep retired
    // measured past the minute, because the shell's repaints kept its last output moving.
    describe('a death at start the minute missed (Sentry DESKTOP-36)', () => {
      const sweptLate = {
        agentRanAt: STARTED_AT_MS + 5_000,
        lastOutputAt: STARTED_AT_MS + 95_000,
        exitedAt: STARTED_AT_MS + 125_000,
        intentionalExit: true,
        overrideExitCode: 0,
      } satisfies Partial<ManagedSession>;
      const cmdCannotFindThePath = 'Microsoft Windows [Version 10.0.26200]\r\nThe system cannot find the path specified.\r\n';

      it('sends output that names a failure to the launch report, and no capture report', async () => {
        await settleAtCeiling(sweptLate, { readOutput: async () => cmdCannotFindThePath });

        expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ cause: 'no_conversation', output_class: 'no_such_file', exit_by: 'sweep', agent_life_s: '60-300' });
      });

      it('keeps the capture report for output that names nothing, now with what it printed and how it ended', async () => {
        await settleAtCeiling(sweptLate, { readOutput: async () => 'something Codex printed before it left\r\n' });

        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({
          source: 'agent_session_id',
          output_class: 'other',
          other_from: 'unknown',
          exit_by: 'sweep',
          exit_code: expect.any(String),
          agent_life_s: '60-300',
          agent_ran_for_s: '60-300',
        });
      });

      it('still reads the output of an agent whose capture report is spent', async () => {
        await settleAtCeiling({ id: 'session-2-long-id' }, { store: 'present' });
        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
        const readOutput = vi.fn(async () => cmdCannotFindThePath);

        await settleAtCeiling(sweptLate, { readOutput });

        expect(readOutput).toHaveBeenCalledTimes(1);
        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError', 'AgentLaunchAgentExitedError']);
      });

      // A store that holds a conversation means the agent did make one, so even output that
      // names a failure is no death at start with nothing to capture.
      it('keeps the capture report, with the identified class, when the agent\'s store holds a conversation', async () => {
        await settleAtCeiling(sweptLate, { store: 'present', readOutput: async () => cmdCannotFindThePath });

        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({
          source: 'agent_session_id',
          id_store: 'present',
          output_class: 'no_such_file',
          exit_by: 'sweep',
        });
      });

      it('files the capture report as unreadable when the read of its output fails', async () => {
        await settleAtCeiling(sweptLate, { readOutput: async () => { throw new Error('host gone'); } });

        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ output_class: 'unreadable' });
        expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty('other_from');
      });

      it('files the capture report as not_read when there is no reader for its output', async () => {
        await settleAtCeiling(sweptLate, { readOutput: null });

        expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ output_class: 'not_read' });
        expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty('other_from');
      });
    });

    // The agent ran and no end was recorded: the tag says whether its session is still up.
    it.each<[string, Partial<ManagedSession>, string]>([
      ['running', { status: 'running' }, 'running'],
      ['not running', { status: 'exited' }, 'unknown'],
    ])('reads agent_life_s as %s when the agent ran and no exit was recorded', async (_label, overrides, expected) => {
      await settleAtCeiling(
        { agentRanAt: STARTED_AT_MS + 5_000, exitedAt: undefined, ...overrides },
        { sessionStatus: overrides.status },
      );

      expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ agent_life_s: expected });
    });

    // Measured on Codex 0.171.0 (task #1182): a project config it refused ended it
    // 6 s in under PowerShell, and the sweep retired the shell at its 120 s start
    // ceiling, so the PTY's exit landed 116 s after the agent ran, past the
    // minute above. Its launch report had already named the failure.
    it('sends no capture report for a launch that already reported, however late the sweep ended it', async () => {
      await settleAtCeiling({
        agentCliVersion: '0.171.0 (Codex CLI)',
        agentRanAt: STARTED_AT_MS + 6_000,
        exitedAt: STARTED_AT_MS + 122_000,
        intentionalExit: true,
        overrideExitCode: 0,
        launchFailureNoted: true,
      });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('marks the session reported, so no later launch report for it goes', async () => {
      const diedAtStart = await settleAtCeiling();
      expect(diedAtStart.launchFailureNoted).toBe(true);
    });

    it('sends one launch report per agent per run, and leaves the agent\'s capture report for a real miss', async () => {
      await settleAtCeiling();
      await settleAtCeiling({ id: 'session-2-long-id' });
      expect(sentNames()).toEqual(['AgentLaunchAgentExitedError']);

      await settleAtCeiling({ id: 'session-3-long-id' }, { store: 'present' });
      expect(sentNames()).toEqual(['AgentLaunchAgentExitedError', 'AgentSessionIdNotCapturedError']);

      // Another agent's death at start is its own report.
      await settleAtCeiling({ id: 'session-4-long-id', agentName: 'gemini' });
      expect(reportHandledError.mock.calls.map((call) => [(call[0] as Error).name, call[1].agent])).toEqual([
        ['AgentLaunchAgentExitedError', 'codex'],
        ['AgentSessionIdNotCapturedError', 'codex'],
        ['AgentLaunchAgentExitedError', 'gemini'],
      ]);
    });

    it('still sends the launch report after the agent spent its capture report', async () => {
      await settleAtCeiling({ id: 'session-2-long-id' }, { store: 'present' });
      // The agent's capture latch is spent, and the launch report still reads the output.
      await settleAtCeiling({ exitCode: 139 }, { readOutput: async () => 'Segmentation fault\r\n' });
      expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError', 'AgentLaunchAgentExitedError']);
      expect(reportHandledError.mock.calls[1][1]).toMatchObject({ output_class: 'crashed', exit_code: '139' });
    });

    // The shape lets the session past the early latch check, so only the check
    // after the store read keeps a second capture report from going.
    it('sends the agent one capture report when two of its sessions have the shape and a store', async () => {
      await settleAtCeiling({}, { store: 'present' });
      await settleAtCeiling({ id: 'session-2-long-id' }, { store: 'present' });
      expect(sentNames()).toEqual(['AgentSessionIdNotCapturedError']);
    });

    it('keeps the signed-out drop ahead of it', async () => {
      const pastWindow = session({
        agentName: 'codex',
        resuming: false,
        status: 'exited',
        agentRanAt: STARTED_AT_MS + 5_000,
        exitedAt: STARTED_AT_MS + 10_000,
      });
      noteSessionIdCaptureWindowPassed(pastWindow, async () => 'absent', async () => 'signed_out');
      reportSessionIdCaptureOutcome(pastWindow.id, atCeiling, 'exited');
      await flushReportChain();
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('a never-captured session says how long its agent ran', () => {
    // A removal settles the report and then ends the PTY, so the exit lands a moment after it and
    // before or after the tag is read. The end is the earlier of the two, whichever order they land in.
    it('counts an exit that landed after the removal to the removal', async () => {
      await settle({ agentName: 'codex', status: 'exited', agentRanAt: STARTED_AT_MS + 10_000, exitedAt: STARTED_AT_MS + 400_000 }, never);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ settled_by: 'removed', agent_ran_for_s: '60-300' });
    });

    it('counts an agent that exited long before its removal to its own exit', async () => {
      await settle({ agentName: 'codex', status: 'exited', agentRanAt: STARTED_AT_MS + 10_000, exitedAt: STARTED_AT_MS + 12_000 }, never);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ settled_by: 'removed', agent_ran_for_s: '1-5' });
    });

    it.each<[string, Partial<ManagedSession>, Parameters<typeof reportSessionIdCaptureOutcome>[1], string]>([
      ['running for a session still up at the ceiling', { agentRanAt: STARTED_AT_MS + 2_000 }, atCeiling, 'running'],
      ['not_run for an agent that never showed it ran', { exitedAt: STARTED_AT_MS + 40_000, status: 'exited' }, atCeiling, 'not_run'],
      // `remove()` settles the report before it ends the session, so the row has no exit yet.
      ['the time to its removal for a session removed while it ran', { agentRanAt: STARTED_AT_MS + 10_000 }, never, '60-300'],
      ['unknown for a row that ended with no exit recorded', { agentRanAt: STARTED_AT_MS + 2_000, status: 'exited' }, atCeiling, 'unknown'],
    ])('reads %s', async (_label, overrides, outcome, expected) => {
      await settle({ agentName: 'codex', ...overrides }, outcome);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ agent_ran_for_s: expected });
    });
  });

  it('keeps a path or an unrecognized name out of the tags', async () => {
    await settle({ agentName: '/Users/dev/agent', agentCliVersion: '/Users/dev/bin/agent', shell: '/Users/dev/bin/myshell' }, never);

    const [error, eventTags, , fingerprint] = reportHandledError.mock.calls[0];
    expect(eventTags).toMatchObject({ agent: 'other', agent_cli_version: 'unknown' });
    expect(fingerprint).toEqual(['agent-session-id-not-captured', 'other']);
    expect(JSON.stringify([(error as Error).message, eventTags])).not.toContain('/Users/dev');
  });

  // Sentry DESKTOP-36 on 0.62.0: a signed-in Command Terminal Codex opened with no
  // prompt, still running at the ceiling, with no hook line. A Codex makes its
  // conversation at its first turn, so nobody typing for five minutes means no
  // conversation and no id. The store answered `present` for the whole day's
  // folder, so the miss was reported. It now answers about this session.
  describe('a terminal nobody used', () => {
    const untouched = {
      agentName: 'codex',
      agentCliVersion: '0.171.0 (Codex CLI)',
      startPath: 'command_terminal',
      openingPrompt: 'none',
      sessionIdCreation: 'not_asked',
      firstOutputAt: STARTED_AT_MS + 900,
    } as const satisfies Partial<ManagedSession>;

    it('sends nothing, says so locally, and keeps the agent\'s one report', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const noRollout = vi.fn(async (): Promise<SessionIdStoreEvidence> => 'absent');
        const pastWindow = session({ resuming: false, ...untouched });
        noteSessionIdCaptureWindowPassed(pastWindow, noRollout);
        reportSessionIdCaptureOutcome(pastWindow.id, atCeiling, 'running');
        await flushReportChain();

        expect(reportHandledError).not.toHaveBeenCalled();
        expect(warn.mock.calls.some((call) => String(call[0]).includes('no prompt reached it'))).toBe(true);
        // Asked again at the settle, not only at the window.
        expect(noRollout).toHaveBeenCalledTimes(2);

        // Not spent on it: a session of the same agent that was typed into and missed its id still reports.
        await settle({ ...untouched, id: 'session-2-long-id', promptObservedAt: STARTED_AT_MS + 4_000 }, atCeiling, async () => 'present');
        expect(reportHandledError).toHaveBeenCalledTimes(1);
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({ prompt_seen: 'yes', id_store: 'present' });
      } finally {
        warn.mockRestore();
      }
    });

    it('sends nothing when the terminal is closed with no conversation made either', async () => {
      const closed = session({ resuming: false, ...untouched });
      noteSessionIdCaptureWindowPassed(closed, async () => 'absent');
      reportSessionIdCaptureOutcome(closed.id, never, 'running');
      await flushReportChain();
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('still reports one whose conversation was made after the window, read again at the settle', async () => {
      const madeLater = vi.fn<() => Promise<SessionIdStoreEvidence>>()
        .mockResolvedValueOnce('absent')
        .mockResolvedValueOnce('present');
      await settle(untouched, atCeiling, madeLater);

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ opening_prompt: 'none', prompt_seen: 'no', id_store: 'present' });
    });

    it('still reports one that the window saw a conversation for, when the settle read fails', async () => {
      const failsLater = vi.fn<() => Promise<SessionIdStoreEvidence>>()
        .mockResolvedValueOnce('present')
        .mockRejectedValueOnce(new Error('EACCES'));
      await settle(untouched, atCeiling, failsLater);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ id_store: 'present' });
    });

    it('never drops one on a stale absent: a settle read that fails reads unknown, and reports', async () => {
      const failsLater = vi.fn<() => Promise<SessionIdStoreEvidence>>()
        .mockResolvedValueOnce('absent')
        .mockRejectedValueOnce(new Error('EACCES'));
      await settle(untouched, atCeiling, failsLater);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ id_store: 'unknown' });
    });

    it.each<[string, Partial<ManagedSession>]>([
      ['was given its prompt on the command line', { openingPrompt: 'command_line' }],
      ['was typed into, with the hook lost', { promptObservedAt: STARTED_AT_MS + 4_000 }],
    ])('still reports one that %s, though its store reads absent', async (_label, overrides) => {
      await settle({ ...untouched, ...overrides }, atCeiling, async () => 'absent');
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ id_store: 'absent' });
    });

    // Sentry DESKTOP-36 on 0.63.0: the same terminal, removed about 30 s in, read `present` from
    // the rollout of a Codex started 13 s later in the same folder, whose id that sibling captured.
    // The real Codex check runs over a sandboxed CODEX_HOME holding that rollout.
    describe('beside a later sibling\'s rollout in the same folder', () => {
      const siblingId = '88888888-8888-4888-8888-888888888888';
      const removedAt30s = { kind: 'never', settledBy: 'removed', settledAt: STARTED_AT_MS + 32_000, filesystemScan: 'empty' } as const;
      const event063 = {
        ...untouched,
        agentCliVersion: '0.170.0 (Codex CLI)',
        // A line the hooks wrote by the window, as the event's `hook_seen=yes` says. The rule reads no hook.
        agentHookLineAt: STARTED_AT_MS + 29_000,
        agentRanAt: STARTED_AT_MS + 1_000,
      } as const satisfies Partial<ManagedSession>;
      const originalCodexHome = process.env.CODEX_HOME;
      let codexHome: string;
      let projectFolder: string;
      let storeCheck: () => Promise<SessionIdStoreEvidence>;

      beforeEach(async () => {
        codexHome = realFs.mkdtempSync(path.join(os.tmpdir(), 'launch-report-codex-home-'));
        projectFolder = realFs.mkdtempSync(path.join(os.tmpdir(), 'launch-report-codex-project-'));
        process.env.CODEX_HOME = codexHome;
        const { CodexAdapter } = await import('../../src/main/agent/adapters/codex/codex-adapter');
        const { codexSessionsDirForToday } = await import('../../src/main/agent/adapters/codex/session-history-parser');
        const spawnedAt = new Date(Date.now() - 32_000);
        const rolloutFolder = codexSessionsDirForToday();
        realFs.mkdirSync(rolloutFolder, { recursive: true });
        const createdAt = new Date(spawnedAt.getTime() + 13_000).toISOString();
        const meta = { type: 'session_meta', payload: { id: siblingId, cwd: projectFolder.replace(/\\/g, '/'), timestamp: createdAt } };
        realFs.writeFileSync(path.join(rolloutFolder, `rollout-${createdAt.replace(/[:.]/g, '-')}-${siblingId}.jsonl`), `${JSON.stringify(meta)}\n`);
        const check = new CodexAdapter().runtime.sessionId?.storeEvidence;
        if (!check) throw new Error('Codex declares no store evidence');
        storeCheck = () => check({ cwd: projectFolder, spawnedAt, claimedSessionIds: new Set([siblingId]) });
      });

      afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        realFs.rmSync(codexHome, { recursive: true, force: true });
        realFs.rmSync(projectFolder, { recursive: true, force: true });
      });

      it('sends nothing for the terminal nobody typed into', async () => {
        const removed = session({ resuming: false, ...event063 });
        // Hold each store check's promise, so the test waits on the real fs check itself
        // rather than a fixed sleep that a slow disk could outlast.
        const storeChecks: Array<Promise<SessionIdStoreEvidence>> = [];
        const watchedStoreCheck = (): Promise<SessionIdStoreEvidence> => {
          const answer = storeCheck();
          storeChecks.push(answer);
          return answer;
        };
        noteSessionIdCaptureWindowPassed(removed, watchedStoreCheck, async () => 'signed_in');
        reportSessionIdCaptureOutcome(removed.id, removedAt30s, 'running');
        // Both the window's check and the settle's start on a microtask: wait until each has begun.
        await vi.waitFor(() => expect(storeChecks.length).toBeGreaterThanOrEqual(2));
        await Promise.all(storeChecks);
        await flushReportChain();
        expect(reportHandledError).not.toHaveBeenCalled();
      });

      it('still reports the same terminal once a prompt reached it', async () => {
        const typedInto = session({ resuming: false, ...event063, promptObservedAt: STARTED_AT_MS + 10_000 });
        noteSessionIdCaptureWindowPassed(typedInto, storeCheck, async () => 'signed_in');
        reportSessionIdCaptureOutcome(typedInto.id, removedAt30s, 'running');
        await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
        expect(reportHandledError.mock.calls[0][1]).toMatchObject({
          start_path: 'command_terminal',
          opening_prompt: 'none',
          prompt_seen: 'yes',
          hook_seen: 'yes',
          login: 'signed_in',
          id_store: 'absent',
          settled_by: 'removed',
          agent_ran_for_s: '30-60',
        });
      });
    });

    it('leaves a late id to the late rule, which reads no store at the settle', async () => {
      const noRollout = vi.fn(async (): Promise<SessionIdStoreEvidence> => 'absent');
      const pastWindow = session({ resuming: false, ...untouched });
      noteSessionIdCaptureWindowPassed(pastWindow, noRollout);
      reportSessionIdCaptureOutcome(pastWindow.id, late, 'running');
      // A session started with no prompt waits two seconds for its first one before a late id is judged.
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1), { timeout: 5_000 });

      expect(noRollout).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][0]).toMatchObject({ name: 'AgentSessionIdCapturedLateError' });
    });
  });

  it('reads a store check that fails or hangs as unknown', async () => {
    await settle({ agentName: 'codex' }, never, async () => { throw new Error('EACCES /Users/dev/.codex'); });
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ id_store: 'unknown' });

    resetLaunchReports();
    reportHandledError.mockClear();
    vi.useFakeTimers();
    try {
      noteSessionIdCaptureWindowPassed(session({ agentName: 'codex' }), () => new Promise(() => undefined));
      reportSessionIdCaptureOutcome('session-1-long-id', never, null);
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ id_store: 'unknown', session_status: 'removed' });
  });

  it('reports each kind once per agent per run, and a different agent still reports', async () => {
    await settle({ agentName: 'claude' }, never);
    reportHandledError.mockClear();
    noteSessionIdCaptureWindowPassed(session({ agentName: 'claude' }), null);
    reportSessionIdCaptureOutcome('session-1-long-id', never, null);
    await settle({ agentName: 'claude' }, late);
    reportHandledError.mockClear();
    await settle({ agentName: 'codex' }, never);

    expect(reportHandledError.mock.calls.map((call) => call[1].agent)).toEqual(['codex']);
  });

  it('vets the opening prompt and the id creation, so an unexpected string reports unknown', async () => {
    await settle({ agentName: 'codex', openingPrompt: '/Users/dev/x' as never, sessionIdCreation: '/Users/dev/y' as never }, never);

    const eventTags = reportHandledError.mock.calls[0][1];
    expect(eventTags).toMatchObject({ opening_prompt: 'unknown', create_chat: 'unknown' });
    expect(JSON.stringify(eventTags)).not.toContain('/Users/dev');
  });

  // Sentry DESKTOP-45: a Cursor session reached the window with no id, and the
  // report could not say whether `create-chat` failed, timed out, printed no id,
  // or was never asked. Each outcome is its own fixed tag.
  it.each(['ok', 'failed', 'timeout', 'no_id', 'aborted', 'not_asked'] as const)('sends the id creation outcome %s as its own tag', async (sessionIdCreation) => {
    await settle({ agentName: 'cursor', sessionIdCreation }, never);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ create_chat: sessionIdCreation });
  });

  // `prompt_seen` is read when the outcome lands, not at the window: a prompt
  // typed after the window is the case that tells a conversation that never
  // existed (no prompt, nothing to resume) from one the capture missed.
  it('reads a prompt sent after the window as seen, on the never and the late report alike', async () => {
    const neverSession = session({ agentName: 'opencode', resuming: false });
    noteSessionIdCaptureWindowPassed(neverSession, null);
    neverSession.promptObservedAt = STARTED_AT_MS + 60_000;
    reportSessionIdCaptureOutcome(neverSession.id, never, 'running');
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ prompt_seen: 'yes' });

    const lateSession = session({ agentName: 'opencode', resuming: false, id: 'session-2-long-id' });
    noteSessionIdCaptureWindowPassed(lateSession, null);
    lateSession.promptObservedAt = STARTED_AT_MS + 60_000;
    reportSessionIdCaptureOutcome(lateSession.id, late, 'running');
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(2));
    expect(reportHandledError.mock.calls[1][1]).toMatchObject({ prompt_seen: 'yes' });
  });

  it('does not run the store check for an agent that already spent both kinds, and sends nothing later', async () => {
    await settle({ agentName: 'claude' }, never);
    await settle({ agentName: 'claude' }, late);
    // settle() returns once any report was sent, which the first one already was.
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(2));
    reportHandledError.mockClear();

    const storeCheck = vi.fn(async (): Promise<SessionIdStoreEvidence> => 'present');
    const anotherSession = session({ agentName: 'claude', id: 'session-2-long-id' });
    noteSessionIdCaptureWindowPassed(anotherSession, storeCheck);
    reportSessionIdCaptureOutcome(anotherSession.id, never, null);
    await flushReportChain();

    expect(storeCheck).not.toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('sends nothing for a kind the agent already spent, though the other kind still holds the session', async () => {
    await settle({ agentName: 'claude' }, never);
    reportHandledError.mockClear();

    const anotherSession = session({ agentName: 'claude', id: 'session-2-long-id' });
    noteSessionIdCaptureWindowPassed(anotherSession, null);
    reportSessionIdCaptureOutcome(anotherSession.id, never, null);
    await flushReportChain();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('sends nothing for a session never held at the window', async () => {
    reportSessionIdCaptureOutcome('no-such-session', never, null);
    await flushReportChain();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('sends nothing once the quit has started, and does not spend the agent\'s one report on it', async () => {
    shuttingDown.value = true;
    noteSessionIdCaptureWindowPassed(session(), null);
    reportSessionIdCaptureOutcome('session-1-long-id', never, null);
    await flushReportChain();
    expect(reportHandledError).not.toHaveBeenCalled();

    shuttingDown.value = false;
    await settle({}, never);
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

  describe('a Post-Worktree Script failure (Sentry DESKTOP-3D could not tell an exit from a kill)', () => {
    const scriptBase = { ...base, cause: 'worktree_setup_script' } as const;
    const scriptFailure = (fields: Record<string, unknown>): WorktreeSetupScriptError => (
      new WorktreeSetupScriptError('init script failed', { cause: Object.assign(new Error('init script failed'), fields) })
    );

    it('names the exit code of a script that exited on its own', () => {
      reportPreflightFailure({ ...scriptBase, error: scriptFailure({ exitCode: 1, timedOut: false }) });

      const eventTags = reportHandledError.mock.calls[0][1];
      expect(eventTags).toMatchObject({ error_type: 'WorktreeSetupScriptError', script_exit: '1', timed_out: 'no' });
      expect(eventTags).not.toHaveProperty('script_signal');
    });

    it('names a script the timeout stopped', () => {
      reportPreflightFailure({ ...scriptBase, error: scriptFailure({ timedOut: true }) });

      const eventTags = reportHandledError.mock.calls[0][1];
      expect(eventTags).toMatchObject({ timed_out: 'yes' });
      expect(eventTags).not.toHaveProperty('script_exit');
    });

    it('names the signal that ended it, and only a signal\'s name', () => {
      reportPreflightFailure({ ...scriptBase, error: scriptFailure({ signal: 'SIGKILL', timedOut: false }) });
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ script_signal: 'SIGKILL', timed_out: 'no' });

      resetLaunchReports();
      reportHandledError.mockClear();
      reportPreflightFailure({ ...scriptBase, error: scriptFailure({ signal: 'killed by /Users/dev/hook' }) });
      expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty('script_signal');
    });
  });

  it('files a start refused for a .cmd shim under a cause of its own, with why the shim gave up', () => {
    reportPreflightFailure({ ...base, cause: 'agent_start', error: new AgentBatchShimUnresolvedError({ gaveUp: 'node_path' }) });

    const [sent, eventTags, , fingerprint] = reportHandledError.mock.calls[0];
    expect(eventTags).toMatchObject({
      cause: 'batch_shim_unresolved',
      batch_shim: 'node_path',
      start_refused_reason: 'prompt-too-long',
      error_type: 'AgentBatchShimUnresolvedError',
    });
    expect((sent as Error).message).toBe('Agent launch failed: preflight (batch_shim_unresolved)');
    expect(fingerprint).toEqual(['agent-launch', 'preflight', 'batch_shim_unresolved']);
    expect(eventTags).not.toHaveProperty('batch_shim_shape');
    expect(eventTags).not.toHaveProperty('batch_shim_ps1');
  });

  // Sentry DESKTOP-3Y recurred as `unparsed`, which named no shape to support next.
  it('names the shape of a shim it could not parse', () => {
    reportPreflightFailure({ ...base, cause: 'agent_start', error: new AgentBatchShimUnresolvedError({ gaveUp: 'unparsed', shape: 'absolute_path' }) });
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ batch_shim: 'unparsed', batch_shim_shape: 'absolute_path' });
  });

  // DESKTOP-3Y again, on 0.64.0: `target_ps1` named none of the refusals behind it.
  it('names which refusal a .ps1 target was', () => {
    reportPreflightFailure({ ...base, cause: 'agent_start', error: new AgentBatchShimUnresolvedError({ gaveUp: 'target_ps1', ps1: 'program_missing' }) });
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ batch_shim: 'target_ps1', batch_shim_ps1: 'program_missing' });
  });

  it('sends a fixed message, never the text git wrote', () => {
    reportPreflightFailure({ ...base, error: new Error("fatal: cannot lock ref 'refs/heads/fix-acme-billing'") });

    const sent = reportHandledError.mock.calls[0][0] as Error;
    expect(sent.name).toBe('AgentLaunchPreflightError');
    expect(sent.message).toBe('Agent launch failed: preflight (worktree)');
    expect(sent.stack).not.toContain('acme');
  });

  it('reports a failure once when a caller catches it again after a rethrow', () => {
    const error = new Error('spawn broke');
    reportPreflightFailure({ ...base, cause: 'agent_start', error });
    reportPreflightFailure({ ...base, cause: 'auto_spawn', error });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
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

  describe('a host request nobody answered (Sentry DESKTOP-4N)', () => {
    // What main holds: the link's rejection, flattened by the pty host's transport and rebuilt.
    const overTheWire = (error: Error): Error => fromPtyHostError(toPtyHostError(error));

    it('files nothing for a request the link was stopped under, bare or wrapped, and still counts it', () => {
      const stopped = overTheWire(new HostRequestUnansweredError('the link stopped', 'link_stopped'));
      reportPreflightFailure({ ...base, cause: 'worktree_other', error: stopped });
      reportPreflightFailure({ ...base, cause: 'worktree_other', error: new Error('could not make the worktree', { cause: overTheWire(new HostRequestUnansweredError('the link stopped', 'link_stopped')) }) });

      expect(reportHandledError).not.toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith('spawn_failed', { agent: 'claude', reason: 'worktree_other' });
    });

    it('still files a request whose wait ran out, with the helper call and how long main waited', () => {
      const unanswered = overTheWire(new HostRequestUnansweredError('the host did not answer runCommand within 250 s', 'no_answer'));
      noteHostRequestWait(unanswered, { method: 'runCommand', waitedMs: 250_000 });
      reportPreflightFailure({ ...base, cause: 'worktree_other', error: unanswered });

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({
        cause: 'worktree_other',
        error_type: 'HostRequestUnansweredError',
        errno: 'HOST_NO_ANSWER',
        host_method: 'runCommand',
        ran_for: '60-300',
      });
    });

    it('sends how long main waited but no host_method for a method name that is not a plain word', () => {
      const unanswered = overTheWire(new HostRequestUnansweredError('the host did not answer', 'no_answer'));
      noteHostRequestWait(unanswered, { method: 'bad method;1', waitedMs: 1_000 });
      reportPreflightFailure({ ...base, cause: 'worktree_other', error: unanswered });

      expect(reportHandledError).toHaveBeenCalledTimes(1);
      const eventTags = reportHandledError.mock.calls[0][1];
      expect(eventTags).toMatchObject({ errno: 'HOST_NO_ANSWER', ran_for: '1-5' });
      expect(eventTags).not.toHaveProperty('host_method');
      expect(JSON.stringify(eventTags)).not.toContain('bad method');
    });

    it('reads the call and the wait off a wrapper\'s cause, and sends no host text', () => {
      const unanswered = overTheWire(new HostRequestUnansweredError('the host did not answer runCommand within 250 s', 'no_answer'));
      noteHostRequestWait(unanswered, { method: 'runCommand', waitedMs: 400_000 });
      reportPreflightFailure({ ...base, cause: 'worktree_other', error: new Error('lab-box: could not make the worktree', { cause: unanswered }) });

      const eventTags = reportHandledError.mock.calls[0][1];
      expect(eventTags).toMatchObject({ host_method: 'runCommand', ran_for: '>300' });
      expect(JSON.stringify(eventTags)).not.toContain('lab-box');
    });
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
