/**
 * Trello REST API base and adapter constants.
 *
 * Trello's API takes an API key plus a user token. A key comes only from a Trello app made in a
 * Workspace (trello.com/apps/admin, Trello Auth tab), and Trello says a key is meant to be public.
 * A token comes from Trello's approval page for that key. Every request sends both in an
 * `Authorization: OAuth` header, never in the URL.
 */
import { DOCS_BASE_URL } from '../../../../shared/docs-links';

export const TRELLO_API_BASE = 'https://api.trello.com/1';

/**
 * Kangentic's own Trello API key, from the Trello app the team owns, registered on 2026-11-17 with
 * the site's origin (`DOCS_BASE_URL`) as its one allowed origin. A Trello key is public: it names
 * the app and grants nothing without a user's token. While it is empty, "Sign in with Trello" is
 * hidden and Connect offers only the user's own key.
 */
export const TRELLO_API_KEY = '97e54a62dab01a06d65eb2c8c63d7af7';

export function isTrelloSignInAvailable(): boolean {
  return TRELLO_API_KEY.length > 0;
}

/**
 * kangentic.com's Trello return page. Trello only returns a token to an origin listed on the key,
 * and Kangentic's key lists kangentic.com. The page reads the token from the URL fragment (never
 * sent to a server), seals it to this attempt's key, and sends the browser to the loopback
 * listener at `TRELLO_SIGN_IN_CALLBACK_PATH`.
 */
export const TRELLO_RETURN_URL = `${DOCS_BASE_URL}/oauth/trello/return`;
export const TRELLO_SIGN_IN_CALLBACK_PATH = '/trello/callback';

/** How long Sign in with Trello waits for the browser to hand back before it gives up. */
export const TRELLO_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * The return page address for one attempt. The one place the sign-in state rides, so moving it
 * from the query to the path is a change here alone. `URLSearchParams` encodes it once.
 */
export function buildTrelloReturnUrl(state: string): string {
  const url = new URL(TRELLO_RETURN_URL);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Trello's approval page for `apiKey`, asking for a read-only token that never expires. With no
 * `returnState`, Trello shows the token on the page for the user to copy, which is the only way
 * for the user's own key: its allowed origins are not ours. With one (Kangentic's key), Trello
 * sends the browser on to kangentic.com's return page with the token in the fragment.
 */
export function buildAuthorizeUrl(apiKey: string, options: { returnState?: string } = {}): string {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('name', 'Kangentic');
  params.set('scope', 'read');
  params.set('expiration', 'never');
  params.set('response_type', 'token');
  if (options.returnState !== undefined) {
    params.set('return_url', buildTrelloReturnUrl(options.returnState));
    params.set('callback_method', 'fragment');
  }
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
