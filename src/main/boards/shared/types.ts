import type {
  ExternalIssue,
  ExternalSource,
  FileAttachmentRef,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
  Task,
} from '../../../shared/types';

export type { FileAttachmentRef } from '../../../shared/types';

/** Downloaded attachment from a board adapter. */
export interface DownloadedAttachment {
  filename: string;
  data: string;
  mediaType: string;
  sizeBytes: number;
  sourceUrl: string;
}

/** Opaque per-adapter credential bag. Each adapter owns its shape. */
export type Credentials = Record<string, string>;

/** Adapter implementation maturity. Used by IPC handlers to short-circuit stub calls. */
export type AdapterStatus = 'stable' | 'stub';

/** Reuses existing ExternalIssue shape rather than defining a parallel type. */
export type RemoteIssue = ExternalIssue;

/** Minimal shape for a remote project/board the user can select from. */
export interface RemoteProject {
  id: string;
  name: string;
  url: string;
  description?: string;
}

/** Opaque per-adapter project reference (e.g. 'owner/repo' for GitHub, 'org/project' for ADO). */
export interface ProjectRef {
  id: string;
  namespace?: string;
}

/** Optional filter applied by listIssues. */
export interface IssueFilter {
  searchQuery?: string;
  state?: string;
  page?: number;
  perPage?: number;
}

/** Prerequisite check result: CLI availability and auth are separate concerns. */
export interface PrerequisiteResult {
  cliOk: boolean;
  authOk: boolean;
  message?: string;
}

export interface AuthInput {
  method: string;
  credentials?: Credentials;
}

export interface AuthResult {
  ok: boolean;
  credentials?: Credentials;
  message?: string;
}

export interface SyncResult {
  updated: number;
  failed: number;
  message?: string;
}

/**
 * Interface that every board integration adapter must implement.
 *
 * The adapter is the single source of truth for how Kangentic talks to a
 * remote issue tracker or project management board. All auth, fetching,
 * mapping, and download logic lives behind this interface.
 *
 * Required methods form the current "import to backlog" surface that the
 * IPC handler at `src/main/ipc/handlers/backlog.ts` calls. Optional methods
 * are future expansion points (discovery, write-back) that no provider
 * implements yet.
 */
export interface BoardAdapter {
  /** Unique identifier for this provider. Matches the ExternalSource union. */
  readonly id: ExternalSource;

  /** Human-readable product name (e.g. 'GitHub Issues', 'Azure DevOps'). */
  readonly displayName: string;

  /** lucide-react icon name for the UI picker. */
  readonly icon: string;

  /**
   * Implementation maturity. IPC handlers short-circuit stub adapters with
   * a structured `not_implemented` response before calling their methods.
   */
  readonly status: AdapterStatus;

  /**
   * Structured check of CLI availability and authentication status. Used by
   * settings UI to show actionable messages ("install gh CLI" vs "run gh auth login").
   */
  checkPrerequisites(credentials?: Credentials): Promise<PrerequisiteResult>;

  /**
   * Legacy check used by the current import IPC flow. Wraps checkPrerequisites()
   * into the older `{available, authenticated, error}` shape. Kept for IPC
   * back-compat during the refactor.
   */
  checkCli(): Promise<ImportCheckCliResult>;

  /**
   * Fetch a page of issues from the remote source. Receives the original
   * IPC input and a callback to determine which external IDs are already
   * imported so the UI can mark duplicates.
   */
  fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult>;

  /** Download inline images referenced in a markdown body. */
  downloadImages(markdownBody: string): Promise<{
    attachments: DownloadedAttachment[];
    skippedCount: number;
  }>;

  /**
   * Download authenticated file attachments. Only implemented by providers
   * that expose explicit file attachments (e.g. Azure DevOps AttachedFile).
   */
  downloadFileAttachments?(
    attachments: Array<FileAttachmentRef>,
  ): Promise<{
    attachments: DownloadedAttachment[];
    skippedCount: number;
  }>;

  /**
   * Resolve a human-readable label from a repository identifier. Called by
   * the backlog handler after a source is added so providers that can fetch
   * a nicer display name (e.g. Asana: project GID -> project name) get one
   * persisted. Best-effort: returning null keeps the sync label built by
   * the URL parser.
   */
  resolveLabel?(repository: string): Promise<string | null>;

  /** Future: initiate an auth flow (PAT, OAuth, CLI). Not wired up yet. */
  authenticate?(input: AuthInput): Promise<AuthResult>;

  /** Future: list projects/boards the user can pick from. Not wired up yet. */
  listProjects?(credentials: Credentials): Promise<RemoteProject[]>;

  /** Future: list issues for a specific project with filtering. Not wired up yet. */
  listIssues?(credentials: Credentials, projectRef: ProjectRef, filter?: IssueFilter): Promise<RemoteIssue[]>;

  /** Future: push local task updates back to the remote. Not wired up yet. */
  pushUpdates?(tasks: Task[], credentials: Credentials): Promise<SyncResult>;
}

/**
 * Convert a PrerequisiteResult to the legacy ImportCheckCliResult shape.
 * Shared so adapters don't duplicate the conversion in their checkCli() shim.
 */
export function prerequisiteToCheckCli(result: PrerequisiteResult): ImportCheckCliResult {
  return {
    available: result.cliOk,
    authenticated: result.authOk,
    error: result.message,
  };
}
