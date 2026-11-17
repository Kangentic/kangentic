/**
 * The Obsidian board adapters on a real vault in a temp folder: the folder check
 * a saved source runs before the Import dialog loads, the mapping into
 * ExternalIssue (display text, priority name, status order, the note's file
 * link, embedded files), one vault read serving a reconcile's fetch and prune,
 * and the local copy of embedded files with its size cap and vault boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({ isAsyncEncryptionAvailable: () => false }),
  };
});

import { ObsidianChecklistAdapter, ObsidianNotesAdapter } from '../../src/main/boards/adapters/obsidian';
import { MAX_ATTACHMENT_SIZE } from '../../src/main/boards/shared';

let sandbox: string;
let vault: string;

function write(vaultPath: string, text: string): string {
  const absolute = path.join(vault, ...vaultPath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
  return absolute;
}

const noneImported = () => new Set<string>();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-obsidian-adapter-'));
  vault = path.join(sandbox, 'Work');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('the folder check', () => {
  it('passes with no folder named, which is the Add Source step', async () => {
    expect(await new ObsidianNotesAdapter().checkCli()).toEqual({ available: true, authenticated: true, error: undefined });
  });

  it('passes for a folder that is inside a vault', async () => {
    expect(await new ObsidianNotesAdapter().checkCli(vault)).toEqual({ available: true, authenticated: true, error: undefined });
  });

  it('names a folder that is gone, and one that is no longer in a vault', async () => {
    const adapter = new ObsidianNotesAdapter();
    const gone = path.join(vault, 'Moved');
    expect(await adapter.checkCli(gone)).toMatchObject({ available: false, error: `Folder not found: ${gone}` });
    fs.rmSync(path.join(vault, '.obsidian'), { recursive: true, force: true });
    expect(await adapter.checkCli(vault)).toMatchObject({ available: false, error: `Not in a vault: ${vault}` });
  });
});

describe('fetch', () => {
  it('maps a note into an ExternalIssue with its folder, priority name and file link', async () => {
    write('Assets/hero.png', 'png');
    const notePath = write('Projects/Website relaunch.md', '---\npriority: high\nstatus: done\n---\nShip it. ![[hero.png]] ![x](https://example.com/a.png)');
    const result = await new ObsidianNotesAdapter().fetch(
      { source: 'obsidian_notes', repository: vault, page: 1, perPage: 100 },
      (_source, ids) => new Set(ids),
    );
    expect(result.hasNextPage).toBe(false);
    const [issue] = result.issues;
    expect(issue).toMatchObject({
      externalId: 'Projects/Website relaunch.md',
      externalSource: 'obsidian_notes',
      externalUrl: pathToFileURL(notePath).href,
      title: 'Website relaunch',
      displayId: 'Projects/',
      priority: 'high',
      stateCategory: 'closed',
      alreadyImported: true,
      attachmentCount: 2,
    });
    expect(issue.stateOrder).toBeUndefined();
    expect(issue.fileAttachments).toEqual([{
      url: pathToFileURL(path.join(vault, 'Assets', 'hero.png')).href,
      filename: 'hero.png',
      sizeBytes: 3,
      externalRef: 'Assets/hero.png',
    }]);
  });

  it('gives checklist items their note as display text and a status order', async () => {
    write('Projects/List.md', '- [/] Compress the hero images ⏫\n- [ ] Redirect the old blog URLs');
    const { issues } = await new ObsidianChecklistAdapter().fetch(
      { source: 'obsidian_checklist', repository: vault, page: 1, perPage: 100 },
      noneImported,
    );
    expect(issues.map((issue) => [issue.title, issue.displayId, issue.state, issue.stateOrder, issue.priority])).toEqual([
      ['Compress the hero images', 'List', 'In progress', 1, 'High'],
      ['Redirect the old blog URLs', 'List', 'To do', 0, undefined],
    ]);
  });

  it('returns everything on the first page and nothing after it', async () => {
    write('Notes/a.md', 'a');
    const second = await new ObsidianNotesAdapter().fetch(
      { source: 'obsidian_notes', repository: vault, page: 2, perPage: 100 },
      noneImported,
    );
    expect(second).toEqual({ issues: [], totalCount: 0, hasNextPage: false });
  });

  it('serves a reconcile fetch and its prune from one read of the vault', async () => {
    write('Notes/a.md', 'a');
    const adapter = new ObsidianNotesAdapter();
    await adapter.fetch({ source: 'obsidian_notes', repository: vault, page: 1, perPage: 100 }, noneImported);
    write('Notes/b.md', 'b');
    expect(await adapter.listExternalIds({ source: 'obsidian_notes', repository: vault })).toEqual(['Notes/a.md']);
    expect(await new ObsidianNotesAdapter().listExternalIds({ source: 'obsidian_notes', repository: vault }))
      .toEqual(['Notes/a.md', 'Notes/b.md']);
  });

  it('drops a read that rejected, so the next fetch inside the window reads again', async () => {
    const adapter = new ObsidianNotesAdapter();
    const later = path.join(vault, 'Later');
    const input = { source: 'obsidian_notes' as const, repository: later, page: 1, perPage: 100 };
    await expect(adapter.fetch(input, noneImported)).rejects.toThrow('Folder not found');
    write('Later/a.md', 'a');
    const result = await adapter.fetch(input, noneImported);
    expect(result.issues.map((issue) => issue.externalId)).toEqual(['Later/a.md']);
  });

  it('reads the vault again once the reuse window has passed', async () => {
    vi.useFakeTimers();
    try {
      write('Notes/a.md', 'a');
      const adapter = new ObsidianNotesAdapter();
      const input = { source: 'obsidian_notes' as const, repository: vault, page: 1, perPage: 100 };
      await adapter.fetch(input, noneImported);
      write('Notes/b.md', 'b');
      vi.advanceTimersByTime(5_001);
      const result = await adapter.fetch(input, noneImported);
      expect(result.issues.map((issue) => issue.externalId)).toEqual(['Notes/a.md', 'Notes/b.md']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('downloadFileAttachments', () => {
  it('copies a file inside a vault and skips one outside, one too large and one gone', async () => {
    const inside = write('Assets/brief.pdf', 'pdf-bytes');
    const outsidePath = path.join(sandbox, 'secret.txt');
    fs.writeFileSync(outsidePath, 'not in a vault');
    const tooBig = write('Assets/huge.mov', '');
    fs.truncateSync(tooBig, MAX_ATTACHMENT_SIZE + 1);
    const reference = (absolute: string) => ({ url: pathToFileURL(absolute).href, filename: path.basename(absolute), sizeBytes: 0 });

    const result = await new ObsidianNotesAdapter().downloadFileAttachments([
      reference(inside),
      reference(outsidePath),
      reference(tooBig),
      reference(path.join(vault, 'Assets', 'gone.png')),
      { url: 'https://example.com/a.png', filename: 'a.png', sizeBytes: 0 },
    ]);
    expect(result.skippedCount).toBe(4);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      filename: 'brief.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 9,
      data: Buffer.from('pdf-bytes').toString('base64'),
    });
  });

  it('skips a plugin file, a folder, a network host and a file reached through a link out of the vault', async () => {
    const good = write('Assets/ok.png', 'png');
    const pluginFile = write('.obsidian/plugins/x/data.json', '{}');
    const folder = path.join(vault, 'Assets', 'inner');
    fs.mkdirSync(folder, { recursive: true });
    const outsideFolder = path.join(sandbox, 'outside');
    fs.mkdirSync(outsideFolder);
    fs.writeFileSync(path.join(outsideFolder, 'secret.png'), 'secret');
    // A junction needs no admin right on Windows; the type is ignored on POSIX.
    fs.symlinkSync(outsideFolder, path.join(vault, 'linked'), 'junction');
    const reference = (url: string, filename: string) => ({ url, filename, sizeBytes: 0 });

    const result = await new ObsidianNotesAdapter().downloadFileAttachments([
      reference(pathToFileURL(pluginFile).href, 'data.json'),
      reference(pathToFileURL(folder).href, 'inner'),
      reference('file://server/share/Vault/a.png', 'a.png'),
      reference(pathToFileURL(path.join(vault, 'linked', 'secret.png')).href, 'secret.png'),
      reference(pathToFileURL(good).href, 'ok.png'),
    ]);
    expect(result.skippedCount).toBe(4);
    expect(result.attachments.map((attachment) => attachment.filename)).toEqual(['ok.png']);
  });
});
