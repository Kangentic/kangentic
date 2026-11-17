import {
  TRELLO_API_BASE,
  TRELLO_CARD_FIELDS,
  TRELLO_CARD_PAGE_LIMIT,
  isTrelloAuthedDownloadUrl,
  trelloAuthorizationHeader,
} from './constants';
import {
  clearTrelloCredential,
  loadTrelloCredential,
  saveTrelloCredential,
  trelloCredentialVersion,
  type TrelloCredential,
  type TrelloCredentialKind,
} from './credential-store';
import type { TrelloCardRaw, TrelloListRaw } from './mapper';
import {
  downloadFile,
  extractInlineImageUrls,
  mediaTypeFromFilename,
  withBackoff,
  type DownloadedAttachment,
  type FileAttachmentRef,
} from '../../shared';
import { RefusalError } from '../../../../shared/refusal';
import type { TrelloBoardSummary } from '../../../../shared/types';

/** HTTP request timeout in milliseconds. Matches the downloadFile helper. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The message every "not connected" path shows, so the banner's Connect Trello button applies. */
export const TRELLO_NOT_CONNECTED_MESSAGE = 'Not connected to Trello. Click "Connect Trello" to connect.';

/** Which half of a credential Trello refused, read from its 401 text. */
export type TrelloCredentialField = 'apiKey' | 'token';

export class TrelloError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly field?: TrelloCredentialField,
  ) {
    super(message);
    this.name = 'TrelloError';
  }
}

interface TrelloOrganizationRaw {
  id: string;
  displayName?: string | null;
}

interface TrelloBoardRaw {
  id: string;
  name?: string | null;
  shortLink?: string | null;
  url?: string | null;
  idOrganization?: string | null;
  organization?: TrelloOrganizationRaw | null;
}

/** A board's lists (archived ones included) and every card, archived ones included. */
export interface TrelloBoardSnapshot {
  lists: TrelloListRaw[];
  cards: TrelloCardRaw[];
}

/**
 * Trello's 401 body is short plain text ("invalid key", "invalid token"). Name the half it blames
 * so the Connect dialog can show the text under that field.
 */
export function credentialFieldFromRefusal(text: string): TrelloCredentialField {
  return /\bkey\b/i.test(text) && !/\btoken\b/i.test(text) ? 'apiKey' : 'token';
}

/**
 * True when a 401's text says the credential itself is dead: a revoked or expired token, or a
 * deleted key. Trello also answers 401 for a board the token cannot read ("unauthorized
 * permission requested"), and that must not throw away a token that still works elsewhere.
 * These strings come from Trello's published 401 text, not a captured response, so any other
 * text keeps the credential: a missed match costs a retry, never a working token.
 */
export function isDeadCredentialRefusal(text: string): boolean {
  return /\binvalid (?:token|key)\b|\bexpired token\b/i.test(text);
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    // report-ok: the body only adds detail to an error already being raised for this response
    return '';
  }
}

export class TrelloClient {
  private credential: TrelloCredential | null;
  /** The store's version when `credential` was read; a save or clear since then reloads it. */
  private credentialVersion: number;
  private readonly boardCache = new Map<string, TrelloBoardSnapshot>();
  private readonly boardNameCache = new Map<string, string>();

  constructor(credential?: TrelloCredential | null) {
    this.credential = credential ?? null;
    this.credentialVersion = trelloCredentialVersion();
  }

  async hasCredential(): Promise<boolean> {
    return (await this.loadCredentialIfNeeded()) !== null;
  }

  async getCredential(): Promise<TrelloCredential | null> {
    return this.loadCredentialIfNeeded();
  }

  /**
   * Check a key and token with Trello before anything is saved. Throws a `TrelloError` carrying
   * Trello's own text, and which half it refused, on a 401. Never touches the stored credential.
   * Uses the board list rather than `/members/me`, which counts against Trello's separate
   * `/members` limit of 100 requests per 15 minutes.
   */
  async validate(apiKey: string, token: string): Promise<void> {
    const response = await this.fetchWithAuth('/members/me/boards?filter=open&fields=id', apiKey, token);
    if (response.ok) return;
    const text = await readBodyText(response);
    if (response.status === 401) {
      throw new TrelloError(text || 'Trello refused the key or token.', 401, credentialFieldFromRefusal(text));
    }
    throw new TrelloError(`Trello could not check the token (${response.status}): ${text.slice(0, 200)}`, response.status);
  }

  /** Persist a validated credential, replacing any stored one. */
  async saveCredential(kind: TrelloCredentialKind, apiKey: string, token: string): Promise<TrelloCredential> {
    const credential: TrelloCredential = {
      kind,
      apiKey,
      token,
      savedAt: new Date().toISOString(),
    };
    await saveTrelloCredential(credential);
    this.credential = credential;
    this.credentialVersion = trelloCredentialVersion();
    this.boardCache.clear();
    this.boardNameCache.clear();
    return credential;
  }

  /**
   * Every open board the token can see, with its workspace, in the order Trello returns them.
   * Also the stored credential's check: this call does not count against Trello's separate
   * `/members` limit of 100 requests per 15 minutes, which `/members/me` does.
   */
  async listBoards(): Promise<TrelloBoardSummary[]> {
    const params = new URLSearchParams();
    params.set('filter', 'open');
    params.set('fields', 'name,shortLink,url,idOrganization');
    params.set('organization', 'true');
    params.set('organization_fields', 'displayName');
    const boards = await this.requestList<TrelloBoardRaw>(`/members/me/boards?${params.toString()}`);
    return boards.flatMap((board) => {
      const shortLink = board.shortLink;
      if (typeof shortLink !== 'string' || shortLink.length === 0) return [];
      return [{
        id: board.id,
        shortLink,
        name: board.name?.trim() || shortLink,
        url: board.url ?? `https://trello.com/b/${shortLink}`,
        workspaceName: board.organization?.displayName?.trim() || null,
      }];
    });
  }

  async getBoardName(boardRef: string): Promise<string | null> {
    const cached = this.boardNameCache.get(boardRef);
    if (cached) return cached;
    const board = await this.request<TrelloBoardRaw>(`/boards/${encodeURIComponent(boardRef)}?fields=name`);
    const name = board.name?.trim() || null;
    if (name) this.boardNameCache.set(boardRef, name);
    return name;
  }

  /**
   * A board's lists and cards. `refresh` reloads them; otherwise a board already loaded in this
   * session is served from memory, so later pages and filter changes cost no requests.
   */
  async loadBoard(boardRef: string, refresh: boolean): Promise<TrelloBoardSnapshot> {
    if (!refresh) {
      const cached = this.boardCache.get(boardRef);
      if (cached) return cached;
    }
    const encodedRef = encodeURIComponent(boardRef);
    // The first card page does not depend on the lists, so both start together.
    const [lists, cards] = await Promise.all([
      this.requestList<TrelloListRaw>(`/boards/${encodedRef}/lists?filter=all&fields=name,closed,pos`),
      this.loadAllCards(encodedRef),
    ]);
    const snapshot: TrelloBoardSnapshot = { lists, cards };
    this.boardCache.set(boardRef, snapshot);
    return snapshot;
  }

  /**
   * Every card on the board, archived ones included. Trello caps one response at 1000 cards, so a
   * full page asks again for the cards before the oldest one seen. A page that adds no new card
   * ends the walk, which also ends it if Trello ignores the cursor.
   */
  private async loadAllCards(encodedRef: string): Promise<TrelloCardRaw[]> {
    const cardsById = new Map<string, TrelloCardRaw>();
    let before: string | null = null;
    while (true) {
      const params = new URLSearchParams();
      params.set('fields', TRELLO_CARD_FIELDS);
      params.set('checklists', 'all');
      params.set('attachments', 'true');
      params.set('attachment_fields', 'name,url,bytes,isUpload');
      params.set('members', 'true');
      params.set('member_fields', 'fullName,username');
      params.set('limit', String(TRELLO_CARD_PAGE_LIMIT));
      if (before) params.set('before', before);
      const page = await this.requestList<TrelloCardRaw>(`/boards/${encodedRef}/cards/all?${params.toString()}`);
      let added = 0;
      for (const card of page) {
        if (cardsById.has(card.id)) continue;
        cardsById.set(card.id, card);
        added += 1;
      }
      if (page.length < TRELLO_CARD_PAGE_LIMIT || added === 0) break;
      before = oldestCardId(page);
    }
    return [...cardsById.values()];
  }

  async downloadInlineImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.downloadAll(extractInlineImageUrls(markdownBody));
  }

  async downloadFileAttachments(
    attachments: FileAttachmentRef[],
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.downloadAll(attachments);
  }

  /** Downloads one at a time, so a card's files never burst Trello's per-token rate limit. */
  private async downloadAll(
    files: Array<{ url: string; filename: string }>,
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const file of files) {
      const downloaded = await this.downloadOne(file.url, file.filename);
      if (downloaded) attachments.push(downloaded);
      else skippedCount += 1;
    }
    return { attachments, skippedCount };
  }

  /**
   * Trello serves an uploaded attachment only with the key and token in the OAuth header. Only
   * Trello's own download address gets them; `downloadFile` drops the header if the download
   * redirects to another host.
   */
  private async downloadOne(url: string, filename: string): Promise<DownloadedAttachment | null> {
    const credential = await this.loadCredentialIfNeeded();
    const headers = credential && isTrelloAuthedDownloadUrl(url)
      ? { Authorization: trelloAuthorizationHeader(credential.apiKey, credential.token) }
      : undefined;
    const result = await downloadFile(url, filename, headers ? { headers } : undefined);
    if (!result) return null;
    return { ...result, mediaType: mediaTypeFromFilename(filename) };
  }

  /** The credential in memory, reloaded when none is held or the store changed since it was read. */
  private async loadCredentialIfNeeded(): Promise<TrelloCredential | null> {
    const storeVersion = trelloCredentialVersion();
    if (this.credential && this.credentialVersion === storeVersion) return this.credential;
    if (this.credentialVersion !== storeVersion) {
      this.boardCache.clear();
      this.boardNameCache.clear();
    }
    this.credential = await loadTrelloCredential();
    this.credentialVersion = storeVersion;
    return this.credential;
  }

  private async requireCredential(): Promise<TrelloCredential> {
    const credential = await this.loadCredentialIfNeeded();
    if (!credential) throw new RefusalError(TRELLO_NOT_CONNECTED_MESSAGE);
    return credential;
  }

  private async request<T>(pathAndQuery: string): Promise<T> {
    return withBackoff(async () => this.requestOnce<T>(pathAndQuery), {
      maxAttempts: 3,
      shouldRetry: (error) => {
        if (!(error instanceof TrelloError)) return false;
        const { status } = error;
        return status === 429 || (status >= 500 && status < 600);
      },
    });
  }

  /** A request whose answer must be a JSON array; anything else is a `TrelloError`, not a TypeError later. */
  private async requestList<T>(pathAndQuery: string): Promise<T[]> {
    const body = await this.request<unknown>(pathAndQuery);
    if (!Array.isArray(body)) {
      throw new TrelloError(`Trello GET ${pathAndQuery.split('?')[0]} did not return a list.`, 200);
    }
    return body as T[];
  }

  private async requestOnce<T>(pathAndQuery: string): Promise<T> {
    const credential = await this.requireCredential();
    const response = await this.fetchWithAuth(pathAndQuery, credential.apiKey, credential.token);
    if (response.status === 401) {
      const text = await readBodyText(response);
      if (isDeadCredentialRefusal(text)) {
        // The token was revoked, or the user's own key was deleted. Drop the stored credential so
        // the next call says "not connected" instead of looping on a dead token. The memory copy
        // goes first, so a file Windows holds open cannot keep the dead token in use.
        this.credential = null;
        this.boardCache.clear();
        this.boardNameCache.clear();
        try {
          clearTrelloCredential();
        } catch (error) {
          // report-ok: the file still holds a dead token, so the next load reads it, Trello
          // refuses it with this same 401, and the delete runs again
          console.warn('[trello/client] could not delete the dead credential:', error instanceof Error ? error.name : 'unknown');
        }
      }
      // Either way the banner shows Trello's own text ("invalid token").
      throw new TrelloError(text || 'Trello refused the stored token.', 401, credentialFieldFromRefusal(text));
    }
    if (!response.ok) {
      const text = await readBodyText(response);
      throw new TrelloError(
        `Trello GET ${pathAndQuery.split('?')[0]} failed (${response.status}): ${text.slice(0, 300)}`,
        response.status,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      // A body that is not JSON (a proxy's HTML page) gets Trello's error shape, not the parser's text.
      throw new TrelloError(`Trello GET ${pathAndQuery.split('?')[0]} returned a body that is not JSON.`, response.status);
    }
  }

  private async fetchWithAuth(pathAndQuery: string, apiKey: string, token: string): Promise<Response> {
    return fetch(`${TRELLO_API_BASE}${pathAndQuery}`, {
      method: 'GET',
      headers: {
        Authorization: trelloAuthorizationHeader(apiKey, token),
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

/** The card created first on a page, by the creation time in its id. */
function oldestCardId(cards: TrelloCardRaw[]): string {
  let oldest = cards[0].id;
  for (const card of cards) {
    if (card.id < oldest) oldest = card.id;
  }
  return oldest;
}
