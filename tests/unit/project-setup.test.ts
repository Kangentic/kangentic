/**
 * Unit tests for ensureGitignore() in src/main/ipc/helpers/project-setup.ts.
 *
 * This branch added the fourth gitignore entry:
 *   .opencode/plugins/kangentic-activity.mjs
 *
 * All four entries are tested:
 *   1. .kangentic/
 *   2. .claude/settings.local.json
 *   3. kangentic.local.json
 *   4. .opencode/plugins/kangentic-activity.mjs
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
  '.opencode/plugins/kangentic-activity.mjs',
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ensureGitignore', () => {
  describe('when the directory is a git repository', () => {
    beforeEach(() => {
      // ensureGitignore early-returns when isGitRepo() returns false.
      // isGitRepo() checks for a `.git` directory, so a real `git init` is needed.
      git('init -b main');
    });

    it('creates a .gitignore containing all four expected entries', () => {
      ensureGitignore(tempDir);

      expect(fs.existsSync(gitignorePath())).toBe(true);
      const content = readGitignore();
      for (const entry of EXPECTED_ENTRIES) {
        expect(content).toContain(entry);
      }
    });

    it('contains .kangentic/ entry', () => {
      ensureGitignore(tempDir);
      expect(readGitignore()).toContain('.kangentic/');
    });

    it('contains .claude/settings.local.json entry', () => {
      ensureGitignore(tempDir);
      expect(readGitignore()).toContain('.claude/settings.local.json');
    });

    it('contains kangentic.local.json entry', () => {
      ensureGitignore(tempDir);
      expect(readGitignore()).toContain('kangentic.local.json');
    });

    it('contains .opencode/plugins/kangentic-activity.mjs entry (OpenCode branch addition)', () => {
      ensureGitignore(tempDir);
      expect(readGitignore()).toContain('.opencode/plugins/kangentic-activity.mjs');
    });

    describe('idempotence', () => {
      it('does not duplicate entries on repeated calls', () => {
        ensureGitignore(tempDir);
        ensureGitignore(tempDir);

        const content = readGitignore();
        for (const entry of EXPECTED_ENTRIES) {
          // Count occurrences of each entry - must be exactly 1.
          const occurrences = content.split('\n').filter((line) => line.trim() === entry);
          expect(occurrences).toHaveLength(1);
        }
      });

      it('calling five times does not grow the file beyond one copy of each entry', () => {
        for (let callIndex = 0; callIndex < 5; callIndex++) {
          ensureGitignore(tempDir);
        }

        const lines = readGitignore().split('\n').filter((line) => line.trim() !== '');
        // The number of non-empty lines should equal the number of distinct entries
        // plus any user lines (none here) - not 5x the entries.
        const entryLines = lines.filter((line) => EXPECTED_ENTRIES.includes(line.trim()));
        expect(entryLines).toHaveLength(EXPECTED_ENTRIES.length);
      });
    });

    describe('preservation of existing user content', () => {
      it('keeps pre-existing user lines when appending kangentic entries', () => {
        const userContent = 'node_modules/\ndist/\n*.log\n';
        fs.writeFileSync(gitignorePath(), userContent);

        ensureGitignore(tempDir);

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

      it('does not overwrite a pre-existing .kangentic/ entry with slash variant', () => {
        // Users may write `.kangentic` without a trailing slash - both forms
        // are treated as already-covered by ensureGitignore.
        fs.writeFileSync(gitignorePath(), '.kangentic\n');

        ensureGitignore(tempDir);

        const content = readGitignore();
        // Should still contain the other three entries.
        expect(content).toContain('.claude/settings.local.json');
        expect(content).toContain('kangentic.local.json');
        expect(content).toContain('.opencode/plugins/kangentic-activity.mjs');
        // Must not have added a duplicate .kangentic/ line.
        const kangenticLines = content.split('\n').filter(
          (line) => line.trim() === '.kangentic' || line.trim() === '.kangentic/',
        );
        expect(kangenticLines).toHaveLength(1);
      });

      it('does not duplicate entries that already exist in the user .gitignore', () => {
        // Pre-seed all four entries plus a user line.
        const preSeeded = [
          '# my project',
          '.kangentic/',
          '.claude/settings.local.json',
          'kangentic.local.json',
          '.opencode/plugins/kangentic-activity.mjs',
          '',
        ].join('\n');
        fs.writeFileSync(gitignorePath(), preSeeded);

        ensureGitignore(tempDir);

        const content = readGitignore();
        for (const entry of EXPECTED_ENTRIES) {
          const occurrences = content.split('\n').filter((line) => line.trim() === entry);
          expect(occurrences).toHaveLength(1);
        }
      });
    });
  });

  describe('when the directory is NOT a git repository', () => {
    it('leaves the filesystem untouched (no .gitignore is created)', () => {
      // tempDir has no .git directory - isGitRepo() returns false.
      ensureGitignore(tempDir);

      expect(fs.existsSync(gitignorePath())).toBe(false);
    });

    it('does not throw', () => {
      expect(() => ensureGitignore(tempDir)).not.toThrow();
    });

    it('does not create any files in the directory', () => {
      const beforeEntries = fs.readdirSync(tempDir);
      ensureGitignore(tempDir);
      const afterEntries = fs.readdirSync(tempDir);
      expect(afterEntries).toEqual(beforeEntries);
    });
  });
});
