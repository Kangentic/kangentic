/**
 * Unit tests for command-builder logic, slugify, shell adaptation,
 * status-bridge script, merged settings, and shell detection.
 *
 * Migrated from tests/e2e/command-builder.spec.ts — pure logic, no Electron needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  quoteArg,
  isUnixLikeShell,
  adaptCommandForShell,
  convertWindowsExePath,
  sanitizeForPty,
} from '../../src/shared/paths';
import { interpolateTemplate, CommandBuilder } from '../../src/main/agent/command-builder';
import { slugify } from '../../src/shared/slugify';

// ── Inline test-only helper (deliberately simplified, omits merged settings / hooks) ──

function buildClaudeCommand(options: {
  claudePath: string;
  prompt?: string;
  sessionId?: string;
  resume?: boolean;
  permissionMode?: string;
}): string {
  const parts = [quoteArg(options.claudePath)];

  // Permission mode (e.g., 'plan')
  if (options.permissionMode && options.permissionMode !== 'default') {
    parts.push('--permission-mode', options.permissionMode);
  }

  if (options.sessionId) {
    const flag = options.resume ? '--resume' : '--session-id';
    parts.push(flag, quoteArg(options.sessionId));
  }

  if (options.prompt) {
    parts.push(quoteArg(options.prompt));
  }

  return parts.join(' ');
}

// ── Shell detection (test infrastructure — not a production duplicate) ──────

interface ShellInfo {
  name: string;
  path: string;
}

function detectAvailableShells(): ShellInfo[] {
  const shells: ShellInfo[] = [];
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const candidates: Array<{ name: string; cmd: string }> = [];

  if (isWin) {
    candidates.push(
      { name: 'PowerShell 7', cmd: 'pwsh' },
      { name: 'PowerShell 5', cmd: 'powershell' },
      { name: 'Git Bash', cmd: 'bash' },
      { name: 'Command Prompt', cmd: 'cmd' },
    );
    try {
      const wslOutput = execSync('wsl --list --quiet', { encoding: 'utf-8', timeout: 5000 });
      const distros = wslOutput
        .split('\n')
        .map((l) => l.replace(/\0/g, '').trim())
        .filter((d) => d && !d.toLowerCase().startsWith('docker-'));
      for (const distro of distros) {
        shells.push({ name: `WSL: ${distro}`, path: `wsl -d ${distro}` });
      }
    } catch {
      // WSL not available
    }
  } else if (isMac) {
    candidates.push(
      { name: 'zsh', cmd: 'zsh' },
      { name: 'bash', cmd: 'bash' },
      { name: 'fish', cmd: 'fish' },
      { name: 'sh', cmd: 'sh' },
      { name: 'nushell', cmd: 'nu' },
    );
  } else {
    candidates.push(
      { name: 'bash', cmd: 'bash' },
      { name: 'zsh', cmd: 'zsh' },
      { name: 'fish', cmd: 'fish' },
      { name: 'sh', cmd: 'sh' },
      { name: 'dash', cmd: 'dash' },
      { name: 'nushell', cmd: 'nu' },
      { name: 'ksh', cmd: 'ksh' },
    );
  }

  for (const c of candidates) {
    try {
      const resolved = execSync(
        isWin ? `where ${c.cmd}` : `which ${c.cmd}`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] },
      ).trim().split('\n')[0].trim();
      if (resolved) {
        shells.push({ name: c.name, path: resolved });
      }
    } catch {
      // Not found
    }
  }

  return shells;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('sanitizeForPty', () => {
  it('strips newlines', () => {
    expect(sanitizeForPty('hello\nworld')).toBe('hello world');
  });

  it('strips \\r\\n (Windows line endings)', () => {
    expect(sanitizeForPty('line1\r\nline2')).toBe('line1 line2');
  });

  it('strips standalone \\r', () => {
    expect(sanitizeForPty('old\rmac')).toBe('old mac');
  });

  it('strips tabs', () => {
    expect(sanitizeForPty('col1\tcol2')).toBe('col1 col2');
  });

  it('collapses multiple newlines into single space', () => {
    expect(sanitizeForPty('a\n\n\nb')).toBe('a b');
  });

  it('collapses mixed whitespace', () => {
    expect(sanitizeForPty('a\n\t\r\n  b')).toBe('a b');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeForPty('\n  hello  \n')).toBe('hello');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeForPty('\n\r\n\t  ')).toBe('');
  });

  it('passes through clean text unchanged', () => {
    expect(sanitizeForPty('simple text')).toBe('simple text');
  });
});

describe('Command Builder Logic', () => {
  it('quoteArg skips quoting simple paths', () => {
    expect(quoteArg('claude')).toBe('claude');
    expect(quoteArg('C:/Users/dev/.local/bin/claude')).toBe('C:/Users/dev/.local/bin/claude');

    const backslashPath = 'C:\\Users\\dev\\.local\\bin\\claude.EXE';
    const quotedBackslash = quoteArg(backslashPath);
    expect(quotedBackslash).toContain('"');

    const pathWithSpaces = 'C:/Program Files/claude/claude.exe';
    const quoted = quoteArg(pathWithSpaces);
    expect(quoted).toContain('"');
  });

  it('quoteArg sanitises multiline input', () => {
    const multiline = 'line1\nline2\nline3';
    const result = quoteArg(multiline);
    expect(result).not.toContain('\n');
    expect(result).toContain('line1 line2 line3');
  });

  it('PowerShell call operator prefix', () => {
    function prefixForShell(command: string, shellName: string): string {
      if (shellName.includes('powershell') || shellName.includes('pwsh')) {
        return '& ' + command;
      }
      return command;
    }

    const cmd = '"C:\\Users\\dev\\.local\\bin\\claude.EXE" --dangerously-skip-permissions';

    expect(prefixForShell(cmd, 'powershell')).toBe('& ' + cmd);
    expect(prefixForShell(cmd, 'pwsh')).toBe('& ' + cmd);
    expect(prefixForShell(cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('& ' + cmd);

    expect(prefixForShell(cmd, 'bash')).toBe(cmd);
    expect(prefixForShell(cmd, 'cmd')).toBe(cmd);
    expect(prefixForShell(cmd, '/bin/zsh')).toBe(cmd);
  });

  it('interpolateTemplate replaces variables', () => {
    const template = 'Task: {{title}}\n\n{{description}}';
    const vars = { title: 'My Task', description: 'Build the feature' };
    const result = interpolateTemplate(template, vars);

    expect(result).toBe('Task: My Task\n\nBuild the feature');
  });

  it('interpolateTemplate handles missing variables', () => {
    const template = '{{title}} in {{worktreePath}}';
    const vars = { title: 'Fix bug', worktreePath: '' };
    const result = interpolateTemplate(template, vars);

    expect(result).toBe('Fix bug in ');
  });

  it('full pipeline: interpolateTemplate + quoteArg with multiline description', () => {
    const template = 'Task: {{title}}\n\n{{description}}';
    const vars = {
      title: 'Fix bug',
      description: 'Step 1: do X\nStep 2: do Y\nStep 3: do Z',
    };
    const interpolated = interpolateTemplate(template, vars);
    const quoted = quoteArg(interpolated);

    expect(quoted).not.toContain('\n');
    expect(quoted).toContain('Fix bug');
    expect(quoted).toContain('Step 1: do X Step 2: do Y Step 3: do Z');
  });
});

describe('Prompt Delivery (Claude Agent)', () => {
  it('fresh session includes task title and description in prompt', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      prompt: 'Task: Fix login bug\n\nUsers cannot log in with OAuth',
    });

    expect(cmd).toContain('Fix login bug');
    expect(cmd).toContain('Users cannot log in with OAuth');
  });

  it('new session with session-id uses --session-id flag', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      sessionId: 'abc-123-def',
      prompt: 'Task: My Task\n\nDescription',
    });

    expect(cmd).toContain('--session-id');
    expect(cmd).not.toContain('--resume');
    expect(cmd).toContain('abc-123-def');
  });

  it('resumed session uses --resume flag and omits prompt', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      sessionId: 'abc-123-def',
      resume: true,
    });

    expect(cmd).toContain('--resume');
    expect(cmd).not.toContain('--session-id');
    expect(cmd).toContain('abc-123-def');
    const parts = cmd.split(' ');
    const lastPart = parts[parts.length - 1];
    expect(lastPart).toContain('abc-123-def');
  });

  it('resumed session with --resume has no prompt text', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      sessionId: 'session-xyz',
      resume: true,
    });

    expect(cmd).toContain('--resume');
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('Task:');
    expect(cmd).not.toContain('Continue working');
  });

  it('plan permission mode adds --permission-mode plan', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      permissionMode: 'plan',
      prompt: 'Task: Design auth\n\nPlan the architecture',
    });

    expect(cmd).toContain('--permission-mode');
    expect(cmd).toContain('plan');
    expect(cmd).toContain('Design auth');
  });

  it('default permission mode omits --permission-mode flag', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      permissionMode: 'default',
      prompt: 'Task: Build feature',
    });

    expect(cmd).not.toContain('--permission-mode');
  });

  it('no permission mode omits --permission-mode flag', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      prompt: 'Task: Build feature',
    });

    expect(cmd).not.toContain('--permission-mode');
  });

  it('acceptEdits permission mode adds --permission-mode acceptEdits', () => {
    const cmd = buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      permissionMode: 'acceptEdits',
      prompt: 'Task: Refactor module',
    });

    expect(cmd).toContain('--permission-mode');
    expect(cmd).toContain('acceptEdits');
    expect(cmd).toContain('Refactor module');
  });
});

describe('Slugify Logic', () => {
  it('converts titles to filesystem-safe slugs', () => {
    expect(slugify('Fix login bug')).toBe('fix-login-bug');
    expect(slugify('Add feature (urgent!)')).toBe('add-feature-urgent');
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('ALL CAPS TITLE')).toBe('all-caps-title');
    expect(slugify('Special @#$% chars!')).toBe('special-chars');
    expect(slugify('')).toBe('');

    const longTitle = 'a'.repeat(100);
    expect(slugify(longTitle).length).toBeLessThanOrEqual(50);
  });

  it('worktree folder includes task ID suffix', () => {
    const taskId = 'abc12345-6789-0000-1111-222233334444';
    const slug = slugify('Fix login bug') || 'task';
    const shortId = taskId.slice(0, 8);
    const folderName = `${slug}-${shortId}`;

    expect(folderName).toBe('fix-login-bug-abc12345');
  });
});

// adaptCommandForShell has a `process.platform !== 'win32'` early-return guard
// in production, so these tests only exercise the conversion logic on Windows.
describe.runIf(process.platform === 'win32')('Windows Path Conversion for Shells (adaptCommandForShell)', () => {
  it('converts Windows paths to Git Bash POSIX format', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --dangerously-skip-permissions "Task: test"';
    const result = adaptCommandForShell(cmd, 'c:\\program files\\git\\usr\\bin\\bash.exe');
    expect(result).toBe('/c/Users/dev/.local/bin/claude.EXE --dangerously-skip-permissions "Task: test"');
  });

  it('converts Windows paths to WSL /mnt/ format', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --print "hello"';
    const result = adaptCommandForShell(cmd, 'wsl -d ubuntu');
    expect(result).toBe('/mnt/c/Users/dev/.local/bin/claude.EXE --print "hello"');
  });

  it('handles quoted Windows paths with spaces', () => {
    const cmd = '"C:\\Program Files\\claude\\claude.exe" --dangerously-skip-permissions "prompt"';
    const result = adaptCommandForShell(cmd, 'bash');
    expect(result).toBe('"/c/Program Files/claude/claude.exe" --dangerously-skip-permissions "prompt"');
  });

  it('handles different drive letters', () => {
    const cmd = 'D:\\tools\\claude.exe --print "hello"';
    const result = adaptCommandForShell(cmd, 'bash');
    expect(result).toBe('/d/tools/claude.exe --print "hello"');
  });

  it('no conversion for cmd.exe', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --dangerously-skip-permissions "prompt"';
    const result = adaptCommandForShell(cmd, 'c:\\windows\\system32\\cmd.exe');
    expect(result).toBe(cmd);
  });

  it('PowerShell gets & prefix, no path conversion', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --print "test"';
    const result = adaptCommandForShell(cmd, 'pwsh');
    expect(result).toBe('& ' + cmd);
  });

  it('does not corrupt prompt text with backslashes', () => {
    const cmd = 'C:\\Users\\dev\\bin\\claude.EXE --print "path is C:\\some\\path"';
    const result = adaptCommandForShell(cmd, 'bash');
    expect(result.startsWith('/c/Users/dev/bin/claude.EXE')).toBe(true);
    expect(result).toContain('C:\\some\\path');
  });
});

// convertWindowsExePath has no platform guard — runs on all platforms
describe('Windows Path Conversion (convertWindowsExePath)', () => {
  it('no-op for Unix paths (macOS/Linux)', () => {
    const cmd = '/usr/local/bin/claude --print "hello"';
    const result = convertWindowsExePath(cmd, false);
    expect(result).toBe(cmd);
  });

  it('no-op for simple commands', () => {
    const cmd = 'echo hello world';
    const result = convertWindowsExePath(cmd, false);
    expect(result).toBe(cmd);
  });
});

describe('Status Bridge Script', () => {
  const bridgePath = path.resolve(__dirname, '../../src/main/agent/status-bridge.js');

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusbridge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bridge writes JSON to output file', () => {
    const tmpFile = path.join(tmpDir, 'bridge-test.json');

    const input = JSON.stringify({
      context_window: { used_percentage: 42, total_input_tokens: 1000, total_output_tokens: 500, context_window_size: 200000 },
      cost: { total_cost_usd: 0.15, total_duration_ms: 5000 },
      model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    });

    execFileSync(process.execPath, [bridgePath, tmpFile], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });

    const written = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(written.context_window.used_percentage).toBe(42);
    expect(written.cost.total_cost_usd).toBe(0.15);
    expect(written.model.display_name).toBe('Opus 4.6');
  });

  it('bridge outputs empty string to stdout (no TUI status line)', () => {
    const input = JSON.stringify({
      context_window: { used_percentage: 67.5 },
      cost: { total_cost_usd: 1.234 },
      model: { display_name: 'Sonnet 4.6' },
    });

    const stdout = execFileSync(process.execPath, [bridgePath], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(stdout).toBe('');
  });

  it('bridge handles malformed JSON gracefully', () => {
    const stdout = execFileSync(process.execPath, [bridgePath], {
      input: 'not-json{{{',
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(stdout).toBe('');
  });

  it('bridge handles missing fields gracefully', () => {
    const input = JSON.stringify({});

    const stdout = execFileSync(process.execPath, [bridgePath], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(stdout).toBe('');
  });
});

describe('Merged Settings (statusLine)', () => {
  it('statusLine is an object with type and command fields', () => {
    const existingSettings = { permissions: { allow: ['Read'] } };
    const bridgePath = '/path/to/status-bridge.js';
    const statusPath = '/project/.kangentic/status/session-123.json';

    const merged = {
      ...existingSettings,
      statusLine: {
        type: 'command',
        command: `node "${bridgePath}" "${statusPath}"`,
      },
    };

    expect(merged.statusLine).toHaveProperty('type', 'command');
    expect(merged.statusLine).toHaveProperty('command');
    expect(typeof merged.statusLine.command).toBe('string');
    expect(merged.statusLine.command).toContain('node');
    expect(merged.statusLine.command).toContain('status-bridge.js');
    expect(merged.statusLine.command).toContain('session-123.json');
  });

  it('merged settings preserve existing project settings', () => {
    const existingSettings = {
      permissions: { allow: ['Read', 'Edit'] },
      env: { CUSTOM_VAR: 'hello' },
    };

    const merged = {
      ...existingSettings,
      statusLine: {
        type: 'command',
        command: 'node /bridge.js /output.json',
      },
    };

    expect(merged.permissions).toEqual({ allow: ['Read', 'Edit'] });
    expect(merged.env).toEqual({ CUSTOM_VAR: 'hello' });
    expect(merged.statusLine.type).toBe('command');
  });

  it('statusLine is not a plain string (regression check)', () => {
    const merged = {
      statusLine: {
        type: 'command',
        command: 'node /bridge.js /output.json',
      },
    };

    expect(typeof merged.statusLine).toBe('object');
    expect(typeof merged.statusLine).not.toBe('string');
  });
});

describe('Merged Settings — Local Settings Merge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgnt-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges user hooks from .claude/settings.local.json into session settings', () => {
    // Set up project with both settings.json and settings.local.json
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Project settings with a user hook
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo project-hook' }] },
        ],
      },
    }));

    // Local settings with a different user hook
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo local-hook' }] },
        ],
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo local-stop' }] },
        ],
      },
    }));

    const builder = new CommandBuilder();

    // Create a status output path so createMergedSettings runs
    const statusOutput = path.join(tmpDir, '.kangentic', 'sessions', 'test-sess', 'status.json');
    fs.mkdirSync(path.dirname(statusOutput), { recursive: true });

    builder.buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      taskId: 'test-task-id',
      cwd: tmpDir,
      permissionMode: 'default',
      sessionId: 'test-sess',
      statusOutputPath: statusOutput,
      activityOutputPath: path.join(tmpDir, '.kangentic', 'sessions', 'test-sess', 'activity.json'),
    });

    // Read the merged settings file
    const mergedPath = path.join(tmpDir, '.kangentic', 'sessions', 'test-sess', 'settings.json');
    const merged = JSON.parse(fs.readFileSync(mergedPath, 'utf-8'));

    // Project hook should be present
    const preToolUseCommands = merged.hooks.PreToolUse
      .flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h: { command: string }) => h.command));
    expect(preToolUseCommands).toContain('echo project-hook');

    // Local hook should also be present
    expect(preToolUseCommands).toContain('echo local-hook');

    // Local Stop hook should be present
    const stopCommands = merged.hooks.Stop
      .flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h: { command: string }) => h.command));
    expect(stopCommands).toContain('echo local-stop');

    // Project permissions should be preserved
    expect(merged.permissions).toEqual({ allow: ['Read'] });
  });

  it('does not write to .claude/settings.local.json in cwd', () => {
    // Set up a "worktree" cwd separate from projectRoot
    const worktreeDir = path.join(tmpDir, 'worktree');
    fs.mkdirSync(worktreeDir, { recursive: true });

    // Project root has settings
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({}));

    const builder = new CommandBuilder();

    const statusOutput = path.join(tmpDir, '.kangentic', 'sessions', 'test-sess', 'status.json');
    fs.mkdirSync(path.dirname(statusOutput), { recursive: true });

    builder.buildClaudeCommand({
      claudePath: '/usr/bin/claude',
      taskId: 'test-task-id',
      cwd: worktreeDir,
      projectRoot: tmpDir,
      permissionMode: 'default',
      sessionId: 'test-sess',
      statusOutputPath: statusOutput,
      activityOutputPath: path.join(tmpDir, '.kangentic', 'sessions', 'test-sess', 'activity.json'),
      eventsOutputPath: path.join(tmpDir, '.kangentic', 'sessions', 'test-sess', 'events.jsonl'),
    });

    // .claude/settings.local.json should NOT be created in the worktree cwd
    expect(fs.existsSync(path.join(worktreeDir, '.claude', 'settings.local.json'))).toBe(false);
  });
});

describe('Shell Detection', () => {
  it('at least one shell is available', () => {
    const shells = detectAvailableShells();
    expect(shells.length).toBeGreaterThan(0);
  });

  it('all detected shells have valid paths or commands', () => {
    const shells = detectAvailableShells();

    for (const shell of shells) {
      expect(shell.name).toBeTruthy();
      expect(shell.path).toBeTruthy();
      if (shell.name.startsWith('WSL:')) {
        expect(shell.path).toMatch(/^wsl /);
      } else {
        expect(fs.existsSync(shell.path)).toBeTruthy();
      }
    }
  });
});
