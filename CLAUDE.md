@AGENTS.md

## Claude Code

Everything shared with other coding agents lives in `AGENTS.md`, imported above. The notes below
bind Claude Code only. Cursor also reads this file, and none of them apply there.

**Always-on rules (Claude Code only):**
- `bash-single-command.md` - in Claude Code, one command per Bash tool call; no `&&` `||` `|` `;`, redirects, or command substitution.

**Local overrides:** in Claude Code, put machine-specific instructions in a gitignored
`CLAUDE.local.md` at the project root.
