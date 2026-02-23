/**
 * Unit-style tests for CommandBuilder logic.
 * These don't need the Electron app — they test the command construction.
 * We run them via Playwright's test runner for consistency.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { detectAvailableShells } from './helpers';

// We can't import TS source directly, so we test via evaluating in the
// Electron main process. For pure logic tests, we inline the logic.

test.describe('Command Builder Logic', () => {
  test('quoteArg skips quoting simple paths', () => {
    // Simulate the quoteArg logic (backslashes are NOT considered simple
    // because they're escape characters in Unix-like shells like Git Bash)
    function quoteArg(arg: string): string {
      if (/^[a-zA-Z0-9_.\/:-]+$/.test(arg)) {
        return arg;
      }
      if (process.platform === 'win32') {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return `'${arg.replace(/'/g, "'\\''")}'`;
    }

    // Simple command name — no quotes needed
    expect(quoteArg('claude')).toBe('claude');

    // Forward-slash path without spaces — no quotes needed
    expect(quoteArg('C:/Users/dev/.local/bin/claude')).toBe('C:/Users/dev/.local/bin/claude');

    // Backslash path — needs quoting (escape chars in Unix shells)
    const backslashPath = 'C:\\Users\\dev\\.local\\bin\\claude.EXE';
    const quotedBackslash = quoteArg(backslashPath);
    expect(quotedBackslash).toContain('"'); // Should be quoted

    // Path with spaces — needs quotes
    const pathWithSpaces = 'C:/Program Files/claude/claude.exe';
    const quoted = quoteArg(pathWithSpaces);
    expect(quoted).toContain('"'); // Should be quoted
  });

  test('PowerShell call operator prefix', () => {
    function prefixForShell(command: string, shellName: string): string {
      if (shellName.includes('powershell') || shellName.includes('pwsh')) {
        return '& ' + command;
      }
      return command;
    }

    const cmd = '"C:\\Users\\dev\\.local\\bin\\claude.EXE" --dangerously-skip-permissions';

    // PowerShell should get & prefix
    expect(prefixForShell(cmd, 'powershell')).toBe('& ' + cmd);
    expect(prefixForShell(cmd, 'pwsh')).toBe('& ' + cmd);
    expect(prefixForShell(cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('& ' + cmd);

    // Other shells should not
    expect(prefixForShell(cmd, 'bash')).toBe(cmd);
    expect(prefixForShell(cmd, 'cmd')).toBe(cmd);
    expect(prefixForShell(cmd, '/bin/zsh')).toBe(cmd);
  });

  test('interpolateTemplate replaces variables', () => {
    function interpolateTemplate(template: string, vars: Record<string, string>): string {
      let result = template;
      for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
      return result;
    }

    const template = 'Task: {{title}}\n\n{{description}}';
    const vars = { title: 'My Task', description: 'Build the feature' };
    const result = interpolateTemplate(template, vars);

    expect(result).toBe('Task: My Task\n\nBuild the feature');
  });

  test('interpolateTemplate handles missing variables', () => {
    function interpolateTemplate(template: string, vars: Record<string, string>): string {
      let result = template;
      for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
      return result;
    }

    const template = '{{title}} in {{worktreePath}}';
    const vars = { title: 'Fix bug', worktreePath: '' };
    const result = interpolateTemplate(template, vars);

    expect(result).toBe('Fix bug in ');
  });
});

test.describe('Slugify Logic', () => {
  test('converts titles to filesystem-safe slugs', () => {
    function slugify(text: string, maxLen = 50): string {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLen)
        .replace(/-+$/, '');
    }

    expect(slugify('Fix login bug')).toBe('fix-login-bug');
    expect(slugify('Add feature (urgent!)')).toBe('add-feature-urgent');
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('ALL CAPS TITLE')).toBe('all-caps-title');
    expect(slugify('Special @#$% chars!')).toBe('special-chars');
    expect(slugify('')).toBe('');

    // Long titles get truncated
    const longTitle = 'a'.repeat(100);
    expect(slugify(longTitle).length).toBeLessThanOrEqual(50);
  });

  test('worktree folder includes task ID suffix', () => {
    function slugify(text: string, maxLen = 50): string {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLen)
        .replace(/-+$/, '');
    }

    const taskId = 'abc12345-6789-0000-1111-222233334444';
    const slug = slugify('Fix login bug') || 'task';
    const shortId = taskId.slice(0, 8);
    const folderName = `${slug}-${shortId}`;

    expect(folderName).toBe('fix-login-bug-abc12345');
  });
});

test.describe('Windows Path Conversion for Shells', () => {
  // Replicate the adaptCommandForShell + convertWindowsExePath logic
  function isUnixLikeShell(shellName: string): boolean {
    return !shellName.includes('cmd');
  }

  function convertWindowsExePath(cmd: string, isWsl: boolean): string {
    const prefix = isWsl ? '/mnt/' : '/';

    if (cmd.startsWith('"')) {
      return cmd.replace(
        /^"([A-Za-z]):((?:\\[^"]+)+)"/,
        (_m, drive: string, rest: string) => {
          const posix = `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`;
          return posix.includes(' ') ? `"${posix}"` : posix;
        },
      );
    }

    return cmd.replace(
      /^([A-Za-z]):((?:\\[^\s]+)+)/,
      (_m, drive: string, rest: string) => {
        return `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`;
      },
    );
  }

  function adaptCommandForShell(cmd: string, shellName: string): string {
    // Simulate Windows platform check
    if (shellName.includes('powershell') || shellName.includes('pwsh')) {
      return '& ' + cmd;
    }
    if (isUnixLikeShell(shellName)) {
      const isWsl = shellName.startsWith('wsl');
      return convertWindowsExePath(cmd, isWsl);
    }
    return cmd;
  }

  test('converts Windows paths to Git Bash POSIX format', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --dangerously-skip-permissions "Task: test"';
    const result = adaptCommandForShell(cmd, 'c:\\program files\\git\\usr\\bin\\bash.exe');
    expect(result).toBe('/c/Users/dev/.local/bin/claude.EXE --dangerously-skip-permissions "Task: test"');
  });

  test('converts Windows paths to WSL /mnt/ format', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --print "hello"';
    const result = adaptCommandForShell(cmd, 'wsl -d ubuntu');
    expect(result).toBe('/mnt/c/Users/dev/.local/bin/claude.EXE --print "hello"');
  });

  test('handles quoted Windows paths with spaces', () => {
    const cmd = '"C:\\Program Files\\claude\\claude.exe" --dangerously-skip-permissions "prompt"';
    const result = adaptCommandForShell(cmd, 'bash');
    expect(result).toBe('"/c/Program Files/claude/claude.exe" --dangerously-skip-permissions "prompt"');
  });

  test('handles different drive letters', () => {
    const cmd = 'D:\\tools\\claude.exe --print "hello"';
    const result = adaptCommandForShell(cmd, 'bash');
    expect(result).toBe('/d/tools/claude.exe --print "hello"');
  });

  test('no conversion for cmd.exe', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --dangerously-skip-permissions "prompt"';
    const result = adaptCommandForShell(cmd, 'c:\\windows\\system32\\cmd.exe');
    expect(result).toBe(cmd);
  });

  test('PowerShell gets & prefix, no path conversion', () => {
    const cmd = 'C:\\Users\\dev\\.local\\bin\\claude.EXE --print "test"';
    const result = adaptCommandForShell(cmd, 'pwsh');
    expect(result).toBe('& ' + cmd);
  });

  test('does not corrupt prompt text with backslashes', () => {
    const cmd = 'C:\\Users\\dev\\bin\\claude.EXE --print "path is C:\\some\\path"';
    const result = adaptCommandForShell(cmd, 'bash');
    // Only the executable path at the start should be converted
    expect(result.startsWith('/c/Users/dev/bin/claude.EXE')).toBe(true);
    expect(result).toContain('C:\\some\\path'); // prompt preserved
  });

  test('no-op for Unix paths (macOS/Linux)', () => {
    const cmd = '/usr/local/bin/claude --print "hello"';
    const result = convertWindowsExePath(cmd, false);
    expect(result).toBe(cmd); // No Windows path to convert
  });

  test('no-op for simple commands', () => {
    const cmd = 'echo hello world';
    const result = convertWindowsExePath(cmd, false);
    expect(result).toBe(cmd);
  });
});

test.describe('Shell Detection', () => {
  test('at least one shell is available', () => {
    const shells = detectAvailableShells();
    expect(shells.length).toBeGreaterThan(0);
    console.log('Available shells:', shells.map((s) => s.name).join(', '));
  });

  test('all detected shells have valid paths or commands', () => {
    const shells = detectAvailableShells();

    for (const shell of shells) {
      expect(shell.name).toBeTruthy();
      expect(shell.path).toBeTruthy();
      // WSL shells are commands ("wsl -d Ubuntu"), not file paths
      if (shell.name.startsWith('WSL:')) {
        expect(shell.path).toMatch(/^wsl /);
      } else {
        expect(fs.existsSync(shell.path)).toBeTruthy();
      }
    }
  });
});
