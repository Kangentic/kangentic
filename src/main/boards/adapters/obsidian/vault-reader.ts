import { RefusalError } from '../../../../shared/refusal';
import { mapChecklistItems } from './checklist-mapper';
import { buildVaultIndex } from './embeds';
import { mapNote } from './note-mapper';
import { findVaultRoot, isDirectory, readVaultSnapshot } from './vault';
import type { VaultItem } from './vault-item';

/** What a source reads: whole notes, or the checklist lines inside them. */
export type VaultItemKind = 'notes' | 'checklist';

export interface VaultRead {
  vaultRoot: string;
  items: VaultItem[];
}

/**
 * Why a source's folder cannot be read right now, or null when it can. The
 * text is what the Import dialog shows in place of the list.
 */
export function folderProblem(folder: string): string | null {
  if (!isDirectory(folder)) return missingFolderMessage(folder);
  if (!findVaultRoot(folder)) return noVaultMessage(folder);
  return null;
}

const YIELD_EVERY_NOTES = 200;

function missingFolderMessage(folder: string): string {
  return `Folder not found: ${folder}`;
}

function noVaultMessage(folder: string): string {
  return `Not in a vault: ${folder}`;
}

/** Read every item of one kind inside `folder`. Throws the folder's problem as a refusal. */
export async function readVaultItems(folder: string, kind: VaultItemKind): Promise<VaultRead> {
  if (!isDirectory(folder)) throw new RefusalError(missingFolderMessage(folder));
  const vaultRoot = findVaultRoot(folder);
  if (!vaultRoot) throw new RefusalError(noVaultMessage(folder));
  const snapshot = await readVaultSnapshot(vaultRoot, folder);
  const index = buildVaultIndex(snapshot.files);
  const items: VaultItem[] = [];
  for (const [noteIndex, note] of snapshot.notes.entries()) {
    if (kind === 'notes') {
      const item = await mapNote(note, index, vaultRoot);
      if (item) items.push(item);
    } else {
      items.push(...await mapChecklistItems(note, index, vaultRoot));
    }
    // Mapping a note with no embeds never waits on the disk, so let the main process breathe.
    if ((noteIndex + 1) % YIELD_EVERY_NOTES === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { vaultRoot, items };
}
