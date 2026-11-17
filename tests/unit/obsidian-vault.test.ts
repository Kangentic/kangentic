/**
 * The Obsidian vault reader: finding a vault, reading note properties, the two
 * mappings (one note per task, one checklist line per task), the ids that keep
 * an item matched across re-imports, and embed resolution. Every case runs on
 * a real vault written to a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitNote, propertyList, propertyText } from '../../src/main/boards/adapters/obsidian/frontmatter';
import { findVaultRoot } from '../../src/main/boards/adapters/obsidian/vault';
import { folderProblem, readVaultItems } from '../../src/main/boards/adapters/obsidian/vault-reader';
import { buildVaultIndex, resolveEmbed } from '../../src/main/boards/adapters/obsidian/embeds';
import { taskTitle, taskPriorityName } from '../../src/main/boards/adapters/obsidian/checklist-mapper';
import { buildObsidianLabel, parseObsidianFolder } from '../../src/main/boards/adapters/obsidian/url-parser';
import { MAX_ATTACHMENT_SIZE } from '../../src/main/boards/shared/download-file';

let sandbox: string;
let vault: string;

function write(vaultPath: string, text: string): string {
  const absolute = path.join(vault, ...vaultPath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
  return absolute;
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-obsidian-'));
  vault = path.join(sandbox, 'Work');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('finding the vault', () => {
  it('walks up from a folder inside the vault', () => {
    write('Projects/Billing/Invoices.md', 'x');
    expect(findVaultRoot(path.join(vault, 'Projects', 'Billing'))).toBe(vault);
    expect(findVaultRoot(vault)).toBe(vault);
  });

  it('finds nothing outside a vault', () => {
    const outside = path.join(sandbox, 'Recipes');
    fs.mkdirSync(outside);
    expect(findVaultRoot(outside)).toBeNull();
  });

  it('names what is wrong with a folder', () => {
    const outside = path.join(sandbox, 'Recipes');
    fs.mkdirSync(outside);
    expect(folderProblem(path.join(vault, 'Gone'))).toBe(`Folder not found: ${path.join(vault, 'Gone')}`);
    expect(folderProblem(outside)).toBe(`Not in a vault: ${outside}`);
    expect(folderProblem(vault)).toBeNull();
  });
});

describe('the folder a source is added by', () => {
  it('keeps the chosen folder as the repository', () => {
    fs.mkdirSync(path.join(vault, 'Projects'));
    expect(parseObsidianFolder(path.join(vault, 'Projects'))).toEqual({ repository: path.join(vault, 'Projects') });
  });

  it('refuses a folder outside any vault', () => {
    const outside = path.join(sandbox, 'Recipes');
    fs.mkdirSync(outside);
    expect(() => parseObsidianFolder(outside)).toThrow(`Not in a vault: ${outside}`);
  });

  it('labels the vault, then the folder', () => {
    fs.mkdirSync(path.join(vault, 'Projects'));
    expect(buildObsidianLabel(vault)).toBe('Work');
    expect(buildObsidianLabel(path.join(vault, 'Projects'))).toBe('Work: Projects');
  });
});

describe('note properties', () => {
  it('reads scalars, quoted strings, flow lists and block lists', () => {
    const { properties, body } = splitNote([
      '---',
      'title: "Launch: phase 2"',
      'status: active # set by hand',
      'tags: [web, "q4"]',
      'aliases:',
      '  - Relaunch',
      '  - Site v2',
      "owner: 'Dana''s'",
      '---',
      'Body text.',
    ].join('\n'));
    expect(propertyText(properties, 'title')).toBe('Launch: phase 2');
    expect(propertyText(properties, 'status')).toBe('active');
    expect(propertyList(properties, 'tags')).toEqual(['web', 'q4']);
    expect(propertyList(properties, 'aliases')).toEqual(['Relaunch', 'Site v2']);
    expect(propertyText(properties, 'owner')).toBe("Dana's");
    expect(body).toBe('Body text.');
  });

  it('reads a block scalar and a comma list, and keeps a quoted wiki-link', () => {
    const { properties } = splitNote('---\nsummary: |\n  line one\n  line two\ntags: a, b\nproject: "[[Website]]"\n---\n');
    expect(propertyText(properties, 'summary')).toBe('line one\nline two');
    expect(propertyList(properties, 'tags')).toEqual(['a', 'b']);
    expect(propertyText(properties, 'project')).toBe('[[Website]]');
  });

  it('treats a note with no closing fence as having no properties', () => {
    const { properties, body } = splitNote('---\ntitle: x\nno closing fence');
    expect(properties).toEqual([]);
    expect(body).toContain('title: x');
  });
});

describe('a Notes source', () => {
  it('maps the properties the design names and lists the rest under ## Obsidian', async () => {
    write('Projects/Website relaunch.md', [
      '---',
      'status: active',
      'priority: high',
      'tags: [web, q4]',
      'due: 2026-12-05',
      'owner: Dana',
      'aliases: [Relaunch]',
      '---',
      'Move the site before the launch. #seo',
      '',
      '```',
      '#notatag',
      '```',
      'Issue #123 and `#code` are not tags.',
    ].join('\n'));
    const { items } = await readVaultItems(vault, 'notes');
    expect(items).toHaveLength(1);
    const [note] = items;
    expect(note.externalId).toBe('Projects/Website relaunch.md');
    expect(note.title).toBe('Website relaunch');
    expect(note.labels).toEqual(['web', 'q4', 'seo']);
    expect(note.priorityName).toBe('high');
    expect(note.state).toBe('active');
    expect(note.closed).toBe(false);
    expect(note.displayText).toBe('Projects/');
    expect(note.body).toContain('Move the site before the launch.');
    expect(note.body).toContain('## Obsidian\n\n- **due**: 2026-12-05\n- **owner**: Dana');
    expect(note.body).not.toContain('Relaunch');
  });

  it('takes the title property, and closes on a done status in any case', async () => {
    write('Notes/a.md', '---\ntitle: Ship the invoices\nstatus: Completed\n---\n');
    write('Notes/b.md', 'No properties at all.');
    const { items } = await readVaultItems(vault, 'notes');
    const byId = new Map(items.map((item) => [item.externalId, item]));
    expect(byId.get('Notes/a.md')).toMatchObject({ title: 'Ship the invoices', closed: true, state: 'Completed' });
    expect(byId.get('Notes/b.md')).toMatchObject({ title: 'b', closed: false, state: 'No status', priorityName: null });
  });

  it('reads only the chosen folder, and skips templates, dot folders and Kanban boards', async () => {
    fs.writeFileSync(path.join(vault, '.obsidian', 'templates.json'), JSON.stringify({ folder: 'Templates' }));
    write('Projects/One.md', 'one');
    write('Projects/Board.md', '---\nkanban-plugin: board\n---\n## Lane\n- [ ] card');
    write('Daily/2026-11-16.md', 'daily');
    write('Templates/Project.md', 'template');
    write('.trash/Old.md', 'old');
    const whole = await readVaultItems(vault, 'notes');
    expect(whole.items.map((item) => item.externalId).sort()).toEqual(['Daily/2026-11-16.md', 'Projects/One.md']);
    const scoped = await readVaultItems(path.join(vault, 'Projects'), 'notes');
    expect(scoped.items.map((item) => item.externalId)).toEqual(['Projects/One.md']);
  });

  it('throws the folder problem when the folder is gone', async () => {
    await expect(readVaultItems(path.join(vault, 'Gone'), 'notes')).rejects.toThrow('Folder not found');
  });
});

describe('a Checklist items source', () => {
  it('reads the Tasks plugin markers and cuts them from the title', () => {
    expect(taskTitle('Compress the hero images ⏫ 📅 2026-11-28 #perf ^img42')).toBe('Compress the hero images');
    expect(taskTitle('Water plants 🔁 every week 📅 2026-11-20 ✅ 2026-11-19')).toBe('Water plants');
    expect(taskPriorityName('a 🔺')).toBe('Urgent');
    expect(taskPriorityName('a ⏫')).toBe('High');
    expect(taskPriorityName('a 🔼')).toBe('Medium');
    expect(taskPriorityName('a 🔽')).toBe('Low');
    expect(taskPriorityName('a ⏬')).toBe('Low');
    expect(taskPriorityName('a')).toBeNull();
  });

  it('maps each checkbox state and keeps the line in the description', async () => {
    write('Projects/Website relaunch.md', [
      '## Launch checklist',
      '- [ ] Redirect the old blog URLs #seo',
      '- [/] Compress the hero images ⏫ 📅 2026-11-28 #perf ^img42',
      '- [x] Pick the body font ✅ 2026-11-10',
      '- [-] Drop the carousel',
      '```',
      '- [ ] not a task, inside code',
      '```',
    ].join('\n'));
    const { items } = await readVaultItems(vault, 'checklist');
    expect(items.map((item) => [item.title, item.state, item.closed, item.stateOrder])).toEqual([
      ['Redirect the old blog URLs', 'To do', false, 0],
      ['Compress the hero images', 'In progress', false, 1],
      ['Pick the body font', 'Done', true, 2],
      ['Drop the carousel', 'Cancelled', true, 3],
    ]);
    const compress = items[1];
    expect(compress.externalId).toBe('Projects/Website relaunch.md#^img42');
    expect(compress.priorityName).toBe('High');
    expect(compress.labels).toEqual(['perf']);
    expect(compress.displayText).toBe('Website relaunch');
    expect(compress.body).toBe('- [/] Compress the hero images ⏫ 📅 2026-11-28 #perf ^img42\n\nFrom Website relaunch, under Launch checklist.');
  });

  it('keeps an id across ticking and a new date, and makes a new one for new words', async () => {
    write('Notes/List.md', '- [ ] Redirect the old blog URLs');
    const before = (await readVaultItems(vault, 'checklist')).items[0].externalId;
    write('Notes/List.md', '- [x] Redirect the old blog URLs 📅 2026-12-01 #seo');
    const ticked = (await readVaultItems(vault, 'checklist')).items[0].externalId;
    write('Notes/List.md', '- [ ] Redirect the old blog URLs to /archive');
    const reworded = (await readVaultItems(vault, 'checklist')).items[0].externalId;
    expect(ticked).toBe(before);
    expect(reworded).not.toBe(before);
  });

  it('tells identical lines apart by their order', async () => {
    write('Notes/List.md', '- [ ] Call the vendor\n- [ ] Call the vendor');
    const ids = (await readVaultItems(vault, 'checklist')).items.map((item) => item.externalId);
    expect(ids).toEqual(['Notes/List.md#call the vendor', 'Notes/List.md#call the vendor~2']);
  });

  it('reads a Kanban board: lane as Status in board order, the Complete lane closed, the archive cut', async () => {
    write('Projects/Launch board.md', [
      '---',
      'kanban-plugin: board',
      '---',
      '',
      '## Backlog',
      '',
      '- [ ] Draft the pricing FAQ',
      '',
      '## Doing',
      '',
      '### Sub heading',
      '- [ ] Compress the hero images',
      '',
      '## Done',
      '',
      '**Complete**',
      '- [x] Pick the body font',
      '',
      '***',
      '',
      '## Archive',
      '',
      '- [x] Archived card',
    ].join('\n'));
    const { items } = await readVaultItems(vault, 'checklist');
    expect(items.map((item) => [item.title, item.state, item.stateOrder, item.closed])).toEqual([
      ['Draft the pricing FAQ', 'Backlog', 0, false],
      ['Compress the hero images', 'Doing', 1, false],
      ['Pick the body font', 'Done', 2, true],
    ]);
  });
});

describe('embedded files', () => {
  it('resolves a bare name beside the note first, then by the shortest path', () => {
    const index = buildVaultIndex(['Assets/deep/logo.png', 'logo.png', 'Projects/logo.png', 'Projects/Plan.md']);
    expect(resolveEmbed('logo.png', 'Projects/Plan.md', index)).toEqual({ kind: 'file', vaultPath: 'Projects/logo.png' });
    expect(resolveEmbed('logo.png', 'Other/Plan.md', index)).toEqual({ kind: 'file', vaultPath: 'logo.png' });
  });

  it('reads a path from the vault root, or from the note folder for ./ and ../', () => {
    const index = buildVaultIndex(['Assets/old.jpg', 'Projects/img/a.png', 'shared.png']);
    expect(resolveEmbed('Assets/old.jpg', 'Projects/Plan.md', index)).toEqual({ kind: 'file', vaultPath: 'Assets/old.jpg' });
    expect(resolveEmbed('./img/a.png', 'Projects/Plan.md', index)).toEqual({ kind: 'file', vaultPath: 'Projects/img/a.png' });
    expect(resolveEmbed('../shared.png', 'Projects/Plan.md', index)).toEqual({ kind: 'file', vaultPath: 'shared.png' });
  });

  it('leaves an embedded note as text and reports a missing file', () => {
    const index = buildVaultIndex(['Brand guide.md']);
    expect(resolveEmbed('Brand guide', 'Plan.md', index)).toEqual({ kind: 'note' });
    expect(resolveEmbed('Brand guide.md', 'Plan.md', index)).toEqual({ kind: 'note' });
    expect(resolveEmbed('missing.png', 'Plan.md', index)).toEqual({ kind: 'missing' });
  });

  it('attaches the files a note embeds and counts the ones it cannot', async () => {
    write('Assets/hero-mockup.png', 'png');
    write('Projects/Launch brief.pdf', 'pdf');
    const tooBig = write('Assets/huge.mov', '');
    fs.truncateSync(tooBig, MAX_ATTACHMENT_SIZE + 1);
    write('Brand guide.md', 'guide');
    write('Projects/Plan.md', [
      '![[hero-mockup.png|300]]',
      '![[Launch brief.pdf]]',
      '![](Assets/hero-mockup.png)',
      '![[Brand guide]]',
      '![[logo-dark.svg]]',
      '![[huge.mov]]',
      '![remote](https://example.com/a.png)',
      'See [[Brand guide]].',
    ].join('\n'));
    const { items } = await readVaultItems(path.join(vault, 'Projects'), 'notes');
    const plan = items.find((item) => item.externalId === 'Projects/Plan.md');
    expect(plan?.embeddedFiles.map((file) => file.vaultPath)).toEqual(['Assets/hero-mockup.png', 'Projects/Launch brief.pdf']);
    expect(plan?.skippedEmbedCount).toBe(2);
  });
});
