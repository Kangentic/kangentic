# Rule: one command per Bash tool call

Claude Code does not support chained, piped, or stderr-redirected shell commands. A
multi-command Bash call produces errors or silent data loss, and the `cd <path> && git ...`
pattern specifically triggers a security prompt that cannot be bypassed. This rule governs
how every agent (main sessions, subagents, worktree agents, commands, and skills) invokes the
Bash tool. It is the project's number one operational rule.

## The rule

Every Bash tool call MUST contain exactly ONE command.

- **Forbidden operators:** `&&`, `||`, `|`, `;`, `2>/dev/null`, `2>&1`.
- **No command substitution:** no backticks or `$(...)`, INCLUDING inside double quotes, where bash
  still runs them. Only single quotes keep them literal. Put code or prose that carries backticks in
  a file (`node <script>`, `git commit -F <file>`) instead of an inline argument.
- **Use dedicated tools instead of shell text:**
  - `Read` (with `offset` / `limit`) replaces `cat`, `head`, `tail`, `less`.
  - `Grep` replaces `grep`, `rg`, and any pipe into `grep`.
  - `Glob` replaces `find` and `ls` for file discovery.
  - `Write` replaces `echo` redirection and `cat <<EOF`.
  - The Bash `timeout` parameter replaces `sleep`.
  - Run commands in separate Bash calls instead of joining them with `&&`, `;`, or `||`.
- **Git in another directory:** always use `git -C <path> ...`. Never `cd <path> && git ...`.

This applies everywhere with no exceptions: main sessions, subagents, worktree agents,
commands, and skills.

## Enforcement (self-maintaining)

- **Hook (blocking):** `scripts/bash-guard.js` runs as a `PreToolUse` hook (registered in
  `.claude/settings.json`) and denies any Bash command that contains a forbidden operator
  outside quotes, or command substitution anywhere but inside single quotes.
- **Test:** `tests/unit/bash-guard.test.ts` locks the guard's allow/deny behavior and its
  response shape. Runs in CI via `npm run test:unit`.

## Scope

Governs the Bash tool only. Operators inside quoted strings (e.g. `echo "a && b"`, a grep
regex `"a|b"`) are allowed because they are arguments, not command separators. Command
substitution is the exception: bash expands it inside double quotes, so only single quotes exempt it. This rule is
about how an agent invokes commands, not about shell scripts committed under `scripts/`, which
run outside the agent and may use normal shell syntax.
