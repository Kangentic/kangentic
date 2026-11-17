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
  if (!isDirectory(folder)) return `Folder not found: ${folder}`;
  if (!findVaultRoot(folder)) return `Not in a vault: ${folder}`;
  return null;
}

/** Read every item of one kind inside `folder`. Throws the folder's problem as a refusal. */
export async function readVaultItems(folder: string, kind: VaultItemKind): Promise<VaultRead> {
  const problem = folderProblem(folder);
  if (problem) throw new RefusalError(problem);
  const vaultRoot = findVaultRoot(folder) as string;
  const snapshot = await readVaultSnapshot(vaultRoot, folder);
  const index = buildVaultIndex(snapshot.files);
  const items: VaultItem[] = [];
  for (const note of snapshot.notes) {
    if (kind === 'notes') {
      const item = await mapNote(note, index, vaultRoot);
      if (item) items.push(item);
    } else {
      items.push(...await mapChecklistItems(note, index, vaultRoot));
    }
  }
  return { vaultRoot, items };
}
