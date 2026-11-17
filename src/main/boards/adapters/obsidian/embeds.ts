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
  /** Folded vault path (see `foldPath`) to the path as it is on disk, the first one when two fold alike. */
  byPath: Map<string, string>;
  /** Folded file name to every vault path with that name. */
  byName: Map<string, string[]>;
  /** File sizes looked up during one read, so a file embedded from many lines is checked once. */
  sizes: Map<string, Promise<number | null>>;
}

/**
 * Obsidian matches a link to a file without regard to case, and a link's text
 * and the name on disk can differ in Unicode form (a vault copied from macOS).
 */
function foldPath(vaultPath: string): string {
  return vaultPath.normalize('NFC').toLowerCase();
}

export function buildVaultIndex(files: string[]): VaultIndex {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const folded = foldPath(file);
    if (!byPath.has(folded)) byPath.set(folded, file);
    const name = folded.split('/').pop() ?? folded;
    const list = byName.get(name);
    if (list) list.push(file);
    else byName.set(name, [file]);
  }
  return { files: new Set(files), byPath, byName, sizes: new Map() };
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

  const file = resolveFile(normalizedTarget, noteVaultPath, index);
  if (file) return { kind: 'file', vaultPath: file };
  // `![[Plan v1.2]]` names the note `Plan v1.2.md`: a dot in a note's name is not an extension.
  return resolveFile(`${normalizedTarget}.md`, noteVaultPath, index) ? { kind: 'note' } : { kind: 'missing' };
}

/** The vault path a link target names, or null. A path that climbs out of the vault matches nothing. */
function resolveFile(target: string, noteVaultPath: string, index: VaultIndex): string | null {
  const noteFolder = path.posix.dirname(noteVaultPath);
  const besideNote = noteFolder === '.' ? target : `${noteFolder}/${target}`;

  if (target.startsWith('./') || target.startsWith('../')) return lookupPath(path.posix.normalize(besideNote), index);
  if (target.includes('/')) {
    return lookupPath(path.posix.normalize(target.replace(/^\/+/, '')), index)
      ?? lookupPath(path.posix.normalize(besideNote), index);
  }

  const candidates = index.byName.get(foldPath(target)) ?? [];
  if (candidates.length === 0) return null;
  const sameFolder = candidates.find((candidate) => path.posix.dirname(candidate) === noteFolder);
  if (sameFolder) return sameFolder;
  let shortest = candidates[0];
  for (const candidate of candidates) {
    if (closerToTop(candidate, shortest)) shortest = candidate;
  }
  return shortest;
}

function lookupPath(vaultPath: string, index: VaultIndex): string | null {
  if (index.files.has(vaultPath)) return vaultPath;
  return index.byPath.get(foldPath(vaultPath)) ?? null;
}

/** Fewer folders first, then the shorter path, then by name, so the pick does not depend on walk order. */
function closerToTop(candidate: string, current: string): boolean {
  const depthDifference = candidate.split('/').length - current.split('/').length;
  if (depthDifference !== 0) return depthDifference < 0;
  if (candidate.length !== current.length) return candidate.length < current.length;
  return candidate.localeCompare(current) < 0;
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
    let size = index.sizes.get(resolution.vaultPath);
    if (!size) {
      size = fileSize(fromVaultPath(vaultRoot, resolution.vaultPath));
      index.sizes.set(resolution.vaultPath, size);
    }
    const sizeBytes = await size;
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
