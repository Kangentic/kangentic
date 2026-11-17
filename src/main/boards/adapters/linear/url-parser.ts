import { RefusalError } from '../../../../shared/refusal';

/**
 * Parse a Linear team URL, returning the team key (`ENG`) as `repository`.
 *
 * The team picker builds `https://linear.app/<workspace>/team/<KEY>/all`, and a
 * pasted link to any page under the team works too:
 *   https://linear.app/<workspace>/team/<KEY>
 *   https://linear.app/<workspace>/team/<KEY>/active
 *   https://linear.app/<workspace>/team/<KEY>/board
 *
 * The key is what Linear prints in every issue id (ENG-214), and the API filters
 * on it. A team whose key is renamed in Linear stops matching its saved source.
 */
export function parseLinearUrl(url: string): { repository: string } {
  const match = /^https?:\/\/linear\.app\/[^/?#]+\/team\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(url);
  if (match) {
    return { repository: match[1].toUpperCase() };
  }
  throw new RefusalError('Invalid Linear team URL. Expected format: https://linear.app/<workspace>/team/<KEY>');
}

/** Placeholder label until `resolveLabel` replaces it with the team's name. */
export function buildLinearLabel(repository: string): string {
  return `Linear team ${repository}`;
}

/** The team URL the picker saves as the source's `url`. */
export function buildLinearTeamUrl(organizationUrlKey: string, teamKey: string): string {
  return `https://linear.app/${organizationUrlKey}/team/${teamKey}/all`;
}
