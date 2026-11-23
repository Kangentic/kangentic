/**
 * Unit tests for src/main/agent/shared/kangentic-made-folder.ts: which folders
 * an adapter's removed-folder sweep may drop entries for, who owns them, and
 * when a folder counts as gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderExists, isKangenticMadeFolder, kangenticMadeFolderOwner } from '../../src/main/agent/shared/kangentic-made-folder';

describe('isKangenticMadeFolder and kangenticMadeFolderOwner', () => {
  it.each([
    ['C:\\Users\\dev\\repo\\.kangentic\\worktrees\\task-1', 'C:\\Users\\dev\\repo'],
    ['C:/Users/dev/repo/.kangentic/worktrees/task-1', 'C:/Users/dev/repo'],
    ['/home/dev/repo/.kangentic/data/preview-projects/project-1', '/home/dev/repo'],
    ['/home/dev/repo/.kangentic/worktrees/task-1/src/deep/folder', '/home/dev/repo'],
    ['C:\\Users\\dev\\repo\\.Kangentic\\Worktrees\\x', 'C:\\Users\\dev\\repo'],
  ])('%s is made, owned by %s', (folderPath, owner) => {
    expect(isKangenticMadeFolder(folderPath)).toBe(true);
    expect(kangenticMadeFolderOwner(folderPath)).toBe(owner);
  });

  it.each([
    'C:\\Users\\dev\\repo\\.kangentic\\worktrees',
    '/home/dev/repo/.kangentic/worktrees/',
    '/home/dev/repo/.kangentic/data/preview-projects',
    '/home/dev/repo',
    '/home/dev/repo/.kangentic/sessions/abc',
  ])('%s is not made and has no owner', (folderPath) => {
    expect(isKangenticMadeFolder(folderPath)).toBe(false);
    expect(kangenticMadeFolderOwner(folderPath)).toBeNull();
  });
});

describe('folderExists', () => {
  let tmpFolder: string;

  beforeEach(() => {
    tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-made-folder-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpFolder, { recursive: true, force: true });
  });

  it('is true for a folder that exists', async () => {
    expect(await folderExists(tmpFolder)).toBe(true);
  });

  it('is false only when stat says ENOENT', async () => {
    expect(await folderExists(path.join(tmpFolder, 'missing'))).toBe(false);
  });

  it.each(['EACCES', 'EPERM'])('is true when stat fails with %s, so an unreadable folder keeps its entries', async (code) => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('refused'), { code }));
    expect(await folderExists(tmpFolder)).toBe(true);
  });
});
