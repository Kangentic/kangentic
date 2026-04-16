/**
 * Asana REST API base and adapter constants.
 *
 * Authentication uses Personal Access Tokens (PATs). The user creates one at
 * app.asana.com/0/my-apps and pastes it into the setup dialog. PATs are
 * scopeless bearer tokens - no OAuth client registration, no refresh, no
 * expiration handling required.
 */

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

/** Default page size for `/projects/{gid}/tasks`; Asana allows up to 100. */
export const DEFAULT_PAGE_SIZE = 100;

/** opt_fields projection used for every task-list call. Kept in one place so mapper + client agree on the shape. */
export const ASANA_TASK_OPT_FIELDS = [
  'name',
  'notes',
  'html_notes',
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
 * Decide whether a host in an attachment URL needs our Asana bearer token
 * attached. Covers `app.asana.com` and every regional `asana-user-private-*`
 * S3 bucket (us-east-1, us-west-2, eu-west-1, etc.) rather than hardcoding
 * one region.
 */
export function isAsanaAuthedDownloadHost(host: string): boolean {
  if (host === 'app.asana.com') return true;
  return host.startsWith('asana-user-private-') && host.endsWith('.s3.amazonaws.com');
}
