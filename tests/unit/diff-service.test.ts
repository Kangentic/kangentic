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
  showBuffer: vi.fn(),
  catFile: vi.fn(),
  revparse: vi.fn(),
  raw: vi.fn(),
  status: vi.fn(),
};

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      stat: vi.fn(),
      open: vi.fn(),
    },
  },
}));

// Isolates the offload-threshold decision (diff-service.ts) from the
// worker's own behavior (covered separately in line-count-client.test.ts).
const { mockCountFiles } = vi.hoisted(() => ({ mockCountFiles: vi.fn() }));

vi.mock('../../src/main/git/line-count/line-count-client', () => ({
  lineCountClient: { countFiles: mockCountFiles },
}));

import fs from 'node:fs';
import path from 'node:path';
import { DiffService, RECENT_WRITE_WINDOW_MS } from '../../src/main/git/diff-service';
import { IMAGE_PREVIEW_MAX_BYTES } from '../../src/shared/image-preview';

/** Backs the countFileLines bounded stat+open read path (see
 *  src/main/git/line-count/count-lines.ts) with a single in-memory buffer, so
 *  an untracked-file test can simulate its content without touching disk. */
function mockUntrackedFileContent(content: Buffer): void {
  vi.mocked(fs.promises.stat).mockResolvedValue({ size: content.length } as never);
  vi.mocked(fs.promises.open).mockResolvedValue({
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      content.copy(buffer, offset, position, position + length);
      return { bytesRead: length, buffer };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  } as never);
}

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

/**
 * Answers `git.raw` by its arguments, joined with spaces. A null answer, or an
 * argument list not listed, rejects the way git does for a ref it cannot resolve.
 */
function routeGit(answers: Record<string, string | null>): void {
  mockGit.raw.mockImplementation(async (args: string[]) => {
    const answer = answers[args.join(' ')];
    if (answer === undefined || answer === null) throw new Error(`fatal: no route for git ${args.join(' ')}`);
    return `${answer}\n`;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DiffService', () => {
  // Create a fresh instance per test so the merge-base cache doesn't leak between tests
  let service: DiffService;

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) also drops each mock's configured
    // implementation/resolved-value - clearAllMocks only clears call history,
    // so a mockResolvedValue set by one test (e.g. mockUntrackedFileContent's
    // fs.promises.stat/open) would otherwise silently leak into the next test
    // that never configures those mocks itself.
    vi.resetAllMocks();
    service = new DiffService('/project');
    // Default merge-base mock - tests can override as needed
    mockGit.raw.mockResolvedValue('abc123\n');
    // Default git status mock - returns no untracked files
    mockGit.status.mockResolvedValue({ not_added: [] });
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

      // Should try origin ref first, then diff against it
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
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

      // Always uses merge-base with origin ref preferred, even without worktreePath
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['abc123']);
      expect(mockGit.diff).toHaveBeenCalledWith(['--name-status', 'abc123']);
    });

    it('falls back to local branch when origin ref fails', async () => {
      // origin/main fails (no remote), local main succeeds. Routed by arguments,
      // since the creation-point lookup runs beside the origin merge-base.
      routeGit({ 'merge-base origin/main HEAD': null, 'merge-base main HEAD': 'def456' });
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');

      await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'main', 'HEAD']);
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['def456']);
    });

    describe('the branch creation point', () => {
      const OLD_BASE = 'a'.repeat(40);
      const CREATED = 'c'.repeat(40);
      const NEW_BASE = 'e'.repeat(40);
      const reflog = (oldest: string) => `${'f'.repeat(40)} commit: the task's work\n${oldest}\n`;

      beforeEach(() => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');
      });

      it('wins over a merge-base left far behind by a rewritten base', async () => {
        // The measured case: the base was rewritten after the branch was cut, so
        // its merge-base with HEAD fell back to an old shared commit and the
        // task was charged with most of the repository.
        routeGit({
          'merge-base origin/main HEAD': OLD_BASE,
          'symbolic-ref -q --short HEAD': 'task-branch',
          'reflog show --format=%H %gs refs/heads/task-branch': reflog(`${CREATED} branch: Created from origin/main`),
          [`merge-base ${CREATED} HEAD`]: CREATED,
          [`merge-base ${OLD_BASE} ${CREATED}`]: OLD_BASE,
        });
        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });
        expect(mockGit.diffSummary).toHaveBeenCalledWith([CREATED]);
      });

      it('loses to a merge-base that a rebase or merge moved past it', async () => {
        routeGit({
          'merge-base origin/main HEAD': NEW_BASE,
          'symbolic-ref -q --short HEAD': 'task-branch',
          'reflog show --format=%H %gs refs/heads/task-branch': reflog(`${CREATED} branch: Created from origin/main`),
          [`merge-base ${CREATED} HEAD`]: CREATED,
          // The creation point is behind the new merge-base, not past it.
          [`merge-base ${NEW_BASE} ${CREATED}`]: CREATED,
        });
        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });
        expect(mockGit.diffSummary).toHaveBeenCalledWith([NEW_BASE]);
      });

      it('is ignored when it is not on HEAD\'s history', async () => {
        routeGit({
          'merge-base origin/main HEAD': OLD_BASE,
          'symbolic-ref -q --short HEAD': 'task-branch',
          'reflog show --format=%H %gs refs/heads/task-branch': reflog(`${CREATED} branch: Created from origin/main`),
          [`merge-base ${CREATED} HEAD`]: OLD_BASE,
        });
        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });
        expect(mockGit.diffSummary).toHaveBeenCalledWith([OLD_BASE]);
      });

      it('is ignored once git has expired the creation entry', async () => {
        // The oldest entry left is an ordinary commit, which says nothing about
        // where the branch started.
        routeGit({
          'merge-base origin/main HEAD': OLD_BASE,
          'symbolic-ref -q --short HEAD': 'task-branch',
          'reflog show --format=%H %gs refs/heads/task-branch': reflog(`${CREATED} commit: an early commit`),
        });
        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });
        expect(mockGit.diffSummary).toHaveBeenCalledWith([OLD_BASE]);
      });

      it('costs no extra call when it is the merge-base, the common case', async () => {
        routeGit({
          'merge-base origin/main HEAD': CREATED,
          'symbolic-ref -q --short HEAD': 'task-branch',
          'reflog show --format=%H %gs refs/heads/task-branch': reflog(`${CREATED} branch: Created from origin/main`),
        });
        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });
        expect(mockGit.diffSummary).toHaveBeenCalledWith([CREATED]);
        const mergeBaseCalls = mockGit.raw.mock.calls.filter(([args]) => (args as string[])[0] === 'merge-base');
        expect(mergeBaseCalls).toHaveLength(1);
      });
    });

    it('falls back to HEAD when both origin and local refs fail', async () => {
      mockGit.raw.mockRejectedValue(new Error('fatal: not a valid object name'));
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');

      await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'nonexistent',
      });

      // Tried both refs
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/nonexistent', 'HEAD']);
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'nonexistent', 'HEAD']);
      // Falls back to HEAD - diffSummary called with HEAD
      expect(mockGit.diffSummary).toHaveBeenCalledWith(['HEAD']);
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

    it('includes untracked files from git status with status U', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/existing.ts', insertions: 3, deletions: 1 },
      ]));
      mockGit.diff.mockResolvedValue('M\tsrc/existing.ts\n');
      mockGit.status.mockResolvedValue({ not_added: ['src/brand-new.ts'] });
      // 3 lines (2 newlines + content after the last, unterminated line)
      mockUntrackedFileContent(Buffer.from('line1\nline2\nline3'));

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files).toHaveLength(2);
      expect(result.files[1]).toEqual({
        path: 'src/brand-new.ts',
        status: 'U',
        insertions: 3,
        deletions: 0,
        binary: false,
      });
      // Total insertions includes both tracked and untracked
      expect(result.totalInsertions).toBe(3 + 3);
    });

    it('detects binary untracked files via null byte check', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');
      mockGit.status.mockResolvedValue({ not_added: ['image.png'] });
      // Buffer with a null byte in the first 8KB
      const binaryBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0A]);
      mockUntrackedFileContent(binaryBuffer);

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0]).toEqual({
        path: 'image.png',
        status: 'U',
        insertions: 0,
        deletions: 0,
        binary: true,
      });
    });

    it('deduplicates untracked files already present in diff', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/file.ts', insertions: 5, deletions: 0 },
      ]));
      mockGit.diff.mockResolvedValue('A\tsrc/file.ts\n');
      // Same file appears in both diff and status.not_added
      mockGit.status.mockResolvedValue({ not_added: ['src/file.ts'] });

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      // Should not duplicate - only one entry with status 'A' from diff
      expect(result.files).toHaveLength(1);
      expect(result.files[0].status).toBe('A');
    });

    it('handles untracked file read failure gracefully', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');
      mockGit.status.mockResolvedValue({ not_added: ['deleted-before-read.ts'] });
      vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'));

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toEqual({
        path: 'deleted-before-read.ts',
        status: 'U',
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    });

    it('counts lines correctly for files ending with newline', async () => {
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');
      mockGit.status.mockResolvedValue({ not_added: ['src/file.ts'] });
      // File with trailing newline: 2 lines
      mockUntrackedFileContent(Buffer.from('line1\nline2\n'));

      const result = await service.getDiffFiles({
        projectPath: '/project',
        baseBranch: 'main',
      });

      expect(result.files[0].insertions).toBe(2);
    });

    describe('untracked line-count offload (UNTRACKED_OFFLOAD_THRESHOLD_BYTES)', () => {
      it('delegates to the line-count worker, with joined absolute paths, when aggregate untracked bytes exceed the offload threshold', async () => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');
        mockGit.status.mockResolvedValue({ not_added: ['big-file.bin'] });
        // A single 3MB untracked file - aggregate (3MB) > the 2MB threshold.
        vi.mocked(fs.promises.stat).mockResolvedValue({ size: 3 * 1024 * 1024 } as never);
        const absolutePath = path.join('/project', 'big-file.bin');
        mockCountFiles.mockResolvedValue([{ path: absolutePath, insertions: 42, binary: false }]);

        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });

        expect(mockCountFiles).toHaveBeenCalledWith([absolutePath]);
      });

      it('does NOT delegate to the line-count worker when aggregate untracked bytes are under the offload threshold', async () => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');
        mockGit.status.mockResolvedValue({ not_added: ['small-file.txt'] });
        // A handful of bytes, well under the 2MB threshold.
        mockUntrackedFileContent(Buffer.from('a\nb\n'));

        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });

        expect(mockCountFiles).not.toHaveBeenCalled();
      });

      it('falls back to inline counting when the worker is unavailable (countFiles resolves null)', async () => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');
        mockGit.status.mockResolvedValue({ not_added: ['big-file.bin'] });
        // Force the offload branch (large reported size)...
        vi.mocked(fs.promises.stat).mockResolvedValue({ size: 3 * 1024 * 1024 } as never);
        // ...but the worker is unavailable (not spawned / crashed / timed out).
        mockCountFiles.mockResolvedValue(null);
        // The inline countFileLines fallback reads via fs.promises.open/read;
        // only the actually-returned bytes are scanned regardless of the
        // inflated stat() size above (see count-lines.test.ts's short-read
        // coverage), so this content resolves deterministically to 3 lines.
        const content = Buffer.from('line1\nline2\nline3\n');
        vi.mocked(fs.promises.open).mockResolvedValue({
          read: vi.fn(async (buffer: Buffer, offset: number, _length: number, position: number) => {
            content.copy(buffer, offset, position, position + content.length);
            return { bytesRead: content.length, buffer };
          }),
          close: vi.fn().mockResolvedValue(undefined),
        } as never);

        const result = await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });

        // The offload was attempted (and declined the worker's result), then
        // fell through to inline counting instead of losing the file.
        expect(mockCountFiles).toHaveBeenCalled();
        expect(result.files[0]).toEqual({
          path: 'big-file.bin',
          status: 'U',
          insertions: 3,
          deletions: 0,
          binary: false,
        });
      });

      it('maps worker results back to the original relative untracked paths by index, not by the entry.path field', async () => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');
        mockGit.status.mockResolvedValue({ not_added: ['src/big-one.bin', 'assets/big-two.bin'] });
        // 2 files * 1.5MB = 3MB aggregate, over the 2MB threshold.
        vi.mocked(fs.promises.stat).mockResolvedValue({ size: 1.5 * 1024 * 1024 } as never);
        // Deliberately mismatched `path` fields on the worker's entries, so a
        // regression that zips by entry.path (instead of untrackedPaths[index])
        // would surface as a wrong path in the result.
        mockCountFiles.mockResolvedValue([
          { path: 'garbage-value-should-be-ignored-0', insertions: 10, binary: false },
          { path: 'garbage-value-should-be-ignored-1', insertions: 0, binary: true },
        ]);

        const result = await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main' });

        expect(result.files).toEqual([
          { path: 'src/big-one.bin', status: 'U', insertions: 10, deletions: 0, binary: false },
          { path: 'assets/big-two.bin', status: 'U', insertions: 0, deletions: 0, binary: true },
        ]);
      });
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

  describe('getChurnSummary', () => {
    it('reuses getDiffFiles(scope: "branch") and maps to linesAdded/linesRemoved/filesChanged', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([
        { file: 'src/a.ts', insertions: 10, deletions: 3 },
        { file: 'src/b.ts', insertions: 5, deletions: 0 },
      ]));
      mockGit.diff.mockResolvedValue('M\tsrc/a.ts\nA\tsrc/b.ts\n');
      mockGit.status.mockResolvedValue({ not_added: [] });

      const result = await service.getChurnSummary('main');

      expect(result).toEqual({ linesAdded: 15, linesRemoved: 3, filesChanged: 2 });
      // branch scope: merge-base resolution, same as the diff panel.
      expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
    });

    it('includes uncommitted + untracked changes (branch scope consults git status)', async () => {
      mockGit.raw.mockResolvedValue('abc123\n');
      mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
      mockGit.diff.mockResolvedValue('');
      mockGit.status.mockResolvedValue({ not_added: ['src/brand-new.ts'] });
      mockUntrackedFileContent(Buffer.from('line1\nline2\n'));

      const result = await service.getChurnSummary('main');

      expect(result).toEqual({ linesAdded: 2, linesRemoved: 0, filesChanged: 1 });
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

    it('returns empty original for untracked files', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue('untracked file content');

      const result = await service.getFileContent({
        projectPath: '/project',
        worktreePath: '/project/.kangentic/worktrees/task',
        baseBranch: 'main',
        filePath: 'src/new-untracked.ts',
        status: 'U',
      });

      expect(result.original).toBe('');
      expect(result.modified).toBe('untracked file content');
      expect(result.language).toBe('typescript');
      // No git show call for untracked files
      expect(mockGit.show).not.toHaveBeenCalled();
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
        { filePath: 'file.mdx', expectedLanguage: 'markdown' },
        { filePath: 'file.markdown', expectedLanguage: 'markdown' },
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

  describe('scope', () => {
    describe('getDiffFiles', () => {
      it('working scope: diffs working tree vs index, includes untracked, no merge-base', async () => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([{ file: 'src/a.ts', insertions: 1, deletions: 0 }]));
        mockGit.diff.mockResolvedValue('M\tsrc/a.ts\n');
        mockGit.status.mockResolvedValue({ not_added: [] });

        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main', scope: 'working' });

        // No `:path` ref - plain `git diff` (working vs index).
        expect(mockGit.diffSummary).toHaveBeenCalledWith([]);
        expect(mockGit.diff).toHaveBeenCalledWith(['--name-status']);
        // No merge-base lookup for the working scope.
        expect(mockGit.raw).not.toHaveBeenCalled();
        // Untracked files are part of working changes, so status is consulted.
        expect(mockGit.status).toHaveBeenCalled();
      });

      it('staged scope: diffs index vs HEAD and excludes untracked (no git status)', async () => {
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([{ file: 'src/a.ts', insertions: 1, deletions: 0 }]));
        mockGit.diff.mockResolvedValue('A\tsrc/a.ts\n');

        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main', scope: 'staged' });

        expect(mockGit.diffSummary).toHaveBeenCalledWith(['--cached']);
        expect(mockGit.diff).toHaveBeenCalledWith(['--cached', '--name-status']);
        expect(mockGit.raw).not.toHaveBeenCalled();
        // Untracked files are not staged, so status is not consulted.
        expect(mockGit.status).not.toHaveBeenCalled();
      });

      it('branch scope is the default and uses the merge-base', async () => {
        mockGit.raw.mockResolvedValue('abc123\n');
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');

        await service.getDiffFiles({ projectPath: '/project', baseBranch: 'main', scope: 'branch' });

        expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
        expect(mockGit.diffSummary).toHaveBeenCalledWith(['abc123']);
      });
    });

    describe('getFileContent', () => {
      it('working scope: original from the index blob, modified from disk', async () => {
        mockGit.show.mockResolvedValue('index content');
        vi.mocked(fs.promises.readFile).mockResolvedValue('working tree content');

        const result = await service.getFileContent({
          projectPath: '/project',
          worktreePath: '/project/wt',
          baseBranch: 'main',
          filePath: 'src/a.ts',
          status: 'M',
          scope: 'working',
        });

        expect(mockGit.show).toHaveBeenCalledWith([':src/a.ts']);
        expect(mockGit.raw).not.toHaveBeenCalled();
        expect(result.original).toBe('index content');
        expect(result.modified).toBe('working tree content');
      });

      it('staged scope: original from HEAD, modified from the index blob (not disk)', async () => {
        mockGit.show.mockImplementation(async (args: string[]) => {
          const ref = args[0];
          if (ref.startsWith('HEAD:')) return 'head content';
          if (ref.startsWith(':')) return 'index content';
          return 'other';
        });

        const result = await service.getFileContent({
          projectPath: '/project',
          worktreePath: '/project/wt',
          baseBranch: 'main',
          filePath: 'src/a.ts',
          status: 'M',
          scope: 'staged',
        });

        expect(mockGit.show).toHaveBeenCalledWith(['HEAD:src/a.ts']);
        expect(mockGit.show).toHaveBeenCalledWith([':src/a.ts']);
        // Staged modified content comes from the index, never the working tree.
        expect(fs.promises.readFile).not.toHaveBeenCalled();
        expect(result.original).toBe('head content');
        expect(result.modified).toBe('index content');
      });

      it('branch scope: consults getMergeBase and fetches original via git.show(<mergeBase>:<path>)', async () => {
        // The merge-base is resolved via git.raw(['merge-base','origin/main','HEAD'])
        // (origin/ tried first). The original side is then fetched from that commit
        // via git.show(['<mergeBase>:<path>']).
        mockGit.raw.mockResolvedValue('base999\n');
        mockGit.show.mockResolvedValue('base file content');
        vi.mocked(fs.promises.readFile).mockResolvedValue('working tree content');

        const result = await service.getFileContent({
          projectPath: '/project',
          worktreePath: '/project/wt',
          baseBranch: 'main',
          filePath: 'src/b.ts',
          status: 'M',
          scope: 'branch',
        });

        // getMergeBase must consult origin/main first.
        expect(mockGit.raw).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
        // Original must come from the merge-base commit, not the index or HEAD.
        expect(mockGit.show).toHaveBeenCalledWith(['base999:src/b.ts']);
        expect(result.original).toBe('base file content');
        // Modified is read from disk (working tree).
        expect(result.modified).toBe('working tree content');
      });

      it('branch scope: returns empty string for original when getMergeBase throws', async () => {
        // Both origin/main and main fail -> getMergeBase falls back to 'HEAD'.
        // git.show('HEAD:...') then also throws to exercise the inner catch.
        mockGit.raw.mockRejectedValue(new Error('fatal: not a valid object name'));
        mockGit.show.mockRejectedValue(new Error('fatal: bad revision HEAD:src/c.ts'));
        vi.mocked(fs.promises.readFile).mockResolvedValue('working tree content');

        const result = await service.getFileContent({
          projectPath: '/project',
          worktreePath: '/project/wt',
          baseBranch: 'main',
          filePath: 'src/c.ts',
          status: 'M',
          scope: 'branch',
        });

        // The inner catch must return '' for original (graceful empty).
        expect(result.original).toBe('');
        // Modified is still read from disk.
        expect(result.modified).toBe('working tree content');
      });
    });
  });

  describe('commitOid (single-commit diff, the history browser)', () => {
    const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    describe('getDiffFiles', () => {
      it('diffs <oid>^..<oid> and never consults git status (no untracked concept for a commit)', async () => {
        mockGit.raw.mockResolvedValue('parent999\n');
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([{ file: 'src/a.ts', insertions: 1, deletions: 0 }]));
        mockGit.diff.mockResolvedValue('M\tsrc/a.ts\n');

        const result = await service.getDiffFiles({
          projectPath: '/project',
          baseBranch: 'main',
          commitOid: 'commit123',
        });

        expect(mockGit.raw).toHaveBeenCalledWith(['rev-parse', '--verify', 'commit123^']);
        expect(mockGit.diffSummary).toHaveBeenCalledWith(['parent999', 'commit123']);
        expect(mockGit.diff).toHaveBeenCalledWith(['--name-status', 'parent999', 'commit123']);
        expect(mockGit.status).not.toHaveBeenCalled();
        expect(result.files[0].status).toBe('M');
      });

      it('root commit: rev-parse <oid>^ fails, falls back to the empty tree', async () => {
        mockGit.raw.mockRejectedValue(new Error('fatal: ambiguous argument \'root123^\': unknown revision'));
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([{ file: 'src/a.ts', insertions: 5, deletions: 0 }]));
        mockGit.diff.mockResolvedValue('A\tsrc/a.ts\n');

        const result = await service.getDiffFiles({
          projectPath: '/project',
          baseBranch: 'main',
          commitOid: 'root123',
        });

        expect(mockGit.diffSummary).toHaveBeenCalledWith([EMPTY_TREE_HASH, 'root123']);
        // Every file in a root commit reads as added against the empty tree.
        expect(result.files[0].status).toBe('A');
      });

      it('commitOid takes precedence over scope', async () => {
        mockGit.raw.mockResolvedValue('parent999\n');
        mockGit.diffSummary.mockResolvedValue(makeDiffSummary([]));
        mockGit.diff.mockResolvedValue('');

        await service.getDiffFiles({
          projectPath: '/project',
          baseBranch: 'main',
          scope: 'staged',
          commitOid: 'commit123',
        });

        // The commit-diff args are used, not the staged-scope args (--cached).
        expect(mockGit.diffSummary).toHaveBeenCalledWith(['parent999', 'commit123']);
        expect(mockGit.diffSummary).not.toHaveBeenCalledWith(['--cached']);
      });
    });

    describe('getFileContent', () => {
      it('reads both original and modified from the commit tree, never disk', async () => {
        mockGit.raw.mockResolvedValue('parent999\n');
        mockGit.show.mockImplementation(async (args: string[]) => {
          const ref = args[0];
          if (ref.startsWith('parent999:')) return 'parent content';
          if (ref.startsWith('commit123:')) return 'commit content';
          return 'other';
        });

        const result = await service.getFileContent({
          projectPath: '/project',
          worktreePath: '/project/wt',
          baseBranch: 'main',
          filePath: 'src/a.ts',
          status: 'M',
          commitOid: 'commit123',
        });

        expect(mockGit.show).toHaveBeenCalledWith(['parent999:src/a.ts']);
        expect(mockGit.show).toHaveBeenCalledWith(['commit123:src/a.ts']);
        expect(fs.promises.readFile).not.toHaveBeenCalled();
        expect(result.original).toBe('parent content');
        expect(result.modified).toBe('commit content');
      });

      it('added file in a commit: original is skipped (empty), modified still reads from the commit tree', async () => {
        mockGit.show.mockResolvedValue('new file content');

        const result = await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/new.ts',
          status: 'A',
          commitOid: 'commit123',
        });

        expect(result.original).toBe('');
        expect(mockGit.show).toHaveBeenCalledWith(['commit123:src/new.ts']);
        expect(result.modified).toBe('new file content');
      });

      it('deleted file in a commit: modified is skipped (empty), original still reads from the parent tree', async () => {
        mockGit.raw.mockResolvedValue('parent999\n');
        mockGit.show.mockResolvedValue('old file content');

        const result = await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/removed.ts',
          status: 'D',
          commitOid: 'commit123',
        });

        expect(mockGit.show).toHaveBeenCalledWith(['parent999:src/removed.ts']);
        expect(result.original).toBe('old file content');
        expect(result.modified).toBe('');
      });

      it('root commit: original reads from the empty tree', async () => {
        mockGit.raw.mockRejectedValue(new Error('fatal: unknown revision'));
        mockGit.show.mockResolvedValue('root file content');

        const result = await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/a.ts',
          status: 'M',
          commitOid: 'root123',
        });

        expect(mockGit.show).toHaveBeenCalledWith([`${EMPTY_TREE_HASH}:src/a.ts`]);
        expect(result.original).toBe('root file content');
      });

      it('caches the resolved parent ref across calls for the same commitOid', async () => {
        mockGit.raw.mockResolvedValue('parent999\n');
        mockGit.show.mockResolvedValue('content');

        await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/a.ts',
          status: 'M',
          commitOid: 'commit123',
        });
        await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/b.ts',
          status: 'M',
          commitOid: 'commit123',
        });

        // rev-parse is only spawned once for the same commitOid across calls.
        expect(mockGit.raw).toHaveBeenCalledTimes(1);
      });

      it('does NOT cache a failed (empty-tree fallback) parent-ref resolution: a transient error is retried on the next call', async () => {
        // First call: rev-parse fails transiently (not a genuine root commit) -
        // falls back to the empty tree but must not poison the cache for
        // commit123, per resolveParentRef's doc comment ("only a SUCCESSFUL
        // resolution is cached").
        mockGit.raw.mockRejectedValueOnce(new Error('fatal: transient git error'));
        mockGit.show.mockResolvedValue('content');

        await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/a.ts',
          status: 'M',
          commitOid: 'commit123',
        });
        expect(mockGit.show).toHaveBeenCalledWith([`${EMPTY_TREE_HASH}:src/a.ts`]);

        // Second call for the SAME commitOid: rev-parse now succeeds. If the
        // empty-tree fallback had been (incorrectly) cached, this would still
        // resolve to the empty tree instead of the real parent.
        mockGit.raw.mockResolvedValueOnce('parent999\n');
        await service.getFileContent({
          projectPath: '/project',
          baseBranch: 'main',
          filePath: 'src/b.ts',
          status: 'M',
          commitOid: 'commit123',
        });

        // rev-parse was retried (spawned twice total), and the second call's
        // successful resolution is used for the original side.
        expect(mockGit.raw).toHaveBeenCalledTimes(2);
        expect(mockGit.show).toHaveBeenCalledWith(['parent999:src/b.ts']);
      });
    });
  });

  // The image view's byte reader. Same per-scope revisions as getFileContent;
  // what differs is that no side is ever decoded as text, a side is
  // fingerprinted before anything else is read, and its size is checked
  // before its bytes are read.
  describe('getImageContent', () => {
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const OVER_CAP = 10 * 1024 * 1024 + 1;
    /** A modified time well outside RECENT_WRITE_WINDOW_MS, so a match is trusted. */
    const SETTLED_MTIME_MS = Date.now() - 60_000;
    const baseInput = {
      projectPath: '/project',
      worktreePath: '/project/wt',
      baseBranch: 'main',
      filePath: 'img/a.png',
    } as const;

    /** The blob id `rev-parse` reports for an object spec in routeObjects. */
    function objectIdOf(spec: string): string {
      return `oid-${spec}`;
    }

    /**
     * Answers `rev-parse --verify <spec>`, then `cat-file -s <object id>` and
     * `show <spec>`, from one table keyed by object spec.
     */
    function routeObjects(objects: Record<string, Buffer>): void {
      mockGit.revparse.mockImplementation(async (args: string[]) => {
        if (!objects[args[1]]) throw new Error(`fatal: path does not exist: ${args[1]}`);
        return objectIdOf(args[1]);
      });
      mockGit.catFile.mockImplementation(async (args: string[]) => {
        const spec = Object.keys(objects).find((candidate) => objectIdOf(candidate) === args[1]);
        if (spec === undefined) throw new Error(`fatal: not a valid object name ${args[1]}`);
        return `${objects[spec].length}\n`;
      });
      mockGit.showBuffer.mockImplementation(async (args: string[]) => {
        const bytes = objects[args[0]];
        if (!bytes) throw new Error(`fatal: path does not exist: ${args[0]}`);
        return bytes;
      });
    }

    function mockDiskFile(bytes: Buffer, mtimeMs: number = SETTLED_MTIME_MS): void {
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: bytes.length, mtimeMs } as never);
      vi.mocked(fs.promises.readFile).mockResolvedValue(bytes as never);
    }

    it('working scope: original is the index blob, modified is read from disk with no encoding', async () => {
      routeObjects({ ':img/a.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);

      const result = await service.getImageContent({ ...baseInput, status: 'M', scope: 'working' });

      expect(mockGit.revparse).toHaveBeenCalledWith(['--verify', ':img/a.png']);
      expect(mockGit.catFile).toHaveBeenCalledWith(['-s', objectIdOf(':img/a.png')]);
      expect(mockGit.showBuffer).toHaveBeenCalledWith([':img/a.png']);
      expect(fs.promises.readFile).toHaveBeenCalledWith(expect.stringMatching(/img[/\\]a\.png$/));
      expect(vi.mocked(fs.promises.readFile).mock.calls[0]).toHaveLength(1);
      expect(result.original).toEqual({
        kind: 'bytes', size: PNG_BYTES.length, bytes: PNG_BYTES, fingerprint: `blob:${objectIdOf(':img/a.png')}`,
      });
      expect(result.modified).toEqual({
        kind: 'bytes', size: PNG_BYTES.length, bytes: PNG_BYTES, fingerprint: `file:${PNG_BYTES.length}:${SETTLED_MTIME_MS}`,
      });
      expect(mockGit.show).not.toHaveBeenCalled();
    });

    it('a git side whose blob id matches the caller\'s fingerprint answers unchanged and is never read', async () => {
      routeObjects({ 'abc123:img/a.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);
      const originalFingerprint = `blob:${objectIdOf('abc123:img/a.png')}`;

      const result = await service.getImageContent({
        ...baseInput, status: 'M', knownFingerprints: { original: originalFingerprint },
      });

      expect(result.original).toEqual({ kind: 'unchanged', fingerprint: originalFingerprint });
      expect(mockGit.catFile).not.toHaveBeenCalled();
      expect(mockGit.showBuffer).not.toHaveBeenCalled();
      // The side with no known fingerprint is read as usual.
      expect(result.modified?.kind).toBe('bytes');
    });

    it('a disk side whose size and modified time match answers unchanged and is never read', async () => {
      routeObjects({ 'abc123:img/a.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);
      const modifiedFingerprint = `file:${PNG_BYTES.length}:${SETTLED_MTIME_MS}`;

      const result = await service.getImageContent({
        ...baseInput, status: 'M', knownFingerprints: { modified: modifiedFingerprint },
      });

      expect(result.modified).toEqual({ kind: 'unchanged', fingerprint: modifiedFingerprint });
      expect(fs.promises.readFile).not.toHaveBeenCalled();
      expect(result.original?.kind).toBe('bytes');
    });

    it('a disk side written inside the recent-write window is reread even when its fingerprint matches', async () => {
      // A second write in the same timestamp tick keeps size and modified time
      // equal, so a match this fresh cannot be trusted. The clock is pinned, so
      // the gap between the two reads of it cannot carry the case out of the window.
      const nowMs = 1_800_000_000_000;
      const recentMtimeMs = nowMs - Math.floor(RECENT_WRITE_WINDOW_MS / 4);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(nowMs);
      try {
        routeObjects({ 'abc123:img/a.png': PNG_BYTES });
        mockDiskFile(PNG_BYTES, recentMtimeMs);
        const modifiedFingerprint = `file:${PNG_BYTES.length}:${recentMtimeMs}`;

        const result = await service.getImageContent({
          ...baseInput, status: 'M', knownFingerprints: { modified: modifiedFingerprint },
        });

        expect(result.modified).toEqual({ kind: 'bytes', size: PNG_BYTES.length, bytes: PNG_BYTES, fingerprint: modifiedFingerprint });
        expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a fingerprint that no longer matches reads the side again', async () => {
      routeObjects({ 'abc123:img/a.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);

      const result = await service.getImageContent({
        ...baseInput,
        status: 'M',
        knownFingerprints: { original: 'blob:an-older-blob', modified: `file:${PNG_BYTES.length}:${SETTLED_MTIME_MS - 1}` },
      });

      expect(result.original?.kind).toBe('bytes');
      expect(result.modified?.kind).toBe('bytes');
      expect(mockGit.showBuffer).toHaveBeenCalledWith(['abc123:img/a.png']);
      expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
    });

    it('staged scope: original is HEAD, modified is the index blob, nothing from disk', async () => {
      routeObjects({ 'HEAD:img/a.png': PNG_BYTES, ':img/a.png': PNG_BYTES });

      const result = await service.getImageContent({ ...baseInput, status: 'M', scope: 'staged' });

      expect(mockGit.showBuffer).toHaveBeenCalledWith(['HEAD:img/a.png']);
      expect(mockGit.showBuffer).toHaveBeenCalledWith([':img/a.png']);
      expect(fs.promises.readFile).not.toHaveBeenCalled();
      expect(result.original?.kind).toBe('bytes');
      expect(result.modified?.kind).toBe('bytes');
    });

    it('branch scope (the default): original is the merge base', async () => {
      routeObjects({ 'abc123:img/a.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);

      const result = await service.getImageContent({ ...baseInput, status: 'M' });

      expect(mockGit.showBuffer).toHaveBeenCalledWith(['abc123:img/a.png']);
      expect(result.original?.kind).toBe('bytes');
    });

    it('commit selection: both sides come from the commit and its parent, never disk', async () => {
      mockGit.raw.mockResolvedValue('parent999\n');
      routeObjects({ 'parent999:img/a.png': PNG_BYTES, 'commit123:img/a.png': PNG_BYTES });

      const result = await service.getImageContent({ ...baseInput, status: 'M', commitOid: 'commit123' });

      expect(mockGit.showBuffer).toHaveBeenCalledWith(['parent999:img/a.png']);
      expect(mockGit.showBuffer).toHaveBeenCalledWith(['commit123:img/a.png']);
      expect(fs.promises.stat).not.toHaveBeenCalled();
      expect(result.original?.kind).toBe('bytes');
      expect(result.modified?.kind).toBe('bytes');
    });

    it('rename: the original side reads from the old path', async () => {
      routeObjects({ 'abc123:img/old.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);

      const result = await service.getImageContent({ ...baseInput, status: 'R', oldPath: 'img/old.png' });

      expect(mockGit.showBuffer).toHaveBeenCalledWith(['abc123:img/old.png']);
      expect(result.original?.kind).toBe('bytes');
    });

    it('Added and Untracked have no original side; Deleted has no modified side', async () => {
      routeObjects({ 'abc123:img/a.png': PNG_BYTES });
      mockDiskFile(PNG_BYTES);

      const added = await service.getImageContent({ ...baseInput, status: 'A' });
      const untracked = await service.getImageContent({ ...baseInput, status: 'U' });
      const deleted = await service.getImageContent({ ...baseInput, status: 'D' });

      expect(added.original).toBeNull();
      expect(added.modified?.kind).toBe('bytes');
      expect(untracked.original).toBeNull();
      expect(deleted.modified).toBeNull();
      expect(deleted.original?.kind).toBe('bytes');
    });

    it('a side over the 10 MB cap reports its size and is never read', async () => {
      mockGit.revparse.mockResolvedValue('big-blob\n');
      mockGit.catFile.mockResolvedValue(`${OVER_CAP}\n`);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: OVER_CAP, mtimeMs: SETTLED_MTIME_MS } as never);

      const result = await service.getImageContent({ ...baseInput, status: 'M' });

      expect(result.original).toEqual({ kind: 'too-large', size: OVER_CAP, fingerprint: 'blob:big-blob' });
      expect(result.modified).toEqual({ kind: 'too-large', size: OVER_CAP, fingerprint: `file:${OVER_CAP}:${SETTLED_MTIME_MS}` });
      expect(mockGit.showBuffer).not.toHaveBeenCalled();
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });

    it('a side of exactly the cap is still read: only a larger side is withheld', async () => {
      // Both readers report a size of exactly IMAGE_PREVIEW_MAX_BYTES but hand back
      // a small buffer, so the test never allocates 10 MB. The size check runs on
      // what `cat-file -s` and `stat` report, before any read, so a `>=` in the cap
      // comparison would turn both sides into `too-large` and skip both reads.
      mockGit.revparse.mockResolvedValue('cap-blob\n');
      mockGit.catFile.mockResolvedValue(`${IMAGE_PREVIEW_MAX_BYTES}\n`);
      mockGit.showBuffer.mockResolvedValue(PNG_BYTES);
      vi.mocked(fs.promises.stat).mockResolvedValue({ size: IMAGE_PREVIEW_MAX_BYTES, mtimeMs: SETTLED_MTIME_MS } as never);
      vi.mocked(fs.promises.readFile).mockResolvedValue(PNG_BYTES as never);

      const result = await service.getImageContent({ ...baseInput, status: 'M' });

      expect(result.original?.kind).toBe('bytes');
      expect(result.modified?.kind).toBe('bytes');
      expect(mockGit.showBuffer).toHaveBeenCalledWith(['abc123:img/a.png']);
      expect(fs.promises.readFile).toHaveBeenCalledWith(expect.stringMatching(/img[/\\]a\.png$/));
    });

    it('a Git LFS pointer in place of the image is reported as one', async () => {
      const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n');
      routeObjects({ 'abc123:img/a.png': pointer });
      mockDiskFile(PNG_BYTES);

      const result = await service.getImageContent({ ...baseInput, status: 'M' });

      expect(result.original).toEqual({
        kind: 'lfs-pointer', size: pointer.length, fingerprint: `blob:${objectIdOf('abc123:img/a.png')}`,
      });
      expect(result.modified?.kind).toBe('bytes');
    });

    it('a failed read on either side is unreadable, not an exception', async () => {
      mockGit.revparse.mockRejectedValue(new Error('fatal: bad object'));
      vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'));

      const result = await service.getImageContent({ ...baseInput, status: 'M' });

      expect(result).toEqual({ original: { kind: 'unreadable' }, modified: { kind: 'unreadable' } });
    });
  });
});
