---
type: Reference
title: Project relocation
description: How project:relocate repoints or moves a project, suspends its sessions and calls onProjectRelocated, and a per-agent table of the path-keyed state each CLI migrates (Claude slugs, Kimi md5 dirs, Codex trust headers, Grok encoded dirs) and the residue it accepts.
tags: [agents, projects, relocation]
sources:
  - resource: src/main/ipc/handlers/project-relocate.ts
  - resource: src/main/agent/shared/relocation-utils.ts
  - resource: src/main/agent/adapters/claude/project-relocation.ts
  - resource: src/main/agent/adapters/qwen-code/project-relocation.ts
  - resource: src/main/agent/adapters/droid/project-relocation.ts
  - resource: src/main/agent/adapters/opencode/project-relocation.ts
  - resource: src/main/agent/adapters/gemini/project-relocation.ts
  - resource: src/main/agent/adapters/codex/project-relocation.ts
  - resource: src/main/agent/adapters/kimi/project-relocation.ts
  - resource: src/main/agent/adapters/copilot/project-relocation.ts
  - resource: src/main/agent/adapters/grok/project-relocation.ts
  - resource: src/main/agent/adapters/antigravity/project-relocation.ts
---
# Project relocation

A Kangentic project relocates in one of two ways, both handled by the `project:relocate` IPC
handler (`src/main/ipc/handlers/project-relocate.ts`): the user moves the folder outside
Kangentic and points us at the new location (`repoint` mode, reached from Project Settings or the
Locate Folder dialog), or Kangentic moves the folder itself in one step (`move` mode, reached
from the Project Settings "Move..." button). In both modes the handler suspends the project's own
live sessions, then rewrites the stored DB paths, then calls the optional
`onProjectRelocated(oldPath, newPath)` hook on every registered adapter (best-effort, per-adapter
try/catch). By the time the hook fires the folder is already at `newPath`. Each adapter migrates
the per-project data its CLI keys to the absolute path OUTSIDE the project folder, so sessions
stay resumable. The shared mechanics (path-pair collection across the project root plus on-disk
worktrees, directory rename/merge, backup + atomic write, serial lock) live in
`src/main/agent/shared/relocation-utils.ts`; per-adapter logic lives in each adapter's
`project-relocation.ts`.

Suspending the project's own sessions fully terminates their PTYs before the folder moves (the
quiesce that lets the move succeed on Windows, where a directory cannot be renamed while a
process holds a handle inside it). The background deleter of worktrees a Done move set aside
stops after its current batch before the move too (`stopRemovedWorktreeDeletion`), and the next
project open at the new path deletes what it left (see
[Done removal](../../architecture/worktrees/worktree-lifecycle.md#done-removal)). The quiesce does
NOT cover an unrelated agent session running in a DIFFERENT project or an external terminal:
such a session can still hold a shared global config (e.g. `~/.claude.json`) in memory and overwrite the migrated keys on its next save. Kangentic
only manages its own sessions and does not detect or kill those, so that residue is accepted (the
same caveat the Claude adapter documents).

| Agent | What migrates | Documented residue / notes |
|-------|---------------|----------------------------|
| Claude | `~/.claude/projects/<slug>/` transcript dirs and `~/.claude.json` `projects` keys (backup `~/.claude.json.kangentic-backup`). | - |
| Qwen Code | `~/.qwen/projects/<slug>/` chats, `~/.qwen/tmp/<sha256>/` history, and `~/.qwen/trustedFolders.json` keys. | - |
| Droid | `~/.factory/sessions/<cwd-slug>/` session dirs. | Best-effort: Droid is closed source, so resume resolution around the slug dir is not authoritatively documented. |
| OpenCode | `session.directory`/`session.path`, `project.worktree`, `project_directory.directory` columns in `~/.local/share/opencode/opencode.db` (one transaction). | No file backup (live WAL DB; rollback = status quo). `project.sandboxes` left untouched. Project id is git-derived, so sessions are never orphaned, only re-scoped. |
| Gemini | `~/.gemini/projects.json` key, `.project_root` markers under `tmp/`+`history/<slug>/`, and `~/.gemini/trustedFolders.json` keys; slug dirs renamed opportunistically on a basename change. | When the new-basename slug is already taken, the old slug is kept (Gemini still resolves via the registry, but Kangentic's basename-keyed chat locator cannot find the old chats - a pre-existing Gemini basename-collision limitation). |
| Codex | `[projects.'<path>']` trust headers in `~/.codex/config.toml` (line-based, preserving quote / `\\?\` prefix / separator style). | Rollout JSONLs under `~/.codex/sessions/` are intentionally NOT touched: `codex resume <id>` resolves by session id, so resume already survives a move. Only the cwd-filtered resume picker shows residue (it has an `--all` escape hatch). |
| Kimi | `~/.kimi/sessions/<md5(work_dir)>/` dirs (and `<kaos>_<md5>` variants) and `~/.kimi/kimi.json` `work_dirs[].path`. | md5 is computed over the resolved native-separator path (Kangentic spawns Kimi with a forward-slashed `-w`, but Kimi normalizes to native before hashing). |
| Copilot | `cwd` / `git_root` lines in `~/.copilot/session-state/<uuid>/workspace.yaml`. | Best-effort and version-fragile (v1.0.52+ resumes in the saved cwd). The `~/.copilot/session-store.db` cache is left untouched, so picker/search residue is accepted. |
| Aider | None. | History (`.aider.chat.history.md`) lives inside the project folder and moves with it. |
| Cursor | None. | No cwd-keyed external session store Kangentic depends on. |
| Oz (Warp) | None. | No resumable on-disk session state. |
| Ollama | None. | No resumable external session state; `onProjectRelocated` omitted. |
| Grok Build | `~/.grok/sessions/<encodeURIComponent(cwd)>/` session dirs and `[folders.'<path>']` headers in `~/.grok/trusted_folders.toml`. | Encoded-dir rename mirrors Droid's slug rename; the trust rewrite mirrors Codex's header rewrite (backup + atomic write). |
| Antigravity | `trustedWorkspaces` entries in `~/.gemini/antigravity-cli/settings.json` and the workspace key in `~/.gemini/antigravity-cli/cache/last_conversations.json`. | Conversation data (`conversations/<uuid>.db`, `brain/<uuid>/`) is keyed by conversation id, not path, and Kangentic resumes by explicit `--conversation <id>` (cross-directory), so only trust and the user's own `agy -c` continuity need migrating. |
| Goose | None. | Resume rides on the caller-supplied `--name` (cwd-independent), so no path-keyed state needs migrating; `onProjectRelocated` omitted. |
