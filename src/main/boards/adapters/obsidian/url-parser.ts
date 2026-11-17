import path from 'node:path';
import { RefusalError } from '../../../../shared/refusal';
import { findVaultRoot, isDirectory } from './vault';

/**
 * An Obsidian source is added by choosing a folder, so the "url" an import
 * source stores is that folder's path. Any folder inside a vault is accepted:
 * the vault is the nearest folder above it holding `.obsidian`, and the chosen
 * folder is what the source reads.
 */
export function parseObsidianFolder(folder: string): { repository: string } {
  const resolved = path.resolve(folder);
  if (!isDirectory(resolved) || !findVaultRoot(resolved)) {
    throw new RefusalError(`Not in a vault: ${resolved}`);
  }
  return { repository: resolved };
}

/** "Work" for a whole vault, "Work: Projects" for a folder inside it. */
export function buildObsidianLabel(repository: string): string {
  const vaultRoot = findVaultRoot(repository);
  const folderName = path.basename(repository) || repository;
  if (!vaultRoot) return folderName;
  const vaultName = path.basename(vaultRoot) || vaultRoot;
  return path.resolve(vaultRoot) === path.resolve(repository) ? vaultName : `${vaultName}: ${folderName}`;
}
