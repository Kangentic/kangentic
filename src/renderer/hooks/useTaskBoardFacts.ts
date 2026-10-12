import { useEffect, useMemo, useState } from 'react';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import type { AgentProjectExecution, AppConfig, BoardProfile, PermissionMode, Project, Swimlane } from '../../shared/types';

/**
 * What a new task's form reads off the board the task goes on: the project's
 * default agent, model and effort, its To Do column (a column override there
 * comes before the project default), its Board Profiles, its default base
 * branch and Worktrees switch, and its agents' execution settings.
 *
 * A workflow's planned task can go on another project's board (#732, board
 * 17b), and every one of these differs per board. The open board's come from
 * the stores, synchronously and live, as the board's own New Task form reads
 * them. Another board's are read over IPC by that project's id, so its facts
 * never borrow the open board's.
 */
export interface TaskBoardFacts {
  /** The project row, for its default agent, model and effort; null when it is not registered. */
  project: Project | null;
  /** Its To Do column, where a new task waits; null until another board's columns arrive. */
  todoLane: Swimlane | null;
  boardProfiles: BoardProfile[];
  /** The team-shared default base branch, else the project's setting; may be empty. */
  defaultBaseBranch: string;
  worktreesEnabled: boolean;
  agentExecution: Record<string, AgentProjectExecution>;
  /** The project's default permission mode, under a column's. */
  permissionMode: PermissionMode;
  /** The open board, which the stores hold and the Board Manager edits. */
  isOpenBoard: boolean;
  /** Another board's facts have not arrived yet. */
  loading: boolean;
}

interface FetchedBoard {
  projectId: string;
  config: AppConfig | null;
  lanes: Swimlane[];
  boardProfiles: BoardProfile[];
}

// hmr-safe: a frozen empty list, a referential-identity sentinel.
const NO_PROFILES: BoardProfile[] = [];

/** Read another board's facts in one go; a read that fails reads as that board having none. */
async function fetchBoard(projectId: string): Promise<FetchedBoard> {
  const [config, lanes, boardProfiles] = await Promise.all([
    window.electronAPI.config.get(projectId).catch(() => null),
    window.electronAPI.swimlanes.list(projectId).catch(() => [] as Swimlane[]),
    window.electronAPI.boardConfig.getBoardProfiles(projectId).catch(() => [] as BoardProfile[]),
  ]);
  return { projectId, config, lanes, boardProfiles };
}

/**
 * The facts of the board `projectId` names, or of the open board when it is
 * null or the open one. A response that lands after the pick moved on is
 * dropped, so a fast change of project never shows the previous board's.
 */
export function useTaskBoardFacts(projectId: string | null): TaskBoardFacts {
  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const openBoardProfiles = useBoardStore((state) => state.boardProfiles);
  const openConfig = useConfigStore((state) => state.config);
  const globalConfig = useConfigStore((state) => state.globalConfig);
  const isOpenBoard = projectId === null || projectId === currentProject?.id;
  const [fetched, setFetched] = useState<FetchedBoard | null>(null);

  useEffect(() => {
    if (isOpenBoard || projectId === null) return undefined;
    let cancelled = false;
    void fetchBoard(projectId).then((board) => { if (!cancelled) setFetched(board); });
    return () => { cancelled = true; };
  }, [isOpenBoard, projectId]);

  return useMemo<TaskBoardFacts>(() => {
    if (isOpenBoard) {
      return {
        project: currentProject,
        todoLane: swimlanes.find((lane) => lane.role === 'todo') ?? null,
        boardProfiles: openBoardProfiles,
        defaultBaseBranch: openConfig.git.defaultBaseBranch,
        worktreesEnabled: openConfig.git.worktreesEnabled,
        agentExecution: openConfig.agent.execution ?? {},
        permissionMode: openConfig.agent.permissionMode,
        isOpenBoard: true,
        loading: false,
      };
    }
    const board = fetched !== null && fetched.projectId === projectId ? fetched : null;
    // Until it arrives, and if its config cannot be read: the global settings,
    // never the open board's own overrides.
    const config = board?.config ?? globalConfig;
    return {
      project: projects.find((project) => project.id === projectId) ?? null,
      todoLane: board?.lanes.find((lane) => lane.role === 'todo') ?? null,
      boardProfiles: board?.boardProfiles ?? NO_PROFILES,
      defaultBaseBranch: config.git.defaultBaseBranch,
      worktreesEnabled: config.git.worktreesEnabled,
      agentExecution: config.agent.execution ?? {},
      permissionMode: config.agent.permissionMode,
      isOpenBoard: false,
      loading: board === null,
    };
  }, [isOpenBoard, projectId, fetched, currentProject, projects, swimlanes, openBoardProfiles, openConfig, globalConfig]);
}
