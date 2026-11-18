import { LOOPBACK_HOST } from '../../shared/loopback-sign-in';

/** Linear's GraphQL endpoint. Every API call is a POST here. */
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export const LINEAR_OAUTH_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_OAUTH_TOKEN_URL = 'https://api.linear.app/oauth/token';
export const LINEAR_OAUTH_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/**
 * Public client id of Kangentic's Linear OAuth application, registered on
 * 2026-11-17 in the team's own Linear workspace with Public on, so any
 * workspace can sign in. Not a secret: the sign-in uses PKCE, so no client
 * secret ships. An empty id hides the "Sign in with Linear" choice, leaving the
 * personal API key as the only way in.
 */
export const LINEAR_OAUTH_CLIENT_ID = '8168d3421eb40a88f70a27ecb44ba8fe';

/**
 * Loopback ports registered as redirect URIs on the OAuth application, tried in
 * order until one binds. Linear matches a redirect URI exactly, so a port the OS
 * picks at random would be refused.
 */
export const LINEAR_OAUTH_REDIRECT_PORTS: readonly number[] = [37421, 37422, 37423];
/** The host the loopback server binds, so the registered redirect always names it. */
export const LINEAR_OAUTH_REDIRECT_HOST = LOOPBACK_HOST;
export const LINEAR_OAUTH_REDIRECT_PATH = '/callback';

/** Kangentic only reads from Linear. */
export const LINEAR_OAUTH_SCOPE = 'read';

/** How long the sign-in waits for the browser to hand back before it gives up. */
export const LINEAR_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Renew an OAuth access token this long before Linear says it expires. */
export const LINEAR_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** Issues per GraphQL page. Nested connections multiply query complexity, so keep it modest. */
export const LINEAR_ISSUE_PAGE_SIZE = 50;

/** Linear's maximum page size, used for the cheap team and workflow-state listings. */
export const LINEAR_MAX_PAGE_SIZE = 250;

/**
 * Workflow state types in the order Linear lays its board out, left to right.
 * Within one type, `WorkflowState.position` orders the states.
 */
export const LINEAR_STATE_TYPE_ORDER: readonly string[] = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'duplicate',
];

/** State types whose issues count as closed in the Import dialog's Open/Closed toggle. */
export const LINEAR_CLOSED_STATE_TYPES: ReadonlySet<string> = new Set(['completed', 'canceled', 'duplicate']);

/**
 * Hosts that serve files uploaded to Linear. They need the same Authorization
 * header as the API; any other host in an issue body gets no credential.
 */
export function isLinearAuthedDownloadHost(host: string): boolean {
  return host === 'uploads.linear.app';
}

export const VIEWER_QUERY = `query Viewer { viewer { id name displayName email organization { urlKey } } }`;

export const TEAMS_QUERY = `query Teams($after: String) {
  teams(first: ${LINEAR_MAX_PAGE_SIZE}, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const TEAM_QUERY = `query Team($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) {
    nodes {
      id key name
      states(first: ${LINEAR_MAX_PAGE_SIZE}) { nodes { id name type position } }
    }
  }
}`;

export const ISSUES_QUERY = `query Issues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(first: $first, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes {
      id identifier title description url priority priorityLabel estimate dueDate
      createdAt updatedAt
      state { id name type position }
      assignee { name displayName }
      labels { nodes { name } }
      cycle { number name }
      project { name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
