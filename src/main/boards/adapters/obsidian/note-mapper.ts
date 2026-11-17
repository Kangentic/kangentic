import { collectEmbeddedFiles, type VaultIndex } from './embeds';
import { isKanbanBoard, propertyList, propertyText, splitNote, type NoteProperty } from './frontmatter';
import { bodyTags, noteName, uniqueTags } from './markdown-text';
import type { VaultNote } from './vault';
import { CLOSED_NOTE_STATUSES, type VaultItem } from './vault-item';

/**
 * A Notes source: each note is one task. Only the properties named here are
 * read; every other property is listed under `## Obsidian` at the end of the
 * description so nothing the note said is lost.
 */

const NO_STATUS = 'No status';
/** Properties the mapping reads, or that mean nothing outside Obsidian. */
const CONSUMED_PROPERTIES = new Set(['title', 'tags', 'tag', 'priority', 'status', 'aliases', 'alias', 'cssclasses', 'cssclass']);

export async function mapNote(note: VaultNote, index: VaultIndex, vaultRoot: string): Promise<VaultItem | null> {
  const { properties, body } = splitNote(note.text);
  if (isKanbanBoard(properties)) return null;

  const status = propertyText(properties, 'status');
  const labels = uniqueTags([
    ...propertyList(properties, 'tags'),
    ...propertyList(properties, 'tag'),
    ...bodyTags(body),
  ]);
  const embedded = await collectEmbeddedFiles(body, note.vaultPath, index, vaultRoot);
  const folder = note.vaultPath.includes('/') ? `${note.vaultPath.slice(0, note.vaultPath.lastIndexOf('/'))}/` : '';

  return {
    externalId: note.vaultPath,
    title: propertyText(properties, 'title') ?? noteName(note.vaultPath),
    body: describeNote(body, properties),
    labels,
    priorityName: propertyText(properties, 'priority') ?? null,
    state: status ?? NO_STATUS,
    stateOrder: null,
    closed: status !== undefined && CLOSED_NOTE_STATUSES.has(status.toLowerCase()),
    noteVaultPath: note.vaultPath,
    displayText: folder,
    embeddedFiles: embedded.files,
    skippedEmbedCount: embedded.skippedCount,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function describeNote(body: string, properties: NoteProperty[]): string {
  const remaining = properties
    .filter((property) => !CONSUMED_PROPERTIES.has(property.key.toLowerCase()))
    .map((property) => ({ key: property.key, text: Array.isArray(property.value) ? property.value.join(', ') : property.value }))
    .filter((property) => property.text.trim() !== '');
  const text = body.replace(/^\s*\n/, '').trimEnd();
  if (remaining.length === 0) return text;
  const section = ['## Obsidian', '', ...remaining.map((property) => `- **${property.key}**: ${property.text}`)].join('\n');
  return text === '' ? section : `${text}\n\n${section}`;
}
