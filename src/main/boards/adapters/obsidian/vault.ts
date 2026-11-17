import fs from 'node:fs';
import path from 'node:path';

/**
 * Finding a vault and reading its files.
 *
 * A vault is the folder that holds `.obsidian`. A source is any folder inside
 * one: the walk up from it finds the vault, and the folder itself is the
 * scope. Every path a source's items carry is vault-relative with `/`
 * separators, which is what keeps an imported item matched on every platform
 * and after the vault moves.
 */

const VAULT_MARKER = '.obsidian';
const YIELD_EVERY_FILES = 200;
/** A note larger than this is an export or a log, not a piece of work, and is left out unread. */
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;

/** The nearest folder at or above `folder` that holds `.obsidian`, or null. */
export function findVaultRoot(folder: string): string | null {
  let directory = path.resolve(folder);
  for (;;) {
    if (isDirectory(path.join(directory, VAULT_MARKER))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch { // report-ok: a missing or unreadable path is simply not a folder
    return false;
  }
}

/** A vault-relative path with `/` separators. */
function toVaultPath(vaultRoot: string, absolutePath: string): string {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join('/');
}

export function fromVaultPath(vaultRoot: string, vaultPath: string): string {
  return path.join(vaultRoot, ...vaultPath.split('/'));
}

/**
 * The folder the Templates core plugin reads from, vault-relative, or null.
 * Notes there are templates, not work, so a source skips them.
 */
async function readTemplatesFolder(vaultRoot: string): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(path.join(vaultRoot, VAULT_MARKER, 'templates.json'), 'utf-8');
    const folder = (JSON.parse(raw) as { folder?: unknown }).folder;
    if (typeof folder !== 'string') return null;
    const trimmed = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return trimmed === '' ? null : trimmed;
  } catch { // report-ok: no templates.json, or one Obsidian never wrote, means no templates folder
    return null;
  }
}

export interface VaultNote {
  /** Vault-relative, with `/` separators. */
  vaultPath: string;
  absolutePath: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultSnapshot {
  vaultRoot: string;
  /** The notes inside the source's folder, templates left out. */
  notes: VaultNote[];
  /** Every file in the vault, vault-relative, for resolving embeds. */
  files: string[];
}

/**
 * Walk the whole vault once. Every file is listed, since an embed can point
 * anywhere in it, and the `.md` files inside `scopeFolder` up to
 * `MAX_NOTE_BYTES` are read. Folders
 * whose name starts with a dot (`.obsidian`, `.trash`, `.git`) are skipped,
 * and so is the templates folder. Symbolic links are not followed, so a link
 * back up the tree cannot loop. The walk yields to the event loop every few
 * hundred files so a large vault does not hold up the main process.
 */
export async function readVaultSnapshot(vaultRoot: string, scopeFolder: string): Promise<VaultSnapshot> {
  const templatesFolder = await readTemplatesFolder(vaultRoot);
  const scopePath = toVaultPath(vaultRoot, path.resolve(scopeFolder));
  const notes: VaultNote[] = [];
  const files: string[] = [];
  let visited = 0;

  const inScope = (vaultPath: string): boolean =>
    scopePath === '' || vaultPath === scopePath || vaultPath.startsWith(`${scopePath}/`);
  const inTemplates = (vaultPath: string): boolean =>
    templatesFolder !== null && (vaultPath === templatesFolder || vaultPath.startsWith(`${templatesFolder}/`));

  const pending: string[] = [vaultRoot];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch { // report-ok: a folder the user cannot read is left out; the rest of the vault still imports
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const vaultPath = toVaultPath(vaultRoot, absolutePath);
      files.push(vaultPath);
      if (!vaultPath.toLowerCase().endsWith('.md') || !inScope(vaultPath) || inTemplates(vaultPath)) continue;
      const note = await readNote(vaultPath, absolutePath);
      if (note) notes.push(note);
      visited += 1;
      if (visited % YIELD_EVERY_FILES === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  notes.sort((left, right) => left.vaultPath.localeCompare(right.vaultPath));
  return { vaultRoot, notes, files };
}

async function readNote(vaultPath: string, absolutePath: string): Promise<VaultNote | null> {
  try {
    const stats = await fs.promises.stat(absolutePath);
    if (stats.size > MAX_NOTE_BYTES) return null;
    const text = await fs.promises.readFile(absolutePath, 'utf-8');
    const created = stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime;
    return {
      vaultPath,
      absolutePath,
      text,
      createdAt: created.toISOString(),
      updatedAt: stats.mtime.toISOString(),
    };
  } catch { // report-ok: a note deleted or locked mid-walk is left out of this read and picked up by the next
    return null;
  }
}
