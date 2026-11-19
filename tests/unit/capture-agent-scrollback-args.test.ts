/**
 * The argument handling and launch shapes of scripts/capture-agent-scrollback.js, the recorder
 * behind the sample install's session fixtures. The script runs main() only when it is the entry
 * point, so requiring it here executes nothing and exposes parseArgs and buildCommand.
 *
 * What this pins:
 * - buildCommand attaches Kangentic's MCP server to a claude launch in the desktop's order
 *   (src/main/agent/adapters/claude/command-builder.ts): the merged settings, then the MCP config,
 *   after the permission mode and before the end-of-options marker and the prompt, or before
 *   --resume on a resume (which carries no prompt and no marker). With neither option the argv is
 *   the one claude got before MCP capture existed. Any other agent refuses the options, because
 *   each adapter delivers the server its own way and a silent drop would record a session with
 *   no tools.
 * - parseArgs accepts a --cwd inside --scratch-root, a nested worktree and a child folder whose
 *   own name starts with two dots included, and refuses one outside it: a sibling, the parent, or
 *   (on Windows) another drive, where path.relative answers with an absolute path.
 * - parseArgs resolves --mcp-config, --settings and --scratch-root to absolute paths.
 * - The read-only launch a workflow's own agent gets carries the desktop's flags, with the tool
 *   list the desktop's read-only launch names, and the default permission mode passes no flag.
 *
 * parseArgs only resolves strings and never touches the disk, so every path here is a string built
 * under os.tmpdir() and nothing is created.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { CommandBuilder } from '../../src/main/agent/adapters/claude';
import {
  EVIDENCE_FIRST_WAIT_MS, EVIDENCE_RETRY_WAIT_MS, MIN_GAP_MS, OUTPUT_SETTLE_IDLE_MS, POST_ENTER_DATA_FLOOR_BYTES,
  SETTLE_CAP_MIN_MS, SETTLE_CAP_PER_BYTE_MS, sanitizeForPaste,
} from '../../src/main/pty/paste-engine';

interface McpLaunchOptions {
  mcpConfig: string | null;
  settings: string | null;
  readOnly?: boolean;
}

interface LaunchCommand {
  exe: string;
  args: string[];
  exit: string[];
}

interface ParsedCaptureOptions {
  agent: string;
  cwd: string;
  project: string;
  out: string;
  prompt: string;
  followUp: string | null;
  resume: string | null;
  mcpConfig: string | null;
  settings: string | null;
  scratchRoot: string | null;
}

interface CaptureScrollbackModule {
  parseArgs: (argv: string[]) => ParsedCaptureOptions;
  buildCommand: (
    agent: string,
    cwd: string,
    prompt: string,
    mode: string | null,
    model: string | null,
    resume: string | null,
    mcp: McpLaunchOptions,
  ) => LaunchCommand;
  CLAUDE_READ_ONLY_TOOLS: string;
  endsOnPermissionQuestion: (raw: string) => boolean;
  pastePacket: (text: string) => string;
  missedSecondTurn: (turn: { followUp: string | null; followUpSent: boolean; pasteRequested: boolean; pasteSent: boolean; reason: string }) => string | null;
  PASTE_TIMINGS: {
    settleIdleMs: number;
    minGapMs: number;
    capMinMs: number;
    capPerByteMs: number;
    enterWaitsMs: number[];
    enterEvidenceBytes: number;
  };
}

interface WslLaunchHelpers {
  wslSpawnArgs: (invocationArgs: string[], linuxCwd: string) => string[];
  withoutDriveMounts: (pathValue: string) => string;
  WSL_AGENT_ENV: Record<string, string>;
}

interface DistroFacts {
  linuxCwd: string;
  leftoverProcesses: () => string[];
  hangUp: (pids: string[]) => void;
}

interface CollectedChanges {
  files: Array<{ path: string; status: string; binary: boolean; insertions: number; deletions: number; original: string; modified: string; language: string | null }>;
  totalInsertions: number;
  totalDeletions: number;
}

interface WslTeardownHelpers {
  settleWslLeftovers: (wsl: DistroFacts, sleep: (milliseconds: number) => Promise<void>) => Promise<void>;
  collectChanges: (cwd: string, sanitizer: { apply: (text: string) => string }, runGit: (args: string[]) => string) => CollectedChanges;
}

const require = createRequire(import.meta.url);
const { settleWslLeftovers, collectChanges } = require('../../scripts/capture-agent-scrollback.js') as WslTeardownHelpers;
const { parseArgs, buildCommand, endsOnPermissionQuestion, pastePacket, missedSecondTurn, PASTE_TIMINGS, CLAUDE_READ_ONLY_TOOLS, wslSpawnArgs, withoutDriveMounts, WSL_AGENT_ENV } = require('../../scripts/capture-agent-scrollback.js') as CaptureScrollbackModule & WslLaunchHelpers;

describe('a capture in a WSL distro', () => {
  // A share path, built as a string only: parseArgs touches no disk.
  const shareCwd = '\\\\wsl.localhost\\Distro\\home\\someone\\redis';
  const base = ['--agent', 'claude', '--cwd', shareCwd, '--project', 'redis', '--out', path.join(os.tmpdir(), 'out.json')];

  it('takes the distro and the host folder together, the folder kept as written', () => {
    const parsed = parseArgs([...base, '--wsl', 'Distro', '--demo-path', '/home/dev/redis', '--prompt', 'Read src/expire.c']) as ParsedCaptureOptions & { wsl: string; demoPath: string };
    expect(parsed.wsl).toBe('Distro');
    // path.resolve would have made it C:\home\dev\redis on a Windows recording machine.
    expect(parsed.demoPath).toBe('/home/dev/redis');
  });

  it('refuses one without the other, and a host folder that is not absolute', () => {
    expect(() => parseArgs([...base, '--wsl', 'Distro'])).toThrow(/go together/);
    expect(() => parseArgs([...base, '--demo-path', '/home/dev/redis'])).toThrow(/go together/);
    expect(() => parseArgs([...base, '--wsl', 'Distro', '--demo-path', 'redis'])).toThrow(/absolute folder on the host/);
  });

  it('refuses every launch shape no distro run has measured', () => {
    const inDistro = [...base, '--wsl', 'Distro', '--demo-path', '/home/dev/redis'];
    expect(() => parseArgs(inDistro.map((value) => (value === 'claude' ? 'codex' : value)))).toThrow(/Claude Code only/);
    expect(() => parseArgs([...inDistro, '--resume', 'session-1'])).toThrow(/plain launch/);
    expect(() => parseArgs([...inDistro, '--follow-up', 'more'])).toThrow(/plain launch/);
    expect(() => parseArgs([...inDistro, '--read-only'])).toThrow(/plain launch/);
    expect(() => parseArgs([...inDistro, '--mcp-config', MCP_CONFIG])).toThrow(/plain launch/);
  });

  it('refuses a prompt that wsl.exe would parse again on its way in', () => {
    const inDistro = [...base, '--wsl', 'Distro', '--demo-path', '/home/dev/redis'];
    expect(() => parseArgs([...inDistro, '--prompt', 'Pin "EXPIRE" with a negative TTL'])).toThrow(/double quote or a backslash/);
    expect(() => parseArgs([...inDistro, '--prompt', 'Read src\\expire.c'])).toThrow(/double quote or a backslash/);
    // The same prompt is fine for a launch on this computer.
    expect(() => parseArgs([...base, '--prompt', 'Pin "EXPIRE" with a negative TTL'])).not.toThrow();
  });

  it('starts the app\'s distro launch in the agent\'s folder', () => {
    const invocationArgs = ['-d', 'Distro', '-e', 'env', 'PATH=/usr/bin', 'claude', '--permission-mode', 'plan', '--', 'Plan it'];
    expect(wslSpawnArgs(invocationArgs, '/home/someone/redis/.kangentic/worktrees/one')).toEqual([
      '-d', 'Distro', '--cd', '/home/someone/redis/.kangentic/worktrees/one', '-e', 'env', 'PATH=/usr/bin', 'claude', '--permission-mode', 'plan', '--', 'Plan it',
    ]);
    // A launch that is not the distro shape is refused rather than given a --cd in the wrong place.
    expect(() => wslSpawnArgs(['-e', 'claude'], '/home/someone')).toThrow(/-d <distro>/);
  });

  it('leaves the Windows folders WSL appends off the agent\'s PATH', () => {
    expect(withoutDriveMounts('/home/someone/.local/bin:/usr/bin:/mnt/c/Windows/system32:/mnt/d/tools:/bin'))
      .toBe('/home/someone/.local/bin:/usr/bin:/bin');
    // Only a drive mount: a folder that merely contains "mnt" stays.
    expect(withoutDriveMounts('/opt/mnt/bin:/mnt/data2/bin')).toBe('/opt/mnt/bin:/mnt/data2/bin');
  });

  it('starts Claude on the classic renderer with no advisor notice, as a launch on this computer does', () => {
    // These cross into the distro only through WSLENV, so a launch that dropped one would record
    // the fullscreen renderer, which a replay cannot reproduce.
    expect(WSL_AGENT_ENV).toMatchObject({ TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' });
  });
});

describe('the browser note the capture pastes', () => {
  it('is the packet the paste engine writes for Send', () => {
    // The capture records what the Browser pane's Send puts into a terminal, so the bytes have to
    // be the engine's: its sanitizer over the payload, inside the bracketed-paste markers.
    const payload = 'Only an admin should cancel.\r\n\r\nScreenshot: @.kangentic/sessions/x/captures/capture-1.png\r\n<browser_context>\x07\n  <url>http://localhost:5173/</url>\n</browser_context>';
    expect(pastePacket(payload)).toBe(`\x1b[200~${sanitizeForPaste(payload)}\x1b[201~`);
  });

  it('refuses a paste beside a follow-up or a cut', () => {
    const base = ['--agent', 'claude', '--cwd', os.tmpdir(), '--project', 'contoso-web', '--out', path.join(os.tmpdir(), 'out.json'), '--paste-file', path.join(os.tmpdir(), 'note.txt')];
    expect(() => parseArgs([...base, '--follow-up', 'more'])).toThrow(/both a second turn/);
    expect(() => parseArgs([...base, '--stop-after', '10'])).toThrow(/waits for the turn to end/);
  });

  it('is entered on the paste engine\'s own clock', () => {
    // The web demo plays the recording from the paste to the Enter, so a capture that waited
    // another span than the engine would record a Send the desktop never makes.
    expect(PASTE_TIMINGS).toEqual({
      settleIdleMs: OUTPUT_SETTLE_IDLE_MS,
      minGapMs: MIN_GAP_MS,
      capMinMs: SETTLE_CAP_MIN_MS,
      capPerByteMs: SETTLE_CAP_PER_BYTE_MS,
      enterWaitsMs: [EVIDENCE_FIRST_WAIT_MS, EVIDENCE_RETRY_WAIT_MS],
      enterEvidenceBytes: POST_ENTER_DATA_FLOOR_BYTES,
    });
  });

  it('fails a capture that asked for the note and never pasted it', () => {
    const turn = { followUp: null, followUpSent: false, pasteRequested: true, pasteSent: false };
    expect(missedSecondTurn({ ...turn, reason: 'question' })).toMatch(/browser note was never pasted \(the first turn ended on a permission question\)/);
    expect(missedSecondTurn({ ...turn, reason: 'timeout' })).toMatch(/browser note was never pasted \(the first turn ended on a timeout\)/);
    expect(missedSecondTurn({ ...turn, pasteSent: true, reason: 'idle' })).toBeNull();
    expect(missedSecondTurn({ ...turn, pasteRequested: false, reason: 'idle' })).toBeNull();
    expect(missedSecondTurn({ ...turn, pasteRequested: false, followUp: 'more', reason: 'exited' })).toMatch(/follow-up was never typed/);
  });
});

const SANDBOX = path.join(os.tmpdir(), 'kangentic-capture-args-test');
const SCRATCH_ROOT = path.join(SANDBOX, 'clone');
const OUT_PATH = path.join(SANDBOX, 'out.json');
const MCP_CONFIG = path.join(SANDBOX, 'mcp.json');
const SETTINGS = path.join(SANDBOX, 'settings.json');
const PROMPT = 'Set a TTL on cart keys';

const NO_MCP: McpLaunchOptions = { mcpConfig: null, settings: null };

/** The flags parseArgs requires (agent, cwd, project, out), plus whatever the case adds. */
function argvFor(cwd: string, extra: string[] = []): string[] {
  return ['--agent', 'claude', '--cwd', cwd, '--project', 'online-boutique', '--out', OUT_PATH, ...extra];
}

describe('buildCommand: Kangentic MCP server on a claude launch', () => {
  it('puts --settings then --mcp-config after the permission mode and before the end-of-options marker and prompt', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, PROMPT, 'acceptEdits', null, null, { mcpConfig: MCP_CONFIG, settings: SETTINGS });

    expect(command.exe).toBe('claude');
    expect(command.args).toEqual([
      '--permission-mode', 'acceptEdits',
      '--settings', SETTINGS,
      '--mcp-config', MCP_CONFIG,
      '--', PROMPT,
    ]);
  });

  it('uses the given permission mode in place of the acceptEdits default', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, PROMPT, 'plan', null, null, { mcpConfig: MCP_CONFIG, settings: SETTINGS });

    expect(command.args.slice(0, 2)).toEqual(['--permission-mode', 'plan']);
    expect(command.args.indexOf('--settings')).toBe(2);
  });

  it('adds only the flag whose option is set', () => {
    const settingsOnly = buildCommand('claude', SCRATCH_ROOT, PROMPT, null, null, null, { mcpConfig: null, settings: SETTINGS });
    const mcpConfigOnly = buildCommand('claude', SCRATCH_ROOT, PROMPT, null, null, null, { mcpConfig: MCP_CONFIG, settings: null });

    expect(settingsOnly.args).toEqual(['--permission-mode', 'acceptEdits', '--settings', SETTINGS, '--', PROMPT]);
    expect(mcpConfigOnly.args).toEqual(['--permission-mode', 'acceptEdits', '--mcp-config', MCP_CONFIG, '--', PROMPT]);
  });

  it('puts both pairs before --resume on a resume, which has no prompt and no end-of-options marker', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, '', 'acceptEdits', null, 'session-1234', { mcpConfig: MCP_CONFIG, settings: SETTINGS });

    expect(command.args).toEqual([
      '--permission-mode', 'acceptEdits',
      '--settings', SETTINGS,
      '--mcp-config', MCP_CONFIG,
      '--resume', 'session-1234',
    ]);
    expect(command.args).not.toContain('--');
  });

  it('keeps a resume without MCP options exactly as it was', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, '', null, null, 'session-1234', NO_MCP);

    expect(command.args).toEqual(['--permission-mode', 'acceptEdits', '--resume', 'session-1234']);
  });

  it('adds no MCP flag at all when neither option is set', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, PROMPT, null, null, null, NO_MCP);

    expect(command.args).toEqual(['--permission-mode', 'acceptEdits', '--', PROMPT]);
    expect(command.args).not.toContain('--settings');
    expect(command.args).not.toContain('--mcp-config');
  });

  it('adds no MCP flag for an empty-prompt claude launch either', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, '', null, null, null, NO_MCP);

    expect(command.args).toEqual(['--permission-mode', 'acceptEdits']);
  });
});

describe('buildCommand: the read-only launch a workflow agent gets', () => {
  it('passes no permission mode in default mode, then the MCP pair, then the read-only flags before the prompt', () => {
    const command = buildCommand('claude', SCRATCH_ROOT, PROMPT, 'default', null, null, { mcpConfig: MCP_CONFIG, settings: SETTINGS, readOnly: true });

    expect(command.args).toEqual([
      '--settings', SETTINGS,
      '--mcp-config', MCP_CONFIG,
      '--tools', CLAUDE_READ_ONLY_TOOLS, '--strict-mcp-config', '--no-chrome',
      '--', PROMPT,
    ]);
  });

  it('names the tools and flags the desktop\'s read-only launch carries', () => {
    const desktop = new CommandBuilder().buildClaudeCommand({
      cliPath: '/usr/bin/claude',
      taskId: 'wf-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      readOnly: true,
    });

    expect(desktop).toContain(`--tools '${CLAUDE_READ_ONLY_TOOLS}' --strict-mcp-config --no-chrome`);
    expect(desktop).not.toContain('--permission-mode');
  });

  it('refuses a read-only launch for an agent with no shape for one', () => {
    expect(() => buildCommand('codex', SCRATCH_ROOT, PROMPT, null, null, null, { mcpConfig: null, settings: null, readOnly: true })).toThrow('No read-only launch shape for agent "codex"');
  });
});

describe('buildCommand: an agent with no MCP launch shape', () => {
  it.each([
    ['codex', { mcpConfig: MCP_CONFIG, settings: null }],
    ['codex', { mcpConfig: null, settings: SETTINGS }],
    ['codex', { mcpConfig: MCP_CONFIG, settings: SETTINGS }],
    ['gemini', { mcpConfig: MCP_CONFIG, settings: null }],
  ] as Array<[string, McpLaunchOptions]>)('refuses %s given %j', (agent, mcp) => {
    expect(() => buildCommand(agent, SCRATCH_ROOT, PROMPT, null, null, null, mcp)).toThrow(`No MCP launch shape for agent "${agent}"`);
  });

  it('still builds the same agent when no MCP option is given', () => {
    const command = buildCommand('codex', SCRATCH_ROOT, PROMPT, null, null, null, NO_MCP);

    expect(command.exe).toBe('codex');
    expect(command.args).toContain(PROMPT);
  });
});

describe('parseArgs: --scratch-root must contain --cwd', () => {
  it('refuses a --cwd in a sibling directory of the root', () => {
    const sibling = path.join(SCRATCH_ROOT, '..', 'other');

    expect(() => parseArgs(argvFor(sibling, ['--scratch-root', SCRATCH_ROOT]))).toThrow('--scratch-root must contain --cwd');
  });

  it('refuses a --cwd that is the parent of the root', () => {
    expect(() => parseArgs(argvFor(path.dirname(SCRATCH_ROOT), ['--scratch-root', SCRATCH_ROOT]))).toThrow('--scratch-root must contain --cwd');
  });

  it.skipIf(process.platform !== 'win32')('refuses a --cwd on another drive, where path.relative answers with an absolute path', () => {
    const rootDrive = path.parse(SCRATCH_ROOT).root.toUpperCase();
    const otherDrive = rootDrive.startsWith('Z') ? 'Y:\\' : 'Z:\\';
    const crossDriveCwd = `${otherDrive}clone${path.sep}worktrees${path.sep}x`;

    expect(path.isAbsolute(path.relative(SCRATCH_ROOT, crossDriveCwd))).toBe(true);
    expect(() => parseArgs(argvFor(crossDriveCwd, ['--scratch-root', SCRATCH_ROOT]))).toThrow('--scratch-root must contain --cwd');
  });

  it('accepts a worktree nested inside the root', () => {
    const worktree = path.join(SCRATCH_ROOT, '.kangentic', 'worktrees', 'x');

    const options = parseArgs(argvFor(worktree, ['--scratch-root', SCRATCH_ROOT]));

    expect(options.cwd).toBe(worktree);
    expect(options.scratchRoot).toBe(SCRATCH_ROOT);
  });

  it('accepts a child folder whose own name starts with two dots', () => {
    const dotDotChild = path.join(SCRATCH_ROOT, '..cache');

    const options = parseArgs(argvFor(dotDotChild, ['--scratch-root', SCRATCH_ROOT]));

    expect(options.cwd).toBe(dotDotChild);
  });

  it('checks nothing when --scratch-root is not given', () => {
    const elsewhere = path.join(SANDBOX, 'unrelated');

    const options = parseArgs(argvFor(elsewhere));

    expect(options.cwd).toBe(elsewhere);
    expect(options.scratchRoot).toBeNull();
  });
});

describe('endsOnPermissionQuestion: the follow-up is never typed into the agent\'s own question', () => {
  const fixturesDirectory = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');
  function streamOf(file: string): string {
    const recording = JSON.parse(fs.readFileSync(path.join(fixturesDirectory, file), 'utf-8')) as { stream: Array<{ data: string }> };
    return recording.stream.map((window) => window.data).join('');
  }

  it('is true where a real recording stops on Claude\'s permission question', () => {
    const stream = streamOf('contoso-web-claude-api-client-tiled.json');
    const asked = stream.lastIndexOf('Do you want to');
    expect(asked, 'the fixture carries a permission question').toBeGreaterThan(-1);

    expect(endsOnPermissionQuestion(stream.slice(0, asked + 1200))).toBe(true);
  });

  it('is false at the end of the recorded workflow agent, whose turn ends on its reply', () => {
    expect(endsOnPermissionQuestion(streamOf('workflow-wf-cw-invoice-pdf.json'))).toBe(false);
  });

  it('is false for a question the agent asks in its own reply, which the follow-up answers', () => {
    expect(endsOnPermissionQuestion('Both tasks run every column. Do you want to skip Planning on the client task?\r\n')).toBe(false);
  });
});

describe('parseArgs: --follow-up', () => {
  it('keeps the text the user types after the first turn', () => {
    const options = parseArgs(argvFor(SCRATCH_ROOT, ['--prompt', PROMPT, '--follow-up', 'Split it in two']));

    expect(options.followUp).toBe('Split it in two');
  });

  it('is null when the flag is absent', () => {
    expect(parseArgs(argvFor(SCRATCH_ROOT)).followUp).toBeNull();
  });

  it('refuses blank text, which would send an empty turn', () => {
    expect(() => parseArgs(argvFor(SCRATCH_ROOT, ['--follow-up', '  ']))).toThrow('--follow-up needs the text the user types');
  });

  it('refuses a cut that would end the first turn before it goes quiet', () => {
    expect(() => parseArgs(argvFor(SCRATCH_ROOT, ['--follow-up', 'More', '--stop-after', '30']))).toThrow('--follow-up waits for the turn to end');
    expect(() => parseArgs(argvFor(SCRATCH_ROOT, ['--follow-up', 'More', '--stop-when', 'Moving']))).toThrow('--follow-up waits for the turn to end');
  });
});

describe('parseArgs: path options resolve to absolute paths', () => {
  it('resolves relative --mcp-config, --settings and --scratch-root', () => {
    const options = parseArgs(argvFor(path.resolve('relative-clone', 'work'), [
      '--mcp-config', path.join('relative-dir', 'mcp.json'),
      '--settings', path.join('relative-dir', 'settings.json'),
      '--scratch-root', 'relative-clone',
    ]));

    expect(options.mcpConfig).toBe(path.resolve('relative-dir', 'mcp.json'));
    expect(options.settings).toBe(path.resolve('relative-dir', 'settings.json'));
    expect(options.scratchRoot).toBe(path.resolve('relative-clone'));
    for (const resolved of [options.mcpConfig, options.settings, options.scratchRoot]) {
      expect(path.isAbsolute(resolved as string)).toBe(true);
    }
  });

  it('normalizes dot segments in absolute paths', () => {
    const options = parseArgs(argvFor(SCRATCH_ROOT, [
      '--mcp-config', `${SANDBOX}${path.sep}nested${path.sep}..${path.sep}mcp.json`,
      '--settings', `${SANDBOX}${path.sep}nested${path.sep}..${path.sep}settings.json`,
    ]));

    expect(options.mcpConfig).toBe(MCP_CONFIG);
    expect(options.settings).toBe(SETTINGS);
  });

  it('leaves mcpConfig, settings and scratchRoot null when the flags are absent', () => {
    const options = parseArgs(argvFor(SCRATCH_ROOT));

    expect(options.mcpConfig).toBeNull();
    expect(options.settings).toBeNull();
    expect(options.scratchRoot).toBeNull();
  });
});

describe('settleWslLeftovers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function distro(overrides: Partial<DistroFacts>): { wsl: DistroFacts; hangUps: string[][] } {
    const hangUps: string[][] = [];
    const wsl: DistroFacts = {
      linuxCwd: '/home/someone/redis',
      leftoverProcesses: () => [],
      hangUp: (pids) => { hangUps.push(pids); },
      ...overrides,
    };
    return { wsl, hangUps };
  }

  function countingSleep(): { sleep: (milliseconds: number) => Promise<void>; calls: number[] } {
    const calls: number[] = [];
    return { sleep: async (milliseconds) => { calls.push(milliseconds); }, calls };
  }

  it('returns at once, with no hangup, when nothing is left', async () => {
    const { wsl, hangUps } = distro({});
    const { sleep, calls } = countingSleep();
    await settleWslLeftovers(wsl, sleep);
    expect(calls).toEqual([]);
    expect(hangUps).toEqual([]);
  });

  it('polls while processes remain and returns once they end', async () => {
    let looks = 0;
    const { wsl, hangUps } = distro({ leftoverProcesses: () => { looks += 1; return looks <= 3 ? ['602 sleep'] : []; } });
    const { sleep, calls } = countingSleep();
    await settleWslLeftovers(wsl, sleep);
    expect(calls).toEqual([500, 500, 500]);
    expect(hangUps).toEqual([]);
  });

  it('hangs up the pids of what outlasts about 5 seconds of polling', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { wsl, hangUps } = distro({ leftoverProcesses: () => ['602 sleep', '911 node'] });
    const { sleep, calls } = countingSleep();
    await settleWslLeftovers(wsl, sleep);
    expect(calls).toHaveLength(10);
    expect(calls.every((milliseconds) => milliseconds === 500)).toBe(true);
    expect(hangUps).toEqual([['602', '911']]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('602 sleep, 911 node'));
  });

  it('reports a hangup that throws and does not throw itself', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { wsl } = distro({
      leftoverProcesses: () => ['602 sleep'],
      hangUp: () => { throw new Error('kill refused'); },
    });
    await expect(settleWslLeftovers(wsl, countingSleep().sleep)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('the hangup failed (kill refused)'));
  });

  it('reports a look that throws, ends the wait, and does not throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { wsl, hangUps } = distro({ leftoverProcesses: () => { throw new Error('wsl.exe failed'); } });
    const { sleep, calls } = countingSleep();
    await expect(settleWslLeftovers(wsl, sleep)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(hangUps).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('wsl.exe failed'));
  });
});

describe('collectChanges', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  const sanitizer = { apply: (text: string) => `S(${text})` };

  function folderWith(files: Record<string, string>): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-changes-'));
    cleanup.push(directory);
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      fs.writeFileSync(path.join(directory, relative), content);
    }
    return directory;
  }

  const NAME_STATUS = ['M\tsrc/expire.c', 'A\tsrc/new.c', 'D\tsrc/gone.c', 'M\tnode_modules/pkg/index.js'].join('\n');
  const NUMSTAT = ['3\t1\tsrc/expire.c', '5\t0\tsrc/new.c', '0\t7\tsrc/gone.c', '1\t1\tnode_modules/pkg/index.js'].join('\n');

  function fakeGit(failOn?: string): { runGit: (args: string[]) => string; calls: string[][] } {
    const calls: string[][] = [];
    const runGit = (args: string[]): string => {
      calls.push(args);
      const joined = args.join(' ');
      if (failOn && joined === failOn) throw new Error(`git ${joined} failed`);
      if (joined === 'diff --name-status HEAD') return NAME_STATUS;
      if (joined === 'diff --numstat HEAD') return NUMSTAT;
      if (joined === 'show HEAD:src/expire.c') return 'old expire';
      if (joined === 'show HEAD:src/gone.c') return 'old gone';
      return '';
    };
    return { runGit, calls };
  }

  const folder = () => folderWith({ 'src/expire.c': 'new expire', 'src/new.c': 'brand new', 'node_modules/pkg/index.js': 'skipped' });

  it('stages intent-to-add, reads both diffs, shows the originals, and resets the index last', () => {
    const { runGit, calls } = fakeGit();
    collectChanges(folder(), sanitizer, runGit);
    expect(calls.map((args) => args.join(' '))).toEqual([
      'add --intent-to-add --all',
      'diff --name-status HEAD',
      'diff --numstat HEAD',
      'show HEAD:src/expire.c',
      'show HEAD:src/gone.c',
      'reset -q',
    ]);
  });

  it('gives each file the status of name-status, the counts of numstat, and the sanitized text', () => {
    const { runGit } = fakeGit();
    const changes = collectChanges(folder(), sanitizer, runGit);
    expect(changes.files.map((file) => file.path)).toEqual(['src/expire.c', 'src/new.c', 'src/gone.c']);
    const [modified, added, deleted] = changes.files;
    expect(modified).toMatchObject({ status: 'M', insertions: 3, deletions: 1, binary: false, original: 'S(old expire)', modified: 'S(new expire)', language: 'c' });
    // An added file has no original to show, and a deleted one has no modified text.
    expect(added).toMatchObject({ status: 'A', insertions: 5, deletions: 0, original: 'S()', modified: 'S(brand new)' });
    expect(deleted).toMatchObject({ status: 'D', insertions: 0, deletions: 7, original: 'S(old gone)', modified: 'S()' });
    expect(changes.totalInsertions).toBe(8);
    expect(changes.totalDeletions).toBe(8);
  });

  it('resets the index even when a step throws', () => {
    const { runGit, calls } = fakeGit('diff --numstat HEAD');
    expect(() => collectChanges(folder(), sanitizer, runGit)).toThrow(/numstat/);
    expect(calls[calls.length - 1]).toEqual(['reset', '-q']);
  });
});
