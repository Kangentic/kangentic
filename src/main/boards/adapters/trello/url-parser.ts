import { RefusalError } from '../../../../shared/refusal';

/**
 * Parse a Trello board URL, returning the board's short link as `repository`. Trello's API takes
 * the short link wherever it takes a board id. Accepts the shapes the Trello web app produces:
 *   https://trello.com/b/<shortLink>
 *   https://trello.com/b/<shortLink>/<board-name-slug>
 *   https://trello.com/b/<shortLink>/<board-name-slug>?filter=...
 */
export function parseTrelloUrl(url: string): { repository: string } {
  const boardPattern = /^https?:\/\/(?:www\.)?trello\.com\/b\/([A-Za-z0-9]+)(?:[/?#]|$)/;
  const match = boardPattern.exec(url.trim());
  if (match) {
    return { repository: match[1] };
  }
  throw new RefusalError('Invalid Trello board URL. Expected format: https://trello.com/b/<board_id>/<board_name>');
}

/**
 * A label for a Trello source before its board name is known. The short link is not readable, so
 * it is prefixed; `resolveLabel` replaces it with the board's name.
 */
export function buildTrelloLabel(repository: string): string {
  return `Trello board ${repository}`;
}
