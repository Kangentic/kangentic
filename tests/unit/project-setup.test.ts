/**
 * Unit tests for ensureGitignore() in src/main/ipc/helpers/project-setup.ts.
 *
 * The generic project-open helper adds three universal Kangentic entries:
 *   1. .kangentic/
 *   2. .claude/settings.local.json
 *   3. kangentic.local.json
 *
 * The OpenCode activity plugin entry (.opencode/plugins/kangentic-activity.mjs)
 * is intentionally NOT written here - it is added lazily by the OpenCode
 * adapter's buildHooks() at spawn time, so projects that never use OpenCode
 * never receive a stray ignore line. See opencode-hook-manager.test.ts for
 * that behavior.
 *
 * ensureGitignore is async (its git tracked-file probe must not block the
 * project-open critical path) and never rejects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ensureGitignore } from '../../src/main/ipc/helpers/project-setup';

let tempDir: string;

/**
 * Run a git command in the temp directory using execSync. Git must be on PATH;
 * CI and developer machines always have it.
 */
function git(args: string): void {
  execSync(`git -C "${tempDir}" ${args}`, {
    stdio: 'ignore',
    env: {
      ...process.env,
      // Suppress editor prompts and make commits deterministic.
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function gitignorePath(): string {
  return path.join(tempDir, '.gitignore');
}

function readGitignore(): string {
  return fs.readFileSync(gitignorePath(), 'utf-8');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangtest-project-setup-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Helper constants for all four expected entries ─────────────────────────

const EXPECTED_ENTRIES = [
  '.kangentic/',
  '.claude/settings.local.json',
  'kangentic.local.json',
];

const OPENCODE_PLUGIN_ENTRY = '.opencode/plugins/kangentic-activity.mjs';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ensureGitignore', () => {
  describe('when the directory is a git repository', () => {
    beforeEach(() => {
      // ensureGitignore early-returns when isGitRepo() returns false.
      // isGitRepo() checks for a `.git` directory, so a real `git init` is needed.
      git('init -b main');
    });

    it('creates a .gitignore containing all three expected entries', async () => {
      await ensureGitignore(tempDir);

      expect(fs.existsSync(gitignorePath())).toBe(true);
      const content = readGitignore();
      for (const entry of EXPECTED_ENTRIES) {
        expect(content).toContain(entry);
      }
    });

    it('contains .kangentic/ entry', async () => {
      await ensureGitignore(tempDir);
      expect(readGitignore()).toContain('.kangentic/');
    });

    it('contains .claude/settings.local.json entry', async () => {
      await ensureGitignore(tempDir);
      expect(readGitignore()).toContain('.claude/settings.local.json');
    });

    it('contains kangentic.local.json entry', async () => {
      await ensureGitignore(tempDir);
      expect(readGitignore()).toContain('kangentic.local.json');
    });

    it('does NOT add the OpenCode plugin entry (added lazily by buildHooks instead)', async () => {
      // Regression guard for the unconditional-append bug: projects that
      // never use OpenCode must not get a stray .opencode/plugins/... line
      // in their .gitignore on every project open.
      await ensureGitignore(tempDir);

      const content = readGitignore();
      const occurrences = content
        .split('\n')
        .filter((line) => line.trim() === OPENCODE_PLUGIN_ENTRY);
      expect(occurrences).toHaveLength(0);
    });

    describe('idempotence', () => {
      it('does not duplicate entries on repeated calls', async () => {
        await ensureGitignore(tempDir);
        await ensureGitignore(tempDir);

        const content = readGitignore();
        for (const entry of EXPECTED_ENTRIES) {
          // Count occurrences of each entry - must be exactly 1.
          const occurrences = content.split('\n').filter((line) => line.trim() === entry);
          expect(occurrences).toHaveLength(1);
        }
      });

      it('calling five times does not grow the file beyond one copy of each entry', async () => {
        for (let callIndex = 0; callIndex < 5; callIndex++) {
          await ensureGitignore(tempDir);
        }

        const lines = readGitignore().split('\n').filter((line) => line.trim() !== '');
        // The number of non-empty lines should equal the number of distinct entries
        // plus any user lines (none here) - not 5x the entries.
        const entryLines = lines.filter((line) => EXPECTED_ENTRIES.includes(line.trim()));
        expect(entryLines).toHaveLength(EXPECTED_ENTRIES.length);
      });
    });

    describe('preservation of existing user content', () => {
      it('keeps pre-existing user lines when appending kangentic entries', async () => {
        const userContent = 'node_modules/\ndist/\n*.log\n';
        fs.writeFileSync(gitignorePath(), userContent);

        await ensureGitignore(tempDir);

        const content = readGitignore();
        // User lines must survive.
        expect(content).toContain('node_modules/');
        expect(content).toContain('dist/');
        expect(content).toContain('*.log');
        // Kangentic entries must also be present.
        for (const entry of EXPECTED_ENTRIES) {
          expect(content).toContain(entry);
        }
      });

      it('does not overwrite a pre-existing .kangentic/ entry with slash variant', async () => {
        // Users may write `.kangentic` without a trailing slash - both forms
        // are treated as already-covered by ensureGitignore.
        fs.writeFileSync(gitignorePath(), '.kangentic\n');

        await ensureGitignore(tempDir);

        const content = readGitignore();
        // Should still contain the other two entries.
        expect(content).toContain('.claude/settings.local.json');
        expect(content).toContain('kangentic.local.json');
        // Must not have added a duplicate .kangentic/ line.
        const kangenticLines = content.split('\n').filter(
          (line) => line.trim() === '.kangentic' || line.trim() === '.kangentic/',
        );
        expect(kangenticLines).toHaveLength(1);
      });

      it('does not duplicate entries that already exist in the user .gitignore', async () => {
        // Pre-seed all three entries plus a user line.
        const preSeeded = [
          '# my project',
          '.kangentic/',
          '.claude/settings.local.json',
          'kangentic.local.json',
          '',
        ].join('\n');
        fs.writeFileSync(gitignorePath(), preSeeded);

        await ensureGitignore(tempDir);

        const content = readGitignore();
        for (const entry of EXPECTED_ENTRIES) {
          const occurrences = content.split('\n').filter((line) => line.trim() === entry);
          expect(occurrences).toHaveLength(1);
        }
      });
    });

    describe('isFileTracked true-branch: .claude/settings.local.json already committed', () => {
      it('does not append .claude/settings.local.json to .gitignore when the file is already tracked by git', async () => {
        // Neutralize the host's global git excludes (a Claude Code dev
        // machine's ~/.config/git/ignore commonly has
        // `**/.claude/settings.local.json`), so `git add` below reliably
        // tracks the fixture instead of silently skipping a globally-ignored
        // path. Mirrors worktree-claude-dirs.test.ts's setup.
        git(`config core.excludesFile "${path.join(tempDir, 'no-global-excludes')}"`);

        const claudeDir = path.join(tempDir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), '{}\n');
        git('add .claude/settings.local.json');
        git('commit -m "chore: track settings.local.json"');

        await ensureGitignore(tempDir);

        // Red-green: fails if isFileTracked's true result is ignored or
        // inverted, which would append the line even though the file is
        // already committed to the team's history.
        const content = fs.existsSync(gitignorePath()) ? readGitignore() : '';
        const settingsLines = content
          .split('\n')
          .filter((line) => line.trim() === '.claude/settings.local.json');
        expect(settingsLines).toHaveLength(0);

        // The other two universal entries are unaffected by the tracked-file
        // check and are still added.
        expect(content).toContain('.kangentic/');
        expect(content).toContain('kangentic.local.json');
      });
    });
  });

  describe('when the directory is NOT a git repository', () => {
    it('leaves the filesystem untouched (no .gitignore is created)', async () => {
      // tempDir has no .git directory - isGitRepo() returns false.
      await ensureGitignore(tempDir);

      expect(fs.existsSync(gitignorePath())).toBe(false);
    });

    it('never rejects', async () => {
      await expect(ensureGitignore(tempDir)).resolves.toBeUndefined();
    });

    it('does not create any files in the directory', async () => {
      const beforeEntries = fs.readdirSync(tempDir);
      await ensureGitignore(tempDir);
      const afterEntries = fs.readdirSync(tempDir);
      expect(afterEntries).toEqual(beforeEntries);
    });
  });
});
