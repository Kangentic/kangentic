/**
 * Unit tests for WorktreeManager.hideWorktreeDir — the skip-worktree
 * logic that prevents duplicate Claude Code slash commands in worktrees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockProjectGit = { raw: vi.fn() };
const mockWorktreeGit = { raw: vi.fn() };

vi.mock('simple-git', () => ({
  default: vi.fn((cwd: string) =>
    // path.join uses backslashes on Windows, forward slashes elsewhere
    cwd.includes('.kangentic\\worktrees') || cwd.includes('.kangentic/worktrees')
      ? mockWorktreeGit
      : mockProjectGit,
  ),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
}));

import fs from 'node:fs';
import { WorktreeManager } from '../../src/main/git/worktree-manager';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Set up mocks so createWorktree reaches the hideWorktreeDir calls. */
function setupCreateWorktreeMocks(options: {
  commandsExist?: boolean;
  skillsExist?: boolean;
  trackedCommands?: string[];
  trackedSkills?: string[];
  skipWorktreeThrows?: boolean;
} = {}) {
  const {
    commandsExist = true,
    skillsExist = false,
    trackedCommands = ['.claude/commands/test.md', '.claude/commands/merge-back.md'],
    trackedSkills = [],
    skipWorktreeThrows = false,
  } = options;

  // fs.existsSync: worktrees dir always exists, then per-dir checks
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const s = String(p);
    if (s.endsWith('commands')) return commandsExist;
    if (s.endsWith('skills')) return skillsExist;
    return true; // worktrees dir, copy sources
  });

  // Project-level git: fetch + worktree add
  mockProjectGit.raw.mockResolvedValue('');

  // Worktree-level git: ls-files + update-index
  mockWorktreeGit.raw.mockImplementation(async (args: string[]) => {
    if (args[0] === 'ls-files') {
      const dir = args[1];
      if (dir === '.claude/commands') return trackedCommands.join('\n');
      if (dir === '.claude/skills') return trackedSkills.join('\n');
      return '';
    }
    if (args[0] === 'update-index' && skipWorktreeThrows) {
      throw new Error('update-index failed');
    }
    return '';
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WorktreeManager — hideWorktreeDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks tracked files as skip-worktree before deleting', async () => {
    const tracked = ['.claude/commands/test.md', '.claude/commands/merge-back.md'];
    setupCreateWorktreeMocks({ trackedCommands: tracked });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // Verify ls-files was called for .claude/commands
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(['ls-files', '.claude/commands']);

    // Verify update-index was called with the tracked files
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'update-index', '--skip-worktree', '--',
      '.claude/commands/test.md',
      '.claude/commands/merge-back.md',
    ]);

    // Verify rmSync was called for the commands directory
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('commands'),
      { recursive: true, force: true },
    );
  });

  it('skips update-index when ls-files returns empty', async () => {
    setupCreateWorktreeMocks({ trackedCommands: [] });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // ls-files was called
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(['ls-files', '.claude/commands']);

    // update-index was NOT called (no tracked files)
    const updateCalls = mockWorktreeGit.raw.mock.calls.filter(
      (c: string[][]) => c[0]?.[0] === 'update-index',
    );
    expect(updateCalls).toHaveLength(0);

    // rmSync still runs to clean up any untracked files
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('commands'),
      { recursive: true, force: true },
    );
  });

  it('falls back to deletion when skip-worktree fails', async () => {
    setupCreateWorktreeMocks({ skipWorktreeThrows: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = new WorktreeManager('/project');
    // Should not throw
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // Warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skip-worktree failed'),
      expect.any(Error),
    );

    // rmSync was still called despite the error
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('commands'),
      { recursive: true, force: true },
    );

    warnSpy.mockRestore();
  });

  it('skips entirely when directory does not exist', async () => {
    setupCreateWorktreeMocks({ commandsExist: false, skillsExist: false });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // No ls-files or update-index calls for worktree git
    const worktreeGitCalls = mockWorktreeGit.raw.mock.calls.filter(
      (c: string[][]) => c[0]?.[0] === 'ls-files' || c[0]?.[0] === 'update-index',
    );
    expect(worktreeGitCalls).toHaveLength(0);

    // No rmSync calls for .claude directories
    const rmCalls = vi.mocked(fs.rmSync).mock.calls.filter(
      (c) => String(c[0]).includes('.claude'),
    );
    expect(rmCalls).toHaveLength(0);
  });

  it('processes both commands and skills directories', async () => {
    setupCreateWorktreeMocks({
      commandsExist: true,
      skillsExist: true,
      trackedCommands: ['.claude/commands/review.md'],
      trackedSkills: ['.claude/skills/deploy/SKILL.md'],
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree('abcd1234-0000', 'Test task');

    // ls-files called for both directories
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(['ls-files', '.claude/commands']);
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith(['ls-files', '.claude/skills']);

    // update-index called for both sets of files
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'update-index', '--skip-worktree', '--', '.claude/commands/review.md',
    ]);
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'update-index', '--skip-worktree', '--', '.claude/skills/deploy/SKILL.md',
    ]);

    // Both directories deleted
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('commands'),
      { recursive: true, force: true },
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('skills'),
      { recursive: true, force: true },
    );
  });
});
