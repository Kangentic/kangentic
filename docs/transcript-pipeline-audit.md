# Transcript pipeline audit (2026-06-12)

Findings from hardening the session-transcript pipeline so cross-agent transcript
consumption (task #223) builds on clean data. All claims were verified against real session
files on a dogfooding machine (`~/.claude/projects/<slug>/*.jsonl`, `~/.codex`, `~/.gemini`,
`~/.qwen`, `~/.kimi`, OpenCode's `opencode.db`).

## What changed

- **Structured transcripts now work for every file/DB-backed agent.** `handleGetTranscript`
  routes through an optional `AgentAdapter.parseTranscript` capability (no agent-name branching;
  satisfies `agent-adapters-boundary`). Parsers exist for Claude, Droid, Codex, Gemini, Qwen,
  Kimi, and OpenCode (SQLite).
- **Claude parser fidelity fixes** (each with a pinned-fixture, individually red-green test):
  slash-command XML collapses to a `[command: ...]` marker, `<system-reminder>` spans are
  stripped (reminder-only turns dropped), `isMeta` injections are skipped, and compaction
  boundaries + `isCompactSummary` summaries surface as explicit `## Conversation compacted`
  sections instead of misleading `## User` turns.
- **Clean output guarantee.** All rendered transcript text passes through
  `sanitizeTranscriptText` (`src/shared/ansi-strip.ts`), so terminal escapes or control bytes
  captured inside tool output never leak into the markdown.
- **Orphaned `tool_result` entries** are rendered in a trailing section instead of being
  silently dropped.
- **MCP tool corrected.** `kangentic_get_transcript` now exposes a `format` parameter (`raw`
  was previously unreachable via MCP) and its description matches actual behavior.

## Audit verdicts

- **Sidechain interleaving: refuted.** Real main-session JSONL contains zero `isSidechain:true`
  entries; subagent conversations live in separate `<sessionId>/subagents/agent-*.jsonl` files.
  No interleaving bug. #223 could later choose to expose subagent files explicitly.
- **Thinking blocks: real thinking is signature-only; text-bearing blocks are narration.** The
  first audit sampled 30 thinking blocks and found none with plaintext. Since 2026-10, Opus 5.5
  and Sonnet 5.5 write text-bearing thinking blocks, and every one measured is narration: its
  signature carries the block kind `narration`, and Claude Code prints it as an ordinary message.
  The parser reads that kind the same way (`adapters/claude/thinking-signature.ts`) and emits
  those blocks as `text`. Real thinking is still persisted empty, and the parser still skips it.
  A conversation the retrieval index stored before this change keeps narration chunks under the
  `Assistant (thinking):` label until its transcript grows and is re-indexed. The text is the same.
- **Orphaned tool_results: none observed** (765/765 paired, including a post-compaction file).
  The markdown hardening is robustness, not a fix for an observed loss.

## Deliberately deferred / known limits (for #223)

- **No cleaned-scrollback fallback.** When structured history is missing or an agent has no
  parser, `get_transcript` reports it and points at `format="raw"`; it never substitutes a
  TUI-cleanup of the scrollback. This is a deliberate product decision (the cleaned-scrollback
  approach was never reliable). The per-agent `transcript-cleanup.ts` modules remain wired only
  into the handoff path, untouched by this work.
- **Aider: no structured transcript.** Aider has no per-session native artifact (only a
  project-cumulative `.aider.chat.history.md`); structured format is unsupported, raw only.
- **Warp / Cursor / Copilot: raw only.** Their native history locations are not yet known.
- **Multi-session continuity.** Structured format reads the latest session's native file;
  resumed Claude sessions carry prior history forward in-file. Selecting older sessions by
  index is #223's scope (`get_session_files` already has a `sessionIndex` param to model after).
- **Schema-derived shapes.** No real local captures existed for Kimi `ContentPart` assistant
  text, Qwen `functionCall`/`functionResponse` parts, or OpenCode `tool` parts; those branches
  are implemented defensively from the upstream wire/GenAI schemas and degrade gracefully. The
  Kimi and Qwen tool fixtures are marked schema-derived.
- **Pre-existing, out of scope: Gemini telemetry parser regression.** `GeminiSessionHistoryParser`
  (telemetry, not transcript) still matches `*.json` and `JSON.parse`s the whole file, but the
  current Gemini CLI writes append-only `*.jsonl` with `$set` patch lines, so its locate/parse
  cannot match current output. The new transcript parser handles the real `.jsonl` format; the
  telemetry-side fix should be filed as a follow-up task.
- **Pre-existing boundary-rule note.** The switch-on-agent-name in
  `handoff/transcript-cleanup.ts` (tests-only code) is a latent `agent-adapters-boundary`
  violation left as-is; a future cleanup can route it through `cleanRawTranscript` capabilities.
