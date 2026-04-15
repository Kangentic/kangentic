/**
 * Asana REST API + OAuth endpoints and adapter constants.
 *
 * Asana's OAuth `/-/oauth_token` endpoint requires client_id AND client_secret
 * (PKCE alone is rejected with 401 `invalid_client`). The user supplies both
 * values via the setup wizard; they are encrypted with safeStorage and read
 * on every token exchange. `ASANA_DEFAULT_OAUTH_*` values let a future
 * packaged build preconfigure a shared identity, but the default empty
 * strings route every user through the wizard.
 */

import { loadAsanaAppCredentials, type AsanaAppCredentials } from './app-config-store';

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';
export const ASANA_OAUTH_AUTHORIZE = 'https://app.asana.com/-/oauth_authorize';
export const ASANA_OAUTH_TOKEN = 'https://app.asana.com/-/oauth_token';
export const ASANA_OAUTH_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

export const ASANA_DEFAULT_OAUTH_CLIENT_ID = '';
export const ASANA_DEFAULT_OAUTH_CLIENT_SECRET = '';

/** Resolve the active app credentials: user-configured values win, fallback to ship-time defaults. */
export function getAsanaAppCredentials(): AsanaAppCredentials | null {
  const userConfigured = loadAsanaAppCredentials();
  if (userConfigured) return userConfigured;
  if (ASANA_DEFAULT_OAUTH_CLIENT_ID && ASANA_DEFAULT_OAUTH_CLIENT_SECRET) {
    return {
      clientId: ASANA_DEFAULT_OAUTH_CLIENT_ID,
      clientSecret: ASANA_DEFAULT_OAUTH_CLIENT_SECRET,
    };
  }
  return null;
}

export const ASANA_OAUTH_SCOPES = [
  'projects:read',
  'tasks:read',
  'users:read',
  'attachments:read',
  'workspaces:read',
  // Required to expand `custom_fields.*` on task reads; Asana returns 403
  // otherwise even though `tasks:read` covers the parent object.
  'custom_fields:read',
].join(' ');

/** Refresh access token this many seconds before it is due to expire. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/** Default page size for `/projects/{gid}/tasks`; Asana allows up to 100. */
export const DEFAULT_PAGE_SIZE = 100;

/** opt_fields projection used for every task-list call. Kept in one place so mapper + client agree on the shape. */
export const ASANA_TASK_OPT_FIELDS = [
  'name',
  'notes',
  'completed',
  'permalink_url',
  'created_at',
  'modified_at',
  'due_on',
  'num_attachments',
  'assignee.name',
  'tags.name',
  'memberships.section.name',
  'custom_fields.name',
  'custom_fields.type',
  'custom_fields.resource_subtype',
  'custom_fields.display_value',
  'custom_fields.text_value',
  'custom_fields.number_value',
  'custom_fields.enum_value.name',
  'custom_fields.multi_enum_values.name',
  'custom_fields.date_value.date',
].join(',');

/**
 * Decide whether a host in an inline image URL needs our Asana bearer token
 * attached. Covers `app.asana.com` and every regional `asana-user-private-*`
 * S3 bucket (us-east-1, us-west-2, eu-west-1, etc.) rather than hardcoding
 * one region.
 */
export function isAsanaAuthedDownloadHost(host: string): boolean {
  if (host === 'app.asana.com') return true;
  return host.startsWith('asana-user-private-') && host.endsWith('.s3.amazonaws.com');
}
