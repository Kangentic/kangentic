/**
 * Trello REST API base and adapter constants.
 *
 * Trello's API takes an API key plus a user token. A key comes only from a Trello app made in a
 * Workspace (trello.com/apps/admin, Trello Auth tab), and Trello says a key is meant to be public.
 * A token comes from Trello's approval page for that key. Every request sends both in an
 * `Authorization: OAuth` header, never in the URL.
 */

export const TRELLO_API_BASE = 'https://api.trello.com/1';

/**
 * Kangentic's own Trello API key, from the Trello app the team owns. While it is empty, "Sign in
 * with Trello" is hidden and Connect offers only the user's own key.
 */
export const TRELLO_API_KEY = '';

export function isTrelloSignInAvailable(): boolean {
  return TRELLO_API_KEY.length > 0;
}

/**
 * Trello's approval page for `apiKey`, asking for a read-only token that never expires. With no
 * `return_url`, Trello shows the token on the page for the user to copy.
 */
export function buildAuthorizeUrl(apiKey: string): string {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('name', 'Kangentic');
  params.set('scope', 'read');
  params.set('expiration', 'never');
  params.set('response_type', 'token');
  return `https://trello.com/1/authorize?${params.toString()}`;
}

/**
 * The OAuth header form Trello takes for REST calls and attachment downloads. Values are
 * percent-encoded as OAuth 1.0 header parameters are, so a pasted quote or comma cannot add a
 * parameter. Trello's keys and tokens are letters and digits, which encoding leaves as they are.
 */
export function trelloAuthorizationHeader(apiKey: string, token: string): string {
  return `OAuth oauth_consumer_key="${encodeURIComponent(apiKey)}", oauth_token="${encodeURIComponent(token)}"`;
}

const AUTHED_DOWNLOAD_PATH = /^\/1\/cards\/[0-9a-f]+\/attachments\/[0-9a-f]+\/download\//i;

/**
 * True only for an attachment Trello itself stores: its download address on trello.com or
 * api.trello.com. Every other address, an image hosted elsewhere included, never gets the key or
 * token.
 */
export function isTrelloAuthedDownloadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // report-ok: a malformed address is not a Trello download, so it gets no credentials
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.host !== 'trello.com' && parsed.host !== 'api.trello.com') return false;
  return AUTHED_DOWNLOAD_PATH.test(parsed.pathname);
}

/**
 * Card fields every board fetch asks for. Checklists, attachments and members come through their
 * own params in `loadAllCards` (client.ts); `TrelloCardRaw` in mapper.ts types all of them.
 */
export const TRELLO_CARD_FIELDS = [
  'name',
  'desc',
  'closed',
  'idList',
  'idShort',
  'shortUrl',
  'labels',
  'due',
  'dueComplete',
  'start',
  'dateLastActivity',
].join(',');

/** Trello caps one page of a board's cards at this many. */
export const TRELLO_CARD_PAGE_LIMIT = 1000;
