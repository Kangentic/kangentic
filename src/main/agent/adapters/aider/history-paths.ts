import path from 'node:path';

/**
 * Where an Aider session's chat history lives.
 *
 * Aider has no session id of its own. It writes one markdown chat history,
 * `.aider.chat.history.md` by default, and takes another path through
 * `--chat-history-file`. `--restore-chat-history` reloads that file's messages
 * into the next run. Both flags are in the options reference
 * (https://aider.chat/docs/config/options.html, Aider v0.86.1); the reload is
 * `Coder.__init__` reading `io.chat_history_file` through
 * `utils.split_chat_history_markdown` (aider/coders/base_coder.py).
 *
 * So Kangentic gives each session its own file, named by the id the engine
 * mints for it (`supportsCallerSessionId`), and resumes the conversation by
 * restoring that file. The file sits flat in the working directory: Aider's own
 * `.gitignore` entry is `.aider*` (`--gitignore`, on by default), which covers
 * it, and Aider creates only a missing PARENT directory from v0.85.0 on, so a
 * subfolder would fail on older installs.
 *
 * A session with no id (a Command Terminal mints none for an adapter whose id
 * is caller-owned) keeps Aider's default file, shared by every Aider run in that
 * directory.
 */
export const AIDER_DEFAULT_HISTORY_FILE = '.aider.chat.history.md';

/**
 * The history file name for one Kangentic-named conversation. The id is a UUID
 * the engine minted; anything outside a plain file-name alphabet is replaced, so
 * a stored id can never name a path outside the working directory.
 */
export function aiderHistoryFileName(agentSessionId?: string | null): string {
  if (!agentSessionId) return AIDER_DEFAULT_HISTORY_FILE;
  return `.aider.chat.history.${agentSessionId.replace(/[^A-Za-z0-9_-]/g, '-')}.md`;
}

/** The absolute history path for a session in `cwd`, as this machine opens it. */
export function aiderHistoryPath(cwd: string, agentSessionId?: string | null): string {
  return path.join(cwd, aiderHistoryFileName(agentSessionId));
}
