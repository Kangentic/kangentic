import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { buildHooks, removeHooks } from '../../src/main/agent/adapters/opencode';

let projectDir: string;

function pluginPath(): string {
  return path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.mjs');
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-hookman-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('opencode-hook-manager', () => {
  describe('buildHooks', () => {
    it('copies the kangentic activity plugin into .opencode/plugins/', () => {
      buildHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(true);
    });

    it('plugin file starts with the kangentic-activity sentinel', () => {
      buildHooks(projectDir);

      const contents = fs.readFileSync(pluginPath(), 'utf-8');
      const firstLine = contents.split('\n', 1)[0];
      expect(firstLine).toContain('kangentic-activity');
    });

    it('plugin source matches the resolved source file byte-for-byte', () => {
      buildHooks(projectDir);

      const sourceFile = path.join(
        process.cwd(),
        'src',
        'main',
        'agent',
        'adapters',
        'opencode',
        'plugin',
        'kangentic-activity.mjs',
      );
      const sourceBytes = fs.readFileSync(sourceFile);
      const installedBytes = fs.readFileSync(pluginPath());
      expect(installedBytes.equals(sourceBytes)).toBe(true);
    });

    it('is idempotent on repeated calls', () => {
      buildHooks(projectDir);
      const firstMtime = fs.statSync(pluginPath()).mtimeMs;

      buildHooks(projectDir);
      const secondMtime = fs.statSync(pluginPath()).mtimeMs;

      // The skip-when-identical guard means the file should not be
      // overwritten on a no-op build.
      expect(secondMtime).toBe(firstMtime);
    });

    it('overwrites a stale plugin file with different contents', () => {
      const targetDir = path.dirname(pluginPath());
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(pluginPath(), '// kangentic-activity\n// outdated stub\n');

      buildHooks(projectDir);

      const contents = fs.readFileSync(pluginPath(), 'utf-8');
      expect(contents).not.toContain('outdated stub');
      expect(contents).toContain('export const KangenticActivity');
    });
  });

  describe('removeHooks', () => {
    it('removes the kangentic plugin file', () => {
      buildHooks(projectDir);
      expect(fs.existsSync(pluginPath())).toBe(true);

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(false);
    });

    it('cleans up empty .opencode/plugins/ and .opencode/ directories', () => {
      buildHooks(projectDir);

      removeHooks(projectDir);

      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, '.opencode'))).toBe(false);
    });

    it('preserves user-authored plugins in the same directory', () => {
      buildHooks(projectDir);
      const userPluginPath = path.join(
        projectDir,
        '.opencode',
        'plugins',
        'user-plugin.mjs',
      );
      fs.writeFileSync(userPluginPath, '// user plugin\nexport default {};\n');

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(false);
      expect(fs.existsSync(userPluginPath)).toBe(true);
      // Directory must remain because it still contains the user plugin.
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins'))).toBe(true);
    });

    it('does not touch a file at our path that lacks the sentinel', () => {
      const targetDir = path.dirname(pluginPath());
      fs.mkdirSync(targetDir, { recursive: true });
      const foreignContents = '// not ours\nexport default {};\n';
      fs.writeFileSync(pluginPath(), foreignContents);

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(true);
      expect(fs.readFileSync(pluginPath(), 'utf-8')).toBe(foreignContents);
    });

    it('handles missing project gracefully', () => {
      expect(() => removeHooks(projectDir)).not.toThrow();
    });
  });

  describe('buildHooks git-exclude behavior', () => {
    const PLUGIN_EXCLUDE_PATTERN = '.opencode/plugins/kangentic-activity.mjs';

    function excludePath(): string {
      return path.join(projectDir, '.git', 'info', 'exclude');
    }

    function readExclude(): string {
      // `git init` may or may not seed a template info/exclude, so a missing
      // file reads as empty rather than failing the assertion.
      return fs.existsSync(excludePath()) ? fs.readFileSync(excludePath(), 'utf-8') : '';
    }

    function initGitRepo(): void {
      execSync(`git -C "${projectDir}" init -b main`, {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    }

    it('adds the plugin entry to .git/info/exclude after a successful install', () => {
      initGitRepo();
      buildHooks(projectDir);

      expect(readExclude()).toContain(PLUGIN_EXCLUDE_PATTERN);
    });

    it('never touches the tracked .gitignore', () => {
      // The pre-exclude implementation appended to the project's .gitignore,
      // dirtying a TRACKED file in the user's checkout. The exclude file is
      // local to .git/ and never committed.
      initGitRepo();
      buildHooks(projectDir);

      expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(false);
    });

    it('is idempotent on repeated calls (no duplicate entry)', () => {
      initGitRepo();
      buildHooks(projectDir);
      buildHooks(projectDir);
      buildHooks(projectDir);

      const occurrences = readExclude()
        .split('\n')
        .filter((line) => line.trim() === PLUGIN_EXCLUDE_PATTERN);
      expect(occurrences).toHaveLength(1);
    });

    it('writes no exclude when the directory is not a git repo', () => {
      // projectDir has no .git directory.
      buildHooks(projectDir);

      // The plugin must still install...
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.mjs'))).toBe(true);
      // ...but no exclude file must be created.
      expect(fs.existsSync(excludePath())).toBe(false);
    });

    it('preserves pre-existing content in the exclude file', () => {
      initGitRepo();
      fs.mkdirSync(path.dirname(excludePath()), { recursive: true });
      fs.writeFileSync(excludePath(), 'node_modules/\n*.log\n');

      buildHooks(projectDir);

      const content = readExclude();
      expect(content).toContain('node_modules/');
      expect(content).toContain('*.log');
      expect(content).toContain(PLUGIN_EXCLUDE_PATTERN);
    });

    it('does not write an exclude entry when copyFileSync fails', () => {
      // This test protects the ordering invariant that is the heart of the
      // "stop appending opencode" fix: the exclude is only seeded when
      // fs.existsSync(destinationFile) is true AFTER the copy attempt. If
      // the copy fails the file does not exist, existsSync returns false,
      // and the exclude entry must never be written - otherwise we would
      // add an entry pointing to a non-existent file.
      initGitRepo();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const copyFileSpy = vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied, open ...');
      });

      buildHooks(projectDir);

      // Assert before restoring spies: mockRestore() resets call history.
      // The plugin file must not exist because the copy threw.
      expect(fs.existsSync(pluginPath())).toBe(false);
      // The exclude entry must not have been written.
      expect(readExclude()).not.toContain(PLUGIN_EXCLUDE_PATTERN);
      // The copy failure must have been logged via console.error.
      expect(errorSpy).toHaveBeenCalledOnce();

      copyFileSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
