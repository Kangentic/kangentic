/**
 * Unit tests for the Antigravity adapter's file-writing subsystems: the
 * hooks.json event wiring (with its space-free relative-token constraint),
 * the workspace MCP plugin, the trustedWorkspaces trust store, and project
 * relocation. All filesystem writes are sandboxed under os.tmpdir() and the
 * home directory is mocked per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir() to redirect ~/.gemini/antigravity-cli/* to a temp dir.
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

// Point the bridge resolver at a real scratch file so the workspace copy
// (deployWorkspaceBridgeCopy's copyFileSync) has something to copy.
let fakeBridgeSource: string;
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn(() => fakeBridgeSource),
}));

import {
  AntigravityAdapter,
  AntigravityCommandBuilder,
  ensureAntigravityWorkspaceTrust,
  removeAntigravityWorkspaceTrust,
} from '../../src/main/agent/adapters/antigravity';
import {
  buildHooks,
  filterOurHooks,
  removeHooks,
  deployWorkspaceBridgeCopy,
  spaceFreeAgentsToken,
  KANGENTIC_HOOK_NAME,
  AGY_BRIDGE_COPY_NAME,
  type AntigravityHooksFile,
} from '../../src/main/agent/adapters/antigravity/hook-manager';
import { migrateAntigravityProjectData } from '../../src/main/agent/adapters/antigravity/project-relocation';
import {
  ensureLocalGitExcludes,
  resolveGitCommonDir,
} from '../../src/main/agent/adapters/antigravity/git-exclude';
import { normalizeForCompare } from '../../src/main/agent/adapters/antigravity/trust-manager';

let tmpRoot: string;
let workspace: string;

function settingsPath(): string {
  return path.join(tmpHome, '.gemini', 'antigravity-cli', 'settings.json');
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
}

function writeSettings(contents: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(contents));
}

function hooksPath(): string {
  return path.join(workspace, '.agents', 'hooks.json');
}

function readHooks(): AntigravityHooksFile {
  return JSON.parse(fs.readFileSync(hooksPath(), 'utf-8'));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adapter-'));
  tmpHome = path.join(tmpRoot, 'home');
  workspace = path.join(tmpRoot, 'ws');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fakeBridgeSource = path.join(tmpRoot, 'event-bridge.js');
  fs.writeFileSync(fakeBridgeSource, '// bridge stub');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hook building
// ---------------------------------------------------------------------------

describe('buildHooks', () => {
  it('wires PreInvocation, PostToolUse, and Stop but NEVER PreToolUse or PostInvocation', () => {
    const merged = buildHooks('../.kangentic/agy-event-bridge.cjs', '../.kangentic/sessions/s1/events.jsonl', {});
    const entry = merged[KANGENTIC_HOOK_NAME];
    expect(entry.PreInvocation).toHaveLength(1);
    expect(entry.PostToolUse).toHaveLength(1);
    expect(entry.Stop).toHaveLength(1);
    // A `{}` response to PreToolUse is treated as a DENY by agy (observed:
    // the model entered a tool-denied retry loop), so it must never appear.
    expect(entry.PreToolUse).toBeUndefined();
    expect(entry.PostInvocation).toBeUndefined();
  });

  it('emits unquoted, space-free command tokens (agy keeps quote chars literal)', () => {
    const merged = buildHooks('../.kangentic/agy-event-bridge.cjs', '../.kangentic/sessions/s1/events.jsonl', {});
    const entry = merged[KANGENTIC_HOOK_NAME];
    const commands = [
      entry.PreInvocation![0].command,
      entry.PostToolUse![0].hooks[0].command,
      entry.Stop![0].command,
    ];
    for (const command of commands) {
      expect(command).not.toContain('"');
      expect(command.startsWith('node ../.kangentic/agy-event-bridge.cjs ../.kangentic/sessions/s1/events.jsonl ')).toBe(true);
      // Every token must be space-free except the separators themselves.
      for (const token of command.split(' ')) expect(token).not.toContain('"');
    }
  });

  it('maps events to prompt/tool_end/idle and captures hookContext on PreInvocation', () => {
    const merged = buildHooks('../bridge.cjs', '../.kangentic/events.jsonl', {});
    const entry = merged[KANGENTIC_HOOK_NAME];
    expect(entry.PreInvocation![0].command).toContain(' prompt ');
    expect(entry.PreInvocation![0].command).toContain('captureHookContext:');
    expect(entry.PostToolUse![0].matcher).toBe('*');
    expect(entry.PostToolUse![0].hooks[0].command).toContain(' tool_end ');
    expect(entry.PostToolUse![0].hooks[0].command).toContain('extractToolPath:');
    expect(entry.Stop![0].command.trimEnd().endsWith(' idle')).toBe(true);
  });

  it('preserves user hooks and strips a stale Kangentic entry', () => {
    const userHook = { PreInvocation: [{ type: 'command', command: './my-hook.sh' }] };
    const stale = { Stop: [{ type: 'command', command: 'node ../.kangentic/agy-event-bridge.cjs ../.kangentic/old/events.jsonl idle' }] };
    const merged = buildHooks('../bridge.cjs', '../.kangentic/events.jsonl', {
      'my-hook': userHook,
      'kangentic-events': stale,
    });
    expect(merged['my-hook']).toEqual(userHook);
    expect(merged[KANGENTIC_HOOK_NAME].Stop![0].command).toContain('../.kangentic/events.jsonl');
  });
});

describe('filterOurHooks', () => {
  it('drops kangentic-prefixed names and command-fingerprint matches, keeps user hooks', () => {
    const root: AntigravityHooksFile = {
      'kangentic-events': { Stop: [{ type: 'command', command: 'node x idle' }] },
      renamed: { Stop: [{ type: 'command', command: 'node event-bridge.cjs ../.kangentic/e.jsonl idle' }] },
      mine: { Stop: [{ type: 'command', command: './notify.sh' }] },
    };
    const kept = filterOurHooks(root);
    expect(Object.keys(kept)).toEqual(['mine']);
  });
});

describe('spaceFreeAgentsToken', () => {
  it('yields the forward-slash relative token even when cwd itself contains a space', () => {
    // The space lives entirely in the SHARED ancestor (cwd), which the
    // relative diff drops via ".." (never a literal name), so it never
    // reaches the returned token even though the caller's cwd is spacy.
    const spacyCwd = path.join(tmpRoot, 'work space');
    const target = path.join(spacyCwd, '.kangentic', 'x.cjs');
    expect(spaceFreeAgentsToken(spacyCwd, target)).toBe('../.kangentic/x.cjs');
  });

  it.runIf(process.platform === 'win32')(
    'falls back to the space-free absolute path when the target is cross-drive (relative cannot express it at all)',
    () => {
      // On Windows, path.relative across drives returns the ABSOLUTE target
      // path rather than a ".." traversal (verified: path.win32.relative
      // returns "D:\\shared\\x.cjs" for a C:-rooted cwd), so
      // path.isAbsolute(relative) is true regardless of spaces and the
      // function falls through to the space-free-absolute fallback. POSIX
      // has a single root and structurally cannot reach this branch (see
      // the down-portion-is-a-suffix-of-absolute argument in the "both
      // contain spaces" test below), so it is Windows-only.
      expect(spaceFreeAgentsToken('C:\\repo\\ws', 'D:\\shared\\x.cjs')).toBe('D:/shared/x.cjs');
    },
  );

  it('returns null when both the relative and the absolute forms contain a space', () => {
    // The target is a SIBLING of cwd (not nested under it), so its own
    // "other project" segment survives into both the relative diff's
    // down-portion and the raw absolute path - there is no way to have a
    // space in one without the other for a target reached this way.
    const cwd = path.join(tmpRoot, 'ws');
    const target = path.join(tmpRoot, 'other project', 'x.cjs');
    expect(spaceFreeAgentsToken(cwd, target)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command-builder side effects (hooks file, bridge copy, MCP plugin)
// ---------------------------------------------------------------------------

describe('AntigravityCommandBuilder side effects', () => {
  const builder = new AntigravityCommandBuilder();

  function eventsPathFor(cwd: string): string {
    return path.join(cwd, '.kangentic', 'sessions', 's1', 'events.jsonl');
  }

  it('writes hooks.json and deploys the .cjs bridge copy when events are wired', () => {
    builder.buildAntigravityCommand({
      agyPath: '/usr/bin/agy',
      taskId: 't1',
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: eventsPathFor(workspace),
    });
    expect(fs.existsSync(path.join(workspace, '.kangentic', AGY_BRIDGE_COPY_NAME))).toBe(true);
    const entry = readHooks()[KANGENTIC_HOOK_NAME];
    expect(entry.PreInvocation![0].command).toContain('../.kangentic/');
  });

  it('writes the MCP workspace plugin with serverUrl and the token header', () => {
    builder.buildAntigravityCommand({
      agyPath: '/usr/bin/agy',
      taskId: 't1',
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      mcpServerUrl: 'http://127.0.0.1:4123/mcp',
      mcpServerToken: 'token-abc',
    });
    const pluginDir = path.join(workspace, '.agents', 'plugins', 'kangentic');
    expect(JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8'))).toEqual({ name: 'kangentic' });
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf-8'));
    expect(mcpConfig.mcpServers.kangentic).toEqual({
      serverUrl: 'http://127.0.0.1:4123/mcp',
      headers: { 'X-Kangentic-Token': 'token-abc' },
    });
  });

  it('suppresses MCP wiring only on an explicit mcpServerEnabled: false', () => {
    builder.buildAntigravityCommand({
      agyPath: '/usr/bin/agy',
      taskId: 't1',
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      mcpServerEnabled: false,
      mcpServerUrl: 'http://127.0.0.1:4123/mcp',
      mcpServerToken: 'token-abc',
    });
    expect(fs.existsSync(path.join(workspace, '.agents', 'plugins'))).toBe(false);
  });

  it('skips hook wiring (never writes hooks.json) but still returns a usable command when the events path cannot be made space-free', () => {
    // A space anywhere under the events path defeats BOTH the relative and
    // the absolute space-free checks in spaceFreeAgentsToken (the relative
    // diff's down-portion is a verbatim suffix of the absolute path, so a
    // space in one is a space in the other), landing writeMergedHooks on the
    // null-token branch it must tolerate without throwing or writing a
    // broken, space-containing command into hooks.json.
    const spacyEventsPath = path.join(workspace, 'space dir', 'events.jsonl');

    const command = builder.buildAntigravityCommand({
      agyPath: '/usr/bin/agy',
      taskId: 't1',
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: spacyEventsPath,
    });

    expect(fs.existsSync(hooksPath())).toBe(false);
    expect(command).toContain('/usr/bin/agy');
  });
});

describe('deployWorkspaceBridgeCopy failure path', () => {
  it('returns null and does not throw when the bridge source cannot be copied', () => {
    // Reuse the module-level resolveBridgeScript mock (set up in beforeEach
    // for the happy-path copy test above) but point it at a path that does
    // not exist, so fs.copyFileSync throws inside the try/catch.
    fakeBridgeSource = path.join(tmpRoot, 'does-not-exist.js');
    expect(deployWorkspaceBridgeCopy(workspace)).toBeNull();
  });
});

describe('removeHooks', () => {
  it('strips the Kangentic hook and plugin, preserving user hooks', () => {
    fs.mkdirSync(path.join(workspace, '.agents', 'plugins', 'kangentic'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.agents', 'plugins', 'kangentic', 'mcp_config.json'), '{}');
    fs.writeFileSync(hooksPath(), JSON.stringify({
      'kangentic-events': { Stop: [{ type: 'command', command: 'node ../.kangentic/agy-event-bridge.cjs ../.kangentic/e.jsonl idle' }] },
      mine: { Stop: [{ type: 'command', command: './notify.sh' }] },
    }));

    removeHooks(workspace);

    expect(Object.keys(readHooks())).toEqual(['mine']);
    expect(fs.existsSync(path.join(workspace, '.agents', 'plugins', 'kangentic'))).toBe(false);
  });

  it('deletes hooks.json (and a now-empty .agents dir) when only Kangentic hooks existed', () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    fs.writeFileSync(hooksPath(), JSON.stringify({
      'kangentic-events': { Stop: [{ type: 'command', command: 'node ../.kangentic/agy-event-bridge.cjs ../.kangentic/e.jsonl idle' }] },
    }));

    removeHooks(workspace);

    expect(fs.existsSync(hooksPath())).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.agents'))).toBe(false);
  });

  it('adapter-level removeHooks refcounts concurrent holders per directory', () => {
    const adapter = new AntigravityAdapter();
    const spawn = (taskId: string) => adapter.buildCommand({
      agentPath: '/usr/bin/agy',
      taskId,
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: path.join(workspace, '.kangentic', 'sessions', taskId, 'events.jsonl'),
    });
    spawn('task-a');
    spawn('task-b');

    adapter.removeHooks(workspace, 'task-a');
    expect(fs.existsSync(hooksPath())).toBe(true); // task-b still holds

    adapter.removeHooks(workspace, 'task-b');
    expect(fs.existsSync(hooksPath())).toBe(false);
  });

  it('removeHooks with no taskId (project-delete cleanup) strips the hook unconditionally, ignoring an outstanding refcount', () => {
    const adapter = new AntigravityAdapter();
    const spawn = (taskId: string) => adapter.buildCommand({
      agentPath: '/usr/bin/agy',
      taskId,
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: path.join(workspace, '.kangentic', 'sessions', taskId, 'events.jsonl'),
    });
    spawn('task-a');
    spawn('task-b');
    expect(fs.existsSync(hooksPath())).toBe(true);

    // No taskId: the project-delete cleanup path. task-b still holds a
    // refcount, but this call must not consult it.
    adapter.removeHooks(workspace);

    expect(fs.existsSync(hooksPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trust store
// ---------------------------------------------------------------------------

describe('ensureAntigravityWorkspaceTrust', () => {
  it('creates settings.json with the workspace entry when absent', async () => {
    await ensureAntigravityWorkspaceTrust(path.join(tmpRoot, 'proj'));
    expect(readSettings().trustedWorkspaces).toEqual([path.join(tmpRoot, 'proj')]);
  });

  it('preserves unrelated settings keys and existing entries', async () => {
    writeSettings({ enableTelemetry: false, trustedWorkspaces: ['/other/project'] });
    await ensureAntigravityWorkspaceTrust('/repo');
    const settings = readSettings();
    expect(settings.enableTelemetry).toBe(false);
    expect(settings.trustedWorkspaces).toEqual(['/other/project', '/repo']);
  });

  it('writes a per-worktree entry even when the repository root above it is trusted', async () => {
    // agy trust is EXACT-PATH: it prompted for a task worktree whose repo
    // root was already trusted (observed live), so no ancestor skip exists.
    writeSettings({ trustedWorkspaces: ['/repo'] });
    await ensureAntigravityWorkspaceTrust('/repo/.kangentic/worktrees/task-1');
    expect(readSettings().trustedWorkspaces).toEqual(['/repo', '/repo/.kangentic/worktrees/task-1']);
  });

  it('does not duplicate an existing entry across separator styles', async () => {
    writeSettings({ trustedWorkspaces: ['C:\\Users\\dev\\repo'] });
    await ensureAntigravityWorkspaceTrust('C:/Users/dev/repo/');
    expect(readSettings().trustedWorkspaces).toEqual(['C:\\Users\\dev\\repo']);
  });

  it('recovers from a corrupt settings.json (does not throw, starts fresh)', async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), 'not json at all');
    await ensureAntigravityWorkspaceTrust(path.join(tmpRoot, 'proj'));
    expect(readSettings().trustedWorkspaces).toEqual([path.join(tmpRoot, 'proj')]);
  });
});

describe('normalizeForCompare', () => {
  it('folds separators and trailing slashes always', () => {
    const expected = process.platform === 'win32' ? 'c:/users/dev/repo' : 'C:/Users/dev/repo';
    expect(normalizeForCompare('C:\\Users\\dev\\repo\\')).toBe(expected);
    expect(normalizeForCompare('/repo/worktree/')).toBe('/repo/worktree');
  });

  it('folds case only on win32', () => {
    // Windows paths are case-insensitive, POSIX paths are not - folding case
    // unconditionally would treat two genuinely different POSIX directories
    // as the same trust entry. Same win32 gate as the Gemini/Qwen trust
    // managers' normalizeForCompare.
    const upper = normalizeForCompare('/Repo/Worktree');
    const lower = normalizeForCompare('/repo/worktree');
    if (process.platform === 'win32') {
      expect(upper).toBe(lower);
    } else {
      expect(upper).not.toBe(lower);
    }
  });
});

describe('removeAntigravityWorkspaceTrust', () => {
  it('removes only the exact-path entry', async () => {
    writeSettings({ trustedWorkspaces: ['/repo', '/repo/.kangentic/worktrees/t1'] });
    await removeAntigravityWorkspaceTrust('/repo/.kangentic/worktrees/t1');
    expect(readSettings().trustedWorkspaces).toEqual(['/repo']);
  });

  it('is a no-op when the entry is absent or the file is missing', async () => {
    await removeAntigravityWorkspaceTrust('/never-trusted');
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Local git excludes for the runtime files
// ---------------------------------------------------------------------------

describe('git-exclude seeding', () => {
  function excludePath(): string {
    return path.join(workspace, '.git', 'info', 'exclude');
  }

  it('resolves a plain .git directory and a worktree .git file with commondir', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    expect(resolveGitCommonDir(workspace)).toBe(path.join(workspace, '.git'));

    // Worktree layout: <repo>/.git/worktrees/<name> gitdir, commondir -> ../..
    const repo = path.join(tmpRoot, 'repo');
    const worktreeGitDir = path.join(repo, '.git', 'worktrees', 'task-1');
    const worktreeCheckout = path.join(tmpRoot, 'checkout');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeCheckout, { recursive: true });
    fs.writeFileSync(path.join(worktreeCheckout, '.git'), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    expect(resolveGitCommonDir(worktreeCheckout)).toBe(path.join(repo, '.git'));
  });

  it('returns null outside a git checkout (seeding is a silent no-op)', () => {
    expect(resolveGitCommonDir(workspace)).toBeNull();
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/']);
    expect(fs.existsSync(excludePath())).toBe(false);
  });

  it('appends missing patterns under the marker, idempotently', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/', '.kangentic/']);
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/', '.kangentic/']);
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content.split('\n').filter((line) => line === '.kangentic/')).toHaveLength(1);
    expect(content).toContain('# kangentic:');
  });

  it('preserves an existing exclude file and appends with a separating newline', () => {
    fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
    fs.writeFileSync(excludePath(), '*.log'); // no trailing newline
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/']);
    const lines = fs.readFileSync(excludePath(), 'utf-8').split('\n');
    expect(lines[0]).toBe('*.log');
    expect(lines).toContain('.agents/plugins/kangentic/');
  });

  it('builder seeds excludes: hooks.json only when Kangentic creates it', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    const builder = new AntigravityCommandBuilder();
    const build = () => builder.buildAntigravityCommand({
      agyPath: '/usr/bin/agy',
      taskId: 't1',
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: path.join(workspace, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerUrl: 'http://127.0.0.1:4123/mcp',
      mcpServerToken: 'token-abc',
    });

    // First spawn: no user hooks.json -> all three patterns excluded.
    build();
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).toContain('.agents/plugins/kangentic/');
    expect(content).toContain('.agents/hooks.json');
    expect(content).toContain('.kangentic/');
  });

  it('builder never excludes a pre-existing user hooks.json', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.agents'), { recursive: true });
    fs.writeFileSync(hooksPath(), JSON.stringify({
      mine: { Stop: [{ type: 'command', command: './notify.sh' }] },
    }));

    new AntigravityCommandBuilder().buildAntigravityCommand({
      agyPath: '/usr/bin/agy',
      taskId: 't1',
      cwd: workspace,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: path.join(workspace, '.kangentic', 'sessions', 's1', 'events.jsonl'),
    });

    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).not.toContain('.agents/hooks.json');
    expect(content).toContain('.kangentic/');
  });
});

// ---------------------------------------------------------------------------
// Command-injection verifier (adapter-level, through the mocked home dir)
// ---------------------------------------------------------------------------

describe('getSubmissionVerifier (command-injection)', () => {
  const CONVERSATION_ID = '3db42741-6af4-4632-99cf-e5f230f7bc94';
  const STEP_TIME = '2026-08-16T16:09:01Z';

  function writeBrainTranscript(text: string): void {
    const logsDir = path.join(
      tmpHome, '.gemini', 'antigravity-cli', 'brain', CONVERSATION_ID,
      '.system_generated', 'logs',
    );
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: STEP_TIME,
        content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
      }) + '\n',
    );
  }

  it('confirms a submitted turn recorded in the brain-dir transcript', async () => {
    writeBrainTranscript('run the full test suite');
    const adapter = new AntigravityAdapter();
    const verifier = adapter.getSubmissionVerifier('command-injection')!;

    const sentAt = Date.parse(STEP_TIME);
    await expect(verifier({
      type: 'command-injection', text: 'run the full test suite',
      agentSessionId: CONVERSATION_ID, cwd: workspace, sentAt,
    })).resolves.toBe(true);
    await expect(verifier({
      type: 'command-injection', text: 'some other command',
      agentSessionId: CONVERSATION_ID, cwd: workspace, sentAt,
    })).resolves.toBe(false);
  });

  it('reports false without a captured conversation id or for the paste context', async () => {
    const adapter = new AntigravityAdapter();
    const verifier = adapter.getSubmissionVerifier('command-injection')!;
    await expect(verifier({ type: 'command-injection', text: 'x' })).resolves.toBe(false);
    expect(adapter.getSubmissionVerifier('paste')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Project relocation
// ---------------------------------------------------------------------------

describe('migrateAntigravityProjectData', () => {
  it('re-keys the trust entry and the last_conversations mapping', async () => {
    writeSettings({ trustedWorkspaces: ['/old/repo', '/other'] });
    const cachePath = path.join(tmpHome, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ '/old/repo': 'conv-uuid-1', '/other': 'conv-uuid-2' }));

    await migrateAntigravityProjectData('/old/repo', '/new/repo');

    expect(readSettings().trustedWorkspaces).toEqual(['/other', '/new/repo']);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache).toEqual({ '/other': 'conv-uuid-2', '/new/repo': 'conv-uuid-1' });
  });

  it('is a no-op when neither file mentions the old path', async () => {
    writeSettings({ trustedWorkspaces: ['/other'] });
    await migrateAntigravityProjectData('/old/repo', '/new/repo');
    expect(readSettings().trustedWorkspaces).toEqual(['/other']);
  });
});
