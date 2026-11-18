/** gitlab.com's base URL, the one server whose browser sign-in Kangentic registers. */
export const GITLAB_COM_BASE = 'https://gitlab.com';

/**
 * The client id of the non-confidential OAuth application registered on
 * gitlab.com for Kangentic (PKCE, no secret). Empty until the team registers it:
 * while it is empty, Connect GitLab offers the personal access token only.
 */
export const GITLAB_COM_OAUTH_CLIENT_ID = '';

/** Read access to the API. The only scope Kangentic asks for, by token or sign-in. */
export const GITLAB_READ_SCOPE = 'read_api';

/**
 * The browser hands back to a loopback IP, never `localhost`: GitLab's OAuth
 * library ignores the redirect's port only for a loopback IP, so any free port works.
 */
export const GITLAB_OAUTH_REDIRECT_HOST = '127.0.0.1';
export const GITLAB_OAUTH_REDIRECT_PATH = '/callback';

/** How long a browser sign-in waits for GitLab to hand back. */
export const GITLAB_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** Renew a sign-in this long before it lapses (GitLab's access tokens last 2 hours). */
export const GITLAB_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** HTTP timeout for every API call. */
export const GITLAB_REQUEST_TIMEOUT_MS = 30_000;

/** How long the anonymous "is this GitLab" probe waits per candidate path. */
export const GITLAB_PROBE_TIMEOUT_MS = 10_000;

/** GitLab's largest page. */
export const GITLAB_MAX_PER_PAGE = 100;
