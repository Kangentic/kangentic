/**
 * Sign in with Atlassian (OAuth 2.0 3LO) for Jira Cloud. Atlassian's 3LO has no
 * PKCE for a public client, so the code exchange and every refresh need the app's
 * client secret. kangentic.com holds it (`functions/oauth/jira/`), trades the code,
 * and seals Atlassian's answer to this attempt's key before redirecting to the
 * loopback listener (`../../shared/sealed-token.ts`).
 */
import { DOCS_BASE_URL } from '../../../../shared/docs-links';

/**
 * Public client id of Kangentic's Atlassian OAuth app. Not a secret: Atlassian's
 * consent page needs it, and the secret stays on kangentic.com. Empty until the
 * app is registered, and an empty id hides "Sign in with Atlassian", leaving the
 * API token as Cloud's one way in.
 */
export const JIRA_OAUTH_CLIENT_ID = '';

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
 */
export const JIRA_OAUTH_SCOPES = [
  'read:jira-work',
  'read:jira-user',
  'offline_access',
  'read:board-scope:jira-software',
  'read:board-scope.admin:jira-software',
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
