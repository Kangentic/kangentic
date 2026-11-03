import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { buildHooks, removeHooks } from '../../src/main/agent/adapters/opencode';

let projectDir: string;

/** The installed copy: OpenCode 1.18.31 loads only `{plugin,plugins}/*.{ts,js}`. */
function pluginPath(): string {
  return path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.js');
}

/** The `.mjs` copy earlier builds installed, which OpenCode never loaded. */
function legacyPluginPath(): string {
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

    it('installs under a name OpenCode loads, and removes the dead .mjs copy an earlier build left', () => {
      fs.mkdirSync(path.dirname(legacyPluginPath()), { recursive: true });
      fs.writeFileSync(legacyPluginPath(), '// kangentic-activity\n// earlier build\n');

      buildHooks(projectDir);

      expect(path.basename(pluginPath())).toMatch(/\.(ts|js)$/);
      expect(fs.existsSync(pluginPath())).toBe(true);
      expect(fs.existsSync(legacyPluginPath())).toBe(false);
    });

    it('leaves a user-authored file at the legacy name alone', () => {
      fs.mkdirSync(path.dirname(legacyPluginPath()), { recursive: true });
      fs.writeFileSync(legacyPluginPath(), '// the user\'s own plugin\nexport const Mine = async () => ({});\n');

      buildHooks(projectDir);

      expect(fs.existsSync(legacyPluginPath())).toBe(true);
    });

    it('survives a legacy path it cannot read, still installs the plugin, and leaves that path alone', () => {
      // A directory at the legacy name makes existsSync true while readFileSync
      // throws EISDIR, on every platform. A throw that
      // escaped here would abort the spawn before the current plugin was copied.
      fs.mkdirSync(legacyPluginPath(), { recursive: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        expect(() => buildHooks(projectDir)).not.toThrow();

        expect(fs.existsSync(pluginPath())).toBe(true);
        expect(fs.statSync(legacyPluginPath()).isDirectory()).toBe(true);
        // The failure is logged, not swallowed silently.
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain(legacyPluginPath());
      } finally {
        errorSpy.mockRestore();
      }
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

    it('also removes a legacy .mjs copy, and cleans up the folders it leaves empty', () => {
      fs.mkdirSync(path.dirname(legacyPluginPath()), { recursive: true });
      fs.writeFileSync(legacyPluginPath(), '// kangentic-activity\n// earlier build\n');

      removeHooks(projectDir);

      expect(fs.existsSync(legacyPluginPath())).toBe(false);
      expect(fs.existsSync(path.join(projectDir, '.opencode'))).toBe(false);
    });

    it('removes both the current plugin and a legacy .mjs left beside it, then the empty folders', () => {
      // The real upgrade state: buildHooks installed the current .js, and an
      // earlier build's sentinel-carrying .mjs is still in the same folder.
      buildHooks(projectDir);
      fs.writeFileSync(legacyPluginPath(), '// kangentic-activity\n// earlier build\n');
      expect(fs.existsSync(pluginPath())).toBe(true);
      expect(fs.existsSync(legacyPluginPath())).toBe(true);

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(false);
      expect(fs.existsSync(legacyPluginPath())).toBe(false);
      expect(fs.existsSync(path.join(projectDir, '.opencode'))).toBe(false);
    });

    it('does not throw on a plugin path it cannot read, and leaves that path alone', () => {
      // A directory at the current plugin name makes existsSync true while
      // readFileSync throws EISDIR, on every platform.
      fs.mkdirSync(pluginPath(), { recursive: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        expect(() => removeHooks(projectDir)).not.toThrow();

        expect(fs.statSync(pluginPath()).isDirectory()).toBe(true);
        // The failure is logged, not swallowed silently.
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain(pluginPath());
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // OpenCode 2 does not run OpenCode 1 plugins and discovers a local plugin as a
  // directory with an `index` entry (measured on 2.2.5). OpenCode 1 reads
  // plugins one level deep, so it never loads the directory copy.
  describe('the OpenCode 2 plugin', () => {
    function v2PluginPath(): string {
      return path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity', 'index.js');
    }

    it('installs the V2 plugin as a directory entry, byte for byte, and not the V1 file', () => {
      buildHooks(projectDir, true);
      const source = path.resolve(__dirname, '../../src/main/agent/adapters/opencode/plugin/kangentic-activity-v2.mjs');
      expect(fs.readFileSync(v2PluginPath()).equals(fs.readFileSync(source))).toBe(true);
      expect(fs.readFileSync(v2PluginPath(), 'utf-8').split('\n', 1)[0]).toContain('// kangentic-activity');
      expect(fs.existsSync(pluginPath())).toBe(false);
    });

    it('removes the directory copy and the folders it leaves empty', () => {
      buildHooks(projectDir, true);
      removeHooks(projectDir);
      expect(fs.existsSync(path.join(projectDir, '.opencode'))).toBe(false);
    });

    it('keeps a user file in that directory, and the directory with it', () => {
      buildHooks(projectDir, true);
      const userFile = path.join(path.dirname(v2PluginPath()), 'notes.md');
      fs.writeFileSync(userFile, 'mine');
      removeHooks(projectDir);
      expect(fs.existsSync(v2PluginPath())).toBe(false);
      expect(fs.readFileSync(userFile, 'utf-8')).toBe('mine');
    });

    it('hides the directory from git through .git/info/exclude', () => {
      execSync('git init', { cwd: projectDir, stdio: 'ignore' });
      buildHooks(projectDir, true);
      const exclude = fs.readFileSync(path.join(projectDir, '.git', 'info', 'exclude'), 'utf-8');
      expect(exclude.split(/\r?\n/)).toContain('.opencode/plugins/kangentic-activity/');
    });
  });

  describe('buildHooks git-exclude behavior', () => {
    const PLUGIN_EXCLUDE_PATTERN = '.opencode/plugins/kangentic-activity.js';

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
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.js'))).toBe(true);
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
