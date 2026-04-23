/**
 * Per-request project resolver for the MCP HTTP server.
 *
 * Each HTTP request binds to a default project via the URL path
 * (`/mcp/<projectId>`). A `RequestResolver` wraps that default plus an
 * on-demand lookup path that lets individual tool calls target a
 * *different* project by passing the optional `project` argument.
 *
 * Resolution rules (see resolveProject):
 *   - null / undefined / empty -> use the default project (URL-path scoped).
 *   - Exact UUID match (case-insensitive) -> that project.
 *   - Exact name match (case-insensitive) -> that project.
 *   - Ambiguous name -> error with candidate IDs so the agent can retry.
 *   - No match -> error listing available projects.
 *
 * UUID lookup takes priority over name lookup, so a project literally
 * named like a UUID is still reachable via its real id.
 */
import type { IpcContext } from '../../ipc/ipc-context';
import type { Project } from '../../../shared/types';
import type { CommandContext } from '../commands';
import { buildCommandContextForProject } from '../mcp-project-context';

export interface ResolvedProject {
  context: CommandContext;
  projectId: string;
  projectName: string;
  /** True when the caller did NOT pass a `project` argument and we fell back to the URL-path project. */
  isDefault: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
  isActive: boolean;
}

/**
 * Cheap UUID v4 shape check - good enough to distinguish a selector
 * that looks like an id vs. one that looks like a project name. Not a
 * full RFC 4122 validator; the actual DB lookup is the source of truth.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RequestResolver {
  private readonly ipcContext: IpcContext;
  private readonly defaultContext: CommandContext;
  private readonly defaultProjectId: string;
  private readonly defaultProjectName: string;
  private cachedProjects: Project[] | null = null;

  constructor(params: {
    ipcContext: IpcContext;
    defaultContext: CommandContext;
    defaultProjectId: string;
    defaultProjectName: string;
  }) {
    this.ipcContext = params.ipcContext;
    this.defaultContext = params.defaultContext;
    this.defaultProjectId = params.defaultProjectId;
    this.defaultProjectName = params.defaultProjectName;
  }

  /**
   * Resolve a caller-supplied project selector. Returns a resolved
   * context + metadata on success, or `{ error }` on failure. The
   * `isDefault` flag lets the tool layer decide whether to annotate the
   * response with cross-project context (we keep output byte-identical
   * when the caller omitted the selector).
   */
  resolveProject(selector: string | null | undefined): ResolvedProject | { error: string } {
    const trimmed = typeof selector === 'string' ? selector.trim() : '';
    if (!trimmed) {
      return this.defaultContextResolved();
    }

    const projects = this.loadProjects();

    // UUID shape -> try id lookup first. Case-insensitive to mirror how
    // GitHub, Linear etc. handle UUID references in agent prompts.
    if (UUID_SHAPE.test(trimmed)) {
      const byId = projects.find((project) => project.id.toLowerCase() === trimmed.toLowerCase());
      if (byId) return this.makeResolved(byId, trimmed);
      // Fall through to name lookup in the weird case where the caller
      // typed a UUID but the project is literally named that string.
    }

    const lower = trimmed.toLowerCase();
    const nameMatches = projects.filter((project) => project.name.toLowerCase() === lower);
    if (nameMatches.length === 1) {
      return this.makeResolved(nameMatches[0], trimmed);
    }
    if (nameMatches.length > 1) {
      const candidateList = nameMatches
        .map((project) => `"${project.name}" (id: ${project.id})`)
        .join(', ');
      return {
        error: `Multiple projects match "${trimmed}": ${candidateList}. Re-run with project set to the target project id.`,
      };
    }

    const available = projects
      .map((project) => `"${project.name}" (id: ${project.id})`)
      .join(', ');
    return {
      error: `No project matching "${trimmed}". Available projects: ${available || '(none)'}.`,
    };
  }

  /**
   * List every project in the global DB, flagging the URL-path project
   * as `isActive`. Used by `kangentic_list_projects` and by error
   * messages to surface valid selectors.
   */
  /**
   * Return the default-project context exposed through the URL path.
   * Tools that intentionally don't take a `project` argument (e.g.
   * `kangentic_get_current_task`) use this directly instead of paying
   * for a no-op `resolveProject(undefined)` round-trip.
   */
  defaultContextResolved(): ResolvedProject {
    return {
      context: this.defaultContext,
      projectId: this.defaultProjectId,
      projectName: this.defaultProjectName,
      isDefault: true,
    };
  }

  listProjects(): ProjectSummary[] {
    const projects = this.loadProjects();
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      lastOpened: project.last_opened,
      isActive: project.id === this.defaultProjectId,
    }));
  }

  private loadProjects(): Project[] {
    if (this.cachedProjects === null) {
      this.cachedProjects = this.ipcContext.projectRepo.list();
    }
    return this.cachedProjects;
  }

  private makeResolved(project: Project, selector: string): ResolvedProject | { error: string } {
    // Default project short-circuits to the pre-built context so we
    // skip the IPC-wiring overhead for the most common path.
    if (project.id === this.defaultProjectId) {
      return this.defaultContextResolved();
    }
    const context = buildCommandContextForProject(this.ipcContext, project.id);
    if (!context) {
      // projectRepo.list() returned the row but buildCommandContextForProject
      // bailed - realistically only happens on a race with project deletion.
      // Surface it instead of silently redirecting to the default project,
      // otherwise the caller would see an un-annotated "success" response
      // and think the action landed in the wrong place.
      return {
        error: `Project "${selector}" (id ${project.id}) disappeared between lookup and context build. Retry after confirming the project still exists.`,
      };
    }
    return {
      context,
      projectId: project.id,
      projectName: project.name,
      isDefault: false,
    };
  }
}
