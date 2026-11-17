import type { EmbeddedFile } from './embeds';

/**
 * One importable item read from a vault, before it becomes an ExternalIssue.
 * The adapter maps it; everything Obsidian-shaped is decided by the time it
 * exists.
 */
export interface VaultItem {
  /** Survives a re-import: a note's vault path, or an item's path plus its block id or words. */
  externalId: string;
  title: string;
  body: string;
  labels: string[];
  /** A priority name to match against the project's scale, or null. */
  priorityName: string | null;
  /** What the Status filter shows. */
  state: string;
  /** Where `state` sorts in the Status filter; null sorts by name. */
  stateOrder: number | null;
  closed: boolean;
  /** The note this came from, vault-relative. */
  noteVaultPath: string;
  /** Shown before the title in the Import dialog: a note's folder, or an item's note. */
  displayText: string;
  embeddedFiles: EmbeddedFile[];
  skippedEmbedCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Statuses that close a note, compared without case. */
export const CLOSED_NOTE_STATUSES = new Set(['done', 'complete', 'completed', 'closed', 'cancelled', 'canceled']);
