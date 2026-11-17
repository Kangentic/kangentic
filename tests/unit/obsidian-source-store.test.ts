/**
 * Adding an Obsidian source: importing the adapter module registers the folder
 * parser for both source types, so the saved source keeps the resolved folder as
 * its repository and the vault-aware label, and a folder outside any vault is
 * refused before anything is stored.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({ isAsyncEncryptionAvailable: () => false }),
  };
});

import '../../src/main/boards/adapters/obsidian';
import { ImportSourceStore } from '../../src/main/boards/shared/source-store';
import type { ExternalSource } from '../../src/shared/types';

let sandbox: string;
let project: string;
let vault: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-obsidian-store-'));
  project = path.join(sandbox, 'project');
  vault = path.join(sandbox, 'Work');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each<ExternalSource>(['obsidian_notes', 'obsidian_checklist'])('ImportSourceStore.add for %s', (source) => {
  it('refuses a folder outside any vault and stores nothing', () => {
    const outside = path.join(sandbox, 'Recipes');
    fs.mkdirSync(outside);
    const store = new ImportSourceStore(project);
    expect(() => store.add(source, outside)).toThrow('Not in a vault');
    expect(store.list()).toEqual([]);
  });

  it('keeps the resolved folder as the repository and labels it with the vault and folder', () => {
    const store = new ImportSourceStore(project);
    const added = store.add(source, path.join(vault, 'Projects'));
    expect(added).toMatchObject({ source, repository: path.resolve(vault, 'Projects'), label: 'Work: Projects' });
    expect(store.list()).toHaveLength(1);
  });
});
