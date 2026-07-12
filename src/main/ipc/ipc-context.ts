import type { BrowserWindow } from 'electron';
import type { ProjectRepository } from '../db/repositories/project-repository';
import type { ProjectGroupRepository } from '../db/repositories/project-group-repository';
import type { SessionManager } from '../pty/session-manager';
import type { ConfigManager } from '../config/config-manager';
import type { BoardConfigManager } from '../config/board-config-manager';
import type { DiffWatcher } from '../git/diff-watcher';
import type { GitDetector } from '../git/git-detector';
import type { ShellResolver } from '../pty/spawn/shell-resolver';
import type { TerminalSubmitScheduler } from '../transition-engine/terminal-submit-scheduler';
import type { TerminalSubmit } from '../pty/terminal-submit';
import type { McpHttpServerHandle } from '../agent/mcp-http-server';
import type { TranscriptionService } from '../transcription/transcription-service';
import type { MobileBridgeService } from '../mobile-bridge/mobile-bridge-service';
import type { BoardEventBus } from '../mobile-bridge/board-event-bus';

export interface IpcContext {
  mainWindow: BrowserWindow;
  projectRepo: ProjectRepository;
  projectGroupRepo: ProjectGroupRepository;
  sessionManager: SessionManager;
  configManager: ConfigManager;
  boardConfigManager: BoardConfigManager;
  /**
   * Watches worktree directories for file changes to drive the live git-diff
   * view. Promoted onto the context (from a module-local in the git-diff
   * handler) so project relocation can release the recursive `fs.watch`
   * handles inside a project folder before moving the folder on disk.
   */
  diffWatcher: DiffWatcher;
  gitDetector: GitDetector;
  shellResolver: ShellResolver;
  /**
   * Task-keyed lifecycle wrapper around `TerminalSubmit.submitKeystrokes`.
   * Owns: cancel-on-rerun, fresh-spawn `'thinking'` wait, drag-burst
   * coalescing. All `auto_command` and settings-injection callers go
   * through this. Renamed from `commandInjector` in the TerminalSubmit
   * unification.
   */
  terminalSubmitScheduler: TerminalSubmitScheduler;
  /**
   * Unified byte-pushing engine. `submitContent` for bracketed paste of
   * free-form text (browser-pane Send), `submitKeystrokes` for slash
   * commands and anything the TUI must interpret (auto_command, /model,
   * /effort, send_command). Layered on top by `terminalSubmitScheduler`
   * for the task-keyed scheduling lifecycle. The bracketed-paste machinery
   * lives in `pty/paste-engine.ts` as a private implementation detail
   * consumed only by TerminalSubmit; callers should never reach into
   * paste-engine directly.
   */
  terminalSubmit: TerminalSubmit;
  /**
   * The single voice-to-text transcription funnel. Owns the active engine and
   * routes all audio (local renderer PCM today, a future mobile client later)
   * through one ingest boundary. Emits `'partial'` / `'final'` events the
   * dictation handler forwards to the renderer popup. See
   * `src/main/transcription/`.
   */
  transcriptionService: TranscriptionService;
  currentProjectId: string | null;
  currentProjectPath: string | null;
  /**
   * Project IDs whose suspended-session recovery (`pruneOrphanedWorktreeTasks`,
   * `cleanupStaleResourcesAsync`, `resumeSuspendedSessions`, `autoSpawnTasks`)
   * has already completed in this app lifetime. Warm reopens skip recovery
   * because the registry-resident PTYs and the on-disk worktree state cannot
   * drift without going through our own handlers. Cleared per-project on
   * `cleanupProject` (PROJECT_DELETE); the whole set dies with the process.
   */
  recoveredProjects: Set<string>;
  /**
   * In-process MCP HTTP server handle. Set once at app startup before
   * any project opens; null only during the brief startup window before
   * the server has bound its port.
   */
  mcpServerHandle: McpHttpServerHandle | null;
  /**
   * Owns the desktop's mobile-bridge identity, signed device roster, and
   * active pairing ceremony. Machine-global like config, not tied to the
   * currently open project. See src/main/mobile-bridge/mobile-bridge-service.ts.
   */
  mobileBridgeService: MobileBridgeService;
  /**
   * Consolidated main-process-internal board-mutation event stream, fed
   * alongside (never instead of) the existing `IPC.*_BY_AGENT` renderer
   * pushes. Lets the mobile bridge's read-board handler subscribe once,
   * filtered by projectId, rather than to each ad-hoc `*_BY_AGENT` channel.
   * See src/main/mobile-bridge/board-event-bus.ts.
   */
  boardEvents: BoardEventBus;
}
