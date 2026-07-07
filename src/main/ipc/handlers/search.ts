import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { runSearchEverything } from '../../search/search-core';
import { retrievalService } from '../../retrieval/retrieval-service';
import type { SearchHit, SearchRequest, MemoryStatus, Project } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * IPC handler for the renderer-side global search palette (Ctrl+Shift+F).
 *
 * Pure-logic search lives in `src/main/search/search-core.ts` so the same
 * code powers the MCP tool `kangentic_search`. This handler is
 * just the IPC<->core adapter: trim the query, decide which projects to
 * scan based on `request.scope`, and delegate.
 */
export function registerSearchHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.SEARCH_EVERYTHING, async (_event, request: SearchRequest): Promise<SearchHit[]> => {
    // Cheap pre-check so the empty-query path (palette open before
    // typing) skips even the global-projects scan.
    if (!(request.query ?? '').trim()) return [];

    const allProjects = context.projectRepo.list();
    const projects: Project[] = request.scope === 'all'
      ? allProjects
      : allProjects.filter((project) => project.id === request.currentProjectId);
    if (projects.length === 0) return [];

    const memoryConfig = context.configManager.load().memory;
    const indexingEnabled = memoryConfig?.indexingEnabled !== false;
    // Smart mode adds the semantic/hybrid path; the embedder is null when the
    // semantic layer is off or unavailable, so the search stays lexical.
    const embedder = request.mode === 'smart' ? retrievalService.getEmbedder(context) : null;

    return runSearchEverything({
      query: request.query ?? '',
      projects,
      includeProjectHits: request.scope === 'all',
      projectsForProjectHits: allProjects,
      conversationSearch: { enabled: indexingEnabled, embedder },
    });
  });

  ipcMain.handle(IPC.MEMORY_STATUS, async (): Promise<MemoryStatus> => {
    return retrievalService.getStatus(context);
  });

  ipcMain.handle(
    IPC.MEMORY_REBUILD_INDEX,
    async (_event, projectId?: string | null): Promise<void> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) return;
      const project = context.projectRepo.list().find((entry) => entry.id === resolvedProjectId);
      if (!project) return;
      retrievalService.rebuildProjectIndex(context, project);
    },
  );
}
