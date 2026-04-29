import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
});
