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
 *
 * parseArgs only resolves strings and never touches the disk, so every path here is a string built
 * under os.tmpdir() and nothing is created.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

interface McpLaunchOptions {
  mcpConfig: string | null;
  settings: string | null;
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
}

const require = createRequire(import.meta.url);
const { parseArgs, buildCommand } = require('../../scripts/capture-agent-scrollback.js') as CaptureScrollbackModule;

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
