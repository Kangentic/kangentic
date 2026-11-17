import fs from 'node:fs';
import path from 'node:path';
import { MAX_ATTACHMENT_SIZE } from '../../shared/download-file';
import { fromVaultPath } from './vault';

/**
 * Embedded files: `![[file]]` and `![alt](file)`.
 *
 * A target resolves the way Obsidian resolves a link. A target with a path is
 * read as written, from the vault's top folder, or from the note's own folder
 * when it starts with `./` or `../`. A bare name is the file of that name
 * anywhere in the vault: the one beside the note first, then the one with the
 * shortest path. Obsidian's "Default location for new attachments" setting
 * only decides where Obsidian saves new files, so it plays no part here.
 *
 * An embedded note (no extension, or `.md`) is a transclusion and stays as
 * text, like a wiki-link. A web image is left to the shared image download.
 */

const WIKI_EMBED = /!\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_EMBED = /!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

export interface VaultIndex {
  files: Set<string>;
  /** Lower-case file name to every vault path with that name. */
  byName: Map<string, string[]>;
}

export function buildVaultIndex(files: string[]): VaultIndex {
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const name = (file.split('/').pop() ?? file).toLowerCase();
    const list = byName.get(name);
    if (list) list.push(file);
    else byName.set(name, [file]);
  }
  return { files: new Set(files), byName };
}

/** The embed targets written in a piece of text, in order, without `|size` or `#heading`. */
export function embedTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(WIKI_EMBED)) {
    const target = match[1].split('|')[0].split('#')[0].trim();
    if (target !== '') targets.push(target);
  }
  for (const match of text.matchAll(MARKDOWN_EMBED)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      target = decodeURI(target);
    } catch { // report-ok: a malformed escape keeps the target as written, which then resolves or is counted skipped
    }
    target = target.split('#')[0].trim();
    if (target !== '') targets.push(target);
  }
  return targets;
}

export type EmbedResolution =
  | { kind: 'file'; vaultPath: string }
  | { kind: 'note' }
  | { kind: 'missing' };

export function resolveEmbed(target: string, noteVaultPath: string, index: VaultIndex): EmbedResolution {
  const normalizedTarget = target.replace(/\\/g, '/');
  const extension = path.posix.extname(normalizedTarget).toLowerCase();
  if (extension === '' || extension === '.md') return { kind: 'note' };

  const noteFolder = path.posix.dirname(noteVaultPath);
  const besideNote = noteFolder === '.' ? normalizedTarget : `${noteFolder}/${normalizedTarget}`;

  if (normalizedTarget.startsWith('./') || normalizedTarget.startsWith('../')) {
    const candidate = path.posix.normalize(besideNote);
    return index.files.has(candidate) ? { kind: 'file', vaultPath: candidate } : { kind: 'missing' };
  }
  if (normalizedTarget.includes('/')) {
    const fromRoot = path.posix.normalize(normalizedTarget.replace(/^\/+/, ''));
    if (index.files.has(fromRoot)) return { kind: 'file', vaultPath: fromRoot };
    const fromNote = path.posix.normalize(besideNote);
    return index.files.has(fromNote) ? { kind: 'file', vaultPath: fromNote } : { kind: 'missing' };
  }

  const candidates = index.byName.get(normalizedTarget.toLowerCase()) ?? [];
  if (candidates.length === 0) return { kind: 'missing' };
  const sameFolder = candidates.find((candidate) => path.posix.dirname(candidate) === noteFolder);
  if (sameFolder) return { kind: 'file', vaultPath: sameFolder };
  const shortest = [...candidates].sort((left, right) =>
    left.split('/').length - right.split('/').length || left.length - right.length || left.localeCompare(right));
  return { kind: 'file', vaultPath: shortest[0] };
}

export interface EmbeddedFile {
  vaultPath: string;
  sizeBytes: number;
}

export interface EmbeddedFiles {
  files: EmbeddedFile[];
  /** Targets that resolved to nothing, or to a file over the attachment cap. */
  skippedCount: number;
}

/** The files a piece of text embeds, each once, with their sizes; notes left as text. */
export async function collectEmbeddedFiles(
  text: string,
  noteVaultPath: string,
  index: VaultIndex,
  vaultRoot: string,
): Promise<EmbeddedFiles> {
  const files: EmbeddedFile[] = [];
  const seen = new Set<string>();
  let skippedCount = 0;
  for (const target of embedTargets(text)) {
    const resolution = resolveEmbed(target, noteVaultPath, index);
    if (resolution.kind === 'note') continue;
    if (resolution.kind === 'missing') {
      skippedCount += 1;
      continue;
    }
    if (seen.has(resolution.vaultPath)) continue;
    seen.add(resolution.vaultPath);
    const sizeBytes = await fileSize(fromVaultPath(vaultRoot, resolution.vaultPath));
    if (sizeBytes === null || sizeBytes > MAX_ATTACHMENT_SIZE) {
      skippedCount += 1;
      continue;
    }
    files.push({ vaultPath: resolution.vaultPath, sizeBytes });
  }
  return { files, skippedCount };
}

async function fileSize(absolutePath: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(absolutePath)).size;
  } catch { // report-ok: a file removed since the walk counts as a skipped attachment
    return null;
  }
}
