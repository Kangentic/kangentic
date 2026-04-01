/**
 * Unit tests for DiffService - git diff logic for the Changes panel.
 * Tests parseNameStatus, inferLanguage, getDiffFiles, and getFileContent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGit = {
  diffSummary: vi.fn(),
  diff: vi.fn(),
  show: vi.fn(),
  raw: vi.fn(),
};

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
    },
  },
}));

import fs from 'node:fs';
import { DiffService } from '../../src/main/git/diff-service';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDiffSummary(files: Array<{ file: string; insertions: number; deletions: number; binary?: boolean }>) {
  return {
    files: files.map((fileEntry) => ({
      file: fileEntry.file,
      insertions: fileEntry.insertions,
      deletions: fileEntry.deletions,
      binary: fileEntry.binary ?? false,
    })),
    insertions: files.reduce((sum, fileEntry) => sum + fileEntry.insertions, 0),
    deletions: files.reduce((sum, fileEntry) => sum + fileEntry.deletions, 0),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DiffService', () => {
  // Create a fresh instance per test so the merge-base cache doesn't leak between tests
  let service: DiffService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DiffService('/project');
    // Default merge-base mock - tests can override as needed
    mockGit.raw.mockResolvedValue('abc123\n');
  });

  describe('getDiffFiles', () => {
    it('parses modified files with correct status and stats', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/index.ts', insertions: 10, deletions: 3 },
        { file: 'src/utils.ts', insertions: 5, deletions: 0 },
      ]));
      mockGit.diff.mockResolvedValue('M\tsrc/index.ts\nA\tsrc/utils.ts\n');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toEqual({
        path: 'src/index.ts',
        status: 'M',
        insertions: 10,
        deletions: 3,
        oldPath: undefined,
        binary: false,
      });
      expect(result.files[1]).toEqual({
        path: 'src/utils.ts',
        status: 'A',
        insertions: 5,
        deletions: 0,
        oldPath: undefined,
        binary: false,
      });
      expect(result.totalInsertions).toBe(15);
      expect(result.totalDeletions).toBe(3);
    });

    it('parses renamed files with old path', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/new-name.ts', insertions: 2, deletions: 1 },
      ]));
      mockGit.diff.mockResolvedValue('R100\tsrc/old-name.ts\tsrc/new-name.ts\n');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].status).toBe('R');
      expect(result.files[0].oldPath).toBe('src/old-name.ts');
      expect(result.files[0].path).toBe('src/new-name.ts');
    });

    it('parses deleted files', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/removed.ts', insertions: 0, deletions: 25 },
      ]));
      mockGit.diff.mockResolvedValue('D\tsrc/removed.ts\n');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].status).toBe('D');
      expect(result.files[0].deletions).toBe(25);
    });

    it('marks binary files with zero insertions/deletions', async () => {
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'image.png', insertions: 0, deletions: 0, binary: true }],
        insertions: 0,
        deletions: 0,
      });
      mockGit.diff.mockResolvedValue('M\timage.png\n');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].binary).toBe(true);
      expect(result.files[0].insertions).toBe(0);
      expect(result.files[0].deletions).toBe(0);
    });

    it('uses merge-base diff when worktreePath is provided', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');

      await service.getDiffFiles({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/my-task',
        baseBranch: 'main',
      });

      // Should find merge-base first, then diff against it
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'main', 'HEAD']);
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['abc123']);
      expect(mockGit.diff).toHaveBeenCalledWith(['--name-status', 'abc123']);
    });

    it('uses merge-base diff when no worktreePath', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');

      await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      // Always uses merge-base, even without worktreePath
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'main', 'HEAD']);
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['abc123']);
      expect(mockGit.diff).toHaveBeenCalledWith(['--name-status', 'abc123']);
    });

    it('falls back to heuristic status when name-status is missing', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'added.ts', insertions: 10, deletions: 0 },
        { file: 'deleted.ts', insertions: 0, deletions: 5 },
        { file: 'modified.ts', insertions: 3, deletions: 2 },
      ]));
      // Empty name-status output (edge case)
      mockGit.diff.mockResolvedValue('');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].status).toBe('A');
      expect(result.files[1].status).toBe('D');
      expect(result.files[2].status).toBe('M');
    });

    it('handles empty diff', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files).toHaveLength(0);
      expect(result.totalInsertions).toBe(0);
      expect(result.totalDeletions).toBe(0);
    });

    it('handles copied files', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/copy.ts', insertions: 0, deletions: 0 },
      ]));
      mockGit.diff.mockResolvedValue('C100\tsrc/original.ts\tsrc/copy.ts\n');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].status).toBe('C');
    });

    it('skips malformed name-status lines', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'valid.ts', insertions: 1, deletions: 0 },
      ]));
      mockGit.diff.mockResolvedValue('M\tvalid.ts\n\n   \ngarbage\n');

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].status).toBe('M');
    });
  });

  describe('getFileContent', () => {
    it('fetches original and modified for a modified file', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.show.mockResolvedValue('original content');
      vi.mocked(fs.promises.readFile).mockResolvedValue('modified content');

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/index.ts',
        status: 'M',
      });

      expect(result.original).toBe('original content');
      expect(result.modified).toBe('modified content');
      expect(result.language).toBe('typescript');
      // Should use merge-base commit for original
      expect(mockGit.show).toHaveBeenCalledWith(['abc123:src/index.ts']);
    });

    it('returns empty original for added files', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue('new file content');

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/new.ts',
        status: 'A',
      });

      expect(result.original).toBe('');
      expect(result.modified).toBe('new file content');
      // No merge-base or show call for added files
      expect(mockGit.show).not.toHaveBeenCalled();
    });

    it('returns empty modified for deleted files', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.show.mockResolvedValue('old content');

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/removed.ts',
        status: 'D',
      });

      expect(result.original).toBe('old content');
      expect(result.modified).toBe('');
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });

    it('uses oldPath for renamed file originals', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.show.mockResolvedValue('original at old path');
      vi.mocked(fs.promises.readFile).mockResolvedValue('modified at new path');

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/new-name.ts',
        status: 'R',
        oldPath: 'src/old-name.ts',
      });

      expect(result.original).toBe('original at old path');
      expect(mockGit.show).toHaveBeenCalledWith(['abc123:src/old-name.ts']);
    });

    it('reads from filesystem when no worktreePath', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.show.mockResolvedValue('original');
      vi.mocked(fs.promises.readFile).mockResolvedValue('from working tree');

      const result = await service.getFileContent({
        projectPath: '/project',
        baseBranch: 'main',
        filePath: 'src/file.ts',
        status: 'M',
      });

      expect(result.original).toBe('original');
      expect(result.modified).toBe('from working tree');
      // Should read from projectPath when no worktreePath
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/src[/\\]file\.ts$/),
        'utf-8',
      );
    });

    it('handles git show failure gracefully for original', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.show.mockRejectedValue(new Error('fatal: bad revision'));
      vi.mocked(fs.promises.readFile).mockResolvedValue('content');

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/file.ts',
        status: 'M',
      });

      expect(result.original).toBe('');
      expect(result.modified).toBe('content');
    });

    it('handles readFile failure gracefully for modified', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.show.mockResolvedValue('original');
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/file.ts',
        status: 'M',
      });

      expect(result.original).toBe('original');
      expect(result.modified).toBe('');
    });

    it('infers language from file extension', async () => {
      mockGit.show.mockResolvedValue('');

      const cases: Array<{ filePath: string; expectedLanguage: string }> = [
        { filePath: 'file.ts', expectedLanguage: 'typescript' },
        { filePath: 'file.tsx', expectedLanguage: 'typescript' },
        { filePath: 'file.js', expectedLanguage: 'javascript' },
        { filePath: 'file.py', expectedLanguage: 'python' },
        { filePath: 'file.json', expectedLanguage: 'json' },
        { filePath: 'file.css', expectedLanguage: 'css' },
        { filePath: 'file.html', expectedLanguage: 'html' },
        { filePath: 'file.md', expectedLanguage: 'markdown' },
        { filePath: 'file.yml', expectedLanguage: 'yaml' },
        { filePath: 'file.rs', expectedLanguage: 'rust' },
        { filePath: 'file.go', expectedLanguage: 'go' },
        { filePath: 'file.unknown', expectedLanguage: 'plaintext' },
      ];

      for (const testCase of cases) {
        const result = await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: testCase.filePath,
          status: 'D',
        });
        expect(result.language).toBe(testCase.expectedLanguage);
      }
    });

    it('infers Dockerfile and Makefile without extensions', async () => {
      mockGit.show.mockResolvedValue('');

      const dockerResult = await service.getFileContent({
        projectPath: '/project',
        baseBranch: 'main',
        filePath: 'Dockerfile',
        status: 'D',
      });
      expect(dockerResult.language).toBe('dockerfile');

      const makeResult = await service.getFileContent({
        projectPath: '/project',
        baseBranch: 'main',
        filePath: 'Makefile',
        status: 'D',
      });
      expect(makeResult.language).toBe('makefile');
    });
  });
});
