---
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (fixes everything it verifies, records the decisions it made, fills red-green test-coverage holes, commits that pass locally, and ends Ready or Blocked from a script)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Agent, mcp__kangentic__kangentic_create_task
argument-hint: [base-ref] [review-only]
---

# Code Review

Review the changes that make up this branch's work - commits on the branch **plus** staged, unstaged, and new untracked files in the working tree (the diff from the base branch through the working tree) - for quality, correctness, and project conventions, then fix every verified finding and end Ready or Blocked.

## Modes

- **Default** (`/code-review`) - review, then fix every verified finding (Lows included), apply the recommended option on every decision and record it, re-run the checks, commit this pass's own work locally (never pushed), and end with the verdict block `scripts/review-verdict.mjs` prints: **Ready** (for Testing) or **Blocked**. There is no third verdict and no "skipped" status. Only Blocked sends the card back to Executing.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits applied.

The skill reads `$ARGUMENTS`, which may carry up to two independent tokens in any order:
- `review-only` - skip the Apply Phase, Re-typecheck, and commit steps (it writes nothing at all) and emit the legacy Verdict footer instead of the default report.
- a **base ref** (any token that is not `review-only`, e.g. `origin/main`, `develop`, or a commit SHA) - overrides the auto-detected base branch the diff is scoped against (see Step 3). Mirrors `claude ultrareview origin/main`. A base ref is diff-*scoping* metadata, not author intent - it never tells the reviewer what the change was "supposed" to do (see "Reviewer independence").

**User-provided arguments (if any):** $ARGUMENTS

**One uniform path.** This skill runs as a thin **driver** in the main loop. Every run - regardless of diff size - does the same thing: mechanical pre-flight, gather the diff, **fan out independent reviewer subagents in parallel** (via the `Agent` tool), then **synthesize and verify their findings in the main agent**, and (default mode) fix every verified finding. There is no size gate and no separate "heavy" path. The fan-out scales naturally with the change: the universal dimension finders always run, and the domain auditors are gated by changed-file type, so a one-file change fires few finders and a broad refactor fires many. This mirrors the recommended orchestrator-worker pattern (a lead agent fans out parallel review subagents and synthesizes their results).

### Reviewer independence

`/code-review` always runs in a **fresh, isolated session** with no prior conversation or generation history (the board spawns the review session `isolated` + `always_spawn_new`; see `.claude/rules/board-config-parity.md`). The reviewing agent therefore did not write the code under review and has no memory of intending anything by it, so it is an independent reviewer **by construction**. Judge the diff strictly on its own merits - correctness, conventions, and the criteria below - and do **not** assume the author's intent was correct; that a change exists is not evidence it is right. The parallel finder subagents each receive only the change itself - the review pack's change-marked sections, never any generation reasoning - and re-derive expected behavior independently. The main agent then **verifies each finding against the actual code**: it reads the cited lines, confirms the issue is real, treats "the author clearly meant X" as inadmissible, and when uncertain **refutes** (drops) the finding rather than waving it through on assumed intent.

### Not the same as `/code-review ultra`

`ultra` is a Claude Code **built-in** that launches a multi-agent review in the **cloud** - user-initiated, billed, and not self-launchable by this skill. This project skill (`/code-review`) is an **in-session, local** reviewer: it fans out parallel read-only subagents via the `Agent` tool and synthesizes their findings in the main loop. Use `ultra` for a deep cloud audit on demand; this skill for the automatic, auto-fixing local pass. They are complementary, not unified - there is no attempt to share code between them.

## Instructions (driver)

The skill is a thin driver that runs in the main loop. All commands below run from the **current working directory** - never use `cd <path> && git ...` (triggers an unbypasable security prompt); use `git -C <path>` if you must target another directory. If the CWD is a worktree, git operates on it automatically.

**`<reviewDir>`, where this pass keeps its files.** `<reviewDir>` is the `code-review` folder inside the session scratchpad directory your environment block names (for example `<scratchpad>/code-review`). It is a fixed name so that a driver whose context was compacted can find its files again. Every file this pass writes goes there: the pack, the dirty list, the findings JSON, and the commit message. Do not keep them in `.kangentic/`: stopping an ephemeral worktree preview moves everything in the worktree's `.kangentic/` to a trash folder (`scripts/dev.js`), and a pass that loses its dirty list mid-run can no longer tell which files it may commit. Only when your session names no scratchpad is `<reviewDir>` the worktree's `.kangentic/`, with `--out-dir` left off the pack command. In a Bash command, write `<reviewDir>` and every path under it with forward slashes (`C:/Users/dev/...`), including a path you copy from a script's summary. On Windows the Bash tool is Git Bash, which drops the backslashes of an unquoted `C:\Users\dev\x` and passes `C:Usersdevx`. Node resolves that as a drive-relative path inside the worktree, so the pack and the dirty list would land as untracked files that Step 8 then commits. `Read`, `Write` and `Edit` accept either form.

1. **Pre-flight typecheck.** Run `npm run typecheck` to check for type errors. Any type errors are **highest-priority findings** - they represent potential runtime crashes. Include them in the review output even if they are in files not touched by the current diff.
2. **Pre-flight HMR vitest.** Run `npx vitest run tests/unit/hmr-resync.test.ts` (fast, ~150ms). This enforces the three mechanical HMR-parity invariants: every IPC-backed store has its `load*` / `sync*` registered in `App.tsx`'s `vite:afterUpdate` handler; every top-level mutable module state under `src/renderer/stores/` or `src/renderer/utils/` either preserves itself via `import.meta.hot.dispose(` or carries a `// hmr-safe:` directive; every `<DndContext>` has `key={...HmrGeneration}`. A failure here is a **Critical** finding (dev-mode regression that production users won't see but dogfooders will mistake for a real bug).
3. **Resolve the base branch.** Agents in this workflow sometimes commit during the working session, sometimes leave changes in the working tree, sometimes both - so the review scope is the full delta from the base branch through the working tree, the same surface `claude ultrareview` reviews. Resolve the base ref in this order, each its own Bash call, first hit wins:
   1. An explicit ref in `$ARGUMENTS` (the token that is not `review-only`), e.g. `origin/main` or a branch/SHA. Authoritative - use it verbatim.
   2. The repo default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (yields e.g. `origin/main`).
   3. Fallback locals: `git rev-parse --verify --quiet refs/heads/main`, then (if that fails) `git rev-parse --verify --quiet refs/heads/master`.
   If none resolve (no remote, no `main`/`master`), set base to empty and review the working tree only - note "base branch undetermined; reviewed working-tree changes only" in the Summary.
4. **Gather the diff (each command its own Bash call).** Capture all three layers for the driver's own use: the signature delta, the empty-diff check, the `--stat` summary, and `preexistingDirty` below. Finders never see this output; the pack script gathers the same layers itself.
   - **Committed-vs-base:** `git diff <base>...HEAD` and `git diff <base>...HEAD --stat` (three-dot = changes since the branch diverged from base). Skip when base is empty; an empty result otherwise just means no committed divergence, not an error.
   - **Uncommitted (staged + unstaged):** `git diff HEAD` and `git diff HEAD --stat` (`git diff HEAD` captures index + working tree in one command).
   - **Untracked new files:** `git ls-files --others --exclude-standard`. No diff shows these, but they are part of the change: `Read` each listed file so the signature delta below covers its exports. The pack script packs them itself, as sections in which every line is marked added.
   If the committed diff, the uncommitted diff, **and** the untracked list are all empty, emit "No changes to review." and stop (the script prints `NO CHANGES:` on the same condition). Compute the compact **signature delta** from these diffs and the untracked files (the integration finder consumes it; see "## Finders"). `changedFiles` comes from the build script's `paths:` line once it has run (below) - never from `--stat` output, which truncates long paths.

   **Record `preexistingDirty`** = the union of `git diff HEAD --name-only` and the untracked list: everything already dirty before this pass touched anything. Step 8 subtracts it to decide what it may commit. This is deliberately **narrower than `changedFiles`**, which also includes the committed-vs-base paths - conflating the two makes Step 8's set difference empty, so nothing would ever commit.

   **Use `--name-only`, never the `--stat` paths, for this set.** `--stat` abbreviates a long path to fit its column budget (`src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx`, already in this repo at 83 chars, renders as `.../sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx`). Step 8 compares against `git diff HEAD --name-only`, which never truncates, so a `--stat`-derived entry would fail to string-match its own full path, drop out of the subtraction, and get committed - the precise outcome this design exists to prevent. Keep the `--stat` capture for the human-readable summary only. This rule now guards the Step 8 dirty set alone: `changedFiles` no longer passes through `--stat` at all, since it comes from the script's `paths:` line.

   **Persist it immediately, do not just remember it.** `scripts/build-review-pack.mjs` (next paragraph) writes the list to `<reviewDir>/REVIEW_PREEXISTING_DIRTY.tmp` from the same gather; confirm the file exists, and only write it yourself (one path per line, `Write` tool) if the script was unavailable. Step 8 is many steps, a fan-out of up to 20 subagents, and a whole Apply Phase later, so this value has to survive a context compaction in between. If it does not survive, the set difference silently UNDER-counts and Step 8 commits the task agent's unfinished work - the exact outcome this design exists to prevent. `<reviewDir>` is outside the repo (or the gitignored `.kangentic/`), so the file never stages itself and needs no cleanup. The since-review pack below gets its OWN out-dir, so it can never overwrite this list.

   **Build the shared review pack (gather once, read N times).** Run `node scripts/build-review-pack.mjs <base> --out-dir <reviewDir> --shard-lines 1500` (one Bash call; omit `<base>` when the base is empty). Besides the `paths:` line below, the summary prints `shards: header 1-<k>; <a>-<b>, <c>-<d>, ...`: the pack split into ranges of about 1500 lines that start on a section heading and never split a section. Step 5 gives one correctness finder per range. The script writes two files into `<reviewDir>` and prints only a short summary that names both paths; verify both exist. `REVIEW_PACK.tmp.md` is the pack: a `Total lines: <N>` header, a one-line format legend, a table of contents with an exact start line for every changed file, then one section per changed file, largest churn first. Every body line is `<marker><line number><tab><text>` with `+` added, ` ` unchanged, and `-` removed (blank number, shown in place before the line that follows it), so each changed line appears exactly once and every citation is a working-tree line number. A file whose full body fits under the 200KB body cap is `## Full file:` or, windowed at 20 lines of context, `## Partial file:`; every other readable file is `## Changed hunks:`, the same windows at 3 lines of context. A file too large to read (over 1MB) that still has parsed hunks gets that same heading at 0 lines of context, and says so in the heading. A hunk section that alone exceeds the 100KB per-file cap becomes a one-line `## Changed hunks omitted:` stub and is listed under `## Not included (read on demand)`, as is any binary file and any oversized file the parse found no hunks for; a hunk-tier file is never listed there, because it already carries every changed line. Deleted, renamed-only, mode-only, and reverted files get a one-line section. There is no separate diff. `REVIEW_PREEXISTING_DIRTY.tmp` is the dirty list from the same gather. Which files get a body is decided on plain full-body cost, so neither windowing nor the marker format ever displaces a file the pack would otherwise carry. If the script is missing (older checkout), write the dirty list by hand per the rules below and give the finders the changed-file list with no pack path; never hand-build a pack, which is the `Write`-tool cost the next rule forbids. This exists because the 2026-08-29 audit (`docs/code-review-fanout-audit.md`) measured each finder independently re-gathering the diff (50-78k tokens each) and re-reading the same changed files (38% of all Read bytes duplicated): the pack pays that cost once. Two rules protect the savings: the pack is delivered as a FILE PATH, never embedded in finder prompts and never written through the `Write` tool (both re-bill the pack as driver output tokens - ~100k tokens at Opus rates for a 200KB pack - which is why the script does the writing); and `<reviewDir>` is outside the repo, so neither tmp file ever stages or needs cleanup.

   **Take `changedFiles` from the script's `paths:` line.** The summary block prints two distinct lines, and only the second carries paths:

   ```
     changed files: 6 (committed 0, uncommitted 4, untracked 2)
     paths: src/main/db/migrations.ts, src/renderer/App.tsx, ...
   ```

   `changedFiles` = that comma-separated list, verbatim. It is the script's own `changedFiles` array - the deduped union of all three layers, in full untruncated form - so it needs no reconstruction and cannot disagree with what the pack was built from. Read the `paths:` line, never the `changed files:` count line above it (counts, not paths), and never the pack's `## Contents` TOC. The TOC now lists every changed file too, but it is a navigation aid for finders, not a contract: reading it means opening the pack in the driver (billing the whole pack as driver input) and parsing paths back out of markdown labels, and every path dropped from `changedFiles` silently un-gates a domain auditor whose glob it matched (a missing `src/main/db/migrations.ts` skips `migration-safety`; a missing `src/main/pty/**` skips `platform-guard`) while the review still reports success. The `paths:` line is the one output the script promises for this purpose, which is exactly why it is the source.

   **Known limit of the format:** the paths are joined with `, `, so a changed file whose own path contains a comma-space would split into two phantom entries - one matching no auditor glob, the other under-gating. Git permits commas in paths, this repo has none, and the format is shared with the sibling repos, so do not redesign it here; if a path ever looks wrong in `changedFiles`, cross-check it against `git diff HEAD --name-only` before trusting the split.

   **Read the review ledger.** Earlier passes on this branch left a record of what they refuted and what they decided, in the bodies of their `*(review)` commits. When the base is non-empty, run `git log --grep="(review)" --format=%B <base>..HEAD` (one Bash call; keep the quotes, since unquoted parentheses are a shell syntax error) and keep every line that starts with `Refuted:` or `Decisions:`. Each line is keyed `<file> <symbol>: <mechanism>`, never by line number, because line numbers drift between passes. Empty output means this is the first pass. Step 6 uses these lines; a pass without them re-raises what earlier passes settled (task 736 re-raised 43 items over 9 passes, and refuted 12 of them a second time).

   **Build the since-review pack (a later pass only).** When the ledger read found an earlier pass, find where that pass began, so its own fixes are reviewed too: no finder ever read them, and every Phase 0 delta case (`docs/code-review-fanout-audit.md` section 15) is a review fix a later pass had to fix again. Run `git log --format="%H %s" <base>..HEAD` (one Bash call; newest first). Walk down to the newest commit whose subject starts `<type>(review):`, then keep walking while each older subject also starts that way; a pass's commits are contiguous, because the card stays in Code Review while they land. Match the subject prefix, never `--grep`, so a task commit that only mentions "(review)" cannot move the base. The base is the parent of the oldest commit in that run: run `node scripts/build-review-pack.mjs <oldest sha>^ --out-dir <reviewDir>/since-review` (one Bash call). That pack holds the earlier pass's fixes, the task agent's work since, and anything new. Its `paths:` line is `sinceReviewFiles`. Step 5 gives it to every pack-reading finder except the correctness shards; the integration finder still gets only the signature delta. If it prints `NO CHANGES:`, nothing changed since that pass began: Step 5 runs the correctness shards alone and gates no auditor.
5. **Fan out reviewer subagents (the `Agent` tool, ALL in ONE message so they run concurrently).** Every finder is a **read-only** subagent in its own fresh context window; only the driver (main loop) mutates the working tree, in the Apply Phase. Give each finder the changed-file list and the absolute path to `<reviewDir>/REVIEW_PACK.tmp.md`, with this instruction: load the pack FIRST and in FULL, in sequential `Read` calls of at most 1000 lines with explicit `offset`/`limit` (its first line states the total line count, so a pack of N lines takes ceil(N/1000) calls - do not re-read overlapping ranges; a 2000-line call can pass the `Read` tool's 25k-token cap and fail, which Phase 0 finders hit on dense packs); treat the pack's sections as the authoritative record of WHAT changed (the working tree stays the record of what the code is); do NOT run the git gather yourself; do NOT re-`Read` any file whose full body is in the pack; and STAY ON YOUR CRITERIA - the pack is the review surface, so do not spend calls re-verifying repo state outside your checklist (the A/B validation measured a finder giving back the entire saving by wandering into out-of-scope verification). Reading beyond the pack is for your criteria only: callers, rule files, tests, the `## Not included` files. Tell the finder what the section kinds guarantee, or it will re-read the file and give the saving back: every line carries a marker (`+` added, ` ` unchanged, `-` removed in place with a blank number) and its exact working-tree line number, so a citation from any section is correct, and a removed line is cited by the numbered line after it; `## Partial file:` carries EVERY changed hunk with 20 lines of context and `## Changed hunks:` the same with 3, with the unchanged runs between windows replaced by a marked, line-numbered gap (`..... 954 unchanged lines omitted (72-1025) .....`), so being windowed is not by itself a reason to re-`Read` a file - only a criterion that genuinely needs code inside a gap is. Every finder prompt also carries: a 3-6 line NEUTRAL summary of what the change does (mechanism only - phrase it as "context, not a licence to assume the author was right", per Reviewer independence) so the finder does not burn reads orienting itself; the instruction to end its final message with `Reads beyond the pack:` and one line per file it Read outside the pack (path and the criterion that needed it), or `none`; and the single-command Bash tool rule verbatim for any Bash-capable finder. Never hand a finder a raw diff inline and never hand it the Step 4 gather commands: the 2026-08-29 audit measured both variants costing each finder tens of thousands of tokens that the pack now pays once. The one exception is the integration finder, which gets ONLY the signature delta (below), not the pack. See "## Finders" for the exact set, the gates, the per-finder criteria, and the required return shape. The universal dimension finders always run; the domain auditors run only when their changed-file glob matches.

   **The correctness lane is sharded.** Spawn one correctness finder per range on the Step 4 `shards:` line. Each one's read plan replaces "load the pack in FULL" with: load pack lines 1-`<k>` (the header and table of contents), then its own range, in `Read` calls of at most 1000 lines with explicit `offset`/`limit`, and no other part of the pack. Each correctness finder covers the files in its own range and may read beyond the pack for the code those files call or test. A range that holds only tests is checked against the production code it exercises, which lives in another range. Every other finder reads the pack in full, as above. Sharding is the shape Phase 0 measured (`docs/code-review-fanout-audit.md` section 15): it costs about what one finder over the whole pack costs, and a long pack no longer sits in one context.

   **Stay under 20 concurrent agents.** Count the finders before you launch: one per shard, the other universal finders, and every gated auditor whose glob matched. If the count would pass 20 (the harness's limit on concurrent subagents), merge the smallest range into its smaller neighbour, and repeat until it fits. The ranges are contiguous and never split a section, so merged ranges stay valid. Launch everything in ONE message.

   **A later pass gives the since-review pack to every finder but correctness.** When Step 4 built a since-review pack, the correctness shards still read the full pack, and their criteria gain the Best Practices security line (injection risks, unsanitized input). Every other pack-reading universal finder and every gated auditor gets `<reviewDir>/since-review/REVIEW_PACK.tmp.md` instead (the integration finder still gets only the signature delta, never a pack), and the gated auditors gate on `sinceReviewFiles`, not `changedFiles`. When that pack came back `NO CHANGES:`, only the correctness shards run. Code an earlier pass reviewed is still read for defects. Its maintainability, performance and conventions calls were already made and are in the ledger. Re-raising them on every pass is the loop this skill exists to stop.
6. **Synthesize + verify (main agent).** Collect every finder's findings. For each, **verify it against the actual code** - read the cited `file:line` (for a removed line, the pack section that shows it, since the working tree no longer does), confirm the issue is real, and refute (drop) anything the code does not substantiate or that cannot be stated falsifiably (judge the code, not assumed intent). Dedup findings the same issue surfaced from multiple dimensions (e.g. an `any` flagged by both correctness and conventions), keeping the highest severity and clearest recommendation. Then check each surviving finding against the Step 4 ledger: a finding with the same file, symbol and mechanism as a `Refuted:` or `Decisions:` line is refuted with the reason `ledger: <the earlier reason>`, unless it cites evidence the earlier reason did not cover (an input it never considered, code that changed since, a test that now fails). A finding that does cite such evidence is verified like any other and recorded with `reRaise: { of: <the ledger line>, newEvidence }`. Never overturn an earlier decision without that evidence: two passes flipping the same call is the loop this rule exists to stop. Fold in the pre-flight signals: Step 1 type errors as Critical rows; a Step 2 vitest failure as a Critical row with the assertion message verbatim. Sort by severity. If a finder returned nothing usable (it errored or came back empty), note the dropped dimension in the Summary. Tally every finder's `Reads beyond the pack:` lines and the script's `pack:` summary line (size, hunk sections, stubbed) for the Summary's Pack line: that is the per-review record of whether the pack's context width and per-file cap are right.
7. **Apply Phase + checks** (skip both in `review-only` mode). Resolve every verified finding as "## Apply Phase" describes: fix it (Lows included), apply the recommended option on a decision, file a larger out-of-diff item in the one grouped follow-up task, or, only after trying, mark it blocked with the step a person must take. Each fix is its own atomic unit. Then re-run `npm run typecheck` and `npx vitest run tests/unit/hmr-resync.test.ts`, the scoped run of every test this pass added, and the scoped run of each existing unit test file that imports a source file a fix touched (find them with `Grep` for the module's path under `tests/unit/`). A fix can break a test it never mentions: in the Phase 0 replay, a review fix that moved a guard above its `try` failed an existing test, and no finder caught it (`docs/code-review-fanout-audit.md` section 15). Keep this scoped: when more than five files import a touched module (a shared module such as `src/shared/types.ts`), run only the ones named after it and leave the rest to CI. When an existing file fails, revert that fix's edit and run the file again. A file that still fails was broken before this pass: add it to `followUps`, and it does not fail `scopedTests`. A file that passes without the fix means the fix is wrong, which the type-error rule below covers: try once more, then `blocked`. If a fix introduces a new type error, revert that specific edit and try once more with a different fix; if the second attempt also fails, the finding is `blocked` with a `step` that names the error and the file. Do not roll back unrelated fixes. The Apply Phase also **fills coverage holes** through `test-builder`, every tier included (see "Auto-adding missing tests"). Finally, write `<reviewDir>/findings.json` with the `Write` tool, in the shape the header of `scripts/review-verdict.mjs` documents: every finding with its final `status` (`fixed`, `refuted` or `blocked`), the three check results, and any `followUps`. There is no `skipped` status, and the script refuses one.
8. **Commit the pass** (skip in `review-only` mode, which writes nothing). Commit this pass's own work so the worktree returns to clean and the next agent inherits an attributed commit instead of a mystery. The commit body carries the ledger, so a later pass knows what this one refuted and decided. See "## Committing the pass" for the set rule, the exact commands, the ledger-only commit, and the mixed-authorship case.
9. **Report.** In `review-only` mode, emit the Review-only-mode footer below and run no script. That mode writes no `findings.json`, and a file an earlier pass left in `<reviewDir>` would give a verdict for findings this review never raised. In default mode, run `node scripts/review-verdict.mjs <reviewDir>/findings.json` and emit the **Output Format** below, ending with that command's output pasted verbatim. Its closing block (`Verdict: Ready`, or `Verdict: Blocked` followed by the numbered steps) is the LAST thing in your final message: no closing prose after it, and no offer of another pass. A person reading the board and an agent reading the transcript both act on those lines, so never relabel the verdict or soften it in your own words.

## Finders

The driver spawns all finders as **read-only** `Agent` subagents **in a single message** so they run in parallel (the orchestrator-worker fan-out). The universal dimension finders always run; the domain auditors are **gated by changed-file globs** and each is its own registered auditor agent, spawned via `subagent_type` - it loads its own domain skill and runs its checklist, so do not duplicate that checklist in the prompt. Findings come back as **text** (the `Agent` tool returns the subagent's final message, so there is no enforced schema): each finder MUST return a structured list, one block per finding with `severity`, `category`, `location` (`file:line`), `finding`, and `recommendation`, plus the falsifiable triple (`triggeringInput`, `codePath`, `testGap`) for every Correctness/Critical finding.

| Finder | `subagent_type` | Run | Gate (changed-file glob / hunk) |
|---|---|---|---|
| Correctness / Performance / Maintainability / Best-Practices+Conventions | `review-finder` (seed with the matching Review Criteria slice, incl. the "no agent-specific code outside `adapters/`" rule, `any`, shorthand, external-parser fixture) | ALWAYS (one finder per dimension; correctness gets one per `shards:` range, see Step 5) | - |
| Cross-file integration (signatures only) | `review-finder` (special prompt below) | ALWAYS when `changedFiles > 1` | - |
| Test coverage (red-green) | `review-finder` (seed with the red-green coverage criteria below) | ALWAYS when the diff changes behavioral source under `src/`, `scripts/`, or `packages/` (self-skips docs-only / test-only / pure-styling diffs) | - |
| IPC consistency | `ipc-auditor` | GATED | `ipc-channels.ts`, `types.ts`, `preload.ts`, `src/main/ipc/handlers/**`, `tests/ui/mock-electron-api.js`, `src/renderer/stores/*-store.ts` |
| HMR parity | `hmr-parity` | GATED | `src/renderer/stores/**`, `src/renderer/utils/**`, `src/renderer/App.tsx`, or any hunk with `<DndContext`/`import.meta.hot`/a new top-level renderer `let` |
| Cross-platform | `platform-guard` | GATED | `src/main/pty/**`, `src/main/agent/**`, `src/main/git/**`, `shell-resolver.ts`, `command-builder.ts`, `worktree-manager.ts`, `paths.ts`, `useTerminal.ts`, or any hunk using `path.join`/`fs.rmSync`/`child_process`/an em-dash |
| Session/PTY lifecycle | `session-debugger` | GATED | `session-manager.ts`, `session-queue.ts`, `transition-engine.ts`, `tasks.ts` (handleTaskMove), `session-store.ts`, `TerminalPanel.tsx`, `TaskDetailDialog.tsx` |
| Migration/schema | `migration-safety` | GATED | `src/main/db/migrations.ts`, `src/main/db/repositories/**`, `src/shared/types.ts` (schema interfaces), `src/main/db/database.ts` |

**Explicit, falsifiable criteria (this is the point of splitting).** Each finder prompt must enumerate concrete, falsifiable criteria - never a vague lens like "review for performance." Embed the matching Review Criteria sub-bullets verbatim for the universal finders; the gated finders inherit their auditor's explicit checklist. Every finding must carry a specific `location` (`file:line`) and a concrete `recommendation`. **Correctness / Critical findings must supply the falsifiable triple:** `triggeringInput` (the specific input that triggers the failure), `codePath` (the failing path), and `testGap` (why existing tests miss it). A finding that cannot be stated falsifiably should not be raised.

**Cross-file integration pass - signatures only (stays cheap).** The single-file finders cannot see interactions. The driver computes a compact "diff interface delta" from its own Step 4 diffs alone - **no file bodies, no pack** - and passes only that to the integration finder:

- `changedExports` - added/changed/removed exported signatures
- `typeDeltas` - interface/type member changes (e.g. a field becoming required)
- `newIpcChannels` - new channel constants in `ipc-channels.ts`
- `importChanges` - added/removed import edges between changed files
- `storeShapeMutations` - new/removed Zustand store fields

It answers questions the per-file finders structurally cannot: a new IPC channel constant with no handler/preload/mock layer touched (7-layer drift); `Task` gained a required field but no migration changed; an export's signature changed but a caller in another changed file still passes the old shape. Input is O(signatures) - a few hundred tokens regardless of diff size - so this pass is roughly constant cost and does not reintroduce long-context degradation. **The driver computes the delta itself and the finder never receives the pack path or gather commands**: in the #568 review the driver delegated the gathering and the "signatures only" finder read 254k tokens of file bodies, 500x its design budget. Its prompt keeps the repo-wide removed-surface `Grep` duty (that needs `Grep`, not file bodies).

**Removed / renamed surface (correctness + integration finders).** When the diff **deletes or renames** an exported symbol, a string constant, a wire-format token, an enum member, or a config key, a repo-wide search is the only way to catch survivors: the type checker cannot see string-keyed contracts, references in non-typechecked `.js`, or test files that reconstruct the old form as string literals. So for each removed/renamed identifier in the signature delta, the correctness and integration finders must `Grep` the **whole repo (including `tests/`, `docs/`, and `.js`)** and flag any surviving reference outside the diff as a finding. (This class produced the only blocking findings in a recent review - two test files outside the diff still emitted a removed directive format that `tsc` happily passed.)

**Test coverage - the red-green pass.** A dedicated coverage finder runs in the same parallel fan-out whenever the diff changes behavioral source under `src/`, `scripts/`, or `packages/` (it self-skips docs-only, test-only, and pure-styling diffs). The gate is the code, not the directory: a `scripts/` change with a `tests/unit/` file behind it is exactly as reviewable as one under `src/`, and reading the gate as `src/`-only would have skipped the finder that added five tests to the review-pack rewrite. It is **read-only** like every other finder; the tests it identifies are written in the Apply Phase by the `test-builder` agent (see "## Apply Phase"). Its single falsifiable question, asked per behaviorally-significant change in the diff:

> Is there a test that would **fail if this change were reverted**?

If not, it reports a **coverage hole**: the `location`, the specific behavior left unverified, why the existing tests miss it (commonly: the line is executed but its effect is never asserted - the exact gap that let an activity-engine seed ship untested), and a **suggested tier** (unit / UI / E2E) as a hint only. Its read slice is the narrowest of any finder: the pack (which already carries the changed implementation AND changed tests) plus additional TEST files only - its question is answered by tests, so it never reads unchanged implementation bodies beyond the pack. It does NOT re-derive the tier rules or write anything: the authoritative tier classification and the authoring belong to `test-builder` in the Apply Phase, so there is one source of truth for tiering. Scope holes to behavior the diff **introduced or changed** - pre-existing untested code is a separate `/test write` task. Pure refactors with no behavior change, styling, and docs produce no holes.

If a finder errors or returns nothing usable, the review proceeds on the surviving dimensions; note any dropped dimension in the Summary.

## Review Criteria

### Correctness
- Logic errors, off-by-one mistakes, null/undefined risks
- Missing error handling or unhandled promise rejections
- Race conditions or incorrect async/await usage

### Performance
- Unnecessary allocations, re-renders, or repeated work
- Missing memoization where expensive computation occurs
- Inefficient data structures or algorithms

### Maintainability
- Readability: unclear naming, overly complex expressions
- Duplication that should be extracted
- Premature abstractions or over-engineering

### Best Practices
- TypeScript strict mode compliance - **no `any` in new code**. Use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints. Flag any new `any` or `as any` cast as a finding.
- **External-input parsers need a real-shape fixture test.** When code parses input from outside the TypeScript boundary (`JSON.parse` of file contents, IPC payloads from external CLIs, network responses, child-process stdout) and dispatches on string-literal field comparisons, flag it as a finding unless there is a regression test that replays a real (sanitized) sample of the external format. Type-safety stops at the parse boundary. TypeScript will happily narrow `unknown` to a union you declared, even when the runtime shape has drifted. Runtime fixtures are the type system on the other side. See `tests/fixtures/codex-rollout-event-msg.jsonl` + `tests/unit/codex-session-history-parser.test.ts` for the canonical pattern.
- **No shorthand variable names** in new or changed code. Use full, descriptive names: `session` not `sess`, `currentIndex` not `curIdx`, `previousValue` not `prev`. Applies to variables, parameters, callback args, refs.
- Security: injection risks, unsanitized input
- Proper error handling at system boundaries

### Project Conventions (source of truth: `.claude/rules/`)

These are summarized for review convenience; the authoritative, enforced versions live in `.claude/rules/*.md` (each names its test and/or auditor agent).

- Single-command bash calls only (no `&&`, `||`, `|`, `;` chaining) - see `.claude/rules/bash-single-command.md`
- House writing style in every piece of authored prose the change adds or rewrites: comments, docs, README, UI copy, and the PR body this pass writes. No em-dashes, en-dashes, `--` as a separator, or curly quotes; no model vocabulary or puffery; sentence-case headings; active voice; say what it does, not how it feels - see `.claude/rules/writing-style.md`. Judge only what the change touches; pre-existing prose is out of scope by that rule's own terms. This line is the docs backstop for the judgment half of the rule. `platform-guard` (see "## Finders") flags dashes and its gate does fire on an em-dash in any hunk, but it checks characters only, so a docs-only or markdown-only change reaches no other reviewer for vocabulary, sentence construction, and voice.
- Lucide React icons only (no inline SVGs)
- Every JSX element rendered from `.map()` (or any array) carries a stable `key`. This check is review-only, since `react/jsx-key` left with `eslint-plugin-react` and no ESLint 10 plugin has replaced it - see `.claude/rules/ui-conventions.md`
- `data-testid` and `data-swimlane-name` attributes for test selectors
- Zustand stores with IPC bridge pattern
- IPC channels defined in `src/shared/ipc-channels.ts`
- Dialogs dismiss via `BaseDialog`'s structural Escape (registered display-only as `dialog.dismiss` in the `KEYBINDINGS` registry); flag a new ad-hoc `addEventListener('keydown')` shortcut outside the registry - see `.claude/rules/keybindings-registry.md`
- `IntentKeyboardSensor` is the only dnd-kit keyboard sensor: it arms only on Tab-placed focus and cancels on a pointer press or a focus move, because the stock `KeyboardSensor` lifts a mouse-focused card on Space/Enter into a ghost that no click or terminal keystroke can end. Flag a `useSensor` site that registers `KeyboardSensor` (or a keyboard sensor of its own, or none while its sortables spread `attributes`), `attributes` and `listeners` spread on two different elements, a key added to the tracker's arming set without the default-action-moves-focus justification, a cancel path that dispatches a synthetic Escape / `visibilitychange` / `resize` instead of the sensor's own `onCancel`, and a transform on the board `DragOverlay`'s first child (dnd-kit measures it) - see `.claude/rules/keyboard-drag-intent.md`
- Shared UI primitives: use `Select` (no raw `<select>`), `CountBadge` for counts, `ConfirmDialog` for confirmations; min font `text-[11px]`; avoid hover-only controls; settings/UI copy is one sentence of about 110 characters, never opens with a rhetorical question, carries only what is essential AND non-obvious, and holds no raw hex/byte literals or platform-specific justification for a universal default - see `.claude/rules/ui-conventions.md`
- A choice-presenting popover (menu, listbox, picker) portals to `document.body` and positions with `usePopoverPosition({ mode: 'dropdown', strategy: 'fixed' })` at `z-[2147483646]`; `z-index` never escapes an ancestor's overflow clip. A menu that stretches to its trigger passes `matchTriggerWidth: true`, never a width measured in the consumer's own later effect (the hook measures first, so that width lands a commit late and the first open per mount is misplaced). Flag a new in-flow `absolute` menu, an outside-click or keyboard-nav handler that checks only the trigger ref, and a consumer-side trigger-width measurement - see `.claude/rules/popover-escapes-clipping.md`
- Light dismiss is a DENYLIST: everything inside a `data-dismiss-layer` shell subtree closes an open task window on a clean click unless excluded. Flag a new overlay mounted INSIDE that subtree rather than as a sibling, an action cursor (`cursor-grab` / `-col-resize` / `-row-resize` / `-move`) without `data-no-dismiss`, and a hover affordance on dead space that promises an action the click will not deliver - see `.claude/rules/light-dismiss-denylist.md`
- The renderer session store is a REPLICA of main's registry: a row leaving the registry emits `session-removed` (never a forced status), a status push only upserts and a removal push only removes, and dropping a session scrubs every map keyed on it through `withoutSessions`. Flag a new `sessions` writer that bypasses the index helpers, a new registry-row exit with no `session-removed`, and a new push handler that does another push's job - see `.claude/rules/session-replica-contract.md`
- No personal info / machine paths in committed code (repo is public) - see `.claude/rules/no-personal-info.md`
- Dev tooling build-time excluded via `__KANGENTIC_DEV__`, not runtime-toggled - see `.claude/rules/dev-tooling-build-exclusion.md`
- **No agent-specific code outside `src/main/agent/adapters/`.** Flag any branch on agent name (`agent === 'claude'`, `agent === 'droid'`, `taskAgent === '<x>'`, `switch (adapter.name)`, etc.) found in renderer code, IPC handlers, shared utilities, stores, or tests outside the `adapters/` tree. Adapter-specific copy, tooltips, capability decisions, and behavior must live with the adapter and surface through generic capability fields (e.g. `AgentAdapter.liveTelemetryUnsupported`, `AdapterRuntimeStrategy`, `AgentDetectionInfo` extensions). Suggested grep: `agent === '|taskAgent ===|adapter\.name ===` under `src/renderer/`, `src/shared/`, and `src/main/ipc/`.

### Domain-Specific Checks

Each domain is owned by a dedicated **gated auditor finder** (see "## Finders" for the gates). The auditor agent is the single source of truth for its checklist: it carries its domain skill via `skills:` preload frontmatter and/or its own agent body, and IT performs the check - the driver only spawns it. Do not restate auditor checklists here: the same no-duplication rule the finder prompts follow applies to this file (the checklists were previously mirrored in this section and drifted). One line each so the driver knows the coverage:

- `ipc-auditor` - 7-layer IPC parity, push-event hygiene, broadcast guards (preloads `ipc-bridge`)
- `session-debugger` - session state machine legality, generation guards, terminal ownership (preloads `session-lifecycle`)
- `platform-guard` - cross-platform pitfalls, shell quoting, text formatting (preloads `cross-platform`)
- `hmr-parity` - the four HMR primitives; semantic mismatches beyond the Step 2 vitest's mechanical checks (source of truth: `.claude/rules/hmr-patterns.md`; a missing pattern is High severity)
- `migration-safety` - migration idempotency, schema/TypeScript alignment, repository column coverage

## Model selection

- **Finders** (every parallel subagent, universal and gated): **Sonnet at medium effort**, pinned in agent frontmatter, never passed per spawn. The universal finders spawn as `subagent_type: "review-finder"` (`.claude/agents/review-finder.md`: `model: sonnet`, `effort: medium`, `tools: Read, Glob, Grep` - the restricted roster drops the ~22k-token tool/MCP manifest from each floor, and under the pack the finders need no Bash or git). The gated auditors carry `effort: medium` in their own frontmatter, on Sonnet except `ipc-auditor`, which runs Haiku: in the section 16 replay of `docs/code-review-fanout-audit.md` it found both planted parity gaps in every run, as Sonnet did, at about a tenth of the cost. The universal finders stay on Sonnet: at medium and at high effort, Haiku missed one of the S4 replay's three known findings in at least one repetition and raised 1.4 to 1.7 times as many findings. Where a domain skill exists they preload it via `skills:` (`ipc-auditor` -> `ipc-bridge`, `session-debugger` -> `session-lifecycle`, `platform-guard` -> `cross-platform`) so the domain material arrives deterministically instead of by runtime discovery. Sonnet at medium is enough because the review's depth and safety come from the **structure** - many independent finders plus main-agent verification and dedup - not from each finder being a frontier reasoner. Known limits (documented harness behavior): subagents inherit the session's extended-thinking config and advisor model with no per-subagent override; `effort` is the available lever.
- **The correctness lane** is the same Sonnet-medium `review-finder`, one per `shards:` range (Step 5). Phase 0 (`docs/code-review-fanout-audit.md` section 15) replayed four shapes over four historical states: one finder, 1500-line shards, one Opus finder, and the shards at high effort. All four found about one late defect per run, so the cheapest shape won. The shards at high effort were the only shape that found the same late defect in both runs, at 2.8 times the cost. Every finder dimension earns its place: the one late defect no correctness shape found was raised by the performance finder, and the S4 replay's three known findings came from the maintainability and coverage finders.
- **Synthesis + verification + Apply Phase** (the driver / main loop): the **session model at its configured effort** - the most capable agent in the system. Findings are verified against the code, deduped, and turned into edits here, so the strong model is spent on the one bounded synthesis context rather than across the fan-out. Because `/code-review` runs in a fresh isolated session, this synthesis agent is an independent reviewer (see "Reviewer independence").

For a deep, no-expense-spared cloud audit, use the `ultra` built-in instead (see "Not the same as `/code-review ultra`").

## Apply Phase

Default mode applies fixes immediately after the findings table, then commits them (Step 8, see "## Committing the pass"). The commit is **local only, never pushed** - landing the branch is still `/pull-request`'s or `/merge-back`'s job.

**This edits and commits in the worktree it is reviewing, and the task agent's own unfinished work is usually already sitting there.** The board spawns this skill from the Code Review column as an `isolated` + `always_spawn_new` session, but `isolated` isolates the **conversation, not the filesystem**: the session's `cwd` is the task's own worktree, the same tree the task agent has been using (`docs/session-lifecycle.md:222` documents the shared worktree).

The two do **not** run concurrently. Entering an isolated column takes the `needsSessionSwitch` branch in `src/main/ipc/handlers/task-move.ts`, which suspends the task agent's main session and kills its PTY (`docs/session-lifecycle.md:228`, plus "one active PTY per task" at `:222`), preserving `agent_session_id` so it resumes when the card leaves. What the suspended agent leaves behind is its **uncommitted working tree** - and by the time you reach Step 8, those files are indistinguishable from your own edits. That is the whole reason Step 8 commits by set math instead of `git add -A`.

Committing the pass is also what keeps the tree legible downstream: a finished pass **normally** leaves a clean tree plus one attributed commit. Normally, not always - a fix that lands on an already-dirty path stays uncommitted by design (see "The mixed-authorship case"), so a dirty tree downstream means one of two things, not one: this pass is still in flight, or it finished and deliberately left those paths mixed. `/pull-request`'s Pre-flight Checks documents both readings.

### How each finding resolves

Every verified finding is fixed in this pass, Lows included. Severity sets the order you work in and how careful a fix must be; it never decides whether a finding gets fixed. There is no "skipped" status. A skip that waited for a person cost a full Executing round, and on 8+ tasks the answer was always "fix findings" (`docs/code-review-fanout-audit.md` section 15). Each finding ends in exactly one of these:

- **`fixed`.** The default. Typical fixes, for orientation rather than as a limit: `any` to a real type; shorthand names expanded; em-dashes and `--` separators replaced; a missing `data-testid`; chained Bash split into single commands; `cd <path> && git` to `git -C <path>`; `{ force: true }` on `fs.rmSync`; a missing `isDestroyed()` guard; an inline SVG to a Lucide icon; agent-specific code moved into `src/main/agent/adapters/`; a type narrowed. A rename across many call sites is still a fix, because typecheck verifies it.
- **`fixed` with a `decision`.** When a finding has more than one valid answer (two designs, UX copy, a security or logging policy, deleting code the author just added, two findings that conflict), apply the option you recommend and record `decision: { chosen, alternative }`. The pass never stops to ask. The report's "Decisions made" list and the commit's `Decisions:` lines carry the alternative, so the call is visible and easy to reverse.
- **Out of the diff.** If the issue relates to this change and you understand both the problem and its fix in this pass, fix it here (`fixed`). That includes a type error in a file the diff did not touch. If it is a larger item that needs its own design, leave it out of `findings` and add it to `followUps` (`title`, `location`, `why`). File ONE grouped To Do task per pass for all of them with `kangentic_create_task`: title "Follow-ups from code review: <task title>", one item per line in the description. Record its board id in `followUpTask`. Missing tests for old code the diff did not touch also go here. Follow-ups never affect the verdict.
- **`refuted`.** The code does not bear it out, it cannot be stated falsifiably, it matches the ledger with no new evidence, or the fix would trip a hook the user opted out of. Give the reason; it becomes a `Refuted:` ledger line.
- **`blocked`.** Only for work this session cannot do, and only after you tried what you can run yourself. Try first: `npm run package` for a packaged-build check, a capture from a CLI that is installed, a fixture you can generate. What is left (a live login, a tool this machine does not have, a fix that broke typecheck twice) is `blocked`. Give a `reason` and a `step` that says exactly what a person or the task agent must do. Any non-quick blocked finding makes the verdict Blocked, the one outcome that sends the card back to Executing.

A finding is **`quick: true`** when its fix is mechanical, at one site, in a file the change touched, and needs no new test: a stale comment or doc line, a renamed local, a wrong path in a message. It resolves like any other finding, is counted on the Summary's "Quick fixes" line, with the fix itself as a row in Changes Applied, and never decides the verdict, even if it ends `blocked`. It never carries a `decision`, because a choice between valid answers is not mechanical. The script refuses the pair.

### Auto-adding missing tests (coverage holes)

When the coverage finder reports a red-green hole on behavior **this diff** introduced, the Apply Phase fills it. A hole is a finding like any other (category `Coverage`): `fixed` once its test is written and green, `blocked` only under the rule above. `/pull-request` remains the hard CI gate behind this pass.

1. **Delegate to `test-builder`** (the `Agent` tool, `subagent_type: "test-builder"`) - one call per hole, or one batched call for several holes in the same area. Pass the hole's `location`, the behavior to pin, and the red-green rationale. `test-builder` owns the authoritative tier choice and the Windows/CI flake discipline, so do not pre-bake the tier - hand it the behavior and let it classify.
2. **Unit and UI tiers.** `test-builder` authors the test and runs ONLY that new file scoped (`npx vitest run <file>` or `npx playwright test <spec>`) to confirm green. Never run the full suite - that is `/pull-request`'s job on CI.
3. **E2E tier, written in the pass too.** `test-builder` runs `npm run build` once, then each new spec alone, scoped: `npx playwright test --project=electron tests/e2e/<file>.spec.ts`. That is safe beside other worktrees: since `a11c33a5` the leak janitor no longer reads another worktree's live Electron as an orphan, and `NODE_ENV=test` skips the single-instance lock. Record the E2E wall time in the report's pass record (`E2E: <n> specs, <m> min`). This is the zero-debt choice, not a measured one, and that record decides whether it stays.
4. **Red-green standard.** The test must assert the post-fix behavior such that reverting the change fails it. Where the change is localized, `test-builder` may briefly toggle the fix to confirm the test goes red, then restore it.
5. If `test-builder` cannot produce a green test, try once more with the behavior stated more narrowly. If that also fails because the test needs something this session cannot get (a live CLI reply, a device), the hole is `blocked`, with a `step` such as "capture a real reply into `tests/fixtures/<name>`". Never leave a red or `.skip` test behind.

Tests are committed with the rest of the pass (Step 8); they are new untracked files, so they always fall on the committable side of the set rule below.

## Committing the pass

Step 8, default mode only. The goal is that a finished pass leaves the worktree **clean**, with its work in one commit whose message says who wrote it.

### What may be committed

This skill deliberately reviews uncommitted work (Step 3: agents "sometimes commit during the working session, sometimes leave changes in the working tree, sometimes both"), so the tree is often **already dirty with the task agent's own unfinished work** when the pass starts. A blind `git add -A` would commit that work under a `refactor(review):` message, which is worse than leaving the tree dirty. So:

> Commit **only** what became dirty during this pass. Never `git add -A`.

Do not try to track "the files the Apply Phase edited" - there is no such value, and `test-builder` is a subagent whose test-file writes are not driver `Edit`/`Write` calls at all, so it would miss them. Use set math over git state instead, which is provable and needs no subagent cooperation. Each command is its own Bash call:

1. `git diff HEAD --name-only` - tracked files dirty now.
2. `git ls-files --others --exclude-standard` - untracked files now.
3. `currentDirty` = the union of those two. **Committable = `currentDirty` minus `preexistingDirty`**, reading `preexistingDirty` back from `<reviewDir>/REVIEW_PREEXISTING_DIRTY.tmp` (written at Step 4) rather than from memory. If that file is missing or unreadable, do NOT guess and do NOT fall back to `git add -A`: skip the commit, and report that the pass could not establish what it may safely commit so the user can stage it themselves.

Anything dirty now that was not dirty at Step 4 is provably this pass's work, whoever wrote it. The edge cases need no special handling: `test-builder`'s new test files are untracked now and were not before, so they commit; a fix on a path the task agent had already left dirty is in both sets, so it is excluded; a fix auto-reverted by the re-typecheck step returns that file to clean, drops out of `currentDirty`, and is never committed.

If Committable is empty, there are no files to commit, but the ledger still has to land: see "The ledger-only commit" below. If the ledger is empty too (nothing refuted, nothing decided), skip the commit and go to the Output Format.

### How to commit

1. Stage each committable path explicitly: `git add <path>`, **one path per Bash tool call** (`.claude/rules/bash-single-command.md` forbids chaining).
2. Run `node scripts/review-verdict.mjs <reviewDir>/findings.json --ledger`. It prints the `Refuted:` and `Decisions:` lines for the body; if it exits 2, fix the findings file it names and run it again. Then write the message to `<reviewDir>/COMMIT_MSG.tmp` with the **Write** tool. Never write to `.git/`; in a worktree `.git` is a file, not a directory.
3. `git commit <path1> <path2> ... -F <reviewDir>/COMMIT_MSG.tmp` - **pass every committable path as a pathspec.** One command with several positional args, so it still satisfies `.claude/rules/bash-single-command.md`. Never use `$(...)` or backtick substitution (triggers a safety prompt).

   **A bare `git commit -F` here is a real bug, not a shortcut.** With no pathspec, `git commit` commits the ENTIRE INDEX. The task agent routinely pauses with work already staged (`git add somefile.ts`, no commit yet); Step 4 correctly puts that file in `preexistingDirty` and Step 8 correctly excludes it from Committable, and then a bare commit sweeps it in anyway because it was sitting in the index the whole time - defeating the set math completely. The pathspec form commits only the named paths and leaves a pre-staged file untouched and still staged. As a cheap assertion, `git diff --cached --name-only` should equal Committable immediately before you commit; if it does not, stop rather than commit.

The message is conventional, and the scope is literally `review`: `fix(review):`, `refactor(review):`, or `test(review):`, picked by primary change type. The body lists what was fixed, one line per finding, then a blank line, then the `--ledger` output verbatim. The ledger is how a later pass knows what this one settled (Step 4 reads it back), so it is never trimmed or wrapped. Commitlint reads its lines as footer trailers, and the repo's config lifts the footer line cap for exactly this reason. Name a follow-up task in prose ("filed as a follow-up task on the board"), never as `#N`: GitHub turns `#N` into a link to an unrelated issue. `allowed-tools` already grants `Bash(git:*)`, so nothing new is needed there.

### The ledger-only commit

When every fix landed on an already-dirty path and no test was added, Committable is empty, yet the ledger still has to reach the branch, or the next pass re-raises everything this one refuted. Task 749's first four passes and one of task 756's passes committed nothing for exactly this reason. Make an empty commit that carries only the ledger:

`git commit --allow-empty --only -F <reviewDir>/COMMIT_MSG.tmp`

with the subject `chore(review): record refuted findings and decisions` and the `--ledger` output as the body. `--only` with no paths commits nothing from the index, so a file the task agent left staged stays staged, which is the same guarantee the pathspec form gives. A bare `git commit --allow-empty -F` would sweep the whole index in. `/pull-request` keeps this commit through its rebase (git keeps commits that start empty) and finds no test files in it to re-run.

### After the report

If the session continues after the report, for example the user types "fix this too", commit everything that follow-up writes as another `*(review)` commit. Use the same set math against the same Step 4 dirty list, and update `findings.json` and the ledger. Fixes a review session wrote and left under another scope fed the next pass code nobody had reviewed: task 761's `perf(changes)` follow-up and task 765's `fix(utility-process)` follow-up were both later found to need fixes.

**Use `review` as the scope even though scope usually names a code area.** A review pass is routinely spread across every area it reviewed - one real pass touched migrations, git, IPC handlers, the transition engine, and the renderer at once - so no single area scope is honest, and the useful grouping is which pass produced the commit. It also makes the commit greppable, which the reading side relies on: `/pull-request`'s Pre-flight tells the next agent to expect exactly a `*(review)` commit and to leave it alone rather than squash or reword it.

**Never push. Never amend an existing commit.** Amending would rewrite the task agent's commit and claim this pass as part of it, which is the misattribution this whole design exists to prevent.

### The mixed-authorship case

When a fix lands on a path that was already dirty, that fix stays uncommitted, mixed into the task agent's work in the same file. The hunks cannot be separated safely, so do not try. Instead the footer must **list those paths by name** - "some fixes left uncommitted" is not enough, because the next agent inherits a dirty tree and needs to know exactly which files hold two authors' work before it stages anything.

**The same split can strand a test.** A coverage-hole test is a new untracked file, so it always falls on the committable side; if the behavior it pins lives in a file that stays uncommitted, the commit lands a test with no corresponding fix in its own history. The working tree is fine (the fix is physically present, just uncommitted), but that commit read in isolation - a bisect, or a later `git stash` of only the dirty paths - is not. When it happens, commit it and say so explicitly in the footer: "test committed without its target fix (see the mixed-authorship list)."

## Output Format

### Findings Table

Present every verified finding in a single table, sorted by severity (Critical first, then High, Medium, Low), with the status it ended in:

| # | Severity | Category | Location | Finding | Fix | Status |
|---|----------|----------|----------|---------|-----|--------|
| 1 | High | Correctness | `src/main/foo.ts:42` | Brief description of the issue | What changed and why | fixed |
| 2 | Medium | Performance | `src/main/baz.ts:88` | Brief description | The option chosen | fixed (decision) |
| 3 | Low | Maintainability | `src/shared/types.ts:10` | Brief description | - | refuted |

#### Severity levels

| Severity | Meaning |
|----------|---------|
| **Critical** | Type errors, runtime crashes, data loss, security vulnerabilities |
| **High** | Logic bugs, missing error handling, `any` types, race conditions |
| **Medium** | Performance issues, convention violations, unclear code |
| **Low** | Style, minor duplication, small improvements |

Severity sets how much risk a finding carries and the order you fix things in. It does not decide whether a finding is fixed: every verified finding is.

### Default-mode report

After the findings table, run the Apply Phase and then emit the sections below. The verdict script's output comes last, verbatim:

```
### Changes Applied (N)

| # | File:Line | What changed |
|---|-----------|--------------|
| 1 | src/main/foo.ts:42 | Replaced `any` cast with `Task` type |
| 2 | src/renderer/Bar.tsx:15 | Renamed `sess` -> `session` (3 sites) |

### Tests Added (K)

| # | Test file | Tier | Behavior pinned (red-green) |
|---|-----------|------|------------------------------|
| 1 | tests/unit/activity-engine.test.ts | unit | seeded 'thinking' spawn is reclaimed to idle by the stale-thinking watchdog |

### Refuted (R)

- src/main/baz.ts parseFoo: empty-array every - vacuous truth is the intended result, pinned by baz.test.ts

### Blocked (B)   <- only when B > 0

| # | Location | What this pass tried | Step for a person or the task agent |
|---|----------|----------------------|--------------------------------------|
| 4 | src/main/cli-parser.ts:30 | No installed CLI to capture from | Capture a real reply into tests/fixtures/cli-reply.jsonl |

### Follow-up task

<board id>, 2 items: <titles>. Or: None.

### Committed

`refactor(review): <subject>` as `<sha>` - P files.

Then the tree status, which is COMPUTED, not boilerplate: print `No uncommitted files.` only when
nothing was left behind. If anything was, print `N file(s) left uncommitted (mixed authorship).`
instead - never print "No uncommitted files" directly above a non-empty list, which is the
contradiction this line exists to avoid.

Left uncommitted (already dirty before this pass, so they hold two authors' work):
- src/main/qux.ts

### Pass record
- Files reviewed: N
- Pack: <size>KB, <L> lines, <B> bodies (<W> windowed), <H> hunk sections, <S> stubbed (<paths, or none>); <F> finders (<C> correctness shards; since-review pack: <lines>, or none); reads beyond the pack: <R> (<path: finder, criterion>, or none). Copy this row into `docs/code-review-fanout-audit.md` section 14.5.
- E2E: <n> specs written, <m> min (or none)

<the output of `node scripts/review-verdict.mjs <reviewDir>/findings.json`, verbatim: its Summary,
its Decisions made list, and its closing block. Nothing follows the closing block.>
```

The closing block reads, for example:

```
Verdict: Blocked
1. src/main/cli-parser.ts:30: capture a real reply into tests/fixtures/cli-reply.jsonl
```

Edge cases the report must handle cleanly:
- No diff at all (committed-vs-base, uncommitted, and untracked all empty) -> short-circuit at the diff-gather step (Step 4) with `"No changes to review."`
- Diff exists, zero quality findings -> skip the fix step, but STILL run the coverage pass; if it reports holes on diff-introduced behavior, write them (Tests Added) and report. With no findings at all, the findings JSON has an empty `findings` array and the script prints `Verdict: Ready`.
- A fix breaks typecheck -> revert it and try once more with a different fix. If the second attempt also fails, the finding is `blocked` and the report shows the error. The `typecheck` check records the final tree, so it is `fail` only when the tree as left does not typecheck.
- Committable set empty at Step 8 (every fix landed on an already-dirty path) -> make the ledger-only commit when the ledger is non-empty, and STILL list the mixed-authorship paths and say the worktree was left dirty, so the reader knows the clean-tree handoff did not happen
- Committable NON-empty while some fixes also landed on already-dirty paths (the common mixed case) -> emit `### Committed` for what did land, and do NOT report "No uncommitted files.": print `N file(s) left uncommitted (mixed authorship)` and list them, because the tree is by definition not clean
- Step 2 hmr-resync vitest FAILS -> the failure output is itself a Critical finding. Include the failing assertion's message verbatim in the findings table, fix it in the Apply Phase (e.g. add the missing store re-sync call to `App.tsx`, add the missing `key={hmrGeneration}` to the new `<DndContext>`, add a `// hmr-safe:` directive or `dispose` block to the new module-scope state), then re-run the vitest in Step 7. If it still fails, `hmrVitest` is `fail` and the verdict is Blocked.

### Review-only-mode footer

When `review-only` is in `$ARGUMENTS`, skip the Apply Phase and the Step 8 commit, and emit the legacy footer:

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** one of:
  - **Ship it** - no findings, or only low-severity items
  - **Minor issues** - medium findings worth addressing, no blockers
  - **Needs revision** - critical or high-severity findings that should be resolved

## Allowed Tools

The driver uses `Bash` (git/npm/npx/node only) for pre-flight, diff gathering and the verdict script, the `Agent` tool to fan out the read-only finder subagents, `kangentic_create_task` for the one grouped follow-up task a pass may file, and owns `Read`, `Edit`, `Write`, `Glob`, `Grep` for verification and the Apply Phase. `review-only` mode performs no edits (the finders are read-only regardless). Always run commands from the project root - no chained commands (`&&`, `||`, `|`, `;`).

**No headless `claude`, no `Workflow`.** All orchestration is in-session via the `Agent` tool. Never invoke `claude -p`, `claude --print`, `git diff | claude ...`, or any other headless `claude` shell pipeline, and do not use the `Workflow` tool - the finders are spawned directly as parallel `Agent` subagents and synthesized in the main loop.

**CRITICAL: Use `git -C <path>` for all git commands in other directories.** Never use `cd <path> && git ...` - the `cd && git` pattern triggers an unbypasable Claude Code security prompt.

**Commit this pass, and nothing else.** Step 8 commits only what became dirty during this pass, so the worktree returns to clean with the work attributed. Never `git add -A`, never touch work that was already uncommitted when the pass started, never amend, and **never push** - landing the branch stays `/pull-request`'s job, or `/merge-back`'s for a direct quick-push. See "## Committing the pass".
