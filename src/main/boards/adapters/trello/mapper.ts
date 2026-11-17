import type { ExternalIssue, FileAttachmentRef } from '../../../../shared/types';
import { extractInlineImageUrls } from '../../shared';

/** A label on a card. A label can have a color and no name, a name and no color, or both. */
export interface TrelloLabelRaw {
  id: string;
  name?: string | null;
  color?: string | null;
}

export interface TrelloCheckItemRaw {
  id: string;
  name?: string | null;
  state?: 'complete' | 'incomplete' | string;
  pos?: number;
}

export interface TrelloChecklistRaw {
  id: string;
  name?: string | null;
  pos?: number;
  checkItems?: TrelloCheckItemRaw[];
}

/** An attachment on a card: a file uploaded to Trello (`isUpload`), or a saved link. */
export interface TrelloAttachmentRaw {
  id: string;
  name?: string | null;
  url?: string | null;
  bytes?: number | null;
  isUpload?: boolean;
}

export interface TrelloMemberRaw {
  id: string;
  fullName?: string | null;
  username?: string | null;
}

/**
 * A card as `/boards/{id}/cards/all` returns it: the fields in `TRELLO_CARD_FIELDS`, plus the
 * checklists, attachments and members that `loadAllCards` in client.ts asks for by their own params.
 */
export interface TrelloCardRaw {
  id: string;
  name?: string | null;
  desc?: string | null;
  closed?: boolean;
  idList?: string | null;
  idShort?: number | null;
  shortUrl?: string | null;
  labels?: TrelloLabelRaw[];
  due?: string | null;
  dueComplete?: boolean;
  start?: string | null;
  dateLastActivity?: string | null;
  checklists?: TrelloChecklistRaw[];
  attachments?: TrelloAttachmentRaw[];
  members?: TrelloMemberRaw[];
}

export interface TrelloListRaw {
  id: string;
  name?: string | null;
  closed?: boolean;
  pos?: number;
}

/**
 * An imported card, with `ExternalIssue`'s optional `displayId` (the card number) and `stateOrder`
 * (its list's place on the board) always set, so the adapter can sort and search on them.
 */
export type TrelloMappedIssue = ExternalIssue & { displayId: string; stateOrder: number };

export function mapTrelloCards(
  cards: TrelloCardRaw[],
  lists: TrelloListRaw[],
  alreadyImportedIds: Set<string>,
): TrelloMappedIssue[] {
  const listsById = new Map(lists.map((list) => [list.id, list]));
  const orderById = listOrderById(lists);
  return cards.map((card) => mapOne(card, listsById, orderById, alreadyImportedIds.has(card.id)));
}

/** Each list's place on the board, left to right by `pos`, archived lists included. */
function listOrderById(lists: TrelloListRaw[]): Map<string, number> {
  const sorted = [...lists].sort((left, right) => (left.pos ?? 0) - (right.pos ?? 0));
  return new Map(sorted.map((list, index) => [list.id, index]));
}

function mapOne(
  card: TrelloCardRaw,
  listsById: Map<string, TrelloListRaw>,
  orderById: Map<string, number>,
  alreadyImported: boolean,
): TrelloMappedIssue {
  const list = card.idList ? listsById.get(card.idList) : undefined;
  const listName = list?.name?.trim() || 'No list';
  // A card on an archived list still reports itself unarchived, so the list decides too.
  const closed = card.closed === true || list?.closed === true;

  const description = (card.desc ?? '').trim();
  const inlineImageUrls = new Set(extractInlineImageUrls(description).map((image) => image.url));
  const attachments = card.attachments ?? [];
  const uploads = attachments.filter((attachment) => attachment.isUpload === true && isNonEmpty(attachment.url));
  const links = attachments.filter((attachment) => attachment.isUpload !== true && isNonEmpty(attachment.url));
  // An upload the description shows inline downloads with the description's images, so it is
  // neither a second file nor counted twice.
  const fileUploads = uploads.filter((attachment) => !inlineImageUrls.has(attachment.url!));

  const body = [
    description,
    buildChecklistsBlock(card.checklists ?? []),
    buildTrelloSection(card, listName, links),
  ].filter((part) => part.length > 0).join('\n\n');

  const createdAt = createdAtFromId(card.id);
  const fileAttachments: FileAttachmentRef[] = fileUploads.map((attachment) => ({
    url: attachment.url!,
    filename: attachment.name?.trim() || attachment.id,
    sizeBytes: attachment.bytes ?? 0,
    externalRef: attachment.id,
  }));

  const issue: TrelloMappedIssue = {
    externalId: card.id,
    externalSource: 'trello',
    externalUrl: card.shortUrl ?? `https://trello.com/c/${card.id}`,
    title: card.name?.trim() || '(untitled)',
    body,
    labels: labelNames(card.labels ?? []),
    assignee: card.members?.[0]?.username ?? null,
    state: listName,
    stateCategory: closed ? 'closed' : 'open',
    createdAt,
    updatedAt: card.dateLastActivity ?? createdAt,
    alreadyImported,
    attachmentCount: fileUploads.length + inlineImageUrls.size,
    displayId: typeof card.idShort === 'number' ? `#${card.idShort}` : '',
    stateOrder: (card.idList ? orderById.get(card.idList) : undefined) ?? Number.MAX_SAFE_INTEGER,
  };
  return fileAttachments.length > 0 ? { ...issue, fileAttachments } : issue;
}

/** A named label imports by its name, a color-only label by its color, and a bare one not at all. */
export function labelNames(labels: TrelloLabelRaw[]): string[] {
  const names: string[] = [];
  for (const label of labels) {
    const name = label.name?.trim() || label.color?.trim() || '';
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}

function buildChecklistsBlock(checklists: TrelloChecklistRaw[]): string {
  const blocks: string[] = [];
  for (const checklist of [...checklists].sort(byPos)) {
    const items = [...(checklist.checkItems ?? [])].sort(byPos)
      .filter((item) => isNonEmpty(item.name))
      .map((item) => `- [${item.state === 'complete' ? 'x' : ' '}] ${item.name!.trim()}`);
    if (items.length === 0) continue;
    const heading = checklist.name?.trim() || 'Checklist';
    blocks.push([`### ${heading}`, '', ...items].join('\n'));
  }
  return blocks.join('\n\n');
}

function buildTrelloSection(card: TrelloCardRaw, listName: string, links: TrelloAttachmentRaw[]): string {
  const memberNames = (card.members ?? [])
    .map((member) => member.fullName?.trim() || member.username?.trim() || '')
    .filter((name) => name.length > 0);
  const lines = [
    `- **List**: ${listName}`,
    memberNames.length > 0 ? `- **Members**: ${memberNames.join(', ')}` : '',
    card.start ? `- **Start**: ${datePart(card.start)}` : '',
    card.due ? `- **Due**: ${datePart(card.due)}` : '',
    links.length > 0 ? `- **Links**: ${links.map((link) => link.url!).join(', ')}` : '',
  ].filter((line) => line.length > 0);
  return ['## Trello', '', ...lines].join('\n');
}

function datePart(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * A Trello id is a MongoDB ObjectId, whose first 8 hex characters are the creation time in
 * seconds. Trello returns no created date for a card, so this is it.
 */
export function createdAtFromId(id: string): string {
  const seconds = Number.parseInt(id.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || id.length < 8) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}

function byPos(left: { pos?: number }, right: { pos?: number }): number {
  return (left.pos ?? 0) - (right.pos ?? 0);
}

function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
