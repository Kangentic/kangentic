/**
 * The files an agent CLI reads and edits that live on the machine it runs on (#913).
 *
 * An adapter's trust, hook and MCP code was written for files on this computer: it merges Kangentic's
 * entry into the user's `~/.gemini/trustedFolders.json` or `<project>/.cursor/mcp.json`, and strips it
 * again when the session ends. For a CLI on an SSH host those files are on the host, and the same code
 * would edit an empty folder here and never reach it. So an adapter does not rewrite that code: it
 * declares the files, and `HostFileSync` (src/main/remote/host-file-sync.ts) pulls them into the folder
 * the code already edits, lets it run unchanged, and pushes what changed.
 *
 * Paths are relative, with forward slashes. Declare only files the adapter reads or writes; a folder is
 * declared by naming the files in it.
 */
export interface RemoteFileDeclaration {
  /** Relative to the CLI's home on the host (`~/.gemini/trustedFolders.json` is `.gemini/trustedFolders.json`). */
  home: readonly string[];
  /** Relative to the folder the agent starts in (`.cursor/mcp.json`). */
  project: readonly string[];
  /**
   * Files from `home` or `project` that hold a secret (a token in an MCP config), written on the host
   * readable by their owner only. Without this a project file is written 0644, as a checkout makes it.
   */
  private?: readonly string[];
}

/** A relative path with forward slashes that stays inside the folder it is joined to. */
export function isPlainRelativePath(relative: string): boolean {
  return relative.length > 0
    && !relative.startsWith('/')
    && !relative.includes('\\')
    && relative.split('/').every((part) => part !== '' && part !== '..');
}

/** A declaration that names nothing, for an adapter that edits no file outside its session folder. */
export const NO_REMOTE_FILES: RemoteFileDeclaration = { home: [], project: [] };
