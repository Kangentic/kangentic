/**
 * scripts/lib/demo-browser-send.mjs is the scratch-tree half of recording a Browser pane Send
 * (scripts/capture-demo-sessions.mjs, the manifest's `browserSends`). The send resumes a session's
 * conversation on a freshly reset clone, so `applyRecordedChanges` first puts the session's own
 * edits back (the resumed agent would otherwise find none of the code it says it wrote), and
 * `excludeFromGit` keeps the project's `.kangentic/` out of git's view while the screenshot the
 * payload names sits under it. Both write into a real repository, and neither had a test.
 *
 * A wrong edit here is quiet. A binary file written from its empty `modified` text would blank a
 * file the conversation edited, and an exclude restore that is not byte-exact would leave the
 * clone's `.git/info/exclude` changed after every capture. The change shapes below are the ones
 * collectChanges in scripts/capture-agent-scrollback.js records: a deletion and a binary or
 * oversized file carry `modified: ''`, and only a plain add or edit carries the file's text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRecordedChanges, excludeFromGit } from '../../scripts/lib/demo-browser-send.mjs';

let workingTree: string;

beforeEach(() => {
  workingTree = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-demo-browser-send-'));
});

afterEach(() => {
  fs.rmSync(workingTree, { recursive: true, force: true });
});

describe('applyRecordedChanges', () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

  function changeFile(file: Record<string, unknown>): Record<string, unknown> {
    return { binary: false, original: '', modified: '', insertions: 0, deletions: 0, language: null, ...file };
  }

  it('deletes a D file, writes A and M files with their modified text, and builds missing directories', () => {
    fs.mkdirSync(path.join(workingTree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workingTree, 'src', 'removed.ts'), 'old contents');
    fs.writeFileSync(path.join(workingTree, 'src', 'edited.ts'), 'before the edit');
    const recording = {
      changes: {
        files: [
          changeFile({ path: 'src/removed.ts', status: 'D' }),
          changeFile({ path: 'src/edited.ts', status: 'M', modified: 'after the edit\n' }),
          changeFile({ path: 'src/deep/er/added.ts', status: 'A', modified: 'export const added = true;\n' }),
        ],
      },
    };

    const result = applyRecordedChanges(recording, workingTree);

    expect(fs.existsSync(path.join(workingTree, 'src', 'removed.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(workingTree, 'src', 'edited.ts'), 'utf-8')).toBe('after the edit\n');
    expect(fs.readFileSync(path.join(workingTree, 'src', 'deep', 'er', 'added.ts'), 'utf-8')).toBe('export const added = true;\n');
    expect(result).toEqual({ applied: ['src/removed.ts', 'src/edited.ts', 'src/deep/er/added.ts'], skipped: [] });
  });

  it('leaves a binary file as the tree has it and names it in skipped, instead of writing its empty text over it', () => {
    fs.mkdirSync(path.join(workingTree, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(workingTree, 'assets', 'logo.png'), PNG_BYTES);
    const recording = {
      changes: {
        files: [
          changeFile({ path: 'assets/logo.png', status: 'M', binary: true }),
          changeFile({ path: 'notes.md', status: 'A', modified: 'a note\n' }),
        ],
      },
    };

    const result = applyRecordedChanges(recording, workingTree);

    expect(fs.readFileSync(path.join(workingTree, 'assets', 'logo.png')).equals(PNG_BYTES)).toBe(true);
    expect(fs.readFileSync(path.join(workingTree, 'notes.md'), 'utf-8')).toBe('a note\n');
    expect(result).toEqual({ applied: ['notes.md'], skipped: ['assets/logo.png'] });
  });

  it('does not create a binary file the tree does not have, and does not create its directory', () => {
    const recording = { changes: { files: [changeFile({ path: 'assets/new.png', status: 'A', binary: true })] } };

    const result = applyRecordedChanges(recording, workingTree);

    expect(fs.existsSync(path.join(workingTree, 'assets'))).toBe(false);
    expect(result).toEqual({ applied: [], skipped: ['assets/new.png'] });
  });

  it('treats a deletion of a file the tree already lacks as applied, not an error', () => {
    const recording = { changes: { files: [changeFile({ path: 'gone.ts', status: 'D' })] } };

    expect(applyRecordedChanges(recording, workingTree)).toEqual({ applied: ['gone.ts'], skipped: [] });
  });

  it('applies nothing for a recording that carries no changes', () => {
    expect(applyRecordedChanges({}, workingTree)).toEqual({ applied: [], skipped: [] });
    expect(applyRecordedChanges({ changes: { files: [] } }, workingTree)).toEqual({ applied: [], skipped: [] });
    expect(fs.readdirSync(workingTree)).toEqual([]);
  });
});

describe('excludeFromGit', () => {
  const PATTERN = '.kangentic/';

  function excludePathOf(): string {
    return path.join(workingTree, '.git', 'info', 'exclude');
  }

  function writeExclude(contents: string): void {
    fs.mkdirSync(path.dirname(excludePathOf()), { recursive: true });
    fs.writeFileSync(excludePathOf(), contents);
  }

  it('adds a newline before the pattern when the file did not end with one, and restores the exact bytes', () => {
    const original = '# comment\nbuild/';
    writeExclude(original);

    const restoreExclude = excludeFromGit(workingTree, PATTERN);

    expect(fs.readFileSync(excludePathOf(), 'utf-8')).toBe('# comment\nbuild/\n.kangentic/\n');
    restoreExclude();
    expect(fs.readFileSync(excludePathOf()).equals(Buffer.from(original))).toBe(true);
  });

  it('adds no blank line when the file already ended with a newline, and restores the exact bytes', () => {
    const original = '# comment\nbuild/\n';
    writeExclude(original);

    const restoreExclude = excludeFromGit(workingTree, PATTERN);

    expect(fs.readFileSync(excludePathOf(), 'utf-8')).toBe('# comment\nbuild/\n.kangentic/\n');
    restoreExclude();
    expect(fs.readFileSync(excludePathOf()).equals(Buffer.from(original))).toBe(true);
  });

  it('restores an existing but empty file as an empty file, not as a missing one', () => {
    writeExclude('');

    const restoreExclude = excludeFromGit(workingTree, PATTERN);

    expect(fs.readFileSync(excludePathOf(), 'utf-8')).toBe('.kangentic/\n');
    restoreExclude();
    expect(fs.existsSync(excludePathOf())).toBe(true);
    expect(fs.readFileSync(excludePathOf(), 'utf-8')).toBe('');
  });

  it('creates the file, and its directory, when the clone has none, and restoring removes the file', () => {
    expect(fs.existsSync(path.join(workingTree, '.git'))).toBe(false);

    const restoreExclude = excludeFromGit(workingTree, PATTERN);

    expect(fs.readFileSync(excludePathOf(), 'utf-8')).toBe('.kangentic/\n');
    restoreExclude();
    expect(fs.existsSync(excludePathOf())).toBe(false);
  });
});
