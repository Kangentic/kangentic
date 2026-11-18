/**
 * Sign in with Atlassian (OAuth 2.0 3LO) for Jira Cloud. Atlassian's 3LO has no
 * PKCE for a public client, so the code exchange and every refresh need the app's
 * client secret. kangentic.com holds it (`functions/oauth/jira/`), trades the code,
 * and seals Atlassian's answer to this attempt's key before redirecting to the
 * loopback listener (`../../shared/sealed-token.ts`).
 */
import { DOCS_BASE_URL } from '../../../../shared/docs-links';

/**
 * Public client id of Kangentic's Atlassian OAuth app, registered on 2026-11-17
 * with resource-level access, so a grant covers the one site the user picks.
 * Not a secret: Atlassian's consent page needs it, and the secret stays on
 * kangentic.com. An empty id hides "Sign in with Atlassian", leaving the API
 * token as Cloud's one way in.
 */
export const JIRA_OAUTH_CLIENT_ID = '6by0AlZqoY87FxgNsUxKzOXHleygaerR';

export const JIRA_OAUTH_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';

/** The callback registered on the Atlassian app: kangentic.com, never the loopback address. */
export const JIRA_OAUTH_REDIRECT_URI = `${DOCS_BASE_URL}/oauth/jira/callback`;

/** kangentic.com's refresh route: `{ "refresh_token" }` in, Atlassian's answer out. */
export const JIRA_OAUTH_REFRESH_URL = `${DOCS_BASE_URL}/oauth/jira/refresh`;

/** Where kangentic.com sends the browser back to, on the loopback listener. */
export const JIRA_OAUTH_CALLBACK_PATH = '/jira/callback';

/**
 * Read-only Jira, the Jira Software board reads, and `offline_access` for a
 * refresh token. The same list the Atlassian app is registered with.
 *
 * The two classic scopes cover the platform API (`/rest/api/3`). Jira Software
 * takes no classic scope, and each board operation needs every granular scope
 * Atlassian's spec lists for it: a board and its issues need
 * `read:board-scope:jira-software` with `read:issue-details:jira`, and a board's
 * columns need `read:board-scope.admin:jira-software` with `read:project:jira`.
 * Without the second of each pair the gateway answers 401 on the board API alone,
 * while a project, a filter and a search still work.
 */
export const JIRA_OAUTH_SCOPES = [
  'read:jira-work',
  'read:jira-user',
  'offline_access',
  'read:board-scope:jira-software',
  'read:board-scope.admin:jira-software',
  'read:issue-details:jira',
  'read:project:jira',
].join(' ');

/** The Cloud sites a 3LO token can open, each with its cloud id. */
export const ATLASSIAN_ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

/** How long the sign-in waits for the browser to hand back before it gives up. */
export const JIRA_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Renew an access token this long before Atlassian says it expires. */
export const JIRA_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function isJiraSignInAvailable(): boolean {
  return JIRA_OAUTH_CLIENT_ID.length > 0;
}
