import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// On macOS a child inherits Crashpad's mach exception port, so anything a shell
// we launch starts writes its crashes into our crash database. Shell launches
// go through resolveShellLaunch (src/main/pty/spawn/shell-launch.ts), which runs
// them through node-pty's spawn-helper there to clear the port.
//
// Two checks keep that true. A literal `shell: true` is the usual way to launch
// a shell with child_process, and it appears in src/main only inside
// shell-launch.ts, so a new one anywhere else is a launch that skipped the
// helper. And the four known launch sites must keep calling resolveShellLaunch,
// so a refactor cannot quietly drop one.
//
// Not covered: a hand-written `[shell, '-c', command]` launch, and `exec()`,
// which also runs a shell. The existing exec() calls launch agent binaries,
// where a missing CLI must still surface as ENOENT, so they stay out on purpose.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = path.join(REPO_ROOT, 'src', 'main');
const SHELL_LAUNCH_MODULE = 'src/main/pty/spawn/shell-launch.ts';
const SHELL_TRUE = /\bshell\s*:\s*true\b/;

const LAUNCH_SITES = [
  'src/main/shell-env.ts',
  'src/main/ipc/handlers/system.ts',
  'src/main/automations/adapters/run-script/index.ts',
  'src/main/git/spawn-with-abort.ts',
];

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

describe('shell launches go through resolveShellLaunch', () => {
  it('has no literal `shell: true` in src/main outside shell-launch.ts', () => {
    const files = collectSourceFiles(SCAN_DIR);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const filePath of files) {
      if (repoRelative(filePath) === SHELL_LAUNCH_MODULE) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (SHELL_TRUE.test(line)) offenders.push(`${repoRelative(filePath)}:${index + 1}`);
      });
    }

    expect(
      offenders,
      'A shell launched with `shell: true` inherits Crashpad\'s exception port on macOS. Build the launch ' +
        'with resolveShellLaunch({ command }) from src/main/pty/spawn/shell-launch.ts and pass its `shell` ' +
        `through instead.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('still finds `shell: true` inside shell-launch.ts, so the scan above is not blind', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, SHELL_LAUNCH_MODULE), 'utf-8');
    const codeLines = source.split('\n').filter((line) => !isCommentLine(line));

    expect(codeLines.some((line) => SHELL_TRUE.test(line))).toBe(true);
  });

  it.each(LAUNCH_SITES)('%s still builds its launch with resolveShellLaunch', (relativePath) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    const codeLines = source.split('\n').filter((line) => !isCommentLine(line));

    expect(codeLines.some((line) => line.includes('resolveShellLaunch('))).toBe(true);
  });
});
