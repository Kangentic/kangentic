---
type: Audit
title: Code review fan-out audit
description: "Where a /code-review fan-out's tokens went on 2026-08-29 and which driver changes cut them, followed by a running table of every later review pass: pack size, finders, reads, and findings raised, fixed and refuted."
tags: [audit, code-review, tokens, subagents]
sources:
  - resource: .claude/skills/code-review/SKILL.md
  - resource: scripts/build-review-pack.mjs
---
# Code-review fan-out token audit

Audited: 2026-08-29. Subject: the `/code-review main` run against task #568 (2026-08-29, agent
session `6d47b681`), which fanned out 10 finder subagents at what the UI reported as 194k to
314k tokens each. Reference point: the same skill peaks at 80k to 100k per finder on a smaller
project. This report decomposes where the tokens actually went, then ranks changes by expected
saving against risk to review quality and to the authoring experience. It is a measurement
report; nothing here has been applied.

The scope guardrail from the task holds: the fan-out design itself (fresh isolated review
session, parallel read-only finders, synthesis in the main loop) is not on trial and the
measurements below largely vindicate it. The waste is in specific mechanics, most of which are
fixable in the skill's driver without touching the codebase.

## 1. Executive summary

The run: 1 Opus 5 driver (40 turns) + 10 finders (6 general-purpose Sonnet, 4 gated auditors),
~24 minutes wall, reviewing a 73-file / +4,440-line diff. Harness-reported cost: $67.87.
Transcript-visible spend prices out at $38.75 (method and residual in section 2).

Where the money is, in order:

1. **Cache re-reads dominate dollars.** The 10 finders together re-read 87.0M cache tokens
   across their 26 to 77 turns each. At the 0.1x cache-read rate that is ~$17.5 of the finders'
   $27.6, and it scales as turns times context size. Everything that shortens finder
   transcripts or trims context pays twice: once in fresh input, again on every later turn.
2. **The fresh-input bill is reads of the changed files, multiplied by the fan-out.** Changed
   file bodies (the SKILL.md step 5 "read the full changed files" mandate) are 22% to 72% of
   each finder's fresh input. 38.4% of all bytes returned by Read across the fan-out were
   duplicates of a file another finder had already read, and 740KB of the 755KB duplicated was
   on changed files. That is ~386k duplicated tokens, 16.6% of all finder fresh input, and it
   is a driver design cost, not a codebase cost.
3. **Six finders re-derived the diff themselves.** The driver passed gather commands instead of
   diff text, so each general-purpose finder ran its own git diffs: 50k to 78k tokens of Bash
   output per finder, ~385k tokens total, again mostly identical across finders.
4. **The fixed floor is real but secondary**, exactly as the task's premise said: 31k to 35k
   tokens for gated auditors, ~56.5k for general-purpose finders (of which ~22.5k is the
   tools + MCP manifest, provably shared via prompt cache by 5 of the 6). The floor is 11% to
   25% of fresh input.
5. **Two configuration leaks burned frontier-model money.** The session-debugger auditor ran on
   Opus 5 (a duplicate `model:` key in its agent file, last value wins): $5.26 against $1.30 to
   $1.68 for its Sonnet peers. And every finder inherited the driver's `effort: xhigh` plus an
   Opus 5 advisor; the transcript shows advisor consultations billed at full uncached Opus
   input rates (365k, 133k, and 59k input tokens on the three visible ones).

Top three recommendations (full list in section 7): (a) a shared pre-read pack built once by
the driver and placed identically at the head of every finder prompt, (b) explicit effort and
advisor caps on finder spawns, (c) the one-line session-debugger model fix. Together they are
estimated to cut the finder bill by 40% to 55% with near-zero review-quality risk.

And the contrast with the "80-100k elsewhere" baseline resolves cleanly: this diff was 73 files
and ~5,000 changed lines in the repo's most interconnected subsystem. Per-finder cost scales
with diff size times the read mandate; the smaller project reviews smaller diffs. This is not
evidence the codebase is unreviewable; it is evidence the review pays the diff cost ten times.

## 2. Method and data

Source data: the review session's transcript JSONL plus its 10 per-subagent JSONLs and
externalized tool-result files, all under the Claude Code projects directory for the
(since-pruned) task #568 worktree; plus the Kangentic session's `status.json` (cost and
context ground truth); plus git history (fork point `8dc8661c` to the last pre-review task
commit `5a2b1f33` defines the reviewed set: 73 files, +4,440/-603).

Accounting rules that matter for anyone reproducing this:

- One API message is written as several JSONL records sharing `message.id`, each carrying full
  usage. Sum per message (field-wise max across its records), never per record.
- Assistant usage carries `input_tokens` (uncached), `cache_creation_input_tokens` (5m/1h
  split), `cache_read_input_tokens`, `output_tokens`. Price weights: cache read 0.1x input,
  5m write 1.25x, 1h write 2x; Sonnet 5 $2/$10 per MTok in/out, Opus 5 $5/$25. Subagent cache
  writes are all 5m TTL; the driver's are 1h.
- Oversized tool results are externalized to files and replaced by a ~2KB stub in the
  transcript; the model was billed for the stub, so transcript content length is the correct
  billing proxy (measured at ~2.0 chars per token across 385 single-result calibration turns).
- Per-turn attribution: a turn's fresh input minus the previous turn's re-ingested output is
  the cost of whatever arrived in between (tool results, attachments), attributed
  proportionally by bytes.
- Some usage records carry an `iterations` array with extra billed iterations, including
  advisor-model entries. Iteration-aware pricing raises the visible total from $35.48 to
  $38.75.

**The cost residual.** The harness reports $67.87; the transcripts account for $38.75. The
long-context premium hypothesis is dead: Anthropic removed the over-200k surcharge in March
2026 (flat 1M pricing). The remaining candidates, unverifiable from transcripts: advisor
consultations that are only sporadically logged (every finder record names
`advisorModel: claude-opus-5` at `effort: xhigh`, yet only 4 advisor iterations appear in the
logged usage), harness-side retries and cache-miss recaching (`miss_recache_tokens: 91,110`
recorded on the main thread), and utility calls outside these files. The decomposition and
rankings below do not depend on closing this gap, but the advisor line item makes
recommendation R2 likely undervalued rather than overvalued.

What could not be observed: the literal system prompt bytes (floor composition is inferred
from turn-1 usage plus known file sizes), and server-side advisor accounting.

## 3. Where the tokens go

Per-finder summary. "Final ctx" is the last turn's context-window occupancy, which is the
metric behind the UI's "194k-314k tokens" readout (the live capture was taken mid-run; the
finished band is 139k to 334k).

| Finder | Type | Model | Turns | Wall | Floor | Fresh in | Cache read | Out | Final ctx | $ |
|---|---|---|---|---|---|---|---|---|---|---|
| Coverage | general-purpose | sonnet-5 | 71 | 10.0m | 34.2k | 308.7k | 16.20M | 11.8k | 334.2k | 4.13 |
| Correctness | general-purpose | sonnet-5 | 77 | 12.0m | 56.6k | 284.6k | 15.26M | 23.0k | 285.9k | 3.99 |
| Integration | general-purpose | sonnet-5 | 70 | 7.8m | 35.0k | 254.5k | 12.69M | 15.1k | 279.0k | 3.33 |
| HMR parity | hmr-parity | sonnet-5 | 26 | 7.0m | 32.8k | 275.3k | 4.54M | 8.2k | 278.5k | 1.68 |
| Session lifecycle | session-debugger | **opus-5** | 37 | 9.0m | 34.4k | 250.2k | 6.51M | 18.4k | 250.1k | 5.26 |
| Maintainability | general-purpose | sonnet-5 | 56 | 6.7m | 33.9k | 216.4k | 9.33M | 12.4k | 240.2k | 2.53 |
| Conventions | general-purpose | sonnet-5 | 57 | 7.5m | 34.5k | 205.0k | 9.24M | 10.1k | 228.9k | 2.46 |
| Performance | general-purpose | sonnet-5 | 48 | 5.2m | 33.9k | 196.0k | 6.92M | 5.7k | 219.9k | 1.93 |
| Platform guard | platform-guard | sonnet-5 | 31 | 8.8m | 31.0k | 200.8k | 3.51M | 10.5k | 205.9k | 1.30 |
| IPC auditor | ipc-auditor | sonnet-5 | 30 | 3.2m | 33.8k | 137.5k | 2.83M | 4.3k | 139.2k | 0.95 |

Driver (main thread): 40 turns, Opus 5 at xhigh, 310.6k fresh, 6.97M cache read, 55.0k out,
$7.91. Finder prompts were 2.0KB to 5.3KB; each finder's report back to the driver was ~1.1KB.
The driver's own final context reconciles exactly with `status.json` (246,769).

Decomposition of fresh input (A = turn-1 floor, B = tool-result payload split by category,
C = the finder's own prior output re-ingested):

| Finder | A floor | B1 changed-file Reads | B2 other Reads | B3 Grep+Glob | B4 Bash (mostly git diff) | C |
|---|---|---|---|---|---|---|
| Coverage | 11% | 43% | 19% | 7% | 49.6k | 4% |
| Correctness | 20% | 41% | 1% | 5% | 71.5k | 8% |
| Integration | 14% | 44% | 1% | 12% | 58.3k | 6% |
| HMR parity | 12% | 72% | 8% | 6% | 0 | 3% |
| Session lifecycle | 14% | 54% | 11% | 14% | 0 | 7% |
| Maintainability | 16% | 22% | 21% | 6% | 63.6k | 6% |
| Conventions | 17% | 30% | 3% | 8% | 78.1k | 5% |
| Performance | 17% | 37% | 3% | 7% | 64.1k | 3% |
| Platform guard | 15% | 56% | 5% | 18% | 0 | 5% |
| IPC auditor | 25% | 67% | 0% | 6% | 0 | 3% |

Readings:

- **B1 is the story.** Reading the full changed files, per the skill's own instruction, is the
  single largest term nearly everywhere. This validates the mandate's intent (finders did the
  assigned reading) and indicts its per-finder duplication.
- **B4 exists only for the six general-purpose finders**, and it is the union diff being
  re-derived per finder via git because the driver handed gather commands, not diff text. The
  four gated auditors (no Bash in their roster) skipped it entirely and were not worse for it.
- **B3 (search) is 5% to 18%.** Real, but a clear second-order term. This bounds what any
  retrieval or repo-map investment can save (section 6).
- **The floor is 11% to 25%**, closing the loop on the task's opening premise. Turn-1 cache
  reads prove partial prefix sharing across the parallel fan-out: five of six general-purpose
  finders read a 22.5k cached prefix (system prompt + tool/MCP manifest) that the correctness
  finder, first to arrive, paid as a 56.6k write. The gated auditors share only a 3.2k prefix
  (their restricted rosters diverge earlier), and the Opus session-debugger shares nothing
  (caches are model-scoped).
- **Rules did not load unasked.** Zero `system-reminder` rule injections appear in any finder
  transcript. Path-scoped `.claude/rules/` auto-loading did not operate inside subagents in
  this run; finders paid for exactly the 9 rule files they chose to Read (86KB total across
  all ten, ~1.8% of fresh input). The 177KB rules corpus was never a per-finder tax. CLAUDE.md
  (37.5KB, ~9.4k tokens) is a different matter: per official docs, subagent startup context
  includes "CLAUDE.md hierarchy files" plus the agent's system prompt, delegation message, and
  git status, so all 11 contexts carried it inside their floors.

## 4. Read amplification and cross-finder duplication

The reviewed diff was 73 files (+4,440/-603). 55 of the 73 were Read in full by at least one
finder. The fan-out's collective read surface was 84 distinct files; beyond the changed set,
finders opened 41 unchanged src files (1,020KB billed) chasing definitions of the stores,
bridges, and registries the diff touched.

Duplication, measured:

- 755KB of Read output was duplicate (a file already read in another finder's context), 38.4%
  of all Read bytes; 740KB of it on changed files.
- Converted at the measured 2.0 chars/token: **~386k duplicated tokens, 16.6% of the fan-out's
  total fresh input** (25.7% of billed tool-result bytes). Since finder tool results share no
  cache across sibling contexts, all of it was paid at full or write rates.
- Worst offenders: `browser-pane-registry.ts` read by 7 finders (186KB duplicated),
  `window-store.ts` by 6 (91KB), `window-parking.ts` by 8 (41KB), `TaskDetailBody.tsx` by 4
  (54KB). All changed files. Even two rule files were independently read by 2 to 3 finders.
- Identical Grep queries across finders were negligible (7KB): finders duplicate reads, not
  searches.
- Same-finder re-reads are all offset continuations on files longer than the 2000-line Read
  cap (`window-store.ts` took 3 Reads in each of two finders). The four files over 40KB in the
  changed set each forced this.
- Nobody read `docs/mcp-server.md` (148KB, 122 changed lines) or
  `tests/ui/browser-pane-registration.spec.ts`. 18 changed files were never opened by any
  finder. A review-quality observation, not just a cost one: large doc diffs are effectively
  reviewed only through whatever diff slice a finder happened to gather.

The bash-guard hook, hypothesized as a tax, measured tiny: 3 rejections across the run. Two
finders did spend a sentence apiece disregarding a conflicting harness suggestion to use
piped Bash. The `deferred_tools_delta` (9KB) and `skill_listing` (10.9KB) attachments arrive
only in the six general-purpose finders; small.

## 5. What the codebase contributes

- **Concept spread is real but is the second factor, not the first.** The browser
  park-on-close concept spans the registry, the window store, four bridge hooks, the IPC
  handler, preload, and shared types; judging it pulled 41 unchanged neighbors. But the reads
  that dominate are of the changed files themselves, and those costs would exist in any layout.
  The spread's main cost is turn count: finders averaged 15 to 24 Read/Grep round trips, and
  every round trip re-reads the whole growing context at 0.1x.
- **The oversized tail is expensive in a specific, fixable way.** 11 changed files over 40KB;
  each costs 2 to 3 Read calls per finder that wants it, and each extra call is another
  full-context cache re-read. `browser-pane-registry.ts` at 41KB and 597 changed lines cost
  ~186KB duplicated across 7 finders by itself.
- **CLAUDE.md at 454 lines / ~9.4k tokens is 3 to 4x community sizing guidance** (keep it
  under ~100-300 lines; bloat correlates with instruction-ignoring, a community claim with
  mixed evidence). Its cost here is ~9.4k tokens in each of 11 floors plus its share of every
  cache re-read. Much of its bulk is authoring narrative (the Command Terminal and activity-mark
  histories) that no reviewer needs.
- **The rules corpus is exonerated for review cost** (section 3), and the eight bare
  `src/renderer/**` globs never fired inside finders. Their weight lands on main authoring
  sessions instead, which is outside this audit's scope but worth its own look.
- **Retrieval ground truth** (for section 6): the only live corpus is `'conversation'`; there
  is no repo-file corpus; `kangentic_search` is semantic only for conversations, and
  `knowledgeGraph.enabled` defaults off, degrading to FTS5 keyword search that tokenizes
  `getUserById` as one token. No finder in this run called any MCP tool at all; the gated
  auditors could not have (Read/Glob/Grep rosters).

## 6. The retrieval lane, evaluated against the measurements

**Idea 1, query the existing conversation corpus:** predicted displacement is near zero for
finders. Their questions are code-shaped ("who calls `unregisterPane`", "does the reaper
resubscribe") and current-state-bound; prior-conversation turns answer history-shaped
questions and cannot be trusted over the tree being reviewed. No finder used MCP tools even
when available. Where it could help is the driver's synthesis ("have we seen this bug class
before"), one call, hundreds of tokens. Verdict: legitimate finding per the task's framing:
it adds a call and changes little for finders. Do not wire it into finder prompts.

**Idea 2, a repo-file corpus:** the architecture supports it (corpus column, store, embedder
all ready; a TS chunker and a non-conversation search entry point are the real work, since
`memory-search.ts` hardcodes session joins). But the measured ceiling is the B3 search band
plus some fraction of B2: roughly 8% to 12% of the finder bill, and only when semantic search
is on (default off) and sqlite-vec loads. It cannot displace B1: a correctness reviewer must
read the changed code, not an embedding of it. Freshness against a worktree the review is
itself mutating adds risk. Verdict: real but the smallest saving per unit of engineering on
this list; defer until after the driver-side wins, and revisit if post-fix profiles show
search chains dominating.

**Idea 3, retrieval-gate the rules and CLAUDE.md:** the measurement inverted the premise for
finders. Rules already behave retrieval-style inside subagents (nothing auto-loads; finders
pull what they decide they need), so there is nothing to gate, and the residual hazard runs
the other way: an auditor might fail to pull the rule that would have produced its finding.
The self-maintaining fix is the documented `skills:`/preload frontmatter mechanism: pin each
gated auditor's load-bearing rule or domain skill in its agent definition so it arrives
deterministically, and validate any change here by replaying this review's finding set.
CLAUDE.md is the piece that does arrive unasked in every finder; shrinking it (R6) is the
actionable variant, not retrieval-gating it.

**The hard limit stands and the run proved its worth in miniature.** The removed-or-renamed
surface check is an exhaustive repo-wide grep because string-keyed contracts, non-typechecked
`.js`, and tests that reconstruct old formats as literals are invisible to both `tsc` and any
approximate-recall index. That check historically produced the only blocking findings of a
prior review. Nothing in this report proposes replacing an exhaustive search with retrieval;
recall is not exhaustiveness, and a recommendation that quietly swaps one for the other is a
regression dressed as an optimization. Finder questions that tolerate approximate recall:
"where does this concept live", "what is related to X". Questions that do not: "does any
surviving reference to this removed symbol exist", "is there a test that fails if this
reverts".

## 7. Recommendations, ranked by saving per unit of risk

Format per the task: measured cost today; mechanism; change; estimated saving; trade-away.

**R1. Build the pre-read pack once, in the driver.** Cost: ~386k duplicated read tokens
(16.6% of finder fresh input) + ~385k of per-finder diff re-derivation (B4) + the turn-count
tax both impose on the 87M cache-read bill. Mechanism: ten finders independently read the same
changed files and six independently re-run git. Change: the driver gathers once (it already
runs the Step 4 commands): it writes the union diff plus the full line-numbered bodies of the
changed files to a single gitignored pack file (capped near 200KB, largest-churn first; files
cut by the cap are listed for on-demand reading), and every finder's first action is one Read
of that file. Delivery detail that matters: the pack must be a file path, never embedded in
the finder prompts, because Agent-tool prompt text is billed again as driver output tokens for
every finder (ten copies of a 100k-token pack at Opus output rates would exceed the saving).
The saving therefore comes from collapsing each finder's 15 to 30 gather-and-read round trips
into one (each avoided round trip is one fewer full-context cache re-read) and from
eliminating B4 entirely, not from cross-finder cache-prefix sharing, which file-borne tool
results cannot get. Finders keep full read freedom beyond the pack. Estimated saving: 30% to
45% of the finder bill. Trade-away: driver curates what finders see first, a mild anchoring
risk, mitigated because the pack is exactly the files the mandate already forces them to
read. Authoring cost: none; this is a SKILL.md edit. (Implemented and A/B-validated after
this audit; see section 10.)

**R2. Pin finder effort and advisor explicitly.** Cost: every finder ran `effort: xhigh` with
an Opus 5 advisor inherited from the driver session; the three transcript-visible advisor
consultations billed 365k, 133k, and 59k uncached Opus input tokens (~$3.2), and the
under-logged remainder is the leading explanation for the $29 cost residual; xhigh also
lengthens thinking (up to 17.1k thinking tokens on a finder). Mechanism: subagent spawns
inherit the session's effort/advisor settings unless overridden. Change: spawn finders at
medium (or low for conventions/coverage-style checklist work), advisor off if the harness
exposes it; keep the driver's synthesis at xhigh, which is where SKILL.md already argues the
safety lives. Estimated saving: $3 to $10 visible, likely double that if the residual is
advisor-driven; also wall-clock. Trade-away: marginally shallower finder reasoning; the
structure (explicit falsifiable criteria + driver verification) is the intended backstop.
Verify by comparing finding sets over a few reviews.

**R3. Fix the session-debugger duplicate `model:` key.** Cost: $5.26 for a finder whose Sonnet
twin would cost ~$1.6; ~$3.6 per review that gates it in. Mechanism: `session-debugger.md`
declares `model: sonnet` at line 3 and `model: opus` at line 23; last key wins. Change: delete
the stray second key (and the harmless duplicates in the five other agent files that carry
one, four gated auditors plus `test-builder`). Saving:
~$3.6/run. Trade-away: none; SKILL.md line 175 already asserts all auditors are Sonnet. Also
fix the SKILL.md line 53 "five-subagent fan-out" undercount (the table spawns up to 11), which
misleads anyone budgeting the review.

**R4. Enforce the integration finder's signature-only contract in the driver.** Cost: the
integration finder, designed to be "a few hundred tokens regardless of diff size", spent 254.5k
fresh (44% B1 full-file reads, 58.3k B4). Mechanism: the driver delegated the interface-delta
computation by handing over gather commands, so the finder read everything to build it.
Change: the driver computes the compact `changedExports`/`typeDeltas`/`importChanges` block
itself from the diff it already gathered (or from the R1 pack) and passes only that, per the
skill's own spec; the finder gets no gather commands. Estimated saving: ~150k to 200k fresh
tokens plus that finder's share of cache reads, ~$2/run. Trade-away: the repo-wide
removed-surface grep must stay in this finder's remit (it needs Grep, not file bodies), so the
prompt must keep that instruction explicit.

**R5. Slice the mandate per dimension instead of "everyone reads everything".** Cost: B1 at
22% to 72% per finder, ten times over, on a 73-file diff. Mechanism: SKILL.md step 5 sends
every finder to the full changed files. Change: with R1's pack in place this becomes cheap to
express: correctness and integration get the full pack; coverage gets the diff plus changed
tests plus the behavioral files only; conventions/maintainability/performance get the diff and
read files on demand rather than by mandate. Keep at least two full-picture finders so
cross-cutting bugs retain two independent chances. Estimated saving: 10% to 20% of the finder
bill on large diffs (overlaps with R1; count them together, not additively). Trade-away: this
is the one recommendation that touches the falsifiable-finding contract's evidence base; a
finder without a file body can mis-cite line numbers. Mitigate by keeping the pack's diff
hunks full-fidelity and validating over several reviews that per-dimension finding counts hold.
(Evaluated 2026-09-14 against the deduplicated pack and not shipped; see section 14.3.)

**R6. Shrink what every context carries: CLAUDE.md now, floor hygiene generally.** Cost:
~9.4k tokens in each of 11 floors (~103k written) plus a share of every cache re-read; the
22.5k tool/MCP prefix similarly rides all six general-purpose contexts (mostly at 0.1x thanks
to prefix sharing). Mechanism: subagents load the CLAUDE.md hierarchy at startup; ours is 454
lines, 3 to 4x published sizing guidance, and most of the excess is authoring narrative.
Change: move the Command Terminal, activity-marks, and settings-tab essays into
`.claude/rules/` or `docs/` pointers (they are already path-scoped concerns), targeting
CLAUDE.md under ~150 lines; add a CI size check to keep it there (self-maintaining, per the
repo's own rule-authoring bar). Estimated saving: ~70k write tokens per review plus main-session
savings every day; the larger benefit is instruction-following headroom, which is claimed by
community evidence rather than measured here. Trade-away: authoring context that genuinely
helps agents write code in those subsystems moves one hop away; the read-trigger gap means
anything that must hold at file-creation time stays in CLAUDE.md or an always-on rule.

**R7. Preload gated auditors' domain material via frontmatter (the Idea 3 replacement).**
Cost today: small and hidden; the risk is silent false negatives if an auditor fails to pull
its load-bearing rule. Mechanism: rules do not auto-load in subagents (measured: zero
injections), so an auditor's domain knowledge arrives only if its definition or its own reads
bring it. Change: pin each auditor's rule/skill dependencies with the documented
`skills:` preload frontmatter instead of trusting runtime discovery. Cost increase: a few KB
per gated floor, deterministic. Trade-away: none material. Validation bar (as the task
required): replay this review's inputs after the change and confirm the finding set is a
superset.

**R8. Retrieval investments, sequenced last.** Idea 1 (conversation corpus in finder prompts):
do not adopt; measured displacement ~zero (section 6); optionally offer it to the driver's
synthesis step only. Idea 2 (repo-file corpus): ceiling ~8-12% of the finder bill, meaningful
engineering, degraded-mode weakness while semantic search defaults off; defer, and prefer an
Aider-style generated repo map first if navigation cost re-emerges after R1/R5: a ~1k-token
PageRank-ranked symbol map is the established cheap alternative for "who calls this" and can be
CI-generated to satisfy `docs-stay-in-sync`. Both are strictly behind R1 through R7 on
saving-per-effort, and neither may touch the exhaustive-grep contract (section 6).

Not recommended: restructuring source layout for the reviewer's benefit (splitting
`browser-pane-registry.ts` etc. purely to cut review reads). The oversized-tail cost is real
but R1 absorbs most of it (pack once, share ten ways), and layout churn to serve the reviewer
inverts the priority the task set: the authoring experience owns the layout.

## 8. Hard limits and open questions

- The removed/renamed-surface check remains an exhaustive repo-wide grep, permanently. Any
  future proposal that gates it behind retrieval should be rejected on sight.
- The $29 gap between transcript-visible pricing and the harness meter is unresolved;
  R2's advisor hypothesis is the best-supported explanation and is testable by re-running a
  review with effort pinned low and comparing meters.
- Whether path-scoped rules are supposed to auto-load in subagents (they did not here) is
  harness behavior that may change under us; R7 removes the dependency either way.
- Fan-out economics are within industry pattern, not an outlier: Anthropic's own
  orchestrator-worker research system reports multi-agent runs at ~15x chat token usage, with
  token spend the dominant performance predictor. The goal of this report is deleting the
  waste share (duplication, re-derivation, model leaks), not shrinking the architecture.

## 9. Appendix: verification and provenance

- Turn/usage parsing spot-checked by hand against the smallest finder (ipc-auditor: 30
  messages, turn-1 floor 33,822 + 2 input, fresh 137.5k) and against `status.json` (driver
  final context 246,769 exact; driver cache writes 310,471 exact).
- Attribution residuals: zero by construction per finder except 0.3k on platform-guard
  (negative deltas floored); bytes-per-token calibration median 2.02 over 385 single-arrival
  turns (per-finder medians 1.46 to 2.30).
- Reviewed-set definition: `git diff 8dc8661c..5a2b1f33` (fork point of the #568 branch to its
  last pre-review commit); later commits on that branch are the review's own apply-phase and
  are excluded.
- Analysis scripts (transcript parser, locality/duplication aggregator, usage probes) were run
  in the audit session's scratchpad; they are ~400 lines of dependency-free Node operating on
  the JSONL shapes documented in section 2, and the method above is sufficient to reproduce
  every number from the same inputs.
## 10. Post-audit validation: the R1 pack, A/B measured

Implemented after this audit: R1 (pack, assembled by `scripts/build-review-pack.mjs` so the
driver pays one Bash call instead of ~100k output tokens writing the pack itself; the script
also emits the pre-existing-dirty list), R2 (`effort: medium` pinned in every finder/auditor
frontmatter; a new `review-finder` agent replaces `general-purpose` for the six universal
finders, whose restricted roster also drops the ~22k tool/MCP manifest, plus a `maxTurns: 50`
circuit breaker), R3 (the session-debugger model key, plus the five harmless duplicate keys),
R4 (the integration finder's signature-only enforcement), R7 (`skills:` preloads on
ipc-auditor, session-debugger, platform-guard), the 5-vs-11 text fix, a stale conventions
criterion (the pre-registry "global Escape listener" bullet, which would have generated
false positives against `keybindings-registry.md`), and a slimmed Domain-Specific Checks
section (the auditor checklists were mirrored in the skill and had drifted; the auditors are
now the single source of truth). R1 was validated with a small controlled A/B before shipping: the diff of
one real 4-file / 123-line commit (`7215826c`), two finder dimensions (correctness,
conventions), Sonnet both arms, identical prompts except the gather step. Control used the
faithful #568 prompt shape (self-gather via git + "read the full changed files"); treatment
replaced it with one pack file (68.7KB: scoped diff + full line-numbered bodies) and a
do-not-regather instruction. Total experiment cost: ~$4.60.

| Pair | Turns | Wall | Fresh input | Cache read | Cost |
|---|---|---|---|---|---|
| Correctness: control | 38 | 8.4m | 190.7k | 4.99M | $1.61 |
| Correctness: pack | 15 | 3.9m | 133.8k | 1.69M | $0.71 (-56%) |
| Conventions: control | 31 | 4.1m | 107.2k | 3.53M | $1.00 |
| Conventions: pack | 36 | 3.8m | 144.0k | 4.28M | $1.27 (+26%) |
| Correctness: v2 final | 22 | 3.8m | 122.0k | 2.02M | $0.76 (-53%) |
| Conventions: v2 final | 11 | 2.1m | 65.1k | 0.72M | $0.31 (-69%) |

The "v2 final" rows are the full implemented configuration: the same pack prompts run on the
new `review-finder` agent (`model: sonnet`, `effort: medium`, `tools: Read, Glob, Grep`) with
the corrected sequential-offset pack-read instruction. Transcripts confirm `effort: medium`
took effect, the pack was read in exactly 2 non-overlapping calls with zero errors, and the
restricted roster delivered the predicted floor (~34k vs the general-purpose ~56.5k).
Combined v2 arm: $1.07 vs control $2.61 (-59%), fresh input -37%, cache reads -68%, turns
69 to 33, worst wall 8.4m to 3.8m. Parity: v2 correctness reproduced the primary
registration-gap race with the full falsifiable triple and explicitly cleared the
removed-surface and reaper checks; v2 conventions additionally surfaced three legitimate
doc-consistency findings (stale module header and public JSDoc, a rule-file
self-contradiction) the earlier arms missed. As in the pack arm, low-severity tail findings
vary between runs; the ten-dimension fan-out plus driver synthesis is the designed mitigation.

Readings, stated honestly:

- **The mechanism works.** Both pack finders read the changed files zero times (full
  displacement); the correctness pair collapsed 38 turns to 15 and cost by 56%, confirming
  the audit's core claim that avoided read round-trips shrink the cache-read integral.
- **The savings are not automatic.** The conventions pack finder gave the saving back two
  ways, both now addressed in SKILL.md: it read the pack in six overlapping fragments
  (the pack exceeded the Read tool's 2000-line-per-call window and the original "one call"
  instruction produced retries; the instruction now specifies sequential offset reads), and
  it spent the freed budget on out-of-scope verification (61KB of an unrelated doc "to
  validate the diff's claims"; the instruction now pins finders to their criteria).
- **Quality held, with one caveat.** The pack correctness finder found the same primary
  defect as control (a real registration-gap race), with deeper supporting citations; the
  pack conventions finder's red-green finding was sharper than control's. Control's second,
  Low-severity finding (crash-liveness) did not reappear in the pack arm - a single data
  point consistent with the anchoring risk R1 names, worth watching across real reviews.
- **Caveats:** one run per cell; the control correctness finder was the arm's first spawn and
  so paid the shared 28.6k prefix as a cache write (adjusting for that still leaves the pack
  finder ~45% cheaper on fresh input and 66% on cache reads); a 2-finder test cannot show the
  10-finder duplication saving, which multiplies the per-finder effect.
- Aggregate across the four finders: $2.61 to $1.98 (-24%) with the conventions regression
  included, and worst-case finder wall time halved (8.4m to 3.9m). The projected full-scale
  saving remains the R1 estimate (30-45% of the finder bill), now with the correctness pair
  as direct evidence and the conventions pair as the failure mode the final instruction
  guards against.

## 11. Second-source validation matrix (2026-08-29)

Every load-bearing claim behind the implemented changes, checked against official docs or
this audit's own measurements:

| Claim | Status | Source |
|---|---|---|
| `effort:` is a valid agent-frontmatter field, per subagent | CONFIRMED (docs + measured: v2 transcripts show `effort: medium`) | code.claude.com plugins-reference (frontmatter sample), agent-loop ("can be configured globally or per subagent") |
| `skills:` preload injects full skill content at startup | CONFIRMED (docs) | sub-agents: "Full skill content is injected, not just descriptions"; not for `disable-model-invocation` skills |
| `maxTurns:` is a valid agent-frontmatter field (turn circuit breaker) | CONFIRMED (docs; partial-output marking needs Claude Code v2.1.246+) | sub-agents: "limits the number of agentic turns before the subagent stops executing"; the stopped subagent returns partial output and can be resumed |
| A `tools:` allowlist excludes MCP tools | CONFIRMED (docs + measured floor 56.5k to 34k) | sub-agents: "Any tool not listed, including MCP tools, will be omitted" |
| Thinking config inherits with no per-subagent override | CONFIRMED (docs) | sub-agents: "no separate per-subagent setting for extended thinking" |
| Advisor model inherits with no per-subagent override | CONFIRMED (docs) | advisor: "Subagents inherit the configured advisor" |
| Subagent startup context includes CLAUDE.md, git status, preloaded skills | CONFIRMED (docs) | sub-agents "What loads at startup" |
| Agent-tool prompt text and Write-tool content re-bill as driver output | CONFIRMED (API mechanics: tool_use blocks are model-generated response content and bill as output; consistent with measured driver output) | Bedrock tool-use token docs; per-turn usage in this audit |
| Read tool returns at most 2000 lines per call | CONFIRMED (measured: 6-fragment pack read before the fix; exactly ceil(N/2000) after) | this audit, section 10 |
| Cache pricing 0.1x read / 1.25x 5m write / 2x 1h write; caches are model-scoped | CONFIRMED | Anthropic API reference (bundled claude-api skill); model-scoping observed (the Opus finder shared no Sonnet prefix) |
| Long-context surcharge above 200k removed (flat 1M pricing) | CONFIRMED (secondary sources; kills the premium hypothesis for the cost residual) | March 2026 pricing change coverage |
| SKILL.md should stay under ~500 lines with detail in support files | CONFIRMED (docs); the skill is ~360 lines after the checklist de-duplication | slash-commands: "keep SKILL.md focused and under 500 lines" |
| CLAUDE.md sizing (~100-300 lines) and bloat-degradation | COMMUNITY ONLY, not official; R6 remains a recommendation | community best-practice guides |
| Multi-agent systems ~15x chat tokens | CONFIRMED (Anthropic engineering post) | "How we built our multi-agent research system" |

## 12. External sources

Claude Code docs on subagent startup context and skill preloading
  (code.claude.com, "What loads at startup": system prompt, delegation message, "CLAUDE.md
  hierarchy files, initial git status, preloaded skills"; "Explore and Plan agents
  intentionally omit CLAUDE.md"), Anthropic API pricing (flat 1M-context pricing since March
  2026; cache multipliers 0.1x/1.25x/2x), Anthropic's multi-agent research system engineering
  post (~15x chat tokens; token use explains ~80% of eval variance), Aider's repository-map
  documentation (1k-token default budget, tree-sitter + graph ranking), and community
  CLAUDE.md sizing guidance (under ~100-300 lines; bloat-degradation claims are community
  experience, not controlled measurement).

## 13. Windowed bodies: what a pack byte is worth (2026-08-31)

Follow-up study prompted by a real observation on task #578's review: with the pack's 200KB body
cap exhausted, two cap-trimmed files were each independently `Read` by several finders during the
fan-out (`task-changes-panel-slice.ts` by 4, `KebabMenu.tsx` by 2) - the section 4 duplication the
pack was built to remove, reappearing on large diffs. The obvious repair is to pack more files.
The measurement says the opposite.

### 13.1 The arithmetic that reframes the problem

**Every byte added to the pack is paid by up to 11 finders. A file left out is paid only by the
finders that actually read it.** With a numbered body costing about 1.15x its raw bytes, packing a
file pays on raw bytes only if more than ~12.6 finders would have read it - more than exist. So
"pack more" never wins on bytes; R1's measured 53-69% win came from collapsing *turns* and with
them the cache-read integral ("87.0M cache tokens across 26-77 turns each... it scales as turns
times context size", section 1), not from moving bytes.

Priced with section 2's constants, reaching churn rank 20 on the #578 diff - far enough to pack
both duplicate-read files - costs about **101KB** of extra pack: ~555k tokens of fresh input
(~$1.11) plus ~22.2M cache-read tokens (~$4.44), so **~$5.55**. The six observed duplicate reads
are worth about **$0.10 each, ~$0.60 total**. Roughly **10x net-negative**. Two related repairs
were measured and rejected on the same arithmetic:

- **Raise `PACK_BODY_CAP_BYTES`.** Packing all 34 of #578's changed files in full costs
  **1,390,167 bytes** against a 204,800 cap - **6.8x** - and 60% of that total is seven files with
  49 lines of churn between them (`types.ts` 288,102 bytes for churn 8; `mock-electron-api.js`
  223,688 for churn 2; `configuration.md` 91,464 for churn 6). No cap value fixes that shape.
- **Change the admission order.** A small-files-first pass admits ~18 small files for 178,705
  bytes and then trims the two highest-churn files in the review. Worse, not better.

### 13.2 What shipped instead: window the body, keep the file set

A body whose changed hunks cover only part of it is packed as `## Partial file:` - every changed
hunk with `WINDOW_CONTEXT_LINES` (20) lines of context, unchanged runs between them replaced by a
marked, line-numbered gap - when that saves at least 15% of the body
(`WINDOW_MAX_SHARE_OF_FULL`). Two properties are load-bearing:

- **Admission is still decided on FULL-body cost.** Windowing only shrinks what the admitted set
  costs; it can never make a larger file affordable and displace a file the pack ships today.
  Spending the freed budget instead was measured: it buys 2 to 8 more files at roughly zero net
  bytes, but that coverage is worth ~$0.60 by 13.1 and costs ~$5.55, and the greedy reorder it
  requires actually *lost* files on two corpus diffs (PR337 17 -> 14, PR316 15 -> 14). The budget
  is banked, deliberately.
- **Windows are placed in WORKING-TREE coordinates**, from one `git diff --unified=0 <mergeBase>`.
  They must not be parsed out of the union diff: its committed layer is three-dot, so those hunks
  are HEAD-relative while the body is read from the working tree, and for a file that is both
  committed-vs-base and dirty the two disagree. The failure is silent - prefixed line numbers come
  from the body and stay correct, so a misplaced window shows unchanged code and omits changed
  code while looking perfectly well-formed. Measured on a real mixed-layer file, the naive
  derivation dropped **18 of 80** changed lines. `tests/unit/build-review-pack.test.ts` pins this
  red-green.

### 13.3 Pack size, measured over eight merged PRs

Replay is deterministic: a pack is a pure function of a ref pair. Each PR was packed by the
pre-change script and the shipped one from the same base and head in an isolated clone.

| Diff | shape | control pack | treatment | delta | bodies packed | windowed |
|---|---|---|---|---|---|---|
| PR341 (#578) | 34f +3158/-311 | 461,539 | 397,151 | **-14.0%** | 7 -> 7 | 4 |
| PR329 (#568) | 79f +4772/-608 | 708,414 | 695,631 | -1.8% | 9 -> 9 | 1 |
| PR316 | 75f +6323/-194 | 594,395 | 581,776 | -2.1% | 15 -> 15 | 2 |
| PR337 | 60f +3416/-77 | 429,754 | 370,024 | **-13.9%** | 17 -> 17 | 5 |
| PR302 | 61f +5817/-92 | 576,634 | 551,839 | -4.3% | 11 -> 11 | 1 |
| PR338 | 20f +1213/-64 | 290,824 | 180,075 | **-38.1%** | 13 -> 13 | 6 |
| PR328 | 8f +294/-25 | 224,435 | 64,337 | **-71.3%** | 8 -> 8 | 7 |
| PR306 | 5f +694/-27 | 174,339 | 111,789 | **-35.9%** | 5 -> 5 | 5 |

Corpus total **3,460,334 -> 2,952,622 bytes (-14.7%)**; at 11 finders, **-5.58MB of finder input**
across eight reviews. **Coverage is identical on every diff** - that is the design, not a result.
Contract checks passed on all eight: the `Total lines:` header matches the pack's real length,
every TOC entry points at its own heading, the `paths:` line is byte-identical between arms, the
treatment pack is never larger, and all **20,070** prefixed line numbers across **85** sections
match the working tree exactly.

The saving is largest on SMALL diffs, which is the opposite of the intuition that motivated the
study: a small PR often edits a few lines in several large files, and today those whole bodies are
packed. PR328 is 8 files and 319 changed lines, and its pack was 224KB.

Two facts about the pack, noted and deliberately not addressed here: the union diff was
**194,209 bytes, 48.5%** of #578's 400KB pack and is **not governed by `PACK_BODY_CAP_BYTES`** at
all, so a pathological diff still blows pack size regardless of the body cap; and for a fully
packed file its diff's `+` and context lines are duplicated in its body (~98KB of that same 194KB).
Both are separate designs with their own quality risk, and neither causes cross-finder duplication.
Both are addressed in section 14.

### 13.4 A/B, section 10's shape

One diff (PR341), two dimensions, two arms, Sonnet and `review-finder` throughout, prompts
identical except the pack file. Per-finder numbers from the subagent transcripts, priced with
section 2's rules.

| Pair | Turns | Wall | Fresh input | Cache read | Cost | Findings |
|---|---|---|---|---|---|---|
| Correctness: control | 20 | 4.7m | 227.3k | 2.87M | $1.21 | 1 Low |
| Correctness: windowed | 19 | 4.2m | 201.5k | 2.51M | $1.02 (-16%) | 0 |
| Conventions: control | 10 | 1.4m | 152.7k | 0.83M | $0.56 | 0 |
| Conventions: windowed | 18 | 4.0m | 166.0k | 1.90M | $0.82 (+45%) | 2 |

**The decisive result is not the cost column.** With one run per cell a +/-20% cost delta is noise,
and the conventions pair shows exactly that: the windowed finder cost 45% more while returning two
findings its control returned none of, having simply worked harder (18 turns against 10). Combined,
control $1.77 vs windowed $1.84 (+3.2%) - flat, on 3 findings against 1.

What the A/B can answer, and does:

1. **No finder re-read a file because it was partial.** This is the failure mode that would make
   windowing net-negative: added pack bytes AND the duplicate read kept. Across both windowed
   finders, three reads went beyond the pack - two files the cap had trimmed in *both* arms, one
   `.claude/rules/` file the criteria call for. **Zero reads of a `## Partial file:`.**
2. **Windowing did not hide anything either finder cited.** Rather than compare stochastic finding
   sets, every line the control finders cited was checked against the treatment pack: 0 of 3 fall
   inside an omitted gap (`ChangesPanel.tsx:1028` is shown inside a window; `CommitGraphPanel.tsx`
   was cap-trimmed in both arms, so windowing did not touch it). The control correctness finding is
   finder variance, not a cost of windowing. Symmetrically, all 4 lines the windowed conventions
   finder cited are shown, and its citations were accurate against the real file.

Section 10's caveats apply unchanged: one run per cell, first-spawn cache-write skew, and a
two-finder test cannot show the 11-finder multiplication that gives 13.3 its force.

### 13.5 The pack is now a function of the diff, not of local git config

Found while hardening the above for a public repo, where `/code-review` runs on other people's
machines and in CI. The windowing pass keys file paths off the `+++ b/<path>` header of a
**commit-vs-working-tree** diff - exactly the case `diff.mnemonicPrefix` renames (`c/` for the
commit side, `w/` for the working tree). With that config set, every parsed key matches no changed
file and **windowing silently switches off**: no error, just a bigger pack. Measured on the test
fixture, the same commits produced a **66-line pack on default config and a 424-line pack with
`diff.mnemonicPrefix=true`** - 6.4x, from a setting the reviewer never sees.

Four more settings were in the same class, three of them pre-existing rather than introduced by
windowing: `diff.noprefix` and `diff.srcPrefix`/`diff.dstPrefix` (same parse), `diff.context`
(resizes the union diff, the pack's largest section), `diff.renames` (off, a renamed-and-modified
file scores zero churn and ranks last instead of first), and `diff.external` (replaces the diff
body with a program's output). All are now pinned to git's own defaults at the single `git()`
chokepoint, except `diff.external`, which cannot be pinned by config - an empty `diff.external=`
makes git try to spawn the empty string and abort the build - so every diff routes through one
`gitDiff()` helper that passes `--no-ext-diff`.

Pinning these is byte-neutral on stock config - the corpus in 13.3 was re-measured after the
change and every number is identical - but it is not a no-op for everyone: someone who
deliberately set a non-default `diff.context` now gets a different union diff than they used to.
That is accepted. One reproducible pack across every machine and CI is worth more in a shared
review artifact than honouring a personal diff preference.
`tests/unit/build-review-pack.test.ts` pins the whole family by asserting a byte-identical pack
under each hostile setting.

One boundary escapes that claim, and it is the operating system rather than git config. The 1MB
`SINGLE_FILE_CAP_BYTES` check measures the file's raw on-disk size, before the CRLF normalization
every body goes through, so a file within a few KB of 1MB whose working copy has CRLF endings can
land over the cap on Windows and under it on Linux, and be a one-line section on one machine and a
body on the other. Measuring after normalization would mean reading the file to decide whether it
is too large to read, which is the cost the cap exists to avoid. The hole is left open and named
here rather than closed: it needs a file sized within about 0.1% of the cap to appear at all.

### 13.6 Stated limitations

- Replay uses landed commits as a proxy for the reviewed tree, which carried uncommitted work: the
  real #578 pack shows `ChangesPanel.tsx` at 1137 lines against 1146 at `976a45c0`, and the replay
  packs 7 files where the real run packed 8.
- **Read multiplicity has exactly one ground-truth sample** (#578: 4 readers and 2 readers). The
  other seven corpus diffs contribute pack bytes and coverage only; multiplicity is neither
  measured nor modelled for them.
- Wall-clock is not claimed. The change alters neither finder count nor the critical path, and the
  observed per-cell wall times differ by more than any effect it could have.
- This does **not** eliminate the duplicate reads that prompted the study. Neither of #578's two
  duplicate-read files is packed under any variant measured; `KebabMenu.tsx` lands only at a
  10-line context width and `task-changes-panel-slice.ts` at none. By 13.1 rescuing them costs
  about ten times what it saves, so the study ends by making every packed byte cheaper rather than
  by buying more of them. Section 14's hunk tier packs both files' changed hunks; whether that
  removes the duplicate reads is unmeasured.

## 14. One record per changed file: the hunk tier and the per-file cap (2026-09-14)

Three items from sections 13 and 7, taken together because one renderer answers all three. 13.3
left the union diff outside every cap (194,209 bytes of #578's 400KB pack) and left a body-packed
file's `+` and context lines duplicated between the diff and the body (about 98KB of that 194KB).
R5 (section 7) was the one recommendation still unimplemented, held back by its own trade-away: a
finder given hunks without a body could mis-cite line numbers. A pack in which every changed line
appears exactly once, with its working-tree line number and a change marker, removes the
duplication by construction, puts the former diff under a cap that changes size and not coverage,
and gives every finder an exact number to cite. The first two shipped. R5 was then measured against
the result and declined (14.3).

### 14.1 Design decisions

- **One format.** The raw union diff section is gone. Every changed file is exactly one section,
  and every body line is `<marker><line number, 5 wide><tab><text>`: `+` added, ` ` unchanged, `-`
  removed with a blank number, shown in place before the line that follows it. A file admitted
  under `PACK_BODY_CAP_BYTES` is `## Full file:` or `## Partial file:` (20 lines of context, as
  13.2 shipped it); every other readable file is `## Changed hunks:`, the same windowed renderer at
  `HUNK_CONTEXT_LINES` (3). Deleted, binary, rename-only, mode-only, and reverted files get a
  one-line section. The header carries a one-line legend and the table of contents lists every
  changed file, so a finder never meets a line it cannot cite or a file it cannot find.
- **Admission is still decided on the plain full-body cost**, the numbered body with no markers
  and no removed lines, so the set of files with a body is byte-identical to 13.2's set. The
  replay's `bodies packed` column must equal 13.3's on every row; a difference is a bug. Written
  body bytes now exceed the charged budget slightly (one marker byte per line plus the removed
  lines); the summary prints both numbers.
- **The former diff is capped per file, not globally.** A hunk-tier section that alone exceeds
  `PACK_HUNK_SECTION_CAP_BYTES` (100KB, half the body cap) becomes a one-line
  `## Changed hunks omitted:` stub listed under `## Not included`. Whether a file is stubbed is a
  fact about that file, never about its neighbours, which is the same property full-body admission
  has: a global cap would make a file's presence depend on what else changed, the greedy reorder
  13.2 measured losing files to. The pathological case 13.3 named (one generated or lockfile diff of
  thousands of lines) is exactly a single oversized section; a 75-file PR is large, not
  pathological, and its hunks are the review surface. So the pack is bounded by the review's own
  changed lines plus the body cap, not by a constant. On the corpus the cap never fired (14.2).
- **Every rendered byte comes from one parse.** The `--unified=0` merge-base diff that 13.2
  introduced for window placement (working-tree coordinates) now feeds the whole pack, including
  the removed lines. The raw three-dot and HEAD diffs are no longer gathered, and the changed-file
  names come from the numstat lines the script already fetches, so a build spawns six git processes
  instead of eight. `diff.context` now reaches no rendered byte and stays pinned. A parse failure is
  loud: there is no fallback shape that would not claim nothing changed. Any path the parse names
  that the three layers did not (a rename committed at HEAD whose working-tree edits then fell
  below git's similarity threshold, so the parse sees a deletion the three-dot layer folded into
  the rename) is added to the changed-file list, so a deletion cannot fall between the two gathers.
- **A light shape exists for measurement.** `--body-cap 0` renders every readable file at the hunk
  tier. That is the pack R5 would have handed its light finders, and 14.2's light column is its
  size. The review skill never passes the flag.

### 14.2 Replay over the same eight PRs

`scripts/replay-review-pack-corpus.mjs` automates 13.3's method: an isolated clone,
`refs/pull/<n>/head` for the reviewed head (this repo rebase-merges, so the pull ref is the only
source), `gh pr view` for the base, three arms per PR. Control is the script 13.3 shipped; its
column reproduces 13.3's treatment column byte for byte, as 13.5 says it must.

| Diff | shape | control | one-record pack | delta | light shape | light vs pack | bodies packed | hunk sections | stubbed |
|---|---|---|---|---|---|---|---|---|---|
| PR341 (#578) | 34f +3158/-311 | 397,151 | 317,155 | **-20.1%** | 281,969 | -11.1% | 7 -> 7 | 27 | 0 |
| PR329 (#568) | 79f +4772/-608 | 695,631 | 570,382 | **-18.0%** | 549,455 | -3.7% | 9 -> 9 | 70 | 0 |
| PR316 | 75f +6323/-194 | 581,776 | 442,691 | **-23.9%** | 432,107 | -2.4% | 15 -> 15 | 60 | 0 |
| PR337 | 60f +3416/-77 | 370,024 | 277,484 | **-25.0%** | 251,422 | -9.4% | 17 -> 17 | 43 | 0 |
| PR302 | 61f +5817/-92 | 551,839 | 424,936 | **-23.0%** | 411,484 | -3.2% | 11 -> 11 | 50 | 0 |
| PR338 | 20f +1213/-64 | 180,075 | 114,754 | **-36.3%** | 94,237 | -17.9% | 13 -> 13 | 7 | 0 |
| PR328 | 8f +294/-25 | 64,337 | 44,719 | **-30.5%** | 25,743 | -42.4% | 8 -> 8 | 0 | 0 |
| PR306 | 5f +694/-27 | 111,789 | 68,169 | **-39.0%** | 52,344 | -23.2% | 5 -> 5 | 0 | 0 |
| Total | | 2,952,622 | 2,260,290 | **-23.4%** | 2,098,761 | -7.1% | | | |

Corpus total **2,952,622 -> 2,260,290 bytes (-23.4%)**; at the nine finders that read the pack,
about **6.2MB less finder input** across eight reviews, on top of 13.3's 14.7%. Coverage did not
move: `bodies packed` is identical on every row, the per-file cap stubbed **zero** files, and every
changed line of every PR is in its pack exactly once. Contract checks passed on all eight and all
three arms: the `Total lines:` header matches the file, every TOC entry points at its own heading,
the `paths:` line is byte-identical across arms, the new pack is never larger than control, and all
**87,341** prefixed line numbers checked across the three arms match the working tree. The saving
is spread across diff sizes (-18% to -39%) where windowing's was concentrated on small diffs:
dedupe removes bytes in proportion to what was body-packed. Build time on the same machine fell
from 480 to 970 ms per pack to 310 to 560 ms; at six sequential git spawns of about 55 ms each plus
45 ms of node startup, the build is now spawn-bound and its own parse and render are within noise.

### 14.3 R5, measured and declined

The steering for this change was to land the two contract-neutral items first, re-measure, and
only then ask whether R5 still adds value, and to judge R5 itself on 13.4's non-cost evidence
(citation accuracy, format-caused re-reads) rather than on cost. The light column answers the first
question before the second is reached. On the corpus total the light shape is **7.1%** smaller than
the one-record pack, and on the three largest diffs, the case R5's 10% to 20% estimate was made
for, **2.4% to 3.7%**. After the dedupe a large PR's pack is mostly hunk tier already (60 of
PR316's 75 files), so the two shapes nearly coincide; R5's premise, that the diff was half the pack
and every body was paid on top of it, no longer holds. With two of nine pack readers on the light
shape (maintainability and conventions; integration gets no pack, so performance would have had
to stay on the full pack as the second body-tier finder R5's own mitigation requires), the fan-out
would save about **1.6%** of pack bytes, against a change to the falsifiable-finding contract's
evidence base. There is nothing to validate shipping, so the 13.4-shaped A/B (four Sonnet
finders) was not run. The skill still hands every finder the one pack, which keeps the public
description of the pack true. Revisit only if a later pack change reopens a gap between the two
shapes; the `--body-cap` knob and the replay script are what measures it.

### 14.4 Stated limitations

- Read multiplicity still has exactly one ground-truth sample (#578); 13.6's caveat stands. Both
  of that review's duplicate-read files now carry their changed lines at 3 lines of context, and
  whether that removes the reads is unmeasured until a review runs on a diff of that shape. Every
  finder now ends its report with its reads beyond the pack, and the review Summary carries the
  tally beside the pack's size and stub count, so the number accrues per review without a study.
  14.5 is where the rows land.
- Replay uses landed commits as a proxy for the reviewed tree (13.6, first bullet).
- The per-file cap's value is checked only against how often the corpus hits it, which is never.
  Its first real firing will be a lockfile or fixture diff.
- The R5 verdict rests on bytes, which the steering said not to decide on. Bytes are used here
  only as the gate to the A/B: a saving this small cannot justify the A/B's own cost, let alone the
  contract risk the A/B exists to measure.
- The replay's control arm ran first on each PR, so its build times include a cold object cache;
  the treatment's advantage is the two dropped spawns, not the cache.

### 14.5 Per-review record

The corpus replay measures bytes. The two things it cannot measure are whether finders re-read a
file the pack already carried, and what the per-file cap stubs when it fires, and both need real
reviews. Every finder now ends its report with its reads beyond the pack, and the driver puts the
tally in the review Summary beside the pack's shape, so each review contributes a row here at no
extra cost. Read the "reads" column against the "hunk sections" column: a read count that climbs
with the hunk-section count is the signal that `HUNK_CONTEXT_LINES` (3) is too narrow.

| Review | shape | pack | bodies (windowed) | hunk sections | stubbed | finders | reads beyond pack | findings raised/kept |
|---|---|---|---|---|---|---|---|---|
| #650 (this change) | 6f +1450 | 219KB, 3175 lines | 4 (1) | 2 | 0 | 7 | 0 of 6 pack-carrying | 11 / 6 |
| #686 | 39f +2367 | 214KB, 3610 lines | 14 (5) | 25 | 0 | 8 | 21 of 7 pack-carrying | 11 / 10 |
| #710 | 4f +116 | 31KB, 513 lines | 4 (4) | 0 | 0 | 7 | 17 of 6 pack-carrying | 5 / 4 |
| #711 | 12f +344 | 81KB, 1325 lines | 7 (6) | 5 | 0 | 7 | 4 of 6 pack-carrying | 9 / 5 |
| #715 | 10f +270 | 63KB, 973 lines | 4 (4) | 6 | 0 | 7 | 30 of 6 pack-carrying | 9 / 5 |
| #713 | 22f +2290 | 285KB, 3870 lines | 2 (1) | 20 | 0 | 7 | 17 of 6 pack-carrying | 19 / 13 |
| #717 | 14f +859 plus 2 new files | 180KB, 3263 lines | 8 (4) | 6 | 0 | 7 | 11 of 6 pack-carrying | 24 / 18 |
| #718 | 11f +312 | 72KB, 1010 lines | 7 (4) | 4 | 0 | 6 | 28 of 5 pack-carrying | 13 / 10 |
| #720 | 9f +284 plus 4 new files | 116KB, 1782 lines | 8 (4) | 5 | 0 | 7 | 12 of 6 pack-carrying | 15 / 13 |
| #724 | 7f +218 | 48KB, 873 lines | 7 (6) | 0 | 0 | 6 | 2 of 5 pack-carrying | 7 / 5 |
| task 727, pre-PR | 13f +964 | 133KB, 1859 lines | 3 (3) | 10 | 0 | 7 | 1 of 6 pack-carrying | 10 / 7 |
| #723 | 9f +210 | 32KB, 459 lines | 3 (2) | 6 | 0 | 8 | 28 of 7 pack-carrying | 12 / 9 |
| #728 | 15f +576 plus 8 new files | 176KB, 3359 lines | 16 (7) | 7 | 0 | 8 | 10 of 7 pack-carrying | 11 / 7 |
| task 733, pre-PR | 26f +1012 plus 3 new files | 164KB, 2755 lines | 8 (4) | 21 | 0 | 9 | 10 of 8 pack-carrying | 8 / 5, plus 2 found in verification |
| task 734, pre-PR | 36f +1490 plus 1 new file | 248KB, 4510 lines | 9 (6) | 28 | 0 | 10 | 3 of 9 pack-carrying | 31 / 27 |
| task 734, second pass | 32f +1824 plus 2 new files | 260KB, 4765 lines | 9 (5) | 25 | 0 | 10 | 6 of 9 pack-carrying | 31 / 20 |
| task 734, third pass | 37f +2922 plus 2 new files | 317KB, 5814 lines | 7 (2) | 32 | 0 | 9 | 16 of 8 pack-carrying | 35 / 28 |
| task 529, whole branch, pre-PR | 357f +51373 -3763 | 3508KB, 61990 lines | 4 (0) | 353 | 1 | 13, sharded by area | about 47 of 12 pack-carrying | about 94 / 38 applied |
| task 529, whole branch, second pass | 364f +53178 -3804 | 3607KB, 63938 lines | 3 (0) | 361 | 1 | 17, sharded by area, 4 over tests | about 68 of 16 pack-carrying | about 106 / 53 applied |
| task 529, whole branch, third pass | 367f +54593 -3815 | 3692KB, 65439 lines | 4 (0) | 363 | 1 | 17, sharded by area, 4 over tests | about 97 of 16 pack-carrying | about 85 / 55 applied |
| task 529, whole branch, fourth pass | 658f +76565 -7547 | 5536KB, 99303 lines | 3 (0) | 655 | 1 | 24, sharded by area and process boundary, 7 over tests | about 150 of 23 pack-carrying | about 85 / 52 applied |
| task 529, whole branch, fifth pass | 663f +79405 -7559 | 5702KB, 102379 lines | 3 (0) | 660 | 1 | 29, one shard file each, 9 over tests | about 195 of 28 pack-carrying | about 77 / 44 applied |
| task 529, whole branch, sixth pass | 674f +83014 -7629 | 5896KB, 105950 lines | 2 (0) | 672 | 1 | 30, one shard file each, 9 over tests | about 190 of 29 pack-carrying | 40 / 34 applied, 2 refuted |
| task 529, whole branch, seventh pass | 675f +84956 -7640 | 5895KB, 105732 lines | 4 (0) | 671 | 2 | 30, one shard file each, 9 over tests, 8 resumed to finish their shards | about 140 of 29 pack-carrying | 38 raised, 31 distinct / 29 applied, 2 refuted |
| task 529, whole branch, eighth pass | 676f +86115 -7734 | 5974KB, 107091 lines | 4 (0) | 672 | 2 | 31, one shard file each, 10 over tests, none resumed | about 110 of 30 pack-carrying | 23 raised, 22 distinct / 19 applied, 3 refuted |
| task 529, first-build progress follow-up | 29f +1093 -287 | 192KB, 3315 lines | 11 (8) | 18 | 0 | 8 | 4 of 7 pack-carrying, 2 not reported | 20 / 19, plus 1 found while filling holes |
| task 735, pre-PR | 49f +2098 -492, 10 new files, 1 deleted | 259KB, 4432 lines | 9 (2) | 40 | 0 | 8 | 10 of 7 pack-carrying | 21 raised, 19 distinct / 12 applied, 7 refuted; 6 coverage holes filled |
| task 736, whole branch, pre-PR | 146f +9278 -1701 | 793KB, 14017 lines | 10 (0) | 136 | 0 | 12, sharded by area: 6 area shards, 5 gated auditors on their own ranges, integration on the delta | about 34 of 11 pack-carrying, 1 not reported | 51 raised, 46 distinct / 27 applied, 2 refuted; 6 coverage holes filled |
| task 736, whole branch, second pass | 153f +10439 -1718 | 866KB, 15295 lines | 9 (0) | 144 | 0 | 14, sharded by area: 7 area shards, 6 gated auditors on their own ranges (cross-platform in two), integration on the delta | about 70 of 13 pack-carrying, most of them greps | 41 raised, 39 distinct, plus 1 found in verification / 27 applied, 4 refuted, 9 skipped; 5 coverage holes filled |
| task 736, whole branch, third pass | 156f +11700 -1724 | 944KB, 16632 lines | 8 (0) | 148 | 0 | 14, sharded by area: 7 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 40 of 13 pack-carrying, most of them rule files and callers | 35 raised, 31 distinct / 12 applied, 7 refuted, 10 skipped; 8 coverage holes filled |
| task 736, whole branch, fourth pass | 159f +12196 -1727 | 977KB, 17163 lines | 7 (0) | 152 | 0 | 15, sharded by area: 8 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 80 of 14 pack-carrying, most of them rule files, greps and callers | 34 raised, 30 distinct / 18 applied, 3 refuted, 9 skipped; 6 coverage holes filled |
| task 736, whole branch, fifth pass | 159f +12596 -1743 | 1007KB, 17608 lines | 7 (0) | 152 | 0 | 17, sharded by area: 10 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 80 of 16 pack-carrying, most of them the WSL sources the focus questions named; the integration finder read no body | 36 raised, 18 distinct / 4 applied, 6 refuted (2 by measurement), 6 skipped; 2 coverage holes filled |
| task 736, whole branch, sixth pass | 159f +12958 -1743 | 1029KB, 17970 lines | 7 (0) | 152 | 0 | 17, sharded by area: 10 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 70 of 16 pack-carrying, most of them rule files, callers and greps; the integration finder read 4 bodies | 43 raised, 42 distinct / 9 applied, 4 refuted, 22 skipped; 7 coverage holes filled |
| task 736, whole branch, seventh pass | 164f +13570 -1747 | 1076KB, 18670 lines | 6 (0) | 158 | 0 | 17, sharded by area: 10 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 80 of 16 pack-carrying, most of them rule files, callers and greps; the integration finder read no body | 30 raised, 22 distinct / 8 applied, 2 refuted, 9 skipped; 3 coverage holes filled |
| task 736, whole branch, eighth pass | 164f +14097 -1751 | 1111KB, 19217 lines | 6 (0) | 158 | 0 | 18, sharded by area: 11 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 90 of 17 pack-carrying, most of them greps, callers and rule files; the integration finder read 4 narrow ranges | 29 raised, 28 distinct / 7 applied, 10 refuted, 7 skipped; 4 coverage holes filled |
| task 736, whole branch, ninth pass | 165f +14518 -1751 | 1137KB, 19642 lines | 6 (0) | 159 | 0 | 18, sharded by area: 11 area shards, 6 gated auditors on their own ranges (cross-platform in two, migration on `types.ts`), integration on the delta | about 60 of 17 pack-carrying, most of them greps, callers and rule files; the integration finder read no body | 12 raised, 12 distinct / 3 applied, 6 refuted, 2 skipped; 1 coverage hole filled |
| task 743, pre-PR | 18f +687 -54 after the pass, 1 new file | 108KB, 2151 lines | 10 (6) | 9 | 0 | 9 | 15 of 8 pack-carrying; 3 finders re-read the pack in windows because a 2000-line read hit the token cap | 24 raised, 21 distinct / 7 applied; 9 coverage holes filled |
| task 741, pre-PR | 5f +94 -31 plus 5 new files | 57KB, 1084 lines | 9 (4) | 1 | 0 | 9 | 17 of 8 pack-carrying | 12 / 5 applied, 5 skipped, 2 dropped; 3 coverage holes filled, 1 already covered |
| task 741, second pass | 11f +232 -57 plus 5 new files | 97KB, 1721 lines | 13 (7) | 3 | 0 | 9 | 15 of 8 pack-carrying | 12 / 4 applied, 4 refuted, 4 skipped, plus 3 found in verification (2 applied, 1 skipped); 4 tests added, 1 hole skipped as unreachable |
| task 746, pre-PR | 25f +1243 -88, 2 new files | 117KB, 2079 lines | 6 (1) | 19 | 0 | 10 | 11 of 9 pack-carrying | 18 raised, 15 distinct / 5 applied, 8 skipped; 2 coverage holes filled, 3 skipped |
| task 745, pre-PR | 1f +56 -14 plus 3 new files | 130KB, 2280 lines | 4 (1) | 0 | 0 | 7 | 0 of 6 pack-carrying; 1 finder re-read the pack after a 2000-line Read hit the token cap, 1 left about 600 lines unread | 24 raised, 23 distinct / 7 applied, 1 refuted; 11 of 17 coverage holes filled |
| task 745, second pass | 2f +58 -14 plus 3 new files | 145KB, 2533 lines | 4 (1) | 1 | 0 | 7 | 3 of 6 pack-carrying, 2 of them re-reads of in-pack files; all 6 hit the token cap on the first 2000-line Read and re-chunked, 1 skipped the test section | 30 raised, 30 distinct / 4 applied, 2 refuted; 8 of 10 coverage holes filled |
| task 749, pre-PR | 32f +1506 -621 plus 4 new files | 299KB, 4881 lines | 8 (2) | 28 | 0 | 7 | about 17 of 6 pack-carrying, most of them callers and rule files; 2 reported the token cap on a 2000-line Read: 1 re-chunked at 1000 lines, the IPC auditor reviewed from the source without loading the pack | 21 raised, 19 distinct / 10 applied, 2 refuted, 7 skipped; 9 coverage holes filled, 1 of them for a fix the pass made |
| task 749, second pass | 34f +1550 -626 plus 12 new files | 371KB, 6153 lines | 8 (2) | 38 | 0 | 7 | about 12 of 6 pack-carrying, most of them callers, rule files and test greps; the IPC auditor hit the token cap on a 2000-line Read and covered the pack in part, the conventions finder skimmed the test sections, and the correctness finder read 2 files from the main checkout by mistake | 32 raised, 30 distinct, plus 1 found in verification / 4 applied, 21 skipped; 5 of 6 coverage holes filled, plus tests for the 4 fixes |
| task 749, third pass | 37f +1743 -659 plus 12 new files | 413KB, 6866 lines | 7 (2) | 42 | 0 | 7 | about 17 of 6 pack-carrying, most of them rule files, callers and greps; the IPC auditor hit the token cap on a 2000-line Read and reviewed from the source without loading the pack, and the coverage finder re-chunked at 900 lines | 17 raised, 16 distinct / 6 applied, 1 refuted, 6 skipped; 3 of 4 coverage holes filled, plus tests for 2 of the pass's fixes |
| task 749, fourth pass | 38f +1918 -669 plus 12 new files | 445KB, 7315 lines | 5 (2) | 45 | 0 | 8 | about 17 of 7 pack-carrying, most of them callers, stores and rule files; at 445KB a 2000-line Read passes the token cap, so the coverage finder re-chunked at 900 lines, the IPC and migration auditors reviewed from the source without loading the pack, and the conventions finder skipped the test sections | 21 raised, 21 distinct / 4 applied, 3 refuted or dropped, 10 skipped; 3 of 4 coverage holes filled |
| task 749, fifth pass | 52f +4672 -696, all committed | 465KB, 7640 lines | 4 (2) | 48 | 0 | 8 | about 21 of 7 pack-carrying, most of them callers, the renderer store and rule files; every pack-carrying finder loaded the pack in 1000-line calls and none reported the token cap, the IPC and cross-platform auditors read only their sections by the table of contents, `migration-safety` did not run on wire-only `types.ts` hunks, and the integration finder read 1 narrow range | 23 raised, 22 distinct / 6 applied, 1 refuted, 11 skipped; 4 of 4 coverage holes filled, plus tests for both Medium fixes |
| task 754, whole branch, pre-PR | 98f +4146 -547, all committed | 432KB, 7662 lines | 11 (2) | 87 | 0 | 9 | about 12 of 8 pack-carrying, most of them greps; every finder that tried a 2000-line Read hit the token cap and re-chunked, the IPC auditor reviewed from the source without loading the pack, the HMR auditor read its 2 sections by the table of contents, `migration-safety` did not run on a non-schema `types.ts` field, and the integration finder read 1 narrow range | 21 raised, 20 distinct / 8 applied, 3 refuted or dropped, 4 skipped; 5 coverage holes filled, plus tests for 2 of the pass's fixes; 1 more found while filling holes, skipped |
| task 751, pre-PR | 5f +85 -24, all uncommitted | 45KB, 648 lines | 4 (3) | 1 | 0 | 8 | 6 of 7 pack-carrying, 2 of them gap reads of in-pack files (`config-store.ts`, `hmr-resync.test.ts`), the rest callers; the IPC auditor used greps only, and the integration finder read 1 narrow range | 10 raised, 6 distinct / 5 applied, 1 skipped, plus 2 found in verification (both outside the diff, skipped); 1 coverage hole filled |
| task 750, pre-PR | 156f +1777 -2966, 7 new files, 4 deleted | 604KB, 10933 lines | 10 (4) | 153 | 0 | 12: 9 in the fan-out, then 3 over the test bodies in 700-line windows | about 40 of 11 pack-carrying; all 8 first-wave pack readers hit the token cap on their first 2000-line Read and sampled, so the 105 rewritten tests went unread until the 3 test-body finders were added | 18 raised, 17 distinct, plus 1 found in verification / 6 applied, 12 refuted (1 by a scoped run of 12 suites); 3 coverage holes filled |
| task 752, pre-PR | 42f +2608 -235, all committed | 237KB, 4140 lines | 8 (5) | 34 | 0 | 9 | about 12 of 8 pack-carrying, most of them callers and rule files; 2 hit the token cap on a 2000-line Read (the IPC auditor then read only its own sections, the coverage finder re-chunked), and the cross-platform auditor read about half the ranges and grepped the rest | 30 raised, 27 distinct / 8 applied (2 in part), 3 dropped, 9 skipped; 5 of 7 coverage holes filled, plus a test for 1 of the pass's fixes. A follow-up in the same task applied 8 of the 9 skipped and refuted 1 by measurement (128 bytes per cursor call against a measured 88), but left both partials open: no real image sample, and 4 of the 7 popover caps untested. A second follow-up closed both (a sanitized real image tool result, and short-window tests for the 4 caps) |
| task 752, second pass | 49f +5091 -282, all committed | 390KB, 6755 lines | 6 (2) | 43 | 0 | 9 | about 15 of 8 pack-carrying, 7 of them the correctness finder's callers and engine reads, the rest rule files, two schema ranges and one shared reader; no finder reported the token cap, and the integration finder read 1 narrow range | 23 raised, 23 distinct / 5 applied, 3 dropped, 12 skipped; 3 of 4 coverage holes filled, the fourth unreachable because every open remounts the popover |
| task 755, pre-PR | 41f +1265 -165 plus 6 new files, all uncommitted | 272KB, 4388 lines | 12 (6) | 35 | 0 | 10 | about 14 of 9 pack-carrying plus greps, 8 of them the session-lifecycle auditor's spawn, insert and capture-site reads; every finder loaded the pack in 600-line calls and none reported the token cap, and the cross-platform auditor read about 1000 lines and grepped the rest | 20 raised, 17 distinct / 3 applied, 7 refuted or dropped, 7 skipped, plus 2 found while filling holes: a clean-at-HEAD test the diff broke (its mock lacked the new `setEarlierRunsSource`, fixed) and a fragile flush in the task's own test (skipped); 7 of 7 coverage holes filled with 29 tests |
| task 755, second pass | 81f +5269 -204, all committed | 420KB, 7292 lines | 14 (1) | 67 | 0 | 10 | about 23 of 9 pack-carrying, most of them greps and callers; 3 finders hit the token cap on a 2000-line Read and re-chunked (the migration auditor then read only its own sections by the table of contents, the session-lifecycle auditor skipped the test sections past line 4000), and the integration finder read 3 narrow ranges | 24 raised, 23 distinct / 3 applied, 8 refuted or dropped, 8 skipped; 4 coverage holes filled with 11 tests, 1 skipped as unobservable. A follow-up in the same task applied all 8 skipped, including the hole skipped as unobservable, which turned out reachable through the queue: one shared own-record lookup with its own test, a required `isRestartRequested` in place of the source-text scan, a 10 s wait before a failed fill reads again (2 tests), one merged-breakdown method, the refresh-named popover read, two shared test fixtures, and 2 tests for a queued spawn's permission mode |
| task 755, third pass | 87f +5520 -212, all committed | 445KB, 7637 lines | 15 (1) | 72 | 0 | 10 | 9 of 9 pack-carrying plus greps, most of them callers and the spawn, insert and summary ranges, and the integration finder read 7 narrow ranges; 4 finders hit the token cap on a 2000-line Read (the migration auditor then read the real files instead of the pack, the session-lifecycle auditor read targeted slices, the conventions finder re-chunked at about 900 lines and sampled the test bodies, the coverage finder read selectively), so the 46 test files were reviewed mostly by grep | 14 raised, 14 distinct / 1 applied (a comment), 4 refuted, 9 skipped; both coverage holes refuted as unobservable: the restart flag has no reader on the update-install route, and a failed-spawn row never reaches the running-status analytics |
| task 756, pre-PR | 40f +21592 -137, all committed, 3 of them captured JSON fixtures | 520KB, 10398 lines | 5 (0) | 35 | 1 (`knowledge-graph.json`, 388KB) | 9, migration-safety added after the fan-out on its `types.ts` gate | about 13 of 7 pack-carrying, most of them greps and callers; finders were told to skip pack lines 45-6473 (two fixtures) and the stubbed fixture was checked only by the driver's personal-info grep; 3 finders hit the token cap on a 2000-line Read and re-chunked, and the performance finder read only the dataset range plus the demo build config | 24 raised, 22 distinct / 8 applied, 2 refuted, 12 skipped; 2 of 3 coverage holes filled, plus tests for 2 of the pass's fixes |
| task 756, second pass | 47f +22558 -186, all committed, 3 of them captured JSON fixtures | 575KB, 11367 lines | 5 (0) | 42 | 1 (`knowledge-graph.json`, 388KB) | 9, migration-safety on its `types.ts` gate from the start | about 20 of 7 pack-carrying, most of them greps and callers; finders were told to skip pack lines 52-6480 (two fixtures) and to read in 900-line chunks, and none reported the token cap; the driver (the session that wrote the code under review) settled two findings by running probes, not by reading | 28 raised, 25 distinct / 9 applied, 3 refuted (2 by probe), 8 skipped; 4 of 6 coverage holes filled, 1 already covered, plus tests for 3 of the pass's fixes |
| task 759, pre-PR | 18f +438 -22 plus 1 new file, all uncommitted | 87KB, 1356 lines | 6 (4) | 13 | 0 | 9 | 4 of 8 pack-carrying plus greps: 2 correctness reads of the reset callers and the replay harness, 1 conventions read of a demo dataset comment, 1 IPC read of the mobile wire mapper; every finder loaded the pack in 700-line calls and none reported the token cap, the migration auditor answered from greps without loading it, and the integration finder read 2 narrow ranges | 5 raised, 5 distinct / 3 applied, 2 skipped; 3 of 4 coverage holes filled with 4 tests, 1 refuted because tsc already enforces the label key, plus 1 test for the pass's own empty-id fix |
| task 758, pre-PR | 10f +685 -50, all uncommitted | 87KB, 1501 lines | 5 (5) | 5 | 0 | 8 | about 12 of 7 pack-carrying, most of them greps; the correctness finder read the exit-event shape in `pty-host-client.ts` and the renderer store, 3 finders read `sentry-breadcrumbs.ts` for the redaction and allowlist; every finder loaded the pack in 750-line calls and none reported the token cap, and the integration finder read no body | 22 raised, 19 distinct / 6 applied (2 in part), 9 refuted or dropped, 4 skipped; 4 of 4 coverage holes filled, plus tests for both code fixes (18 tests). A follow-up in the same task applied all 4 skipped. One run of the real CLI, driven the probe's way and sending no prompt, gave verbatim 2.1.290 screens that now back every end-to-end probe test, and it refuted the welcome-box worry for 2.1.290, whose header names no one (a `Welcome back` mask covers other layouts). The store now reloads the list when it learns a model id, and the ladders and the log line each became one helper |
| task 758, second pass | 14f +1161 -60, all committed | 127KB, 2122 lines | 4 (4) | 10 | 0 | 9 | about 8 of 8 pack-carrying, most of them `sentry-breadcrumbs.ts` for the redaction and greps of the PTY exit shape and `VirtualScreen.text()`; the driver asked for 2000-line calls and 4 finders hit the token cap on the first one (the IPC and HMR auditors then read only the last 122 lines plus the source, the maintainability finder skipped the test sections), where the first pass's 750-line calls hit nothing, and the integration finder read 1 file | 12 raised, 12 distinct / 3 applied, 3 refuted; 6 of 6 coverage holes filled with 7 tests |
| task 762, pre-PR | 23f +1255 -132, all committed | 171KB, 2600 lines | 8 (4) | 15 | 0 | 7 | about 10 of 6 pack-carrying, 7 of them the correctness finder's session-manager, spawn-flow and resume-controller reads for the label race and the successor hop, 1 not reported (conventions); the driver asked for 2000-line calls and 4 finders hit the token cap, so the IPC auditor read only from line 1437 on and the performance finder skipped the test, docs and protocol sections; the integration finder read 3 narrow ranges | 16 raised, 12 distinct / 7 applied (1 in part), 2 refuted or dropped, 3 skipped; 5 of 5 coverage holes filled, plus a drain-coupling test and a producer-to-parser round trip |
| task 762, second pass | 39f +2835 -311, all committed | 323KB, 4881 lines | 10 (3) | 29 | 0 | 8 | about 12 of 7 pack-carrying, most of them rule files, greps and `ansi-strip.ts` for the label sanitizer, and the integration finder read 1 narrow range; the driver asked for 2000-line calls again and 4 finders hit the token cap (the cross-platform auditor read the first 900 lines and searched the rest by regex, the IPC auditor read only its own sections, the correctness finder re-chunked and skipped most test bodies, the maintainability finder read only the source sections) | 17 raised, 13 distinct, plus 2 found in verification / 4 applied (1 in part), 2 dropped, 5 skipped, both found in verification applied; 2 of 2 coverage holes filled with 3 tests, plus a test for the pass's listener guard |
| task 762, third pass | 41f +3107 -316, all committed | 344KB, 5199 lines | 10 (3) | 31 | 0 | 8 | about 13 of 7 pack-carrying: 6 correctness reads for the label owner and the import cycle, 3 conventions reads (`ansi-strip.ts` for the sanitizer, the protocol helpers, the moved engine call), 3 coverage greps of tests, 1 IPC read of the broadcast guard; the driver asked for 2000-line calls again and 3 finders reported the token cap (the cross-platform auditor read regex-found windows, the IPC auditor read only its sections by heading, the conventions finder read in chunks and skipped most test bodies), and the integration finder read no body | 16 raised, 15 distinct / 2 applied, 8 refuted or dropped, 1 skipped; 4 of 4 coverage holes filled with 7 tests, plus a test for the sanitizer fix. A follow-up in the same task applied the skipped one: the archive read for resume eligibility moved into `resumeBlockReasonForTask`, with a parity check over the four sites |
| task 762, fourth pass | 41f +3377 -328, all committed | 362KB, 5464 lines | 8 (2) | 33 | 0 | 8 | about 10 of 7 pack-carrying: 4 correctness reads (the `spawn-progress.ts` gaps for the claim owner, the `session-manager.ts` removal and placeholder emit order, greps of the spawn flow and the protocol imports), 4 conventions reads (the protocol release rule, `ansi-strip.ts`, greps of the changelog and `tsconfig.json`), 2 IPC reads (`session-reconcile.ts`, the UI mock's resume); the driver asked for 2000-line calls again, the cross-platform auditor hit the token cap and read the first 900 lines then searched the rest by regex, the conventions finder read only the first 900 test lines, the performance finder skipped the test sections, and the integration finder read 2 files | 11 raised, 11 distinct / 5 applied, 4 refuted or dropped, 2 skipped; 3 of 3 coverage holes filled with 3 tests, plus 14 tests for the pass's own fix (a phone Resume that failed after it was accepted showed nothing anywhere, and now sends the desktop spawn-blocked notice through an `onFailed` hook) |
| task 762, fifth pass | 42f +3749 -328, all committed | 381KB, 5771 lines | 7 (2) | 35 | 0 | 8 | about 11 of 7 pack-carrying: 5 correctness reads (the `session-manager.ts` removal emits, the `session-reconcile.ts` label pushes, a `read-stream.ts` subscribe window, two source-scan tests), 4 conventions reads (the protocol release rule, the changelog headings, `ansi-strip.ts`, a `sessions.ts` import grep), 2 IPC reads (`send-to-renderer.ts`, `task-git.ts` for the spawn-blocked guard); the driver asked for 800-line calls instead of 2000 and no finder reported the token cap, though the cross-platform auditor still read only the first 1600 lines in full and searched the rest by regex and the correctness finder skipped the last 300 lines (docs, lockfile, mock); the integration finder read 3 narrow ranges | 9 raised, 9 distinct / 5 applied (2 in part), 2 dropped, 2 skipped; no coverage holes. Two behavioral findings. A doc claim said the stream's `resumable` is pushed on every change, but a Done move or archive of a paused task is no edge of its row, so three doc sites now say the stream copy can lag behind the board row, which is the gate. The correctness finder's abort-cleanup race was refuted as stated (the per-project worktree queue orders it), but verification found the same cleanup's `removeByTaskId` drops the paused row on every resume a newer one aborts, ending a phone's feed with no successor; skipped as a design change shared with suspend, reset and relocation. A follow-up in the same task applied both skipped: the cancelled resume now cleans up nothing, as `autoSpawnForTask`'s abort already did (each canceller settles the task under its own lock), and the label sanitizer also strips the soft hyphen, the invisible math operators, and tag characters outside the three flag emoji spelled with them (England, Scotland, Wales) |
| task 762, sixth pass | 43f +3832 -347, all committed | 391KB, 5890 lines | 7 (2) | 36 | 0 | 9 | about 26 of 8 pack-carrying: 11 session-auditor reads of the engine abort checkpoints, the suspend, reset and relocate paths, the spawn flow drain and the queued placeholder, 7 IPC reads of the renderer resume store and its caller, 5 conventions reads (the protocol release rule, changelog headings, greps), 2 cross-platform reads (`ansi-strip.ts`, a source-scan test), 1 correctness read of the engine checkpoints; the skill's 2000-line calls came back, and 5 finders hit the token cap (the IPC auditor read 900 lines and then only its sections, the cross-platform auditor and the correctness finder re-chunked at 900, the conventions and maintainability finders skipped most test bodies), where the fifth pass's 800-line calls hit none; the integration finder read 2 files | 15 raised, 15 distinct, plus 1 found in verification / 7 applied (2 in part), 3 refuted or dropped, 6 skipped; 5 of 5 coverage holes filled, plus tests for each code fix (13 tests added, 4 updated). The session auditor found that a task holding a paused row and a queued respawn read `resumable: true` while `start-session` answered `live`, so `pausedTaskIdsOf` now excludes a task with a live row. The IPC auditor found the renderer's `resumeSession` threw on the null a cancelled resume returns, which a phone Resume can now cause by cancelling a desktop one. The correctness finder found the spawn-progress feed's stale prune swallowed a clear that arrived after a quiet phase longer than the TTL. A follow-up in the same task closed all six skips. Phase 3's profile fold and engine setup moved inside the try that reports through `onFailed`, with the refusal check read off the column's own row ahead of it. The label sanitizer turns the vertical tab, the form feed and the C1 next line into spaces before the escape strip. A single-task `isTaskPaused` wraps `pausedTaskIdsOf` for start-session and the stream copy. The resume's label and abort comments were cut to what the code needs. Two were kept on purpose: the feed's options object matches its sibling `SessionLifecycleBoardFeed`, and its stale prune stays on `Date.now()` because the desktop TTL it mirrors does |
| task 765, pre-PR | 11f +421 -45 plus 2 new files, all uncommitted | 117KB, 2036 lines | 8 (5) | 5 | 0 | 7 | 1 of 6 pack-carrying, the correctness finder's read of `initialize()` in `retrieval-worker.ts`, the rest greps; the driver asked for 1000-line calls and no finder reported the token cap; the integration finder sent no reads line | 20 raised, 15 distinct / 5 applied, 1 refuted, 9 skipped; 2 of 5 coverage holes filled, plus a test for the applied constructor guard |
| task 765, second pass | 25f +980 -70, all committed | 142KB, 2435 lines | 6 (3) | 19 | 0 | 7 | 6 of 6 pack-carrying plus greps: 1 correctness read of the `semantic: 'error'` branches in `retrieval-service.ts`, 2 conventions and 1 platform-guard read of rule files, 1 platform-guard read of `.gitattributes`, and the integration finder read 10 lines of `docs/analytics.md`; the driver asked for 600-line calls and no finder reported the token cap | 13 raised, 11 distinct / 5 applied, 6 skipped; 2 of 3 coverage holes filled, 1 refuted as unreachable, plus a source-scan guard that every fork catch reports `fork_failed` |
| task 766, pre-PR | 33f +2112 -93, all committed | 252KB, 4012 lines | 8 (4) | 25 | 0 | 9 | about 6 of 8 pack-carrying plus greps: the correctness finder's renderer copy and `tagged-reap.ts` gap reads, and the IPC auditor's UI mock and store-test reads; the driver asked for 2000-line calls and at least 4 finders hit the token cap (the IPC auditor skipped pack lines 901-2988, the performance finder skipped the darwin and win32 sections, the HMR auditor read its sections by the table of contents), `.kangentic/` was wiped mid-pass so the cross-platform auditor could not re-open the pack for the test sections, and the integration finder read no body | 26 raised, 24 distinct / 7 applied, 4 refuted, 8 skipped; 5 of 5 coverage holes filled with 13 tests, plus 1 for the pass's own comment fix |
| task 761, pre-PR | 39f +2495 -192, all committed | 229KB, 3935 lines | 14 (4) | 25 | 0 | 9 | about 8 of 8 pack-carrying plus greps, most of them rule files and the cache and watcher ranges in `ChangesPanel.tsx`; the driver asked for 2000-line calls and at least 3 finders hit the token cap on the first one (the HMR auditor then read only its own section by grep, the correctness finder and IPC auditor re-chunked), and the integration finder read 1 file | 26 raised, 26 distinct / 7 applied, 8 refuted or dropped, 11 skipped; 5 of 6 coverage holes filled with 27 tests, 1 refuted as already pinned by `changes-panel-rail-clamp-parity.test.ts`; 1 more found while filling holes (a roll-in from an image cleared its request before the diff computed), fixed with a red-green test |
| task 761, second pass | 43f +4020 -200, all committed | 300KB, 5099 lines | 9 (1) | 34 | 0 | 9 | about 12 of 8 pack-carrying, 1 not reported: 7 by the IPC auditor, which reviewed from the source and greps without loading the pack, 2 by the HMR auditor (the rule file and the worker), 2 correctness greps of the `pixelmatch` and `simple-git` typings, 1 conventions read of the light-dismiss test; the driver asked for 2000-line calls, the conventions finder hit the token cap and re-chunked, the maintainability finder left pack lines 1-950 (the new UI spec) unread, and the integration finder read no body | 22 raised, 21 distinct / 7 applied, 2 refuted, 12 skipped; 5 of 6 coverage holes filled with 9 tests, 1 skipped because the cache-hit re-insert in `ChangesPanel.tsx` needs a budget override or about 64MB of fixtures to reach; plus 1 test for the pass's own prototype-key fix |
| task 767, pre-PR | 20f +3041 -119, all committed, 13 new files | 298KB, 3623 lines | 6 (0) | 14 | 0 | 9, the first pass under the converge rules: 3 correctness shards from `--shard-lines 1500` (1427, 1443 and 729 lines) | 11 of 8 pack-carrying, 5 of them the tests-and-data shard reading the scripts its range exercises, the rest build-script ranges, a test helper, the skill's own path rule and an audit range; no finder reported the token cap at 1000-line reads; the integration finder read 2 narrow ranges | 27 raised, 26 distinct, plus 3 found in verification / 23 fixed (3 by decision), 6 refuted, 0 blocked; 6 of 6 coverage holes filled plus a transcript fixture test and a test for the entrypoint helper the pass extracted (108 tests added). The pass's own commit found the worst one: commitlint read the one-line ledger items as footer trailers and refused every line over 100 characters, so no ledger had ever been committable. Platform-guard found that the skill passed the Windows scratchpad path unquoted to Git Bash, which drops its backslashes, so the pack and dirty list would land inside the worktree for Step 8 to commit. The pack header still told finders 2000 lines per Read, a survivor of the rule this change replaced |
| task 773, pre-PR | 19f +1255 -60, all committed, 2 new files | 149KB, 2186 lines | 13 (8) | 6 | 0 | 8: 2 correctness shards from `--shard-lines 1500`, platform-guard on its `src/main/agent/**` gate | 5 of 7 pack-carrying, all single files or greps (`eval-ask.mjs`, `cost.mjs`, `answer-prompt.ts`, the skill twice), and the integration finder read 4 narrow ranges; no finder reported the token cap at 1000-line reads, but platform-guard loaded only pack lines 1-500 and grepped the rest | 23 raised / 21 fixed (3 by decision), 2 refuted, 0 blocked; 7 of 8 coverage holes filled, 1 refuted, plus tests for the pass's fixes. The real-shape fixture finding was closed from a tee capture the model round left in another session's scratchpad: a real 2.1.293 Ask stream, sanitized into `tests/fixtures/claude-ask-stream.jsonl`. Without it the finding would have been blocked, because the skill forbids a headless `claude` call |
| task 775, pre-PR | 32f +510 -80 plus 4 new files, all uncommitted | 155KB, 2327 lines | 13 (8) | 23 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1496 and 791 lines) | about 8 of 9 pack-carrying plus greps: 5 by the second correctness shard, 3 of them re-reads of in-pack files (`known-project.ts`, `auto-spawn-reconcile.ts`, `session-resume-eligibility.ts`), the rest one callee range each for performance and maintainability and one rule file for conventions; no finder reported the token cap at 1000-line reads, and the integration finder read 1 file | 8 raised, 8 distinct / 5 fixed (1 by decision, 2 quick), 3 refuted, 0 blocked; 2 of 3 coverage holes filled with 3 tests, the third refuted because the archived page shares the full view's mapper. The one code defect was a log line: the auto-spawn suspend loop printed "Suspended session" after every early return, including the exited-agent case the change itself stopped suspending |
| task 774, pre-PR | 24f +1872 -176, all committed, 3 new files | 238KB, 3885 lines | 9 (3) | 15 | 0 | 10: 3 correctness shards from `--shard-lines 1500` (1430, 1468 and 959 lines), 2 gated auditors (platform-guard, session-debugger) | about 19 of 9 pack-carrying plus greps, 4 of them the same gap read of `read-stream.ts` (the seed-to-subscribe span the windowed section hid, where the seed tap leak was), the rest callers, test helpers and omitted bridge-session windows; no finder reported the token cap at 1000-line reads; the integration finder read 3 narrow ranges | about 56 raised, 45 distinct, plus 3 found while filling holes / 40 fixed (3 by decision), 8 refuted, 0 blocked; 15 coverage holes filled across 9 test files. Filling them found 5 `session-manager-data-tap.test.ts` assertions already failing on the branch (the tap gained an argument), a failed re-subscribe dropping a live stream's marker, and a few buffered bytes printing as 0 kB. Platform-guard's High (fs.watch `ignore` given absolute paths) was refuted from Node's own `recursive_watch.js` |
| task 778, pre-PR | 14f +607 -37 plus 2 new files, all uncommitted | 100KB, 1712 lines | 9 (5) | 7 | 0 | 8: 2 correctness shards from `--shard-lines 1500` (1453 and 239 lines), platform-guard on its `src/main/pty/**` and `src/main/agent/**` gate | 4 of 7 pack-carrying plus greps: correctness shard 1 and platform-guard each read the `quoteArg` body in `paths.ts`, which the hunk window cut off, and shard 1 also read the `resolveSpawnCwd` body and a docs range; performance, maintainability and shard 2 read nothing; no finder reported the token cap at 1000-line reads; the integration finder read 4 narrow ranges | 19 raised, 18 distinct, plus 1 found in verification / 15 fixed (3 by decision, 4 quick), 4 refuted, 0 blocked; 2 of 2 coverage holes filled, plus pins for the new `quoteCmdExecutable` and a scan for bare `exec` heads. The conventions finder's Low on 15 unescaped Windows `exec` heads was fixed in this pass, not filed. The live cmd and PowerShell round trips ran on the driver's Windows machine before and after the probe changes, so this pass checked the escapes against real shells |
| task 780, pre-PR | 112f +5247 -1345, all committed, 2 test files deleted | 601KB, 10073 lines | 18 (3) | 94 | 0 | 18: 8 correctness shards from `--shard-lines 1500`, 5 gated auditors each on its own ranges (task 750's 604KB full-pack pass hit the token cap, so only the 4 universal finders read the whole pack), integration on the delta | about 70 of 17 pack-carrying, most of them callers, session-manager and pty-host gap reads, and rule files; no finder reported the token cap at 1000-line reads, including the 4 that read all 11 chunks; the integration finder read 13 narrow ranges | 70 raised, plus 3 found in verification or while filling holes / 35 fixed (4 by decision, 11 quick), 24 refuted, 0 blocked; 16 coverage holes filled across 18 test files, with a real-shape `UserPromptSubmit` fixture taken from the vendor's documented hook input because the skill forbids a headless capture. Three finders independently raised the dead-shell path deleting the session directory under an exiting agent; verification refuted it, since `remove()` already deletes the directory on every end path, and the same read found the cold-open prune deleting a live terminal's directory (fixed). A test-builder's whole-object `toEqual` on a git env printed every inherited variable on its red run, which turned up the same dump-on-failure shape in an older test |
| task 781, pre-PR | 11f +692 -64 after the pass, all uncommitted | 91KB, 1544 lines | 7 (7) | 4 | 0 | 9: 2 correctness shards from `--shard-lines 1500` (1498 and 31 lines), 2 gated auditors (platform-guard, session-debugger), integration on the delta | 14 of 8 pack-carrying plus greps: correctness shard 1 and session-debugger read 5 each (the session file manager, the telemetry getter, `remove()`, the spawn flow, `parseWslShellSpec`), platform-guard and conventions 2 each; performance, maintainability and coverage read nothing, and the 31-line shard sent no reads line; no finder reported the token cap at 1000-line reads; the integration finder read no body | 19 raised, 18 distinct, plus 1 found in verification / 15 fixed (6 by decision, 4 quick), 4 refuted, 0 blocked; 6 coverage holes filled in one test file, each confirmed red by a toggle. The verification one was a High no finder raised: the new WSL end settle would end a live agent if `/resume` sent SessionEnd while its picker was open. A new `--mode resume` probe on Claude Code 2.1.294 refuted it, with no hook while the picker was open and 116 ms between the choice's two hooks. Every fix landed on an already-dirty path, so the pass committed only its ledger and this row |
| task 783, pre-PR | 6f +46 -13, all uncommitted | 19KB, 344 lines | 5 (4) | 1 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (334 lines), 2 gated auditors (platform-guard, session-debugger), integration on the delta | 12 of 7 pack-carrying: 5 of the 7 read lines 1-20 of `task-process-tag.ts` to rule out an import cycle, because the windowed section left its import header in a gap; the rest were the other WSL detectors (`paths.ts`, `shim-launch.ts`, `terminal-clipboard.ts`), a docs range and two `session-manager.ts` ranges; performance and coverage read nothing; the integration finder read 5 narrow ranges | 11 raised, 9 distinct / 4 fixed (1 quick), 6 refuted, 0 blocked; the 1 coverage hole was refuted, since the bare `wsl` test already fails if the gate is reverted. No code defect: the fixes were a comment that called `parseWslShellSpec` the one WSL detector, a docs line, and the two probe scripts' copies of `resolveShellArgs`, which kept the old gate. The comment fix stayed uncommitted as mixed authorship |
| task 802, pre-PR | 101f +4289 -888, all committed | 511KB, 8738 lines | 14 (2) | 87 | 0 | 17: 7 correctness shards from `--shard-lines 1500`, 5 gated auditors (IPC, HMR, platform-guard, session-debugger, migration-safety), integration on the delta | about 39 of 16 pack-carrying plus greps, most of them production code a test-heavy shard exercises from another shard's range (`record-background-call.ts` by 3 shards, `system.ts`, `cli-print.ts`, `project-repos.ts`); no finder reported the token cap at 1000-line reads, the session, HMR and migration auditors read only their own sections by the table of contents, and the integration finder read 3 narrow ranges | 40 raised, 36 distinct / 28 fixed (5 by decision, 6 quick), 7 refuted, 0 blocked, 1 filed as a follow-up; 15 coverage holes filled across 18 test files with 5 test-builders split by target file. Three test-builders could only check their private-logic tests by flipping the expected value, so the driver mutated the source for 5 of them (the timeout label, the unknown outcome, the discovery retry, the turn-end call context, the workflow step's call id) and watched each go red. Three finders raised the same defect: any error mentioning "timed out", a CLI's own included, was recorded as our timeout |
| task 782, pre-PR | 16f +411 -53 plus 2 new files, all uncommitted | 95KB, 1711 lines | 9 (5) | 9 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1421 and 268 lines), 3 gated auditors (ipc-auditor, platform-guard, migration-safety), integration on the delta | 18 of 9 pack-carrying, from 5 finders: correctness shard 1 read 8 (the engine core, callers, the schema), shard 2 read 5, migration-safety 3, performance and conventions 1 each; three of them read the `activateAllProjects` body the hunk window cut off; maintainability, coverage, ipc-auditor and platform-guard used greps only; no finder reported the token cap at 1000-line reads; the integration finder read 5 files | 33 raised, 24 distinct / 16 fixed (4 by decision, 3 quick), 4 refuted, 0 blocked, 1 filed as a follow-up; 6 of 8 coverage holes filled, plus a fixture repair and a real-file test for the prompt facts, each confirmed red by a toggle but one contract pin. Integration and correctness shard 1 both found 4 existing tests whose database mock lacked the new export: `workflowTasks`' bare catch swallowed the throw, so they passed on an empty task list. The blocked-start hole needed a board unread yet still readable (a table renamed on the live handle), since a fully unreadable blocker already reads as not done |
| task 789, pre-PR | 12f +378 -26 with 1 new file, all committed | 61KB, 1112 lines | 7 (4) | 5 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (1096 lines), 2 gated auditors (migration-safety, platform-guard), integration on the delta | 18 of 7 pack-carrying: correctness read 6 (the database helpers, `sqlite-error.ts`, `transaction.ts`, the unchanged `evaluate` and `snapshot`, the `migrateWorkflows` gap, a test's plain-Error mocks), migration-safety 4, platform-guard 3, maintainability 2, performance, conventions and coverage 1 each; three of them read the `migrateWorkflows` body the hunk window cut off; no finder reported the token cap at 1000-line reads; the integration finder read 7 narrow ranges | 15 raised, 15 distinct / 9 fixed (0 by decision, 2 quick), 6 refuted, 0 blocked; 5 of 7 coverage holes filled in one test file, each confirmed red by a toggle, and 2 refuted as not red-green holes. No code defect: three finders checked the narrowed catch for an environmental non-SQLite error and found none that reaches these reads, since missing files are checked first and row parsing is defensive. The backoff-restart hole needed an open board broken on its live handle, because the engine never looks again at a project whose probe once succeeded |
| task 732, whole branch, fifth pass | 466f +50696 -2012, all committed | 3404KB, 59635 lines | 5 (0) | 461 | 1 (a 3223-line replay fixture) | 22: 10 correctness shards (44 `--shard-lines 1500` ranges merged to fit 20 agents, 5.2k to 6.7k lines each), 5 universal finders and 5 gated auditors on the 5616-line since-review pack, then 2 more correctness finders over the ranges 3 shards skipped | about 51 of 19 pack-carrying plus greps, most of them callers, then 13 by the 2 gap finders; no finder reported the token cap at 1000-line reads, but at about 6k lines a shard, shard 1 read only `workflow-service.ts` and part of the UI mock, 2 shards skipped their test sections, 1 read part of a neighbour's range by mistake, and `migration-safety` read only its own sections; the integration finder read 3 files | 19 raised, 19 distinct / 12 fixed (2 by decision, 5 quick), 7 refuted (4 by the ledger), 0 blocked; 3 of 3 coverage holes filled, plus tests for 4 of the pass's fixes; 1 follow-up task (the engine's boot pass opens every registered project's database). The 2 gap finders found 2 of the 19, so a 6k-line range is more than one finder reads in full |
| task 732, whole branch, sixth pass | 469f +51375 -2012, all committed | 3446KB, 60333 lines | 6 (0) | 463 | 1 (the 3223-line replay fixture) | 54: 44 correctness shards at the script's own ranges of about 1500 lines (the 528-line tail folded into the last), started in rolling batches of at most 20 running at once instead of merged to fit one message; 5 universal finders and 5 gated auditors on the 6642-line since-review pack, `session-debugger` gated in by `task-move.ts`, where `handleTaskMove` now lives | about 29 of 53 pack-carrying plus greps, 2 not reported; every shard but 2 listed its pack lines read and each list covered the header and the whole range, the 2 that did not said they read it all; 2 finders had a 1000-line Read refused for size and split it; the integration finder read 1 narrow range | 23 raised, 22 distinct / 13 fixed (4 by decision, 1 quick), 8 refuted (5 by the ledger, 1 by React Flow's own source), 0 blocked; tests for 4 of the pass's fixes; 1 follow-up task (a deleted project leaves its workflows' members and links on other boards). The shards raised 13 of the 23 and read their whole ranges, where the fifth pass's 10 shards of about 6k lines left whole ranges unread: the 20-agent cap limits agents running at once, not a pass's total, so keeping the script's range size and starting shards as slots free up is the shape to keep |
| task 732, whole branch, seventh pass | 471f +51826 -2012, all committed | 3474KB, 60809 lines | 6 (0) | 465 | 1 (the 3223-line replay fixture) | 21: 9 correctness shards (45 `--shard-lines 1500` ranges merged five to a shard, 6.0k to 7.3k lines each, to fit 19 agents in one message), 5 universal finders and 5 gated auditors on the 7514-line since-review pack, `session-debugger` gated in by `task-move.ts`; then 1 gap finder over the 2 files shard 1 left unread, and the driver read the 309-line tail shard 9 left | about 85 of 19 pack-carrying plus greps, most of them callers, rule files and React Flow's own source; 1 finder had a 1000-line Read refused for size and split it; the integration finder read 10 narrow ranges | 21 raised, 20 distinct / 12 fixed (3 by decision, 1 quick), 7 refuted (5 by the ledger, the arrow-key one checked again against React Flow's source), 0 blocked; 2 of 2 coverage holes filled with 3 UI tests, plus 8 unit tests for the pass's fixes; 1 follow-up task (a task whose blocker row is gone waits forever under a Queued label). Merging to 9 shards repeated the fifth pass: shard 1 skipped one of its 5 files and half of another, and shard 9 stopped 309 lines short, so the sixth pass's rolling batches of 1500-line shards stay the shape to use. The 3 code defects came from the session auditor (a Pause pressed during the spawn), the migration auditor (the rename's ASCII-only TRIM and LOWER) and shard 3 (a pane width save that let go early) |
| task 732, whole branch, eighth pass | 472f +52299 -2012, all committed | 3504KB, 61293 lines | 5 (0) | 467 | 1 (the 3223-line replay fixture) | 56: 45 correctness shards at the script's own ranges of about 1500 lines, started in rolling batches of at most 20 running at once, as the sixth and seventh rows recommend and against Step 5's merge rule; 5 universal finders and 5 gated auditors on the 8449-line since-review pack, `session-debugger` gated in by `task-move.ts`; then 1 performance gap finder over the source sections the performance finder skipped | about 24 of 55 pack-carrying plus greps, most of them callers and the production code a test exercises; every shard listed its pack lines, and each list covered the header and its whole range; the performance, HMR, session and migration finders read only their own sections of the since-review pack, and the gap finder covered what the performance finder skipped; 2 finders had a 1000-line Read refused for size and split it; the integration finder read 9 narrow ranges | 14 raised, 14 distinct, plus 1 found in verification / 10 fixed (1 by decision, 4 quick), 5 refuted (2 by the ledger), 0 blocked; 4 of 4 coverage holes filled with 5 tests, plus 2 for the pass's restart fix; 1 follow-up task (Step 5 still merges shards). The shards raised 2 of the 14 and read every range. The one code defect came from shard 8: a restart for read access owed while the agent was mid-turn outlived a Pause and Resume, so the resumed agent, which already had the checkout, was restarted again. One UI spec timed out loading the board while a test-builder ran vitest beside it, and passed alone |
| task 786, pre-PR | 2f +16 -8 after the pass, all uncommitted | 43KB, 127 lines | 1 (1) | 1 | 0 | 5: 1 correctness shard from `--shard-lines 1500` (121 lines), performance, maintainability, conventions, integration on the delta; coverage gated out (skill and docs only), no gated auditor matched | 3 of 4 pack-carrying: correctness read section 14.5 to check the task 732 claims and a `SKILL.md` range for surviving "concurrent" text, conventions read `skill-authoring.md`; performance and maintainability read nothing; the integration finder read one 16-line `SKILL.md` range | 11 raised, 9 distinct, plus 1 found in verification / 9 fixed (2 by decision, 1 quick), 1 refuted, 0 blocked; no coverage holes. The two Medium procedure gaps came from the correctness shard: the finder queue held only shard lines, so Step 6 could start before a non-shard finder returned, and compaction recovery could neither tell a running non-shard finder from a returned one nor launch a reset line with nothing left running. The fix gives every finder a queue line. Every fix landed on an already-dirty path, so the pass committed only its ledger, and the fixes and this row stay uncommitted as mixed authorship |
| task 788, pre-PR | 3f +134 -5, all uncommitted | 33KB, 374 lines | 2 (1) | 1 | 0 | 6: 1 correctness shard, 4 universal finders, integration on the delta; no gated auditor matched | 14 of 5 pack-carrying: 11 by the correctness finder (the two host tabs, the UI mock, `ModelCombobox`, the hook, and greps of the tab ids, the store and the adapter), 2 by performance and 1 by coverage, mostly greps; the integration finder read 1 narrow range | 5 raised, 5 distinct / 3 fixed (1 quick), 2 refuted (Claude's picker probe test lists `haiku` as an alias, and the no-alias list is covered by other specs), 0 blocked; 1 coverage hole filled by running the stored-version case on both hosts, red with the prop removed. Committable was empty, so the ledger went in an empty commit |
| task 784, pre-PR | 39f +562 -96 plus 5 new files, all uncommitted | 151KB, 2668 lines | 13 (7) | 31 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1417 and 1203 lines), 4 gated auditors (ipc-auditor, hmr-parity, platform-guard, migration-safety), integration on the delta | about 46 of 10 pack-carrying plus greps, most of them callers (`cleanupProject`, `deleteWorkflow`, `writeWorkflowColumns`) and the IPC push path; correctness shard 2 read the two new modules' bodies from shard 1's range, since its files call them; performance and coverage read nothing; no finder reported the token cap at 1000-line reads; the integration finder read 7 narrow ranges | 29 raised, 23 distinct / 15 fixed (2 by decision, 1 quick), 8 refuted, 0 blocked; 8 of 8 coverage holes filled, plus tests for 4 of the pass's fixes, each confirmed red by a toggle. Four finders raised the same defect: the task panel said "no longer exists" after any failed workflow read. The first fix shape, returning without writing state on another failure, would have left a first-read failure on Loading forever, so the store now records `gone` or `unreadable` and the panel has a state for each. Every production fix landed on an already-dirty path, so the commit held the shared refusal sentence and two new test files |
| task 787, pre-PR | 17f +423 -107, all uncommitted | 102KB, 1637 lines | 7 (6) | 10 | 0 | 9: 2 correctness shards from `--shard-lines 1500` (1496 and 120 lines), 2 gated auditors (platform-guard, hmr-parity), integration on the delta | 12 of 8 pack-carrying plus greps: correctness shard 1 read 7 (the `quoteArg` body in a `paths.ts` gap, four adapters' quoting call sites, the spawn flow, the probe helper), shard 2 read 3 to check comment claims against `shell-quote.ts` and `cli-print.ts`, performance and platform-guard 1 each; maintainability, conventions and coverage read nothing; hmr-parity answered from 2 greps without loading the pack; the integration finder read 6 files | 19 raised, 14 distinct, plus 1 found while filling holes / 12 fixed (2 by decision, 0 quick), 2 refuted, 0 blocked; 2 of 2 coverage holes filled with 13 tests, each red under one of 5 toggles. Three finders raised Aider's unescaped inner `"` for `/bin/sh`. Inner `'` was rejected under a unix-like outer shell because nushell's single quotes cannot read the `'\''` that `quoteArg` writes, so it is used only for pwsh off Windows. The live cmd and PowerShell round trips ran on the driver's Windows machine. Every fix except the probe helper and one codex test comment landed on an already-dirty path and stayed uncommitted as mixed authorship |
| task 785, pre-PR | 16f +387 -66 plus 3 new files, all uncommitted | 100KB, 1758 lines | 9 (6) | 10 | 0 | 9: 2 correctness shards from `--shard-lines 1500` (1343 and 392 lines), 2 gated auditors (ipc-auditor, hmr-parity), integration on the delta | about 5 of 8 pack-carrying plus greps: correctness shard 1 grepped the two repositories for the `delete` return and the archive filter and read a `workflow-engine-host.ts` gap for `evaluate` and `flush`, conventions read `docs/database.md` for stale prose, and the IPC auditor read `send-to-renderer.ts` for the destroyed-window guard; no finder reported the token cap at 1000-line reads; the integration finder read no body | 14 raised, 14 distinct, plus 1 found in verification / 14 fixed (2 by decision, 3 quick), 1 refuted, 0 blocked; 6 of 6 coverage holes filled with 12 tests, each confirmed red by a toggle. No code defect: both correctness shards came back empty, and the driver's check that Start and Add task commit a task row before its link found no way for a fresh link to read as gone. The one found in verification was `docs/architecture.md`'s module tree, which no finder searched; the conventions finder found the other stale doc only by grepping for the old phrases |
| task 794, pre-PR | 6f +104 -90 plus 2 new files, all uncommitted | 69KB, 1197 lines | 7 (3) | 1 | 0 | 7: 1 correctness shard from `--shard-lines 1500` (1185 lines), performance, maintainability, conventions, coverage, 1 gated auditor (platform-guard, gated in by `path.join` in the new specs), integration on the delta | 1 of 6 pack-carrying plus greps: correctness read `focused-sessions.ts` to check the new panel gate against the focused-set derivation; maintainability grepped the `tests/ui/helpers.ts` exports; performance, conventions, coverage and platform-guard read nothing; no finder reported the token cap at 1000-line reads; the integration finder read 2 narrow ranges | 16 raised, 16 distinct / 10 fixed (1 by decision, 5 quick), 6 refuted, 0 blocked; 4 of 4 coverage holes filled with 4 UI tests, each red under its revert, the snap-restart case on Playwright's paused clock. The one code defect was raised as a Low with no trigger the finder could construct. The driver found one: a collapse driven by a store update flushes its passive effect after a frame can cancel the expand's transition, so the reveal read a stale ref. Every fix landed on an already-dirty path, so the pass committed only its ledger |
| task 791, pre-PR | 21f +571 -107 plus 4 new files, all uncommitted | 145KB, 2281 lines | 12 (7) | 13 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1438 and 814 lines), 4 universal finders, 3 gated auditors (ipc-auditor, hmr-parity, platform-guard), integration on the delta; `migration-safety` left out because the `types.ts` hunks touch no schema interface | about 17 of 9 pack-carrying plus greps: shard 2 read 6 (the shared choice module, `answer-agent.ts`, both tabs' capable-agent filters, the capability hook, the mock's agent list), shard 1 read 3 (the start dedup, `loadAgentList`, and the store section outside its range), hmr-parity 2, maintainability 2, performance, ipc-auditor and platform-guard 1 each, coverage none; hmr-parity's 1000-line Read of pack lines 1001-2000 was refused for size and it fell back to narrower offsets; the integration finder read 2 narrow ranges | 30 raised, 26 distinct, plus 2 found in verification / 20 fixed (4 by decision, 4 quick), 6 refuted, 0 blocked; 7 of 7 coverage holes filled, plus tests for the pass's own fixes, each red under a toggle; 1 follow-up task. The one High code defect came from the maintainability and conventions finders, not a correctness shard: the agent's terminal pasted images by the project's default agent, which this change stopped running. Shard 1 raised the three Medium pane-state holes. Of the two found in verification, one was in the pass's own fix: a chosen agent that is not installed now showed main's reason, but nothing retried it, so the retry on a Settings close was widened to every refusal. Running the unit and UI test-builders side by side cost a red first run: the unit builder's toggle of `workflow-store.ts` for its red-green check landed while the UI builder ran the pane spec |
| task 900, pre-PR | 122f +5027 -762, all committed | 595KB, 10217 lines | 9 (2) | 113 | 0 | 17: 8 correctness shards from `--shard-lines 1500`, 4 universal finders, 4 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger), integration on the delta; all 17 in one message, no queue | about 41 of 16 pack-carrying plus greps, most of them host-side gap reads (`write-queue.ts`, `backpressure-controller.ts`, `pty-host-core.ts` ranges) and the status-file, agent-detector and spawn-flow callers; no finder reported the token cap at 1000-line reads, the HMR auditor read only its renderer sections, and the integration finder read 1 narrow range | 56 raised, 50 distinct, plus 1 found while filling holes / 38 fixed (3 by decision, 6 quick), 13 refuted, 0 blocked; 7 coverage holes filled, plus tests for the pass's fixes, across 13 test files. The 7 test-builders were each held to their own files and barred from `src/`, so red-green was argued or shown with mutants inside the test file, never a source toggle another builder's run could see. The one found while filling holes came from the seal-order builder: the quit path wrote the exit sequence before it sealed the PTY, the reverse of `kill()`. Five finders raised the same stale `SESSION_DATA` example in the ipc-bridge skill, and two raised the draft mirror's lag, which keystroke injection now reads from the host |
| task 790, pre-PR | 6f +477 -40, all committed, no `src/` file | 72KB, 990 lines | 2 (2) | 4 | 0 | 9: 1 correctness shard (980 lines), performance, maintainability, conventions, coverage, 2 gated auditors (ipc-auditor on the UI mock, platform-guard on a `path.join` hunk), integration on the delta. The coverage gate reads a diff with no `src/`, `scripts/` or `packages/` file as test-only, and the finder ran anyway because the UI mock is the web demo's runtime bridge | about 22 of 8 pack-carrying plus greps: correctness read 13 (the renderer components the new selectors hit, the dataset, the mock), ipc-auditor read 4 main-process workflow and agent-list files, platform-guard and coverage used greps only; no finder reported the token cap at 500-line reads; the integration finder read 2 files | 23 raised, 21 distinct, plus 1 found while filling holes / 19 fixed (2 by decision, 2 quick), 3 refuted, 0 blocked; 5 of 5 coverage holes filled, plus tests for 3 of the pass's fixes, 36 unit tests in one new file, each confirmed red by a toggle. All 5 holes came from the lane the gate would have skipped, and so did the defect found while filling them: rows the mock's Start and Add task created on another board carried no project tag, so every later read put them on the home board. The ipc-auditor found the other mock defects, against main's own read model. The driver also ran the demo smoke spec and the workflow UI specs before and after the fixes, which proved the new selectors where the correctness finder had only read them |
| task 795, pre-PR | 54f +1276 -235 plus 5 new files, all uncommitted | 247KB, 3925 lines | 9 (5) | 50 | 0 | 12: 3 correctness shards from `--shard-lines 1500` (1286, 1487 and 1089 lines), 4 universal finders, 4 gated auditors (ipc-auditor, platform-guard, session-debugger, migration-safety), integration on the delta | about 18 of 11 pack-carrying plus greps: shard 1 read 4 (`workflow-agent.ts` gaps, the `agent-session-id` emitter and its other listener, all of `session-id-manager.ts`), session-debugger 4, shard 3 read 3 (each adapter's MCP wiring, to check its `kangenticMcp` declaration), migration-safety 3, platform-guard 2, maintainability and ipc-auditor 1 each; shard 2, performance, conventions and coverage grepped only; the ipc-auditor's 1000-line Read of pack lines 2001-3000 was refused for size and it split it; the integration finder read 4 narrow ranges | 37 raised, 31 distinct, plus 1 to the follow-up task / 26 fixed (4 by decision, 4 quick), 5 refuted, 0 blocked; 10 of 10 coverage holes filled, plus tests for the pass's own fixes, the start-over, setting, spend and access cases shown red on the pre-pass code in a scratch worktree and the rest argued from the code, since the builders ran side by side and were told not to toggle source. Shard 1, session-debugger and migration-safety each found the same race (the start's null write over a reported id); session-debugger alone found that a failed start-over lost the saved-plan continuation; the conventions finder and shard 2 both found that an unparseable `.cursor/mcp.json` was overwritten. The access-restart fix reddened 12 existing tests whose fixtures ran an agent with no recorded id, a state a real start never leaves; the fixtures now record one |
| task 799, pre-PR | 12f +190 -31, all uncommitted | 70KB, 1057 lines | 9 (9) | 3 | 0 | 8: 1 correctness shard (1041 lines), performance, maintainability, conventions, coverage, 2 gated auditors (migration-safety on the repository, platform-guard on `prompt-xml.ts`), integration on the delta | about 14 of 7 pack-carrying, most of them greps and the plan-exit writer in `sessions.ts`, which correctness, conventions and migration-safety each read to test the change's premise; no finder reported the token cap at 1000-line reads; the integration finder read no body | 7 raised, 7 distinct / 3 fixed (2 quick), 4 refuted (1 by measurement), 0 blocked; 1 of 2 coverage holes filled with 11 unit tests in one new file, the tie-break confirmed red by a toggle |
| task 798, pre-PR | 54f +1638 -900 plus 3 new files, all uncommitted | 268KB, 4711 lines | 11 (7) | 46 | 0 | 13: 4 correctness shards from `--shard-lines 1500` (1422, 1492, 1490 and 246 lines), 4 universal finders, 4 gated auditors (ipc-auditor, platform-guard, session-debugger, migration-safety), integration on the delta | about 24 of 12 pack-carrying plus greps: shard 1 read 6 (the preparation gaps in both startup files, `prepare-spawn.ts`, `spawn()` and `doSpawn`, `adapter-lifecycle.ts`, the holds class from another range), shard 3 read 5 (the `doSpawn` and `kill()` gaps, the spawn flow's throw sites, `spawn-failure-handler.ts`, the parity test's helpers), shard 4 and session-debugger 4 each, conventions and coverage 2 each, migration-safety 1; shard 2, performance, maintainability, platform-guard and ipc-auditor read nothing or grepped only; no finder reported the token cap at 1000-line reads; the integration finder read 6 files | 27 raised, 17 distinct / 15 fixed (2 by decision, 0 quick), 2 refuted, 0 blocked; 4 of 4 coverage holes filled, plus tests for the pass's own fixes, 15 from two test-builders each confirmed red by a toggle; 1 follow-up task. The one Medium code defect came from session-debugger alone: a spawn that throws after its PTY row is registered (a throwing `session-changed` listener, an adapter's `attachSession`) had its hold released under the running agent. Shard 3 read the same catch and cleared it, because it counted only explicit `throw` statements after `registry.set`. Shards 1 and 4 and session-debugger each found a hold leaked at shutdown, and three finders raised the Windows case fold. The fix moved every release after `spawn()` into SessionManager, which turned one existing test that mocked a rejecting spawn into a `buildEnv` test. Two pre-existing deferred-kill tests fail on Windows only, shown by the host's win32 `releaseExitedPty` rather than by a revert. Every production fix landed on an already-dirty path, so the commit held two out-of-diff files and the ledger |
| task 801, pre-PR | 1f +25 -5, all committed, one test file | 11KB, 227 lines | 1 (1) | 0 | 0 | 4: 1 correctness shard from `--shard-lines 1500` (222 lines), performance, maintainability, conventions; integration gated off at 1 changed file, coverage self-skipped on a test-only diff, no gated auditor matched | 7 of 4 pack-carrying: correctness read 6 (the deferred-kill registry, `safeKillPty`, `kill()`, `RemotePty.kill`, `releaseExitedPty`, the test's mock prelude) to check each changed assertion would still fail on a regression, maintainability read 1 (the test file's gaps, for other `mockPty.kill` assertions after a natural exit); performance and conventions read nothing | 4 raised, 4 distinct / 4 fixed (1 by decision, 2 quick), 0 refuted, 0 blocked; no coverage holes. No code defect: correctness confirmed the spy sits on the object the registry kills, and the whole file passed on Windows, where the task 798 row saw its two deferred-kill tests fail. The four Lows were comment prose: two colons joining clauses, and the reason for spying on the handle written in two tests and missing from the third, now kept once in the helper |
| task 800, pre-PR | 41f +1700 -69 plus 1 new file, all uncommitted | 233KB, 3814 lines | 8 (5) | 34 | 0 | 12: 3 correctness shards from `--shard-lines 1500` (1239, 1473 and 1056 lines), 4 universal finders, 4 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger; migration-safety did not run on an `ElectronAPI`-only `types.ts` hunk), integration on the delta | about 22 of 11 pack-carrying plus greps, 1 not reported: hmr-parity 5 (one a re-read of the in-pack `useLeftoverRecheck.ts`), shard 1 read 4 (`dev.js`, `session-manager.ts`, `protocol.ts`, `host-process-table.ts`), shard 3, performance, conventions, platform-guard and session-debugger 2 each, shard 2, maintainability and ipc-auditor 1 each, coverage did not report; finders read at 500 lines because the driver's own 840-line read of the pack's dense tail was refused for size; the integration finder read 4 narrow ranges | 40 raised, 36 distinct, plus 1 found in verification / 31 fixed (3 by decision, 7 quick), 6 refuted, 0 blocked; 12 of 12 coverage holes filled across 6 test-builder batches, each shown red by a toggle of its production line. Performance and session-debugger both found the Windows recheck taking a snapshot per process that will not open; platform-guard and session-debugger both found exit code 259 reading as running |
| task 804, pre-PR | 8f +143 -128, all uncommitted | 80KB, 1341 lines | 6 (5) | 2 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (1329 lines), performance, maintainability, conventions, coverage, integration on the delta; no gated auditor matched | 4 of 5 pack-carrying plus greps, 2 not reported: correctness read 3 (the folds in `bucketing.ts`, the service's gaps, the schema's nullability), performance 1 (the index definitions), coverage grepped only, maintainability and conventions sent no reads line; no finder reported the token cap at 1000-line reads; the integration finder read 3 narrow ranges | 8 raised, 7 distinct / 6 fixed (1 by decision, 3 quick), 1 refuted, 0 blocked; 1 of 2 coverage holes filled with 1 unit test, confirmed red by a toggle, the other refuted because the equivalence test seeds a null model. No code defect: every reader of the merged rows sums them, so splitting a bucket by model changed no total. The one decision moved the by-model fold into `bucketing.ts`, because the equivalence test pinned a hand copy of the service's mapping. Every fix except the new fold and its test landed on an already-dirty path |
| task 808, pre-PR | 39f +1530 -316 plus 8 new files, all uncommitted | 307KB, 4734 lines | 10 (4) | 37 | 0 | 11: 4 correctness shards from `--shard-lines 1500` (1271, 1424, 1451 and 537 lines), 4 universal finders, 2 gated auditors (ipc-auditor, platform-guard; migration-safety did not run on an `ElectronAPI`-only `types.ts` hunk, and hmr-parity had no store, util or `DndContext` change), integration on the delta | about 35 of 10 pack-carrying, most of them greps, callers and rule files, 1 not reported: shard 2 11 (one a re-read of the in-pack `merge-mac-update-feeds.js`), shard 4 6, conventions and platform-guard 5 each, shard 1 and ipc-auditor 4 each, performance, maintainability and coverage none, shard 3 did not report; the integration finder read 2 narrow ranges | 21 raised, 20 distinct / 16 fixed (2 by decision, 5 quick), 4 refuted, 0 blocked; 7 of 8 coverage holes filled across 3 test-builder batches, each shown red by a toggle of its production line, the eighth refuted as unreachable, plus a test for the pass's own `search.ts` gate. Shard 1's dropped-`blockMapSize` finding was refuted against a published `latest-mac.yml` |
| task 809, pre-PR | 14f +449 -139 plus 1 new file, all uncommitted | 129KB, 2118 lines | 8 (6) | 7 | 0 | 9: 2 correctness shards from `--shard-lines 1500` (1359 and 740 lines), 4 universal finders (performance, maintainability, conventions, coverage), 2 gated auditors (ipc-auditor, migration-safety; hmr-parity had no store, util or `DndContext` change), integration on the delta | about 15 of 8 pack-carrying, most of them greps and the summary SQL outside the pack's windows: ipc-auditor 5, migration-safety 4, shard 2 3, shard 1 2, performance 1, maintainability, conventions and coverage none; the integration finder read 3 narrow ranges | 11 raised, 9 distinct / 7 fixed (3 quick), 2 refuted, 0 blocked; 3 coverage holes filled plus a test for the pass's own `modelFallbackOf` tie-break, each shown red by a toggle of its production line. The brief for both SQL tie-break tests inserted the winning row first, which stays green without `id DESC`; test-builder caught it on the toggle and flipped the order. Every path was dirty before the pass, so it committed only its ledger |
| task 811, pre-PR | 7f +264 -20, all uncommitted | 38KB, 693 lines | 5 (5) | 2 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (682 lines), 4 universal finders, 2 gated auditors (hmr-parity, platform-guard), integration on the delta | 3 of 7 pack-carrying, 1 not reported: correctness 1 (the `@xterm/headless` bundle, grep only, for the internal member shapes and the reflow gate), maintainability 1 (`inspection-server.ts`, for a leftover viewport loop), hmr-parity 1 (`hmr-patterns.md`); performance, conventions and platform-guard none, coverage sent no reads line; the integration finder read 2 files | 9 raised, 9 distinct, plus 1 found in verification / 7 fixed (1 by decision, 3 quick), 3 refuted, 0 blocked; 4 of 4 coverage holes filled across 2 test-builder batches. No code defect. Correctness checked every xterm internal the alt-line trim calls against the installed bundle. The driver cut the second batch's AST scanner from about 280 lines to about 80 and re-ran one site red; the other two sites went red against the longer scanner, which used the same end-column check. Every fix landed on an already-dirty path, so the pass committed only its ledger |
| task 813, pre-PR | 7f +154 -20 plus 4 new files, all uncommitted | 48KB, 951 lines | 8 (3) | 3 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (936 lines), 4 universal finders, 2 gated auditors (platform-guard, session-debugger), integration on the delta | about 8 of 7 pack-carrying plus greps, 1 not reported: session-debugger 4 (the echo judge, settle, reveal and unmount ranges of `useTerminal.ts`, `parked-terminals.ts`, `getTerminalDimensions`, the host client's raw read), correctness 2 (`getTerminalDimensions`, the echo flow in `useTerminal.ts`), performance 1 (the bounded tail in `composed-width.ts`), platform-guard 1 (its rule file), conventions and coverage grepped only, maintainability sent no reads line; the integration finder read 10 narrow ranges | 11 raised, 11 distinct, plus 1 found in verification / 10 fixed (1 by decision, 2 quick), 2 refuted, 0 blocked; 5 of 5 coverage holes filled across 3 test-builder batches, plus a UI test for the pass's own fix from a fourth, each shown red by a toggle of its production line except the sampler's null-source guard, whose removal the sampler's own catch hides. The one code defect came from session-debugger alone: a terminal parked inside the 150 ms re-assert debounce owed no recheck, so the reveal never healed it. Correctness read the same flow and did not raise it. The trace listener hole needed an esbuild bundle with the dev flag on, because vitest pins it off. The helper, the route and four test files committed; the rest landed on already-dirty paths |
| task 812, pre-PR | 47f +1616 -294 plus 5 new files, all uncommitted | 300KB, 4791 lines | 7 (4) | 45 | 0 | 13: 4 correctness shards from `--shard-lines 1500` (1090, 1395, 1456 and 794 lines), 4 universal finders, 4 gated auditors (ipc-auditor, platform-guard, session-debugger, migration-safety; hmr-parity had no store, util or `DndContext` change), integration on the delta | about 15 of 12 pack-carrying plus greps, 1 not reported: migration-safety 4, shard 4 3 (one a re-read of the in-pack `final-reply-reader.ts`), session-debugger 3, shard 3 2 plus a re-read of the in-pack `final-line-match.ts`, shard 2 2, ipc-auditor greps only, performance, maintainability, conventions, coverage and platform-guard none, shard 1 sent no reads line; ipc-auditor hit the Read tool's 25k-token cap on a 1000-line call and fell back to 500-line windows; the integration finder read 5 narrow ranges | 34 raised, 26 distinct plus 1 follow-up / 20 fixed (3 by decision, 3 quick), 6 refuted, 0 blocked; 3 of 4 coverage holes filled in 1 test-builder batch, each shown red by a toggle of its production line, the fourth refuted as unreachable, plus tests for the pass's own fixes in the already-dirty test files. The backtracking wildcard RegExp came from 4 finders (shard 2, performance, conventions, platform-guard); the invisible-character gap from shard 2 alone; the eval build dropping Text match runs from ipc-auditor alone, though it is no IPC defect. The Edit tool decoded `\u` escapes in a test edit into literal zero-width characters, which only a scoped lint caught. Three new tests and one skill line committed; the rest landed on already-dirty paths |
| task 814, pre-PR | 46f +1613 -514 plus 15 new files, all uncommitted | 361KB, 6212 lines | 16 (2) | 45 | 0 | 15: 5 correctness shards from `--shard-lines 1500` (1309, 1303, 1445, 1478 and 612 lines), 4 universal finders, 5 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger, migration-safety), integration on the delta | about 43 of 14 pack-carrying, most of them greps and callers: session-debugger 8 (one a gap of the in-pack `transition-engine.ts`), platform-guard 6 (`quoteArg`, `shim-launch.ts`, `shell-quote.ts`, the command builder), shard 5 4 (one a re-read of the in-pack `session-transcript-path.ts`), shards 1, 3 and 4, performance, maintainability, conventions and ipc-auditor 3 each, shard 2 and migration-safety 2 each, coverage and hmr-parity none; no finder reported the token cap at 1000-line reads; the integration finder grepped only | 53 raised, 47 distinct, plus 3 found while filling holes / 39 fixed (6 by decision, 7 quick), 9 refuted, 0 blocked; 12 of 12 coverage holes filled across 6 test-builder batches with 20 new unit files, each shown red by a toggle of its production line, and the E2E spec hardened; 1 follow-up task with 3 items. Shard 2, session-debugger and platform-guard each raised the recap's command-line budget from a different side (an isolated column's prompt on top, `%` quoting). Session-debugger alone found that the recap's summary turn ran the column's turn-end rows. Of the three found while filling holes, a test-builder found the cross-agent handoff typing the column's message into a recap-only session, another found the pass's own `%` measure missing the backslash run cmd quoting doubles, and the E2E builder found the spec matching the previous run's carried-over scrollback. Every production fix but the recap-turn module and the shared ENOENT helper landed on an already-dirty path |
| task 814, second pass | 90f +9448 -546, all committed | 656KB, 11815 lines | 11 (0) | 79 | 0 | 19: 9 correctness shards from `--shard-lines 1500` (1486, 1222, 1216, 1233, 1411, 1412, 1394, 1445 and 902 lines), 4 universal finders, 5 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger, migration-safety), integration on the delta; the since-review pack equalled the full pack, because both earlier review commits sat on the merge base and the task's own work landed after them | about 54 of 18 pack-carrying, most of them source files outside the pack's hunk windows and greps: session-debugger 12, platform-guard 7, shard 4 6, shards 3 and 6 5 each, shard 2 4, shard 9 3, shards 1, 5 and 7, maintainability and conventions 2 each, performance and ipc-auditor 1 each, shard 8, coverage, hmr-parity and migration-safety grepped only; ipc-auditor and session-debugger hit the token cap on 1000-line reads past line 10000 and re-read in 500-line chunks; hmr-parity and migration-safety read only their sections, and performance skipped the test sections; the integration finder grepped only | 36 raised, 35 distinct, plus 1 found while filling holes / 27 fixed (5 by decision, 6 quick), 8 refuted (4 by the ledger), 0 blocked; 7 of 7 coverage holes filled across 6 test-builder batches with about 100 new tests and 1 new unit file, each shown red by a mutation of its production line; 1 follow-up task with 2 items. Session-debugger alone found two defects: a mid-turn watchdog idle ended the recap turn early, because the engine re-stamps a turn's start on idle to thinking, and a legacy Start agent row let the column's messages reach a recap-only session. Shard 6 alone found an isolated column's message lost when its expired conversation started fresh with the task template. A test-builder found the task's own command dropped on any fresh spawn the message could not ride, which predates the branch |
| task 814, third pass | 91f +11635 -572, all committed | 783KB, 14111 lines | 8 (0) | 83 | 0 | 20: 11 correctness shards from `--shard-lines 1500` (1437, 1058, 1491, 1380, 1295, 1495, 1330, 1409, 1453, 1494 and 174 lines) on the full pack, 4 universal finders and 4 gated auditors (ipc-auditor, platform-guard, session-debugger, migration-safety) on the since-review pack (244KB, 4215 lines, 34 files), integration on the delta; hmr-parity gated off because no renderer file changed since the last pass, and migration-safety ran on a comment-only `types.ts` hunk | about 42 of 19 pack-carrying, most of them production code the test-only shards checked against, plus greps: shard 6 and ipc-auditor 6 each, shard 2 5, migration-safety 4, shards 7 and 8 and session-debugger 3 each, shards 4, 9, 10 and 11 2 each, shards 1 and 5, coverage and platform-guard 1 each, shard 3, performance, maintainability and conventions grepped only or read nothing; maintainability and platform-guard read only parts of the since-review pack; no finder reported the token cap at 1000-line reads; the integration finder read 2 narrow ranges | 13 raised, 13 distinct / 10 fixed (3 by decision, 2 quick), 3 refuted, 0 blocked; 4 of 4 coverage holes filled across 2 test-builder batches with about 22 new tests in 6 existing files, plus tests for the pass's own two recap fixes, each shown red by a mutation of its production line. Shard 7 alone found the one Medium code defect: the previous pass stripped control characters from the recap's summary and tail, but not from the git lines, the PR URL, or the task title and description. Of the five shards that held only tests, only shard 2 raised anything, two test-precision Lows. No finder re-raised a ledger line |
| task 814, fourth pass | 91f +12033 -572, all committed | 808KB, 14509 lines | 7 (0) | 84 | 0 | 20: 12 correctness shards from `--shard-lines 1500` (820, 1281, 1070, 1495, 1301, 1285, 1450, 1171, 1411, 1461, 1494 and 175 lines) on the full pack, 4 universal finders and 3 gated auditors (ipc-auditor, platform-guard, session-debugger) on the since-review pack (289KB, 4975 lines, 34 files), integration on the delta; hmr-parity gated off because no renderer file changed since the last pass began, and migration-safety off because the since-review `types.ts` hunk is a doc comment | about 36 of 19 pack-carrying, most of them production code the test-only shards checked against, plus greps: ipc-auditor 11 (7 ranges of the push channel's layers, 4 greps), shard 8 4, shards 2, 4, 10 and session-debugger 3 each, shards 9 and 11 2 each, shards 1, 3 and 12, coverage and platform-guard 1 each, shards 5, 6 and 7, performance, maintainability and conventions none; the ipc-auditor's 975-line Read of the since-review pack's tail was refused for size and it split it; the integration finder read 1 narrow range | 8 raised, 9 recorded (one session-debugger finding split into its two cases) / 5 fixed (2 by decision, 2 quick), 4 refuted (1 by the ledger), 0 blocked; 5 unit tests for the pass's own fix. The two delivery cases went red with the fallback's delivery line deleted, a recap-only case with the recap-only return deleted, and a driver mutation of the restore's condition reddened a row case; the withhold and no-double-send cases pin the contract with no red run. The one code defect came from session-debugger alone: the previous pass restored a task's own command for delivery after a spawn that did not carry it, but a column with no message row never delivered it, a gap that predates the branch for a plain fresh spawn. The 12 correctness shards raised nothing, 6 of them holding only tests |
| task 815, pre-PR | 212f +5417 -4805, all committed | 996KB, 18031 lines | 7 (3) | 205 | 0 | 20: 13 correctness shards from `--shard-lines 1500` on the full pack, 4 universal finders (performance, maintainability, conventions, coverage) and 2 gated auditors (hmr-parity on `utils/`, session-debugger on `TerminalPanel.tsx`) told to read the full pack, integration on the delta; ipc-auditor, platform-guard and migration-safety gated off | about 70 of 19 pack-carrying, most of them the shards' reads of `Tooltip.tsx` for its contract plus greps: shard 13 about 12, shard 12 9, shard 8 6, shards 3 and 9 5 each, conventions about 5, shards 10 and 11 4 each, shards 1 and 6 3 each, shards 2, 4, 5 and 7, performance and hmr-parity 2 each, maintainability and coverage 1 each, session-debugger none. Only the conventions finder read the whole pack (two 1000-line Reads hit the token cap and it re-read them in halves); performance, maintainability, coverage, hmr-parity and session-debugger read their own sections and grepped the rest; the integration finder read no body | 20 raised, 19 distinct, plus 1 found in verification / 16 fixed (4 by decision, 6 quick), 4 refuted, 0 blocked; 5 coverage holes filled plus a test for the High, in 2 test-builder batches (a new `tab-focus.test.ts` with 10 tests, about 15 cases in `tooltip.test.ts`, 5 UI cases), each shown red by a mutation. The one High came from shard 8 and the conventions finder independently: a mechanical title-to-tip rewrite cut the opening words off all four Monitor summary tile tips. A driver scan of removed titles against added Tooltips per pack section confirmed it was the only truncation and the TerminalPanel spacer the only dropped tip |
| task 819, pre-PR | 35f +88 -72 with one rename, all uncommitted | 104KB, 1748 lines | 8 (6) | 26 | 0 | 8: 2 correctness shards from `--shard-lines 1500` (1495 and 214 lines), 4 universal finders (performance, maintainability, conventions, coverage), 1 gated auditor (platform-guard, on the `path.join` and `spawnSync` hunk in `build-demo.js`), integration on the delta | 0 of 7 pack-carrying, greps only: every finder grepped the repo for the old `vitest.config.ts` and `ubuntu-latest` names; no finder reported the token cap at 1000-line reads; the integration finder read no body | 8 raised, 6 distinct plus 1 sub-claim split out / 6 fixed (2 by decision, 2 quick), 1 refuted, 0 blocked; 3 of 3 coverage holes filled in 1 test-builder batch with 2 new unit files (38 tests), each shown red on an in-memory copy of a real workflow or a cut-down copy of the real script, never by editing the dirty file. No code defect: both shards, performance, integration and platform-guard raised nothing. Conventions and maintainability flagged the same uneven `build-demo.js` comment, and the claim that the pin triggers Vite's warning was refuted against Vite 8's default loader. Every comment fix landed on an already-dirty path, so only the two tests and this row committed |
| task 821, pre-PR | 10f +610 -33 with one new file, all uncommitted, tests and docs only | 111KB, 1293 lines | 5 (4) | 5 | 0 | 7: 1 correctness shard from `--shard-lines 1500` (1279 lines), 3 universal finders (performance, maintainability, conventions), 2 gated auditors (ipc-auditor on `mock-electron-api.js`, platform-guard on a `path.join` hunk), integration on the delta; coverage self-skipped because nothing under `src/`, `scripts/` or `packages/` changed | about 35 of 6 pack-carrying, plus greps: the correctness shard about 25, the renderer and main files behind ten driver-seeded checks (timestamp coverage, route and outcome counts, testids, the import chain), ipc-auditor 7 (greps and 2 ranges of main's handlers), conventions 3 greps, maintainability 2, performance and platform-guard 1 each; no finder reported the token cap at 1000-line reads; the integration finder grepped only | 17 raised, 16 distinct / 13 fixed (1 by decision, 0 quick), 3 refuted, 0 blocked; the driver added 5 test cases in 2 existing files (one shown red by restoring the old hydrate order). No scene-breaking defect: the shard answered all ten seeded checks clean, the driver ran the 4 touched scenes in the `demo` tier before and after the fixes, and a throwaway tests-inclusive typecheck (`tests/` is outside `tsconfig.json`) found only pre-existing drift, filed as a follow-up. The one Medium came from conventions alone: the rule's list of authored parts left out two the README named. Every fix landed on an already-dirty path, so the pass committed its ledger and this row |
| task 820, pre-PR | 1f +14 -5, all committed | 5KB, 79 lines | 1 (1) | 0 | 0 | 4: 1 correctness shard from `--shard-lines 1500` (74 lines), 3 universal finders (performance, maintainability, conventions); integration gated off on a one-file diff, coverage on a test-only diff, and every auditor by its globs | 0 of 4 pack-carrying. The correctness shard and maintainability grepped only, and the shard's grep of `playwright-core/lib` for `chromewebdata` matched nothing, so the driver confirmed the `interrupted by another navigation to "<url>"` message shape in `coreBundle.js` | 4 raised, 2 distinct, plus 1 found in verification / 2 fixed (2 quick), 1 refuted, 0 blocked; no tests added. Correctness, maintainability and conventions all raised the JSDoc that a new const had pulled off `gotoVite`. Conventions called the rewritten JSDoc's prose clean, but verification found two colons joining clauses in it. The `readonly` nit on the marker array was refuted |
| task 822, pre-PR | 10f +133 -20 plus 2 new files, all uncommitted | 74KB, 976 lines | 4 (2) | 8 | 0 | 9: 1 correctness shard from `--shard-lines 1500` (960 lines), 4 universal finders (performance, maintainability, conventions, coverage), 3 gated auditors (ipc-auditor on `handlers/task-move.ts`, platform-guard on `agent/mcp-http/task-tools.ts`, session-debugger on `handleTaskMove`), integration on the delta; hmr-parity and migration-safety gated off | about 31 of 8 pack-carrying, plus greps: ipc-auditor about 10 ranges, the correctness shard 9, session-debugger, maintainability and performance 3 each, conventions 2, platform-guard 1, coverage none; the integration finder read 6 narrow ranges. Every finder was told to read the pack in two 500-line calls, because the driver's own 1000-line call passed the token cap | 22 raised, 19 distinct (1 filed as a follow-up), plus 1 found in verification / 16 fixed (4 by decision, 6 quick), 3 refuted, 0 blocked; 7 coverage holes filled in 1 test-builder batch (12 new tests in 2 existing files) plus 1 driver-written test, each shown red by a temporary production edit. The one race came from session-debugger and the correctness shard independently: a push the killed session recorded while the To Do move held the lock wrote `pushed_branch` back after the clear. Verification found the push's stated reason wrong, since the renderer re-fetches the task list after its own move. Every code fix landed on an already-dirty path, so only `docs/architecture.md` and this row committed |
| task 824, pre-PR | 16f +80 -29 plus 1 new file, all uncommitted, no `src/` file | 33KB, 487 lines | 4 (3) | 13 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (466 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched. Coverage ran although nothing under `src/`, `scripts/` or `packages/` changed, because `demo/boot.js` and the CI wiring are behavior. The since-review pack equalled the full pack, because the earlier review commit carried only a ledger | about 13 of 5 pack-carrying, plus greps: the correctness shard 5 (`boot.js`, `scene-page.ts`, `tsconfig.json`, and greps of `scenes.ts` and `.gitignore`), coverage 4 plus greps, conventions 2, performance and maintainability 1 each; no finder reported the token cap at a 1000-line read; the integration finder read 1 narrow range | 14 raised, 13 recorded / 8 fixed (1 by decision, 3 quick), 5 refuted (1 by a timing, 1 by a typecheck probe), 0 blocked; 1 coverage hole filled with a new unit file of 18 tests, each revert shown red on an in-memory copy of the real file, plus 3 demo-tier tests for the pass's own `boot.js` fix, shown red by removing it and rebuilding. Only coverage raised the Medium hole: nothing pinned the new demo typecheck program, its scripts or its CI step. The one code defect came from the correctness shard: routing the rig's mouse press through `boot.js` turned a chord or a misspelled button from a Playwright error into a keydown nothing hears. The driver ran `static-demo.spec.ts` (139 tests, 5.7 min) after that fix. The fixes in the task's own files stayed uncommitted, so the two tests, two out-of-diff comment files and this row committed |
| task 823, pre-PR | 13f +521 -54, all uncommitted | 141KB, 2468 lines | 5 (4) | 8 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1347 and 1104 lines, the first holding only `resource-cleanup.test.ts`), 4 universal finders (performance, maintainability, conventions, coverage), 3 gated auditors (ipc-auditor on `handlers/`, platform-guard on a `path.join` context line in a `resource-cleanup.ts` hunk, session-debugger on `handleTaskMove`), integration on the delta; hmr-parity and migration-safety gated off | about 19 of 9 pack-carrying, plus greps: shard 2 and session-debugger 4 each, shard 1, performance, conventions, coverage and ipc-auditor 2 each, maintainability 1 (the column list a gap in `pr-link-reset.ts` hid), platform-guard none; no finder reported the token cap at 1000-line reads; the integration finder read 4 narrow ranges | 5 raised, 6 recorded (session-debugger's finding split into the new restore branch and the pre-existing reset branch, the second filed as a follow-up and then folded into the pass at the user's request) / 6 fixed (2 by decision, 1 quick), 0 refuted, 0 blocked; 2 of 2 coverage holes filled plus tests for the pass's two sweep fixes, across 3 test-builder batches (7 new tests in 2 existing files); the commit-time throw test was shown red by a toggle of its production line, the rest by reasoning. Session-debugger alone found the stale-snapshot race: shard 2 read the same branch and judged a To Do task's session unable to be live, missing a drag out while the unawaited sweep runs. Wrapping the sweep in the task lock moved its row read ahead of `currentVisit`, which left one test's queued answer unconsumed and leaked it into the next test; the third test-builder caught it and reset the mock per test. Only `pr-identity.ts`, the `docs/database.md` line and this row committed |
| task 828, pre-PR | 3f +72 -12 plus 1 new file, all uncommitted, no `src/` file | 35KB, 558 lines | 4 (3) | 0 | 0 | 5: 1 correctness shard from `--shard-lines 1500` (550 lines), 3 universal finders (performance, maintainability, conventions), integration on the delta; coverage skipped itself because nothing under `src/`, `scripts/` or `packages/` changed, and no gated auditor matched | 5 of 4 pack-carrying, all from the correctness shard (`final-line-match.ts`, `automation-runner.ts`, `automation-run-repository.ts`, `review-verdict.mjs`, `automation-run-frequency-boundary.test.ts`); maintainability and conventions grepped only, performance read nothing; the integration finder read 1 range of `review-verdict.mjs` | 13 raised, 13 recorded / 9 fixed (1 by decision, 4 quick), 4 refuted, 0 blocked; no tests added, since the pass tightened the branch's own new test. Only the correctness shard saw that the new skill pins matched the outcome token anywhere in the file, so the intro's copy passed with the printing step deleted. A probe showed each step-scoped pin finds its token once, against 2 to 5 copies file-wide. Maintainability's failure-message finding came in Medium and was recorded Low. The fixes in the task's own files stayed uncommitted, so only the out-of-diff merge-back reminder and this row committed |
| task 827, pre-PR | 38f +571 -107 plus 10 new files, all uncommitted | 282KB, 5114 lines | 13 (1) | 35 | 0 | 14: 4 correctness shards from `--shard-lines 1500` (1438, 1428, 1454 and 742 lines, the first two holding only tests), 4 universal finders (performance, maintainability, conventions, coverage), 5 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger, migration-safety), integration on the delta; one wave, no queue | about 36 of 13 pack-carrying, plus greps: ipc-auditor about 6 ranges, session-debugger 5, shards 1, 2 and 4 four each, conventions 5 (two rule files), coverage 2, performance, maintainability, migration-safety and hmr-parity 1 each, shard 3 and platform-guard none. Platform-guard read pack lines 1-1000 and searched the rest, and maintainability skimmed most of the new tests; the integration finder read 2 narrow ranges | 23 raised, 23 recorded / 12 fixed (3 by decision, 2 quick), 9 refuted, 0 blocked, and 2 pre-existing gaps filed as one follow-up; 10 test cases in 5 unit files and 1 UI spec across 2 test-builder batches, each shown red by toggling its production line. The one user-visible defect came from ipc-auditor alone: a monitor-row toggle on the open project left the board card stale, and verification found the monitor's move, archive and delete share the gap. Session-debugger alone found the warm-move race that logged a typed message as skipped. The perf Medium (uncached re-reads of the switch) was refuted as unmeasured beside the move's worktree and PTY work. Only `docs/architecture.md`, the runner's exported constant, two tests and this row committed |
| task 829, pre-PR | 39f +635 -152 plus 8 new files, all uncommitted | 190KB, 3343 lines | 17 (8) | 30 | 0 | 12: 3 correctness shards from `--shard-lines 1500` (1309, 1493 and 490 lines), 4 universal finders (performance, maintainability, conventions, coverage), 4 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger), integration on the delta; migration-safety not run, since its `types.ts` glob matched only `ElectronAPI` hunks; one wave, no queue | about 24 of 11 pack-carrying, plus greps: session-debugger 8, ipc-auditor 4, shard 2 four, shard 3 three (one of them `other-window-task-writes.ts`, whose full body was in the pack), shard 1 and maintainability 2 each, hmr-parity 1 (the rule file), performance, conventions, coverage and platform-guard none. ipc-auditor hit the Read token cap on the 2001-3000 window and fell back to 500-line chunks | 25 raised, 23 recorded / 15 fixed (2 by decision, 1 quick), 8 refuted, 0 blocked, no follow-up; 59 unit cases in 6 new files, 9 UI cases in 1 new spec, the hidden-arrival spec moved from a fixed delay to a replay gate, across 3 test-builder batches, each red shown on a mutant copy or a dev-server response rewrite. The user-visible defect (a cross-window announce that only ran on success, so a write that committed and then threw left the main board stale) came from four finders at once: shards 2 and 3, ipc-auditor and session-debugger. A failed archive with no message to the user came from a test-builder run, not a finder. Only the new helper, the new tests and this row committed |
| task 830, pre-PR | 7f +1121 -181, all uncommitted | 130KB, 2287 lines | 5 (5) | 2 | 0 | 8: 2 correctness shards from `--shard-lines 1500` (1324 and 952 lines, the first holding only the two UI specs), 4 universal finders (performance, maintainability, conventions, coverage), 1 gated auditor (hmr-parity, gated by a comment-only edit to `utils/diff-scroll-memory.ts`), integration on the delta; one wave, no queue | 4 of 7 pack-carrying, plus greps: shard 2 three (a `DiffViewer.tsx` gap, monaco's `diffEditorViewModel.js` and `diffEditorWidget.js`), performance 1 (`diffEditorViewModel.js`), conventions, coverage and hmr-parity greps only, shard 1 and maintainability none; the integration finder grepped only | 15 raised, 16 recorded with 1 found in verification / 11 fixed (2 by decision, 4 quick), 5 refuted, 0 blocked; 3 UI tests in 1 test-builder batch, each shown red by removing its production line. The defect came from verification, not a finder: a switch between two files with identical text never detached, so the side-by-side latch the removed rearm effect used to reset stayed set. The perf Medium (a lost 200ms debounce) was refuted by the diff watcher's own 500ms debounce. A guard coverage hole was refuted by measurement, its test staying green with the guard commented out. test-builder's first route for the mount-time test was vacuous, because @monaco-editor/react calls onMount in the task that creates the editor, ahead of any refetch. Only the blame test and this row committed |
| task 831, pre-PR | 19f +647 -59 plus 2 new files, all uncommitted | 162KB, 2170 lines | 5 (3) | 15 | 0, and the 292KB recording omitted as not included | 10: 2 correctness shards from `--shard-lines 1500` (1431 and 714 lines), 4 universal finders (performance, maintainability, conventions, coverage), 3 gated auditors (ipc-auditor and migration-safety on `types.ts`, platform-guard on `path.join`, `fs.rmSync` and `child_process` hunks in the new capture rig), integration on the delta; hmr-parity and session-debugger gated off; one wave, no queue | about 21 of 9 pack-carrying, plus greps: shard 1 about 10 (the recording's peek timeline among them), ipc-auditor 5, performance 3, shard 2, conventions and migration-safety 1 each, maintainability, coverage and platform-guard greps only; the integration finder read 5 narrow ranges | about 39 raised, 34 recorded with 1 found in verification / 30 fixed (3 by decision, 2 quick), 4 refuted, 0 blocked, 1 follow-up; 72 unit cases in 3 new files and 1 existing one plus 4 demo-tier cases, across 4 test-builder batches, each shown red by a mutation of its production code except two launch-order cases whose mutation run a permission check denied. Shard 1 alone found the flaky replay poll, by reading the recording's peek timeline: the peek naming `kangentic_move_task` lasts about a second. Platform-guard alone found the timed-out run rejected before it exited. The driver measured the scene-only session at about 18 KB gzipped of the eager seed by building the seed with and without it. The capture rig and the dataset were the task's own files, so only the scaffold helper, `scene-page.ts`, the architecture doc, the new tests and this row committed |
| task 833, pre-PR | 14f +464 -71 plus 1 new file, all uncommitted | 93KB, 1388 lines | 7 (5) | 8 | 0 | 7: 1 correctness shard from `--shard-lines 1500` (1369 lines), 4 universal finders (performance, maintainability, conventions, coverage), 1 gated auditor (platform-guard on `path.join` hunks in a unit test), integration on the delta; coverage ran although nothing under `src/`, `scripts/` or `packages/` changed, because `demo/boot.js` and the Vite config are behavior; one wave, no queue | about 10 of 6 pack-carrying, plus greps: the correctness shard 6 (`vite.config.mts`, `boot.js` and `demo-dataset.ts` gaps, the consumer parity test, `static-server.mjs`, `tsconfig.demo.json`), performance 3 (`tsconfig.json`, `tsconfig.demo.json`, a grep of the root Vite config), conventions 1 grep of `boot.js`, maintainability, coverage and platform-guard none; no finder reported the token cap at 1000-line reads; the integration finder read 1 narrow range | 17 raised, 15 recorded / 11 fixed (2 by decision, 4 quick), 4 refuted (1 by a timing), 0 blocked; 1 coverage hole filled with 1 unit test in 1 test-builder batch, shown red by pointing a merge target at the wrong map, by removing the blame merge, and by a sweep of every target, plus a driver-written parity scan case. Only the correctness shard found the defect: the consumer parity scan read no option with a line comment above it, so `sceneRowData` and `knowledgeGraph` were invisible at both call sites. Maintainability and coverage both raised the unreachable Vite throw, and coverage alone raised the unreachable `boot.js` branch. Coverage raised the untested merges, and maintainability's duplication Medium noted that nothing caught a key missing from them. The driver ran the scene-row, duplicate-row and `task-mcp` demo-tier tests on a fresh build after the `boot.js` fix. Every other fix landed on an already-dirty path, so only the parity test and this row committed |
| task 834, pre-PR | 31f +1039 -374 (one renamed module and its renamed test), all uncommitted | 139KB, 2348 lines | 8 (5) | 23 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1452 and 861 lines), 4 universal finders (performance, maintainability, conventions, coverage), 3 gated auditors (ipc-auditor on `ipc/handlers/**`, platform-guard on `path.join` hunks in a unit test, session-debugger on `task-move.ts`), integration on the delta; hmr-parity and migration-safety gated off; one wave, no queue | about 33 of 9 pack-carrying, plus greps: shards 1 and 2 seven each (the handler bodies behind 3-line hunks), session-debugger 6, performance 5 (the four bus listeners), ipc-auditor 5, maintainability, conventions and platform-guard 1 each (platform-guard read pack lines 1-785 and searched the rest), coverage greps only; a 1000-line read of the pack's dense tail passed the Read token cap, so every finder got split ranges; the integration finder grepped only | 19 raised, 19 recorded with 2 duplicates merged and 1 found by test-builder, 1 coverage hole split in two / 10 fixed (3 by decision, 1 quick), 9 refuted, 0 blocked, no follow-up; 32 unit cases in 8 existing files in 1 test-builder batch, most shown red by a mutation of the handler line. Only ipc-auditor found that TASK_RESOLVE_PR passed a null board change on the false premise that `linkPR`'s `onLinked` announces every write. Shard 1 alone found that a refused demote announced `task-deleted` for a card still on the board, and test-builder found the in-lock race the fix leaves announced. Session-debugger's late-restore finding was refuted by the spawn-progress feed, which pushes `task-updated` at `onProgress('resuming')`. Every fix landed on an already-dirty path, so only six test files and this row committed |
| task 836, pre-PR | 22f +638 -117 plus 3 new files, all uncommitted | 160KB, 2444 lines | 11 (8) | 14 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1422 and 993 lines), 4 universal finders (performance, maintainability, conventions, coverage), 4 gated auditors (ipc-auditor on `types.ts` and `handlers/sessions.ts`, platform-guard on `pty/**` and `agent/**`, session-debugger on `session-manager.ts`, migration-safety on `repositories/**`), integration on the delta; hmr-parity gated off; one wave, no queue | about 8 of 10 pack-carrying, plus greps: shards 1 and 2 two each (runner gaps, `plan-exit-target.ts`, and `plan-mode-trail.ts` from outside shard 2's range), session-debugger 2 (`session-manager.ts` suspend and remove), coverage 1, migration-safety 1 (it skipped the pack and read the schema), performance, maintainability, conventions, ipc-auditor and platform-guard greps only; the integration finder read 3 narrow ranges | 20 raised, 17 recorded / 13 fixed (2 by decision, 2 quick), 4 refuted, 0 blocked, no follow-up; 30 unit cases (4 new files, one a fixture, and 3 existing ones) across 3 test-builder batches, the runner's shown red on mutant copies and the bridge's and helper's by in-place toggles. Four finders raised the plan-mode trail's cap comment. Conventions alone raised the Stop payload with no fixture. The vendor hooks reference settled it, since its Stop example is the main agent's and `agent_id` marks a hook inside a subagent, so the driver used that example as the fixture, as the UserPromptSubmit one already is. A test-builder mutant showed the null source-column check is the only thing keeping a workflow route from reading a null column as its first step. Every source fix landed on an already-dirty path, so only the fixture, three new test files and this row committed |
| task 838, pre-PR | 20f +1485 -78 plus 3 new files, all uncommitted | 206KB, 3479 lines | 11 (3) | 12 | 0 | 8: 3 correctness shards from `--shard-lines 1500` (898, 1489 and 1065 lines, the first holding only `push-notifier.test.ts`), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched; one wave, no queue | about 18 of 7 pack-carrying, plus greps: shard 2 eleven (the session-manager, board-bus and task-move emit sites, the activity engine's plan approval, the task-moves repository), shard 1 three, shard 3 two, performance 1, conventions 1 (the protocol release rule), maintainability and coverage greps only; no finder reported the token cap at 1000-line reads; the integration finder read 2 narrow ranges | 16 raised, 17 recorded with 1 found in verification / 14 fixed (3 by decision, 3 quick), 3 refuted, 0 blocked, no follow-up; 50 unit cases (26 in a new ledger file, 12 each in 2 existing files) across 3 parallel test-builder batches, each shown red by a toggle of its production line. Only shard 2 found that a failed resend deleted the record it replaced and left an older alert on the phone untracked. Its other finding, that an exit leaves turn-complete in place, was answered by the idle timeout, which suspends an idle session with nobody at the desk, so the pass documented the behavior instead of changing it. The performance Low was refuted because the blob budget bounds each fit check. Two batches toggled production files at once, and the notifier batch caught the ledger batch mid-toggle in its own backup. Every source fix landed on an already-dirty path, so only the ledger test and this row committed |
| task 839, pre-PR | 15f +360 -97 plus 2 new files, all uncommitted | 124KB, 2138 lines | 13 (10) | 4 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1450 and 667 lines), 4 universal finders (performance, maintainability, conventions, coverage), 3 gated auditors (ipc-auditor on `mock-electron-api.js` and `session-store.ts`, hmr-parity on `stores/**` and `utils/**`, session-debugger on `session-store.ts`), integration on the delta; platform-guard and migration-safety gated off; one wave, no queue | about 15 of 9 pack-carrying, 1 not reported, plus greps: shard 1 five (the store, the host context, `Tooltip.tsx`, the eligibility module's head and the old toggle flow), session-debugger 4 (main's pause handler, `sessions.ts`, `session-manager.ts` suspend and the replica rule), shard 2 three (`session-toggle.ts`, `ipc-error.ts` and an old toast spec), conventions 2, performance 1 (the `useTaskProgress` gap), coverage, ipc-auditor and the integration finder greps only, hmr-parity none, maintainability sent no reads line | 15 raised, 13 recorded with the IPC auditor's mock-recorder item and the session-debugger's test gaps merged into coverage holes / 9 fixed (2 by decision, 1 quick), 3 refuted, 0 blocked, 1 follow-up; 9 UI cases in 1 new spec and 49 unit cases in 1 new file across 2 test-builder batches, each shown red by a mutation. Only session-debugger raised that a refused suspend leaves the optimistic `suspended` row over a live agent. Shard 1 saw the same path and let it pass because the task detail's own Pause behaves the same way, which was the evidence for fixing it in the store rather than in the new menu path. Every source fix landed on an already-dirty path, so only the two new test files and this row committed |
| task 844, pre-PR | 32f +571 -165 plus 7 new files, all uncommitted | 186KB, 3110 lines | 12 (4) | 27 | 0 | 12: 3 correctness shards from `--shard-lines 1500` (1251, 1485 and 331 lines), 4 universal finders (performance, maintainability, conventions, coverage), 4 gated auditors (ipc-auditor and migration-safety on `types.ts`, platform-guard on `pty/**` and `agent/**`, session-debugger on `session-manager.ts` and `transition-engine.ts`), integration on the delta; hmr-parity gated off; one wave, no queue | about 15 of 11 pack-carrying, plus greps: ipc-auditor 5 (the mock, the snapshot parity test, `board.ts`, preload), session-debugger 4 (`session-manager.ts` anchors, `task-move.ts`, the runner's gap), shard 2 two (`session-telemetry.ts`, `activity-engine.ts`), conventions 2 (the lock rule, `types.ts`), shard 1 and shard 3 one grep each, platform-guard and coverage greps only, performance and maintainability none, migration-safety skipped the pack and grepped; the integration finder read 2 narrow ranges | 31 raised, 31 recorded / 30 fixed (4 by decision, 0 quick), 1 refuted, 0 blocked, no follow-up; 3 parallel test-builder batches wrote 3 new test files and extended 6 existing ones (162 cases pass across them), the driver extended the snapshot parity test, the engine batch shown red on mutant copies, two runner guards shown red by in-place driver toggles, the rest traced by hand. One paid haiku capture on Claude 2.1.303 pinned the tool hooks' `agent_id` shape: it became the fixture and refuted session-debugger's hook-ordering Low. Only session-debugger found the three Mediums: a reclaim adopting the serial of work begun during its read, a move landing during that read, and Run again's re-check outside the lock. Shard 1 alone found the turn end that lands before its own pass is scheduled. Only `task-move.ts`, `final-reply-reader.ts`, the fixture, five test files, the demo README and this row committed; every other fix landed on an already-dirty path |
| task 840, pre-PR | 111f +2999 -1096 plus 18 new files, all uncommitted | 612KB, 10068 lines | 19 (3) | 110 | 0 | 17: 7 correctness shards from `--shard-lines 1500`, 5 universal finders (performance, maintainability, conventions, coverage, integration on the delta), 5 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger, migration-safety); one wave, no queue | about 50 of 16 pack-carrying, mostly greps: session-debugger 7 ranges (the exit handler, suspend, the spawn sites), shard 7 six, platform-guard six, ipc-auditor five, shard 3 eight with greps, coverage test files only; 4 finders told to read the whole pack read only part of it (performance, hmr-parity, migration-safety, session-debugger) | 44 raised, 46 recorded with 2 found in verification / 30 fixed (3 by decision, 6 quick), 9 refuted, 1 blocked (no captured Qwen or Copilot hook payload), 1 follow-up; 189 cases (184 unit in 14 new files, 5 UI in 1 new spec) from 4 parallel test-builder batches, each shown red by a toggle of its production line. Shard 4 and session-debugger both found the gate dropping a plan prompt's idle on the marker alone, which the CLI can refuse; only session-debugger found a held idle released after the session ended. The driver's neutral summary wrongly said Copilot and Qwen register the plan approval hook, and the integration finder caught it. An inline node script's `$1` was expanded by the shell and blanked the Qwen hook keys mid-pass; the driver restored them from the diff. Nearly every fix landed on an already-dirty path, so only adapter-lifecycle.ts, the demo seed, the new tests and this row committed |
| task 840, second pass | 151f +9179 -1102, all committed | 824KB, 14071 lines | 12 (2) | 139 | 0 | 21: 11 correctness shards from `--shard-lines 1500` (the last 77 lines), 5 universal finders (performance, maintainability, conventions, coverage, integration on the delta), 5 gated auditors (ipc-auditor, hmr-parity, platform-guard, session-debugger, migration-safety); 20 in the first wave, shard 11 from the queue. The since-review pack equalled the full pack, because the first pass's commits sit on the merge base and the task's own work was committed after them | about 70 of 20 pack-carrying, plus greps: shard 4 nine, shard 9 nine, session-debugger 8 ranges, ipc-auditor 9, shard 3 seven, shards 1 and 8 five each, migration-safety 4, coverage 4 test files, the rest 2 to 4 or greps only; hmr-parity read only the renderer sections and session-debugger lines 1-5000 plus ranges; platform-guard hit the Read token cap twice and fell back to 500-line reads; the integration finder grepped only | 63 raised, 59 recorded plus 2 follow-ups, with 1 found by test-builder / 34 fixed (1 by decision, 7 quick), 24 refuted, 1 blocked (live Qwen hook captures for `is_interrupt` and `agent_id`); about 67 cases across 4 parallel test-builder batches, 3 of them UI, each shown red by a toggle or a mutant probe except a stale-revision pre-check whose run a permission check denied. Only session-debugger found the queued session whose placeholder names no agent, so the writer never approved it; shard 5 raised the same frozen capability with no live trigger. Only a test-builder batch found the three register-all unit files red on the task's own commit, the real writer meeting a fake SessionManager. The driver's fix for the gate's ended mark broke two tests the first pass wrote, and was reverted and refuted: the flushed idle lands after session_end either way. Nothing was dirty when the pass began, so every path committed |
| task 840, third pass | 171f +10819 -1100 committed, 14f +293 -34 uncommitted, 4 new files | 987KB, 16221 lines; since-review 270KB, 3949 lines | 11 (1); since-review 13 (8) | 166; since-review 52 | 0 | 19: 12 correctness shards from `--shard-lines 1500` on the full pack, 5 universal finders on the since-review pack (performance, maintainability, conventions, coverage, integration on the delta), 2 gated auditors on the since-review files (ipc-auditor, platform-guard); hmr-parity, session-debugger and migration-safety gated off; one wave, no queue | about 31 of 18 pack-carrying, mostly greps: ipc-auditor 6 ranges, shard 4 four, shards 1, 7 and 10 two or three each, the rest one, two or greps only; performance none; platform-guard hit the Read token cap on one range; the integration finder grepped and read narrow ranges | 16 raised, 16 recorded / 8 fixed (2 quick), 8 refuted, 0 blocked, no follow-up; 6 unit cases and 1 UI case from 3 parallel test-builder batches, each shown red by a toggle of its production line. Shard 1 answered shard 5's stale decision file on its own: every spawn mints a fresh session directory. Only conventions found that Copilot's settings reader swallowed a read failure other than a missing file. Coverage found neither status line's new quoting pinned, and test-builder found the backslash branch unreachable through either builder, since both convert to forward slashes first. Platform-guard's Windows concern about the `sh -c` test was refuted by running it here. Three findings repeated an earlier ledger line or a documented design. The fixes to the Copilot hook manager, `hook-utils.ts` and the integration doc landed on already-dirty paths |
| task 846, pre-PR | 8f +197 -128, all uncommitted | 118KB, 1424 lines | 6 (4) | 2 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (1412 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched; one wave, no queue | 3 of 5 pack-carrying, plus greps: the correctness shard 1 (the `validateFindings` gap), maintainability 1 (a `SKILL.md` gap), conventions 1 (the skill-authoring rule), performance and coverage none; the integration finder read 2 narrow ranges (audit section 15.6 and the skill's blocked bullet) | 5 raised, 5 recorded / 4 fixed (1 by decision, 2 quick), 1 refuted, 0 blocked; 1 unit case in 1 existing file from 1 test-builder batch, shown red by dropping the fallback it pins. Only the integration finder caught that the skill said Back for revisions hands the task agent only the steps, when `kangentic.json` sends the whole reply after the instruction, and that section 15.6 still stated the retired rule. Every fix landed on an already-dirty path, so the pass committed only an empty ledger commit |
| task 847, pre-PR | 27f +951 -176 plus 1 new file, all uncommitted | 164KB, 2690 lines | 11 (8) | 17 | 0 | 8: 2 correctness shards from `--shard-lines 1500` (1451 and 1207 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `platform-guard` gated; one wave, no queue | about 12 of 7 pack-carrying, plus greps: correctness shard 2 read 10 (callers, the bridge, the spawn env, and `hook-utils.ts`, which sat in the other shard's range), shard 1 and conventions 1 each, the other four none; performance hit the token cap on its 1000-line reads and left pack lines 1001-1057 and 1491-1871 unread; the integration finder read 6 files | 18 raised, 17 recorded / 14 fixed (1 by decision, 4 quick), 3 refuted, 0 blocked; 3 coverage holes filled by 1 test-builder batch (9 unit cases, 1 new file), each shown red, plus 5 pins the driver wrote for its own fix. Only correctness shard 1 found the one real defect: two adjacent characters that need single quotes became `'$''$'`, which Windows PowerShell 5.1 and pwsh both hand node as `$'$`, confirmed by a live probe before the fix. The new test file was the only path not already dirty, so it committed without its target fix |
| task 850, pre-PR | 37f +374 -102 plus 4 new files, all uncommitted | 116KB, 1959 lines | 14 (9) | 27 | 0 | 10: 2 correctness shards from `--shard-lines 1500` (1494 and 420 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard` and `session-debugger` gated; one wave, no queue | about 30 of 9 pack-carrying, plus greps: shards 1 and 2 about 8 each (`git-client.ts`, both migrated handlers, the tests that mock them), session-debugger 3, performance 2, maintainability 1, ipc-auditor 2 ranges plus `child-env.ts`, whose full body was in the pack (it said there was no section, and shard 2 re-read it too), conventions, coverage and platform-guard greps only; the integration finder read 11 files | 29 raised, 29 recorded / 19 fixed (2 by decision, 4 quick), 10 refuted, 0 blocked; 8 coverage holes filled by 1 test-builder batch (2 new files, 6 extended), each shown red by a toggle of its production line. Only shard 1 found that the always-passed env broke `resource-cleanup.test.ts`, whose exact-options asserts failed and whose one negative assert had gone vacuous. The driver's scoped run of every test that mocks `child_process` found the second break, in `run-cli-print-summarize.test.ts`, which no finder raised. That failure printed main's whole env, so the repairs read single fields. Six fixes landed on already-dirty paths, and every committed test pins behavior that stays uncommitted |
| task 851, pre-PR | 9f +133 -29 plus 1 new file, all uncommitted | 49KB, 777 lines | 8 (2) | 2 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (763 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched; one wave, no queue | 1 of 5 pack-carrying, plus greps: the correctness shard read `session-liveness.ts` and grepped `framing.ts`, `session-manager.ts` and `handlers-registration.test.ts`, conventions grepped the same liveness and protocol files, maintainability grepped for `refuseWithCode`, performance and coverage none; the integration finder grepped only | 5 raised, 6 recorded with 1 found in verification / 3 fixed (1 by decision, 0 quick), 3 refuted, 0 blocked; 6 unit cases in 1 new file from 1 test-builder batch, shown red by narrowing the status check to `suspended`, plus 2 cases the driver wrote for its own fix. Every finder passed `answer-permission-prompt`'s order. The driver found in verification that its prompt binding ran before the writability check, and a suspend drops the session's activity state, so that verb still refused an ended session with no code. The new test file was the only path not already dirty, so it committed without its target |
| task 849, pre-PR | 10f +431 -49, all uncommitted | 68KB, 1217 lines | 8 (4) | 2 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (1203 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, 2 gated auditors (ipc-auditor on `mock-electron-api.js`, platform-guard on the `path.join` hunks); hmr-parity, session-debugger and migration-safety gated off; one wave, no queue | 4 of 7 pack-carrying, plus greps: the correctness shard 2 (`error-reporting.ts`, `user-configuration-error.ts`), maintainability 1 (`trust-manager.ts`), ipc-auditor 1 (`toast-click-through.spec.ts`), performance, conventions, coverage and platform-guard none; performance read only to pack line 1000, by choice; the integration finder grepped only | 13 raised, 12 recorded with 1 found by test-builder / 9 fixed (3 by decision, 1 quick), 3 refuted, 0 blocked; 2 unit cases and 1 UI assertion from 1 test-builder batch, each shown red by a toggle of its production line. Only test-builder found the Medium: writing the red case for the stack-header guard, it saw `startsWith` accept a message that is a prefix of the stack's path-bearing first line, so the Sentry copy kept both paths, red against the unmodified source. A live probe showed Windows raising EPERM from `rename` for a read-only target and a directory target exactly as for a held one, which turned platform-guard's and performance's Lows into one confirmed defect. Only `toast-click-through.spec.ts` and this row were not already dirty, so only they committed |
| task 852, pre-PR | 9f +293 -45 plus 1 new file, all uncommitted | 57KB, 1052 lines | 5 (4) | 5 | 0 | 9: 1 correctness shard from `--shard-lines 1500` (1038 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `hmr-parity` and `platform-guard` gated; `migration-safety` not run, since the `types.ts` change is an IPC payload field, not a schema interface; one wave, no queue | about 9 of 8 pack-carrying, plus greps: correctness read 4 (gap ranges of the store and the service, the mock, the dashboard body), `hmr-parity` 2, conventions and `ipc-auditor` greps only, the other four none; the integration finder read about 12 files and ranges for its five questions | 9 raised, 8 distinct / 6 fixed (3 by decision), 2 refuted, 0 blocked; 3 coverage holes filled, 2 by test-builder (17 unit cases: 1 new file, 5 cases in an existing one), each shown red, and 1 by a testid and a positive assertion. Correctness and integration both found the one real defect: the store's restart flag was app-wide, so a late answer for a key the user had left could set or clear the notice over another key's figures. Every fix in task code landed on an already-dirty path, so the store test committed without its target fix |
| task 854, pre-PR | 35f +1738 -188 plus 7 new files, all uncommitted | 306KB, 5098 lines | 9 (2) | 33 | 0 | 13: 4 correctness shards from `--shard-lines 1500` (960, 1427, 1463 and 1202 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard`, `session-debugger` and `migration-safety` gated (the last on the `types.ts` hunks only); one wave, no queue | about 27 of 12 pack-carrying, plus greps: `session-debugger` read 9 (callers of `suspend()` and `awaitExit()`: relocate, reconcile, task-move, resource cleanup, and the host core), correctness shard 4 read 4, shards 2 and 3 three each, `platform-guard` 2, performance, conventions and the IPC auditor 1 each, the rest none; the IPC auditor hit the token cap on a 1000-line Read past line 3001 and re-read in 500-line windows | 57 raised, 41 recorded / 35 fixed (5 by decision, 6 quick), 6 refuted, 0 blocked; 6 coverage holes filled by 2 test-builder batches (about 38 unit cases in 9 existing files), plus pins for the pass's own fixes. Only `session-debugger` caught that a close-at-once `suspend()` or `awaitExit()` resolved on the shell's exit while Claude was still exiting, under a relocate's folder move or a respawn's resume; only correctness shard 4 caught that `CLAUDE_CODE_NO_FLICKER` never crossed into a WSL distro. Four finders raised the whole-tree wait that a dev server held to 8 s. Every source fix but one landed on an already-dirty path, so the commit carried 3 source files and 5 test files, the tests without their target fixes |
| task 848, first pass | 36f +1521 -304 committed, 14f +762 -39 plus 2 new files uncommitted | 618KB, 4603 lines | 5 (1) | 38 | 3 fixture recordings over the per-file cap, plus 1 new fixture over 1MB | 11: 4 correctness shards from `--shard-lines 1500`, a fifth on the 4 files the pack could not carry (greps only), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `platform-guard` gated; one wave, no queue | about 11 of 10 pack-carrying, each for code a shard's files call (the seed's helpers, the mock, the capture rig, the paste engine), plus greps; `platform-guard` read 1641 of the pack's 4603 lines and said it could not fit the rest | 43 raised, 40 distinct / 28 fixed, 12 refuted; 7 coverage holes filled with 46 new unit tests and 7 demo-tier tests; testing them found 2 more defects (a listed send with no final frame dropped silently, and a tiled sibling replaying past its finished session's end) |
| task 858, first pass | 14f +110 -25 plus 1 new file, all uncommitted | 78KB, 1045 lines | 9 (7) | 6 | 0 | 9: 1 correctness shard, 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard` and `migration-safety` gated, each on a comment-only `types.ts` hunk or a description string under `src/main/agent/**`; one wave, no queue | 11 of 8 pack-carrying (correctness 5, migration 3, conventions 2, performance 1), all callers, the predicate and the repository's boolean mapping; the integration finder read 7 call-site ranges | 3 raised, 3 distinct / 1 fixed (quick), 2 refuted; no coverage holes; the fix landed on an already-dirty file, so the pass made a ledger-only commit |
| task 856, pre-PR | 8f +237 -23, all uncommitted | 46KB, 665 lines | 4 (4) | 4 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (653 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched; one wave, no queue | 3 of 5 pack-carrying, plus greps: correctness 1 (`index.css`, for root overflow), maintainability 1 (the spec's earlier content-frame lookup), coverage 1 (the scene registry), conventions and performance greps or none; the integration finder read `static-server.mjs`, the CI demo job and narrow ranges of the spec and the player | 19 raised, 15 distinct / 12 fixed (1 by decision, 4 quick), 3 refuted, 0 blocked; 2 coverage holes filled by 2 parallel test-builder batches (14 unit cases in 1 new file, 1 demo-tier case), each shown red: the demo case moved the host page from 2000 to 1132 with a plain `focus()` back in `boot.js`. Only coverage found that no host-scroll case reached `boot.js`'s field focus, since every case started with the field's half on screen; its second hole overstated, because `completed-tasks` does scroll the board sideways and only the wider-than-box branches were unreached. Correctness, integration and performance found nothing. The new test file was the only path not already dirty, so it committed without its target fix |
| task 857, first pass | 34f +728 -80 plus 7 new files, all uncommitted | 158KB, 2360 lines | 11 (3) | 30 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1483 and 832 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard`, `session-debugger` and `migration-safety` gated (the last two on the `types.ts` comment and `session-manager.ts`); one wave, no queue | about 27 of 10 pack-carrying, plus greps: `session-debugger` read 7 (the exit, suspend and turn-end paths), correctness shard 2 six, conventions 5 (3 of them rule files), shard 1 four, `platform-guard` 3, maintainability 2, the rest none | 23 raised, 20 recorded / 16 fixed (1 by decision, 7 quick), 4 refuted, 0 blocked; 5 coverage holes filled by 2 test-builder batches (31 unit cases, one new test file and a fixture of real Claude PostToolUse payloads the task agent's own probe had captured). Only `session-debugger` caught that an exited row keeps its engine state, so a late mark could end a dead session's held turn and fire its column automations. Every source fix but one landed on an already-dirty path, so the commit carried 1 source file and 3 test files, the tests without their target fixes |
| task 855, pre-PR | 21f +958 -289 plus 5 new files, all uncommitted | 175KB, 3085 lines | 16 (8) | 10 | 0 | 10: 3 correctness shards from `--shard-lines 1500` (1425, 1500 and 130 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `hmr-parity` and `platform-guard` gated; `ipc-auditor` gated off, since the store change is a slice and not a `*-store.ts`; one wave, no queue | about 12 of 9 pack-carrying, plus greps: shard 3 read 4 (the registry, `swimlane-icons.tsx`, `build.js`, `ColumnRail.tsx`), shard 2 read 3 (the registry, `BoardManagerDialog.tsx`, `vite.config.mts`), shard 1, `hmr-parity` (`App.tsx`) and `platform-guard` (`playwright.config.ts`) 1 each, performance, maintainability and coverage none, conventions did not report the line; maintainability and `hmr-parity` hit the Read token cap on 1000-line reads of this pack and re-read in smaller ranges; the integration finder read `vite.config.mts` | 34 raised, 32 distinct, plus 1 found by the driver's scoped run and 2 by the UI test-builder / 27 fixed (3 by decision, 8 quick), 8 refuted, 0 blocked; 41 unit cases (2 new files, 1 existing) and 7 UI tests from 2 test-builder batches, each shown red by a toggle, plus 4 vendor-chunk cases and a switch-back leg the driver wrote. Two finders found the stale publish a project switch overtook during the icon wait, and the advisor's read of the warm switch path decided its fix. Only the UI test-builder found two runtime defects no finder could: Chromium keeps a failed dynamic import for the document, so the picker's reopen-to-retry could never work, and a project marked warm before its board landed cached the previous project's board. The scoped run found the existing vendor-chunk test red against the task's own new assertion. Every source fix but one landed on an already-dirty path, so the commit carried 1 source file, 1 module and 3 test files, the tests without their target fixes |
| task 859, first pass | 73f +2081 -430 plus 39 new files, all uncommitted | 484KB, 7475 lines | 10 (4) | 102 | 0 | 15: 6 correctness shards from `--shard-lines 1500` (1289, 1397, 1486, 1465, 1497 and 225 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard`, `session-debugger` and `migration-safety` gated (the last on the `types.ts` hunks only); one wave, no queue | about 28 of 14 pack-carrying, plus greps: shard 3 read about 7 (the bridges' unchanged ranges, `hook-trust.ts`, the rollout parser, the engine's handlers), shard 1 five, shard 5 four, shard 2 three, shard 4, conventions and `ipc-auditor` two each, performance, `session-debugger` and `platform-guard` one each, the rest none; `platform-guard` skipped about 3400 of the pack's lines for the Read token cap; the integration finder read about 15 files for its eight questions | 47 raised, 45 recorded / 34 fixed (3 by decision, 6 quick), 11 refuted, 0 blocked; 13 coverage holes plus pins for the pass's own fixes, filled by 5 parallel test-builder batches (about 160 unit cases: 4 new test files, 12 existing), each shown red. The driver captured a real `hooks/list` answer from the installed Codex 0.163.0 and two real turn-end records from local rollouts instead of blocking on them. Only `session-debugger` caught that PTY silence cleared a Codex session's tracked shells while its tracker still ran; two shards caught the trust read caching a failed run. Every source fix but a README row landed on an already-dirty path, so the commit carried 1 doc, 2 fixtures and 7 test files, the tests without their target fixes |
| task 861, first pass | 25f +1930 -101, all committed, nothing uncommitted | 149KB, 2808 lines | 7 (3) | 18 | 0 | 11: 3 correctness shards from `--shard-lines 1500` (1075, 1466 and 238 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `hmr-parity` and `migration-safety` gated (the last on the `TaskUnarchiveInput` hunk in `types.ts`); one wave, no queue | about 26 of 10 pack-carrying, plus greps: shard 2 read 6 (the preview module, the view model, the hook's collision tiers, the archive handler, the repository, the slice), `ipc-auditor` 5, shard 3 four, shard 1 three, performance, conventions, `hmr-parity` and `migration-safety` two each, maintainability and coverage none; the integration finder answered its five questions with greps and short reads | 26 raised, 23 distinct, plus 2 the driver found / 25 recorded: 23 fixed (5 by decision, 0 quick), 2 refuted, 0 blocked; 8 coverage holes plus pins for the pass's own fixes, filled by 2 parallel test-builder batches, then a second round of each (42 unit cases: 1 new test file, 3 existing; 9 UI tests in the drop-gap spec), each shown red. No finder raised the two medium defects. The unit test-builder noticed that an append to a lane at 0, 5, 9 sorts second, and the advisor's read of `TaskRepository.move` found the board's cross-column drop passing a slot index where `move()` reads a raw position, so on a gapped lane a drop and an end-slot restore both landed a slot off the gap; every UI case had seeded dense lanes. The tree was clean at the start, so the commit carried every path; its body bullets break commitlint's 100-character body line limit, which this worktree's husky hook did not enforce |
| task 865, pre-PR | 24f +1002 -188 plus 2 new files, all uncommitted | 184KB, 3033 lines | 7 (5) | 19 | 0 | 12: 3 correctness shards from `--shard-lines 1500` (1242, 1492 and 269 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` and `migration-safety` on a comment-only `types.ts` hunk, `platform-guard` on `git/**`, `session-debugger` on `handleTaskMove`; `hmr-parity` gated off; one wave, no queue | about 29 of 11 pack-carrying, plus greps: shard 1 about 12 (the registry, `spawn-with-abort.ts`, `task-cleanup.ts`, `task-move.ts`, `task-crud.ts`, `resource-cleanup.ts` gaps), shard 3 about 9, `session-debugger` 3, shard 2 two, maintainability, conventions and `platform-guard` 1 each, performance, coverage, `ipc-auditor` and `migration-safety` greps or none; the integration finder read about 13 ranges for its five questions | 32 raised, 31 recorded / 24 fixed (3 by decision, 3 quick), 7 refuted, 0 blocked; 28 unit cases (1 new file of 12, 7 existing files) from 2 parallel test-builder batches, each shown red on a scratchpad mutant copy, 18 by the first batch and 8 by the driver on the same harness. Only the integration finder caught that the MCP delete and the project delete still removed inside the git queue, which now refuses a path a creation holds, so a delete during a re-creation's setup left the worktree and branch behind. Only shard 3 caught the backlog pass deleting a held task's branch and nulling its row; the second test-builder batch found the same gap left open for a creation claimed mid-pass. Every other fix landed on an already-dirty path, so the commit carried the 2 delete sites, 4 test files and this row, the registry test without its target |
| task 863, first pass | 32f +1070 -247 plus 3 new files, all uncommitted | 220KB, 3640 lines | 7 (2) | 28 | 0 | 12: 3 correctness shards from `--shard-lines 1500` (1042, 1489 and 1070 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `hmr-parity`, `session-debugger` and `platform-guard` gated (the last on a test hunk's `path.join`); `migration-safety` gated off, since the `types.ts` change is an `ElectronAPI` member; one wave, no queue | about 39 of 11 pack-carrying, plus greps: shard 2 read about 11 (the window's fetch range, `Tooltip.tsx`, `ConversationView.tsx`, the transcript service and format, the stores), shard 1 about 9, `session-debugger` 5, shard 3 five, performance 4 and conventions 3 by grep, `hmr-parity` 2, `ipc-auditor`, coverage and `platform-guard` none, maintainability did not report the line; the integration finder read 4 files | 44 raised, 37 recorded / 27 fixed (3 by decision, 7 quick), 10 refuted, 0 blocked; 66 unit cases (4 new files, 1 existing) and 12 UI tests from 2 test-builder batches, each shown red. Two finders found a failed route re-read wiping a working tab row, and two found that an untargeted open reset a reused window to All. The conventions finder's cross-project note led the driver to a gap older than the diff: every conversation opener in a task detail the Agent Monitor hosts opened a board-layer window under the monitor overlay, against the open board's project, so the host now says whether it can show the viewer. Every other source fix landed on an already-dirty path, so the commit carried the 5 host-gate files and 4 test files, both without their target changes |
| task 866, first pass | 17f +268 -45, all uncommitted | 86KB, 1361 lines | 8 (7) | 9 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (1340 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched; one wave, no queue | 2 of 5 pack-carrying, plus greps: the correctness shard read ranges of `Tabs.tsx` and `ColumnRail.tsx` and grepped the window, the types and the transcript service, conventions and coverage greps only, performance and maintainability none; the integration finder read a range of `Tabs.tsx` | 10 raised, 11 recorded with 1 found by the driver / 8 fixed (2 by decision, 1 quick), 3 refuted, 0 blocked; 3 coverage holes filled by 1 test-builder batch (6 unit cases in 1 existing file, 2 UI tests in 2 existing specs), each shown red by a toggle of its production line. Correctness found that the live-poll signature ignored which columns ran an isolated session, but main bumps a revision only when turns change, so that fix is defense in depth with no test. The test-builder's late-badge test first fed a reply whose only change was `sessions`, a state main never sends. The driver gave the late revision its first isolated turn, and the test stayed red against the `tabsKey` mutation and green without the signature term. Every fix landed on an already-dirty path, so the pass made a ledger-only commit and this row |
| task 874, first pass | 3f +143, all uncommitted (the `.ps1` untracked) | 20KB, 268 lines | 3 (2) | 0 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (261 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; no gated auditor matched; one wave, no queue | 0 of 5 pack-carrying; the integration finder read `electron-builder.yml` | 8 raised, 8 recorded (1 maintainability item folded into coverage, 1 correctness sub-point split out) / 6 fixed (1 by decision, 3 quick), 2 refuted, 0 blocked; 1 coverage hole filled by 1 test-builder call (2 unit cases in 1 new file), shown red by removing the `.gitignore` line. The change is a Windows PowerShell script that no tier runs, so the driver checked the fixes with PowerShell 5.1 probes. A probe confirmed the trailing-backslash quoting bug. Another showed that the correctness finder's suggested `Join-Path` fix would double an absolute `-ShortcutPath`, so the driver used `GetUnresolvedProviderPathFromPSPath`. Every script fix landed on the untracked script, so the commit carried the test without its target |
| task 870, first pass | 27f +646 -67 (24 tracked plus 3 new files), all uncommitted | 167KB, 2763 lines | 11 (6) | 16 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1278 and 1454 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard`, `session-debugger` and `migration-safety` gated (the last on the `types.ts` EventType hunk, reading only that section); one wave, no queue | 8 of 10 pack-carrying, plus greps: shard 2 read ranges of `command-builder.ts`, `plan-approval-gate.ts`, `hook-manager.ts` and `command-builder.test.ts`, `session-debugger` ranges of `session-telemetry.ts`, `session-manager.ts`, `session-spawn-flow.ts` and `event-handlers.ts`; performance, coverage, `platform-guard`, `ipc-auditor` and `migration-safety` greps only; shard 1, maintainability and conventions none; the integration finder read 4 ranges | 35 raised, 35 recorded / 27 fixed (4 by decision, 6 quick), 8 refuted, 0 blocked; 4 test-builder batches (20 gate cases, 19 rules and builder cases, a bridge tool-spec block rebased on 2 captured fixtures, 6 SessionManager wiring cases, 1 existing file each), each shown red by a toggle of its production line. Only `session-debugger` found the High: an answered tool idle held past the turn's end was released at 30 s and marked an idle session as needing permission, so a turn boundary now drops held tool waits. The driver ran the change's own probe against its local API stand-in to capture two real 2.1.306 MCP PermissionRequests (main agent and subagent) as fixtures. Every source fix landed on an already-dirty path, so the commit carried 1 test file and the 2 fixtures, the test without its target fix |
| task 879, first pass | 9f +181 -43, all uncommitted | 38KB, 634 lines | 8 (8) | 1 | 0 | 7: 1 correctness shard from `--shard-lines 1500` (621 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `platform-guard` gated on `src/main/agent/**`; `ipc-auditor`, `hmr-parity`, `session-debugger` and `migration-safety` gated off; one wave, no queue | 3 of 6 pack-carrying, plus greps: correctness read the Qwen launch fixture, conventions and coverage each read the unchanged `CASES` range of the reporting test, `platform-guard` grepped the Gemini fixtures, performance and maintainability none; the integration finder answered with greps | 19 raised, 17 recorded (the platform and correctness Gemini whitespace items merged, a maintainability title complaint folded into the conventions one) / 12 fixed (1 by decision, 1 quick), 5 refuted, 0 blocked; 7 coverage holes filled by 1 test-builder batch (11 unit cases in 1 existing file), each shown red by a mutation of its bridge or adapter line, plus the driver's 2 stale-settings cases and 1 parity case. The advisor turned the stale `pattern` item from a refutation into a fix. The change's own test passed only because its stale text held a space, so a stale source would have read any id-shaped text as a phantom shell. The Copilot sync-completed capture could not catch a dropped `after`, so that case is synthetic. Every fix landed on an already-dirty path, so the commit carried only this row |
| task 876, first pass | 245f +6806 -2207, all committed | 1000KB, 16855 lines | 10 (1) | 235 | 0 | 22: 12 correctness shards from `--shard-lines 1500`, 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `hmr-parity`, `platform-guard`, `session-debugger` and `migration-safety` gated; 2 waves through the queue (20, then shards 11 and 12). Four finders read only part of the pack against instructions: performance (about 2.2k lines of source sections), `platform-guard`, `hmr-parity` and `migration-safety` (the contents list plus their own sections) | about 36 of 21 pack-carrying, plus greps: `session-debugger` 5 (telemetry sweep, session manager, config manager, pause tail, MCP session tools), shards 7, 10 and 11 three each, shards 3, 6, 8, 9 and 12 two each, conventions, coverage, `hmr-parity` and `migration-safety` two each, shards 1, 4 and 5 and `ipc-auditor` one each, shard 2, performance, maintainability and `platform-guard` none or greps; the integration finder read 2 files | 36 raised after dedup, 37 recorded with 1 found by a test-builder / 29 fixed (8 by decision, 7 quick), 8 refuted, 0 blocked; 3 parallel test-builder batches (unit main: 3 existing files; unit renderer: 1 new file of 7 cases, 1 existing; UI: 3 new specs, 1 existing, 2 mock fire hooks), each shown red against a reverted production line except one unobservable `dispose()`. Only the UI batch found the High: the Workflow complete toast opened a finished workflow, which has left every list, so the view fell back to the first listed one; the card now opens nothing. Only `session-debugger` found the idle sweep queuing a pause every minute behind the task lock and the idle pause landing over a typed draft. Only `hmr-parity` found the paused toast's Review closure pointing at a replaced store after a reload. Nothing was dirty at Step 4, so the commit carried all 43 paths |
| task 880, first pass | 17f +307 -116 (15 tracked plus 2 new files), all uncommitted | 120KB, 1752 lines | 7 (5) | 10 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1382 and 349 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard` and `migration-safety` gated (`ipc-auditor` and `migration-safety` on a `types.ts` doc comment, `platform-guard` on the new script's `child_process`); `hmr-parity` and `session-debugger` gated off; one wave, no queue, then performance relaunched over pack lines 601-1752 because its first run read only lines 1-600 | 4 of 10 pack-carrying, plus greps: shard 1 and `platform-guard` read `scripts/lib/is-entrypoint.mjs`, shard 2 the webhook adapter, conventions the release skill's frontmatter; the rest greps only or none; the integration finder answered with greps | 15 raised, 14 recorded (the two first-release skill items merged) / 13 fixed (2 by decision, 4 quick), 1 refuted, 0 blocked; 4 coverage holes and 1 performance item filled by 2 test-builder batches (11 unit cases in 1 new file; 8 cases and a template repository that halved the file's run time in 1 existing file; 2 cases in another), each shown red by a mutation of its source line except two checked by reasoning after a mutation round was denied. Only integration found that the demo deploy smoke ran without the flag the change put on every `ci.yml` run, behind a stated exemption that fit only `release.yml`. The driver checked the retry fixtures against playwright-core's own message templates. Every other fix landed on an already-dirty path, so the commit carried `deploy-demo.yml` without its pin and the extracted retry module and its test without the `helpers.ts` switch to it, then this row |
| task 883, first pass | 23f +695 -407 (19 tracked plus 4 new files), all uncommitted | 126KB, 1907 lines | 13 (8) | 10 | 0 | 9: 2 correctness shards from `--shard-lines 1500` (1471 and 409 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `hmr-parity` gated on `src/renderer/utils/**` and `platform-guard` on `useTerminal.ts` and `src/main/pty/**`; `ipc-auditor`, `session-debugger` and `migration-safety` gated off; one wave, no queue | 4 of 8 pack-carrying, 10 reads: shard 1 read 3 xterm typings and bundles, shard 2 and performance 3 xterm sources each, coverage `headless-frame.test.ts:186-308`, which the 3-line hunk context cut off; maintainability, conventions, `hmr-parity` and `platform-guard` greps only or none; the integration finder answered with greps | 12 raised, 13 recorded (the two right-click items merged, the `codeOnly` sub-point split out, and a stale `fit-addon` `_core` note at two sites that only the advisor raised) / 8 fixed (3 by decision, 1 quick), 5 refuted, 0 blocked; 1 coverage hole filled by 1 test-builder batch (1 unit case in 1 existing file), shown red by blanking the suffix's region. The Medium, a color-scheme assertion with no positive control, was refuted by a driver toggle run: with `vtExtensions` removed from `useTerminal` the spec read the bundle's `ESC[?997;1n` reply and failed. Only integration raised the probes' unpinned extensions. Two fixes landed on clean paths, so the commit carried `helpers.ts` and `terminal-grid-registry.ts`; every other fix stayed on an already-dirty path, then this row |
| task 887, first pass | 62f +1378 -1339, all committed, a dependency refresh whose `package-lock.json` is 2400 of those lines | 106KB, 1823 lines | 15 (14) | 47 | 1 (`package-lock.json`, over the per-file hunk cap) | 9: 2 correctness shards from `--shard-lines 1500` (1491 and 266 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` gated on `src/main/ipc/handlers/**` and `platform-guard` on `src/main/git/**`; `hmr-parity`, `session-debugger` and `migration-safety` gated off; one wave, no queue | 6 of 8 pack-carrying, about 23 reads, most of them the `node_modules` sources and typings the major bumps changed: shard 1 read Sentry's `DataCollection` type and its resolver, shard 2 the v11 bundler plugin option types and both call sites, conventions and `platform-guard` simple-git 4's env guard, conventions the line-count worker and the MCP token header to check doc claims, coverage a gap in the dompurify test; performance and maintainability greps only or none; the integration finder answered with greps | 7 raised, 6 recorded (a coverage note marked no action dropped) / 3 fixed (0 by decision, 1 quick), 3 refuted, 0 blocked; 1 coverage hole filled by 1 test-builder (the 3.4.17 override floor), shown red by raising the floor literal. The one Medium, `platform-guard`'s claim that Update from base's fetch lost inherited `GIT_*` keys under simple-git 4, was refuted from source: `fetchIfStale` ignores its git client and fetches through `runGitWithTimeout`, and a grep of the nine simple-git files found no other remote call. Every fix landed on a clean path, so the commit carried all four files, then this row |
| task 888, first pass | 16f +185 -118, all uncommitted | 67KB, 976 lines | 5 (5) | 11 | 0 | 10: 1 correctness shard from `--shard-lines 1500` (956 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `platform-guard`, `session-debugger` and `migration-safety` gated (`platform-guard` on `src/main/agent/mcp-http/task-tools.ts`, `migration-safety` on the repository and a `types.ts` doc comment); `hmr-parity` gated off; one wave, no queue. Performance read only the contents and one test section (pack lines 21-277) against instructions | about 15 of 9 pack-carrying, plus greps: shard 1 and `migration-safety` 4 each (the protocol payload type, the test comments a grep found, `task-move.ts`, the repository's workflow join), `session-debugger` 3 (`task-move.ts`, `transition-engine.ts`, `agent-spawn.ts`), conventions 2, `ipc-auditor` and `platform-guard` 1 each, performance, maintainability and coverage none or greps; the integration finder read 8 files | 21 raised, 15 recorded / 11 fixed (0 by decision, 5 quick), 4 refuted, 0 blocked; 1 coverage hole filled by 1 test-builder call (1 UI test in 1 existing spec), shown red by putting the mock's clear back. The change removes a behavior, so most of the yield was stale prose the type checker cannot see: the published protocol JSDoc (raised by correctness, integration and `migration-safety`), a migration comment and a renderer comment only integration found, and two test comments. `session-debugger` and correctness both traced a held task's agent start to `spawnAgent`'s fallback, so the new engine test's "starts no agent" title was narrowed. The UI test waits for the restore toast, because the optimistic restore paints the strip whatever the mock writes. Six fixes landed on clean paths, so the commit carried them with the UI test without its target mock change; four stayed on already-dirty paths, then this row |
| task 889, first pass | 64f +3565 -1980, all committed, a docs split whose deleted `agent-integration.md` is 1895 of those lines | 448KB, 4440 lines | 13 (0) | 51 | 1 (the deleted `agent-integration.md`, over the per-file hunk cap) | 11: 3 correctness shards from `--shard-lines 1500` (1433, 1456 and 1483 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `platform-guard` gated on `src/main/agent/**` and `ipc-auditor` on `tests/ui/mock-electron-api.js` (one string each), plus one extra correctness finder outside the standard set that read the deleted file's merge-base copy against the 23 new concept files instead of the pack; `hmr-parity`, `session-debugger` and `migration-safety` gated off; one wave, no queue | about 5 of 9 pack-carrying, plus greps: shards 1 to 3 one each (the paging audit, `eval-docs-reads.mjs`, `code-record.ts` 60-135), `ipc-auditor` 2 small ranges, the rest greps only or none; the split finder read the old file and every concept (no pack by design); the integration finder read 2 files | about 60 raised, 37 recorded / 25 fixed (4 by decision, 5 quick), 7 refuted, 0 blocked; coverage holes filled by 3 parallel test-builder batches (1 new file of 51 cases; 20 cases and a parser-parity check in 1 existing file; 36 behaviors in another), shown red by a HEAD swap of the fixed source and by 154 hand mutants (151 killed, 3 equivalent), and the batches found 4 more defects the finders missed. No finder found the High: the driver's `git merge-tree` against `main` showed `main` had rewritten a section of the deleted file after the branch point, so the rebase would have dropped it, and the driver ported it. Shard 3 raised the block-scalar description as a hypothetical; it was live on every `.claude/agents` file. The real-shape fixture is one captured Haiku run. Nothing was dirty at Step 4, so the commit carried all 23 paths, then this row |
| task 881, first pass | 103f +2186 -1612 (84 tracked plus 19 new files), all uncommitted | 646KB, 10657 lines (250KB of bodies against the 200KB budget) | 10 (0) | 93 | 0 | 18: 8 correctness shards from `--shard-lines 1500`, 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor`, `hmr-parity`, `platform-guard` and `migration-safety` gated; `session-debugger` gated off; one wave, no queue, then a conventions gap-fill over the renderer, docs and rules ranges the conventions finder skipped (it read pack lines 1-2000 and chosen sections, as performance did) | about 30 of 17 pack-carrying, plus greps: shard 8 read 6 ranges (`worktree-manager.ts`, `PopOutChangesFileRoot.tsx`, `escape-ownership.ts`, `task-repository.ts`, `CompletedTaskView.tsx`, the slice), shard 5 five files, `ipc-auditor` four, shards 2, 4 and 7 two each, shard 6, performance, conventions, `hmr-parity` and `migration-safety` one to three each, the rest greps only or none; the integration finder answered with greps | 44 recorded (2 from the gap-fill, 1 from the driver's own scoped run) / 31 fixed (4 by decision, 2 quick), 11 refuted, 0 blocked; 6 parallel test-builder batches (resolver 18 real-git cases, DiffService 8, handler 12, repository and remote 9, renderer 2 new files and 1 existing, UI 3 cases), each shown red by a mutation of its source line except the union parity pins. Only shard 4 found `truncated` set for commits missing from the clone; the driver then found the index read capped linked commits at 300, so the resolver could never flag a cut, and asked for one more. Step 7's scoped run found `pop-out-changes-root-guard.test.ts` failing on the base, after the change handed an unboarded task to a hook-reading root. Every source fix landed on an already-dirty path, so the commit carried 2 new tests, 1 new component, 2 updated tests and 3 comment files, the tests without their target fixes, then this row |
| task 889, rollout pass | 311f +19173 -15646, all committed, the rest of the docs split into concepts (12 flat docs deleted, 16 renamed) | 3092KB, 25756 lines | 7 (0) | 304 | 10 (the deleted flat docs, over the per-file hunk cap) | 36 in rolling waves of 20 from a queue: 19 correctness shards from `--shard-lines 1500` plus a re-run of the half of one shard that stopped early, integration on the delta, the 4 other universal finders and all 5 gated auditors on named pack ranges instead of the whole pack (3092KB would not fit one finder), and 6 later sweeps over every above/below and quoted-section pointer in `docs/`, because the shards had only sampled that class | about 45 of 30 pack-carrying, most of them greps of `docs/` for a cross-reference target; one sweep stopped at its turn limit and was resumed to report; the performance finder skipped 5 of its 14 ranges | 63 recorded / 42 fixed (5 by decision, 11 quick), 10 refuted, 0 blocked, with about 80 prose pointers rewritten as links by two editing agents and the conformance test checking every link; 2 parallel test-builder batches (eval-docs-reads; measure-docs-structure and docs-bundle), each case shown red by a reverted source line. The driver's own repo-wide grep found the mechanical command-injection retarget before any finder, and its check of the one broken link a shard reported showed `linksOf` never read link text wrapped across lines. Nothing was dirty at Step 4, so the commit carried all 99 paths, then this row |
| task 890, first pass | 3f +103 -36 plus 1 new file, all uncommitted | 56KB, 984 lines | 3 (2) | 1 | 0 | 7: 1 correctness shard from `--shard-lines 1500` (976 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `platform-guard` gated on the new spec's `path.join`; `ipc-auditor`, `hmr-parity`, `session-debugger` and `migration-safety` gated off; one wave, no queue | 8 of 6 pack-carrying, plus greps: correctness read monaco's `diffEditorWidget.js`, `utils.js` and `diffEditorViewModel.js` and grepped the minified @monaco-editor/react bundle, for the change's refcount and dispose claims; `platform-guard` read the cross-platform rule and grepped a sibling spec; maintainability grepped `helpers.ts` and `tests/ui` for duplication; performance, conventions and coverage none; the integration finder read `monacoConfig.ts` | 8 raised, 11 recorded (2 pre-flight type errors, 1 from the advisor's read of `getModel`) / 6 fixed (1 by decision, 3 quick), 5 refuted, 0 blocked; 1 coverage hole filled by 1 test-builder call (2 UI tests in the change's own new spec), each shown red by deleting the `onDidDispose` listener. Both type errors came from the worktree's `node_modules` junction to the main checkout's install, which predates the simple-git 4 and Sentry 8 bumps. The driver deleted the link and ran `npm ci` into the worktree, and typecheck passed. Correctness checked the change's monaco claims against source and they held. Only coverage found that no test closed the window, so deleting the dispose-on-close listener passed every case. Every fix landed on an already-dirty path, so the pass made a ledger-only commit, then this row |
| task 896, first pass | 15f +349 -20 plus 3 new files, all uncommitted | 103KB, 1824 lines | 10 (7) | 8 | 0 | 10: 2 correctness shards from `--shard-lines 1500`, 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` gated on `src/main/ipc/handlers/**`, `platform-guard` on `src/main/agent/**`, `session-debugger` on `handleTaskMove` (which now lives in `task-move.ts`, not the `tasks.ts` the gate names); `hmr-parity` and `migration-safety` gated off; one wave, no queue | about 24 of 9 pack-carrying, plus greps: correctness read the terminal-transition callers (`task-move.ts`, `task-cleanup.ts`, `backlog.ts`, `task-commands.ts`, `projects.ts`) to trace each one the docs name; the IPC auditor read the renderer's `pop-out-changed.ts`, the changes slice and `browser-pane-detach.ts`; performance, maintainability and `platform-guard` none; the integration finder read 5 narrow ranges | 21 raised, 19 distinct / 11 fixed (4 by decision, 2 quick), 8 refuted, 0 blocked; 4 coverage holes filled by 1 test-builder call, one of them a runtime test of `cleanupProject` that replaced a source-text scan. The driver ran the 44 unit files that import the touched modules before the fan-out returned, which refuted the import-breakage finding two finders raised. Only the second correctness shard found that the missing-folder delete closed windows while its agents still ran. Every source fix landed on an already-dirty path, so the commit holds the new test, one adjusted test and this row |
| task 902, first pass | 7f +403 -31, all uncommitted | 56KB, 1024 lines | 7 (5) | 0 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (1013 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` and `hmr-parity` gated on `host-memory-store.ts`; `platform-guard`, `session-debugger` and `migration-safety` gated off; one wave, no queue | about 12 of 7 pack-carrying, plus greps: correctness read `session-liveness.ts` and ranges of `session-store.ts`, `toast-store.ts` and `session-registry.ts` to check the change's replica and clock claims; `ipc-auditor` read the preload, `types.ts`, mock and `App.tsx` lines for the test hooks; `hmr-parity` the rule file and the session store's pin; performance and coverage greps only, conventions none, maintainability not reported; the integration finder answered with greps | 9 raised, 9 recorded / 7 fixed (3 by decision, 1 quick), 2 refuted, 0 blocked; 2 coverage holes filled with red-green tests for the pass's own fix by 1 test-builder call (8 helper cases, 5 store cases, 3 UI cases), each shown red by a mutation of its source line. Only the correctness shard found that the new count read liveness as a level, so an agent that came back and then stopped counted as paused again; the pass made the outcome a stored edge. The advisor turned the To Do and delete finding from a refute into a fix on the same record. Every fix landed on an already-dirty path, so the pass made a ledger-only commit, then this row |
| task 893, first pass | 155f +11617 -1527, all committed | 986KB, 15560 lines | 5 (1) | 150 | 1 (`tests/ui/command-terminal.spec.ts`, over the per-file hunk cap) | 23: 21 in rolling waves of 20 from a queue (11 correctness shards from `--shard-lines 1500`, 4 universal finders, integration on the delta, all 5 gated auditors), then an extra correctness finder over the stubbed spec in 400-line reads and a `platform-guard` re-run over its gate files' sections in reads of at most 300 lines, because the first run's 1000-line pack reads hit the Read tool's token cap on this dense pack. Performance, `hmr-parity`, `migration-safety` and `session-debugger` read chosen ranges, not the whole pack | about 25 of 20 pack-carrying, plus greps: shard 3 read `useTerminal`'s unmount cleanup, shard 7 the history helper and the resume handler, shard 9 `config-manager.ts` and the transient slice, shard 2 five files, maintainability `CommandTerminalWindow.tsx`, coverage the stubbed spec, `ipc-auditor` the broadcast helper; the integration finder answered with greps and 2 reads | about 80 raised, 67 recorded / 50 fixed (7 by decision, 9 quick), 17 refuted, 0 blocked; coverage holes filled by 5 test-builder calls (unit: 2 new files, 2 extended; UI: 3 specs and the helpers; the conform step cap; a de-flake), each case shown red by a toggled source line. The test-builders found 4 defects the finders missed: the capture handler's zoom read outside its try, the detached window mounting on an unreadable session list, the pop-out bootstrap's uncaught config load, and a ResizeObserver refit that fired mid OS drag and made a branch-added UI test fail about 1 run in 8 to 16 (caught by running it 16 times, with an A/B against the pass's own gate fix). Two finders raised the frame hold re-aim race independently. Nothing was dirty at Step 4, so the commit carried every path, then this row |
| task 910, first pass | 13f +119 -7 plus 4 new files, all uncommitted | 90KB, 1489 lines | 12 (7) | 5 | 0 | 8: 1 correctness shard from `--shard-lines 1500` (1468 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` gated on `src/main/agent/commands/types.ts` (a `types.ts` by basename) and `platform-guard` on `src/main/agent/**`; `hmr-parity`, `session-debugger` and `migration-safety` gated off; one wave, no queue | about 9 of 7 pack-carrying, plus greps: correctness read the phone's `board-tool.ts` and `task-resolver.ts` and grepped the shared and protocol types for its round-trip check; performance read `readTaskChanges`, `board-tool.ts` and `callHandler` to see what the new caller discards; `ipc-auditor` read `git-diff.ts` and the `GitTaskChangesInput` type; conventions read the protocol release rule; maintainability, coverage and `platform-guard` greps only or none; the integration finder answered with greps | 15 raised, 15 recorded / 11 fixed (2 by decision, 3 quick), 4 refuted, 0 blocked; 3 coverage holes and the pass's own git option filled by 2 parallel test-builder calls (2 context cases and 3 git-option cases in 2 existing files, 1 new MCP wiring file of 10 cases, 16 parser cases in the change's own test file), each shown red by a mutation of its source line. Correctness, integration, `ipc-auditor` and `platform-guard` raised nothing; the fixes came from maintainability's copied protocol guards and performance's discarded web-link lookup and duplicate `message`. The advisor turned two refutes into fixes (the header's compile-error claim and the doc `sources:` entry) and had the slice refute cite the cap test that pins it. Two source fixes landed on clean paths, so the commit carried `payloads.ts` and `git-diff.ts` with 3 tests, two of them without their target code; the other fixes stayed on already-dirty paths, then this row |
| task 916, first pass | 217f +69211 -1712, all committed, 90 of them generated `.po` catalogs | 2954KB, 77366 lines | 5 (0) | 212 | 1 (`src/locales/en/dialogs.po`, over the per-file hunk cap) | 23 from a queue in rolling waves of 20: 11 of the 45 printed correctness shards, since the other 34 held only non-English catalogs whose every `msgstr` was empty, which `npm run i18n:check` sync and driver greps of `src/locales/en` covered instead; performance, maintainability, conventions and an i18n message-quality finder each in two halves over the source ranges only, because the 742KB of source would not fit one finder; coverage on the behavioral `.ts` sections; integration on the delta; `hmr-parity` gated on `src/renderer/utils/board-workflow.ts` and `platform-guard` on `src/main/agent/**`; `ipc-auditor`, `session-debugger` and `migration-safety` gated off | about 53 of 22 pack-carrying, plus greps: most were `src/shared/i18n/english.ts`, `text.ts`, `src/renderer/i18n/translate.ts`, `src/shared/workflow-refusals.ts` for whether refusals resolve lazily, and the Lingui react source for whether `t` is stable; the integration finder read 2 narrow ranges | 46 raised, plus 1 found in verification and 1 while filling holes, 37 recorded / 21 fixed (5 by decision, 2 quick), 14 refuted, 0 blocked; coverage filled by 2 test-builder calls (a new 18-case file under a fake French catalog, 3 cases in `i18n-boundaries.test.ts`, 2 MCP cases), each shown red by a mutation of its source line. No finder found the Critical. The driver found it while verifying a label fix, by bundling `automation-describe.ts` with main's plain esbuild options and calling it: the runtime macro's `plural()` throws on a raw number there, so the MCP automation listing threw for any row with a Frequency, while every finder and every unit test ran under the Lingui transform, where the same call works. Nothing was dirty at Step 4, so the commit carried every path, then this row |
| task 927, first pass | 17f +499 -27, all uncommitted | 104KB, 1593 lines | 11 (10) | 6 | 0 | 7: 2 correctness shards from `--shard-lines 1500` (1477 and 95 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; all 5 gated auditors gated off (no hunk carried `path.join`, `fs.rmSync`, `child_process` or a dash, and `automation-run-again.ts` sits under `ipc/helpers`, not `ipc/handlers`); one wave, no queue | about 8 of 6 pack-carrying, most of them greps, 1 not reported: shard 2 read a range of `workflow-step-condition.ts` and grepped the manifest, the verdict script and the step; maintainability grepped `automation-runner.ts` for the filter it found copied; conventions grepped `types.ts`; performance and coverage none; shard 1 did not report; the integration finder read `automation-describe.ts` lines 130-149 | 16 raised, 16 recorded / 12 fixed (1 by decision, 2 quick), 2 refuted, 0 blocked; 6 coverage holes filled by 1 test-builder call (6 `runWorkflowStep` cases and 2 `stepExitVerdict` cases in 2 existing files), each shown red by a toggled source line except two equivalent mutations. Correctness found only a stale comment and a `-x` base the `--no-changes` parser accepted. The coverage finder's suggested test for the Send message filter could not tell the filter apart, so the driver rewrote it before delegating. Every fix but two landed on already-dirty paths, so the commit carried `automation-describe.ts` (which needs the uncommitted manifest helper to typecheck) and one test comment, then this row |
| task 929, first pass | 37f +992 -56 plus 1 new file, all uncommitted | 169KB, 2405 lines | 8 (5) | 30 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1464 and 899 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` gated on `src/main/ipc/handlers/**`, `platform-guard` on `src/main/pty/**` and `src/main/agent/**`, `session-debugger` on `session-manager.ts` and `transition-engine.ts`, `migration-safety` on `src/main/db/repositories/**`; `hmr-parity` gated off; one wave, no queue | about 17 of 10 pack-carrying, plus greps: shard 1 read ranges of `task-move-repository.ts`, `agent-spawn.ts`, `task-move.ts` and `session-manager.ts`; shard 2 `task-move.ts` and `shapes.ts`; `ipc-auditor` `task-move.ts`, `session-start.ts`, `session-resume.ts` and `workflow-service.ts`; `session-debugger` `held-pause.ts`, `session-resume.ts` and `agent-spawn.ts`; `migration-safety` the schema, the repository and `recordMove`; maintainability one range of `task-commands.ts`; performance and conventions greps only; coverage and `platform-guard` none; the integration finder answered with greps | 24 raised, plus 1 found in verification and 2 from the advisor's checks, 25 recorded / 17 fixed (3 by decision, 3 quick), 8 refuted, 0 blocked; 8 coverage holes and the pass's own fixes filled by 4 parallel test-builder calls (11 cases in `mcp-move-task-workflow-lock.test.ts`, 10 in `session-resume-after-entry.test.ts`, 5 in `session-leftover-reap-wiring.test.ts`, 2 engine and 2 facts cases, and a new `automation-needs-agent.test.ts`), each shown red by a mutation of its source line. Neither correctness shard raised anything. Both Medium defects came from `session-debugger`: the paused-move branch returned above the cross-agent override clear, and a paused task's recovery out of Done skipped the worktree. Tracing the second, the driver found that an unarchive records a move, so the later Resume sent the column's agent rows a recovery move suppresses. The driver's first fix for that tripped `session-resume-guard.test.ts`'s ban on a bare role check, caught by the scoped rerun of the tests named after the touched modules. Every source fix landed on an already-dirty path, so the commit carried the new test, which needs the uncommitted manifest helper, then this row |
| task 931, first pass | 10f +146 -12 plus 17 new files, all uncommitted, 14 of them machine-translated READMEs | 261KB, 3585 lines | 15 (0) | 12 | 0 | 9: 3 correctness shards from `--shard-lines 1500` (1377, 1352 and 825 lines, the second all translations), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `platform-guard` gated on `path.join` in a script hunk and the translations' long dashes; `ipc-auditor`, `hmr-parity`, `session-debugger` and `migration-safety` gated off; one wave, no queue | about 14 of 8 pack-carrying, plus greps: all three shards read README.md to compare the translations, shard 1 also `git-output.mjs` and `glossary.mjs`, shard 3 `docs-links.test.ts` and a gap in `docs-path-citations.test.ts`; performance and `platform-guard` read `engines/claude.mjs`, `platform-guard` also `git-output.mjs` and `.gitattributes`; conventions grepped the release skill, `cli.mjs`, the i18n rule and the 14 READMEs for personal info; maintainability and coverage none; the integration finder read 5 callee files | 38 raised, 38 recorded / 25 fixed (2 by decision, 3 quick), 10 refuted, 0 blocked; 18 coverage holes filled by 1 test-builder call (a new 36-case `translate-readme.test.ts`, the rest in the two existing test files), checked by about 66 source mutations. Only shard 1 found a defect in the write path: a reply with its switcher markers swapped passed every check, then threw mid-write after README.md was written. The driver refuted shard 2's only finding, an Italian verb that agrees with its pronoun subject as Italian copulas do. Every new check was gated on a scratch harness that replays the 14 live translations through `readmeProblems`, and a `--stale` run with all of them current drove the rebuilt write phase for free, leaving all 15 README blob hashes unchanged. Every fix to the task's scripts landed on an already-dirty path, so the commit carried the engine's failed-call cost and the new test, which needs the uncommitted script, then this row |
| task 932, first pass | 44f +1773 -143 plus 8 new files, all uncommitted, 30 of them `.po` catalogs | 233KB, 4781 lines | 7 (2) | 45 | 0 | 11: 4 correctness shards from `--shard-lines 1500` (1320, 1471, 1487 and 447 lines, the last two mostly catalogs), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `hmr-parity` gated on `src/renderer/utils/**` and `platform-guard` on `path.join` in two test hunks; `ipc-auditor`, `session-debugger` and `migration-safety` gated off; one wave, no queue | about 28 of 10 pack-carrying, plus greps, 1 not reported: shard 4 read 9 files, among them `MarkdownRenderer.tsx` and `markdown-document-plugins.ts`, whose full bodies the pack carried; shard 1 the three new utils and a range of `DiffViewer.tsx`; shard 2 `git-diff.ts`, `types.ts` and `diff-service.ts`; shard 3 `build.js` and the pop-out root; conventions and `platform-guard` the sanitizer's schema, conventions also `system.ts` and `platform-guard` also `build.js`; `hmr-parity` the HMR rule; performance and coverage none; maintainability did not report; the integration finder read 4 files | 36 raised, plus 1 from a test-builder's report, 35 recorded / 25 fixed (3 by decision, 5 quick), 10 refuted, 0 blocked; 13 coverage holes filled by 2 parallel test-builder calls (3 new unit files with 61 cases, a new 8-test UI spec), checked by mutation harnesses and by the driver reverting the image guard (9 red). The High came from conventions and coverage both, and from no correctness shard: an image named `//host/x.png`, or a relative path above the repo root, passed the sanitizer and rendered as written, so it resolved against the packaged app's `file://` origin, a network share on Windows. The driver's own rename of shorthand names in the sibling UI spec's init script left three `ts` references behind and broke its `beforeAll`, caught by the scoped rerun. Every source fix landed on an already-dirty path, so the commit carried the new alert-kinds module and the four new test files, which need the uncommitted fixes, then this row |
| task 942, first pass | 12f +566 -165, all uncommitted | 104KB, 1993 lines | 9 (9) | 3 | 0 | 8: 2 correctness shards from `--shard-lines 1500` (1462 and 515 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` gated on `src/main/ipc/handlers/**`; `hmr-parity`, `platform-guard`, `session-debugger` and `migration-safety` gated off; one wave, no queue | 4 reads by 3 of 7 pack-carrying, plus greps: shard 1 read a gap in `related-work.ts` (the rollup body) and two ranges of `retrieval-store.ts`, shard 2 `Tooltip.tsx`, the IPC auditor a range of `mock-electron-api.js`; performance, maintainability, conventions and coverage none; the integration finder used greps only | 26 raised, 22 recorded / 20 fixed (5 by decision, 5 quick), 2 refuted, 0 blocked; 7 coverage holes filled by 3 parallel test-builder calls (3 new unit files, additions to 2 existing ones, one UI case), each shown red by toggling the production line. The one Medium defect, the prose classifier reading a markdown reference line `[1]: url` inside a reply as a system label, came from shard 2 and conventions both. None of the 4 reads went to a hunk-tier file. Fixing it showed that the change's own test had passed on a subtype that is not in `TranscriptSystemSubtype`, since `tests/` is not typechecked. Every source fix landed on an already-dirty path, so the commit carried the shared text-budget constant and the tests, which need the uncommitted fixes, then this row |
| task 945, first pass | 15f +228 -50, all committed | 87KB, 967 lines | 7 (7) | 8 | 0 | 6: 1 correctness shard from `--shard-lines 1500` (948 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta; `ipc-auditor`, `hmr-parity`, `platform-guard`, `session-debugger` and `migration-safety` gated off; one wave, no queue | 10 reads by 3 of 5 pack-carrying, plus greps: the correctness shard never loaded the pack, because its one 1000-line `Read` of this dense 967-line pack passed the token cap, and it read 6 working-tree files instead (`session-resume-eligibility.ts` and `wire-mappers.ts`, both windowed in the pack, then `session-registry.ts`, `session-manager.ts`, `send-user-message.ts` and `session-lifecycle-feed.ts`); conventions read the protocol-release rule, the protocol changelog and the release-protocol skill; coverage a gap in `read-board.test.ts`; performance none; maintainability and the integration finder greps only | 5 raised, 5 recorded / 2 fixed (2 by decision, 0 quick), 3 refuted, 0 blocked; no test-builder call, since the one coverage hole was refuted: the `'sessions'` rows filter the same `toTaskWire` output the full-view test pins. No defect: the shard checked the hold of a suspended id, the restart placeholder's `session-changed` edge and the registry's insertion order against the code. The driver's prompt said one 1000-line call covers a pack under 1000 lines, which is false for a pack this dense, and only the shard reported it. Every fix landed on a clean path, so the commit carried all four files, then this row |
| task 950, first pass | 16f +776 -191, all uncommitted | 153KB, 2555 lines | 7 (5) | 9 | 0 | 11: 2 correctness shards from `--shard-lines 1500` (1380 and 1155 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, `ipc-auditor` and `session-debugger` gated on `session-store.ts`, `hmr-parity` on `src/renderer/stores/**` and `src/renderer/utils/**`, `platform-guard` on `src/main/agent/**`; `migration-safety` gated off; one wave, no queue | about 10 reads by 5 of 10 pack-carrying, plus greps, 1 not reported: shard 1 read a gap in `agent-detector.ts` and a range of `off-main-exec.ts`, shard 2 the same `agent-detector.ts` gap; `hmr-parity` `useValuePulse.ts` and a range of `App.tsx`; `session-debugger` the replica rule and a range of `session-store.ts`; `platform-guard` `exec-version.ts`; performance, conventions, coverage and `ipc-auditor` none, greps only; maintainability did not report; the integration finder read a range of `off-main-exec.ts` | 19 raised, 19 recorded / 12 fixed (2 by decision, 2 quick), 7 refuted, 0 blocked; one batched test-builder call filled 4 coverage holes (a new pill-tick UI spec, and transient-probe cases in the fallback and WSL detector tests), each toggle-checked red. Two findings came from real data: no captured status.json carries the `spend_limit` window a comment claimed, and 44 of them carry only `seven_day`, so one became the parser's fixture. A WSL override still cached the transient misses the change exempts everywhere else. Every fix but the new files landed on paths the task agent left dirty, so the commit carried 3 test files, then this row |
| task 952, first pass | 152f +4026 -719 plus 16 new files, all uncommitted | 831KB, 11876 lines | 7 (2) | 161 | 0 | 26: 9 correctness shards from `--shard-lines 1500`; performance, maintainability, conventions and coverage each split in two halves at pack line 5175, since the whole 831KB pack would not fit one finder's context; integration on the delta; all 5 gated auditors on the header plus their own sections; 3 relaunched after partial returns (the second maintainability half sampled its range, so two quarter-range finders reran it, and `platform-guard` left 11 of 16 sections unread, so a second pass took them); 23 planned through a queue of 20 | about 27 reads by 15 of 25 pack-carrying, plus many greps, 1 not reported: most were gaps of in-pack files (`agent-spawn.ts` 840-1020 by three finders, `workflow-recovery.ts`, `workflow-step.ts`, `session-resume.ts` 140-410, `paste-engine.ts`, `plan-tool-approval.ts`), one a full re-read of the in-pack `workflow-memory-resume.ts`, the rest rule files and callers | about 66 raised, 54 distinct plus 18 coverage holes / 63 fixed (7 by decision, 8 quick), 9 refuted, 0 blocked; 7 test-builder calls filled every hole, each toggle-checked red, and found 2 more (a whole-opening recap whose mark named the wrong turn, and an unpinned `readStartHead` wiring). Two test-builders toggled `agent-spawn.ts` at once, and one restore put back the other's mutant, deleting the recap's `!isHandoff` guard; the handoff test caught it, and a script that checks every pack line against the tree found no other. Every fix but the new files landed on paths the task agent left dirty, so the commit carried 3 source and 18 test files, then this row |
| task 954, first pass | 43f +1333 -176 plus 6 new files, all uncommitted, 15 of them `.po` catalogs | 239KB, 3656 lines | 12 (5) | 37 | 0 | 13: 3 correctness shards from `--shard-lines 1500` (1354, 1478 and 771 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, all 5 gated auditors (`ipc-auditor` and `migration-safety` on `src/shared/types.ts`, `hmr-parity` on `App.tsx`, `platform-guard` on `src/main/agent/**` and `src/main/pty/**`, `session-debugger` on `session-manager.ts` and `transition-engine.ts`); one wave, no queue | about 11 reads by 7 of 12 pack-carrying, plus greps: `platform-guard` read `shell-quote.ts`, `transcript-locator.ts` and `history-scan.ts`; `session-debugger` ranges of `transition-engine.ts`, `task-cleanup.ts` and `projects.ts`; shard 3 a range of `resume-conversation-guard.ts`; shard 1 and performance `history-scan.ts`; shard 2 a range of `task-cleanup.ts`; `hmr-parity` a range of `App.tsx`; maintainability, conventions, coverage, `ipc-auditor` and `migration-safety` greps only or none; the integration finder read 2 ranges | 33 raised, 34 recorded / 24 fixed (4 by decision, 1 quick), 8 refuted, 1 blocked; 10 coverage holes filled by 7 parallel test-builder calls (3 new unit files, cases in 5 existing ones), each shown red by a mutation of its source line. Both Medium session defects came from `session-debugger` and no correctness shard: the background-session stop gate trusted a stored id that a pause or Done within one status refresh of `/bg` leaves on the pre-move conversation, and the live move check gave up after 5.5 s. A test-builder found that the driver's own schedule fix counted each delay from the previous check, not from the hook. The advisor caught that the driver's streamed scan parsed every events line. Three fixtures are sanitized live captures of a `/bg` move; no `claude agents --json` capture existed, so that replay is the one blocked step. Every source fix landed on an already-dirty path, so the commit carried the shared SessionStart parser, the fixtures and three new tests, which need the uncommitted code, then this row |
| task 954, second pass | 58f +4187 -183, all committed, 15 of them `.po` catalogs | 347KB, 5581 lines | 8 (2) | 50 | 0 | 15: 5 correctness shards from `--shard-lines 1500` (1100, 1263, 1273, 1494 and 389 lines), 4 universal finders (performance, maintainability, conventions, coverage), integration on the delta, all 5 gated auditors on the same globs as the first pass. The first pass committed only on top of `main`, so the since-review base was `main` and every finder read the one pack; one wave, no queue | 25 reads by 11 of 14 pack-carrying, plus greps: shard 1 read `background-sessions.ts`, `conversation-switch-gate.ts`, the SessionStart helper, `history-scan.ts` and ranges of `session-telemetry.ts`; shard 2 the gate, the reconcile and a range of `task-cleanup.ts`, all bodies in other shards' ranges; shard 3 `cli-run.ts` and ranges of `transition-engine.ts` and `prepare-spawn.ts`; shard 4 and maintainability a range of `session-telemetry.ts`; `session-debugger` ranges of `transition-engine.ts`, `prepare-spawn.ts`, `session-lifecycle.ts` and `task-move.ts`; `ipc-auditor` ranges of `mock-electron-api.js`, `sessions.ts` and `App.tsx`; `platform-guard` `shell-quote.ts` and `transcript-locator.ts`; `hmr-parity` a range of `App.tsx`; conventions `package.json`; `migration-safety` a range of `session-repository.ts`; performance, coverage and shard 5 none or greps only; the integration finder read 2 ranges | 33 raised, 36 recorded / 19 fixed (2 by decision, 7 quick), 16 refuted, 1 blocked; 2 parallel test-builder calls added 9 cases to 5 existing files, each shown red by reverting its source line. The one defect four finders raised (`platform-guard`, shard 3, integration, `session-debugger`) was the resume path's move check reading a WSL record's transcript on this machine, so a `/bg` move went unproven and its stop was skipped. A Node 24.15 probe refuted shard 3's readline hang: the iterator throws the stream's error into the catch. Four `session-debugger` findings, one from maintainability and one from performance re-raised the first pass's ledger with no new evidence. The blocked step is the Command Terminal, which has no session row and so none of the `/bg` handling. Every fix landed on a clean path, so the commit carried all of them, then this row |
Row one is the format's own review, and it is weak evidence for the hunk tier: four of its six
files were body tier, so the finders were mostly reading whole bodies. The integration finder is
excluded from the reads column throughout, since it deliberately receives no pack. What the row
does establish is that the reporting works end to end on its first run, and that the driver
refuted five of eleven candidates, which is the falsifiable-finding contract doing its job on a
pack whose every line number it then verified (2682 of them, zero mismatched).

Row two is the first hunk-heavy sample: 25 of its 39 files were hunk tier. Of the 21 reads beyond
the pack, 17 were files outside the changed set (callers of `autoSpawnForTask`, the lock, the
registry, the engine's abort checkpoint), which is criterion work no context width removes. The
other 4 were re-reads of pack-carried files: the unchanged gap between `agent-spawn.ts`'s two
hunk groups (roughly lines 300-620, the `startAgent` closure) twice, because two finders needed
it to answer a question about a changed guard,
`docs/mobile-bridge.md` once for an unchanged line, and `session-resume-controllers.ts` once as a
full body the pack already carried. So the hunk tier cost 3 gap reads on this diff, and one
finder re-read a body it had; that is the number to watch, not the 21.

Row three is small and all partial tier, with no hunk sections, so it says nothing about
`HUNK_CONTEXT_LINES`. Of the 17 reads beyond the pack, 12 were outside the changed set: adapter
greps to check a `probeAuth` regex, the UI mock's agent list, and a rule file. The other 5 were gap
reads inside windowed bodies. Two finders read `WelcomeScreen.tsx`'s `DetectionRow` render (roughly
lines 78-142), which sat just past the 20-line window of the prop the change added. One grepped the
same file for the panel width, one read the spec's launch helper, and one read the `seeds` type in
`scenes.ts`. So the partial tier's 20 lines stopped short of the component a changed prop feeds
twice on this diff.

Row four is the first sample where the body budget, not the file, decided the tier. The pack
counted 198KB of full-body cost against the 200KB cap but wrote 69KB, because 6 of its 7 bodies
were windowed. That left no room for `demo/posters.mjs`, a 110-line file, so it went in as hunks.
Three of the 4 reads beyond the pack were re-reads of hunk-tier files: `demo/posters.mjs` in full
by two finders that needed its call order, and the gap above a changed assertion in
`tests/demo/static-demo.spec.ts` once. The fourth was `.gitattributes`, outside the changed set,
for a line-ending question. A small file squeezed out by windowed bodies that were billed at full
cost is the case to watch here.

Row five is hunk-heavy on a small diff. Six of its 10 files were hunk tier, including the two
largest, the UI mock (5041 lines) and `BoardManagerDialog.tsx` (2627 lines). Of the 30 reads beyond
the pack, 23 were outside the changed set: the Codex adapter behind the mock's KEEP IN SYNC comment
(three finders), the capability hooks the column form reads, `format-tokens.ts`, `model-id.ts`, and
rule files. Four of the other 7 went into hunk-tier files, and they split two ways. Two finders read
`BoardManagerDialog.tsx` for how the column form resolves its own agent (`effectiveAgent`, its
display names, and its permissions, lines 1173-1182). That code sits 4 to 13 lines past the overview
hunk's 3-line window, so a 20-line window would have carried it. This is the first row where
`HUNK_CONTEXT_LINES` was too narrow for a finder's question. The other two read the mock past its
Codex hunk for the other agents' entries, which run about 140 lines, so no context width covers
them. The last 3 were a render-branch read in the windowed `DataTable.tsx`, a grep of the UI spec
outside its window, and one finder's dash scan over files the pack already carried.

Row six is the first pack past the Read tool's output cap. The skill sizes the load at one call
per 2000 lines, but the first 2000 lines of this 285KB pack came back as 58,377 tokens against the
tool's 25,000, so the call failed and the finders were told to read it in six 650-line calls. The
pack is still read once per finder; only the call count changed, and a pack this wide will need
the same until the skill sizes calls by bytes. Of the 17 reads beyond the pack, 4 were files
outside the changed set (the capture rig, to learn whether it runs the seed without a recordings
index) and 13 were the conventions finder's, 9 of them re-reads of pack-carried files to check a
comment against the code around its hunk.

Row eight has a 2050-line file in the hunk tier (`demo-dataset.ts`) and ran 6 finders, because no
domain auditor's glob matched. Of the 28 reads beyond the pack, 22 were outside the changed set:
the renderer files behind the new scene's selectors, the UI mock's dictation methods, rule files,
and the tests around the moved `selectTier`. Of the other 6, one is a second case for a wider
`HUNK_CONTEXT_LINES`. The correctness finder read `demo/boot.js` for the line that sets the boot
veil (523), which a changed helper tests for. It sits 14 lines above the 3-line window of the
hunk that routes click steps through that helper, so a 20-line window would have carried it. The rest are not about
width. Two finders read the gap in the partial-tier `transcription-service.ts` to learn whether
an import the diff left in place was still used, and the use sits over 100 lines from either
window. One read a whole rule file for its contract, one grepped every `click:` step in
`scenes.ts`, and one re-read `detect-hardware.ts` for an import line the pack's window already
showed.

Row ten is small and all partial tier, like row three, so it says nothing about
`HUNK_CONTEXT_LINES`. Both reads beyond the pack were the correctness finder's and fell outside
the changed set: `electron-builder.yml`, to learn how the macOS bundle and executable names are
derived, and a repo-wide grep for a renamed constant. No finder re-read a file the pack carried.
Three of the seven candidates were one issue, raised by three dimensions, so the kept count is
the dedup, not a refutation.

The task 727 row reviewed uncommitted work before any PR existed, so it is keyed by task. Its
pack was 133KB, past the Read tool's output cap at 2000 lines, so the finders loaded it in three
620-line calls. Five of the six pack-carrying finders read nothing else. The sixth,
`platform-guard`, read two gaps in the hunk-tier `gh-client.ts`: the `execFileAsync` binding near
the top of the file and the sibling `gh` methods, to compare the new call's argv against them.
Both sit far outside any hunk, so this is not a case for a wider `HUNK_CONTEXT_LINES`. The driver
refuted 3 of the 10 findings: a `Promise.all` that would have broken the `gh` queue's concurrency
cap, and two coverage holes, one already pinned by an existing test and one that changed no
output. It also found one that no finder raised. A timer-driven re-poll inherits the arming
caller's `force` flag, and a comment claimed otherwise.

The #723 row has one behavioral file, `demo/boot.js`, and it keys on DOM markers the renderer
stamps. So 22 of its 28 reads beyond the pack went outside the changed set: the files that stamp
each marker, xterm's own source for whether it stops an Escape, the keybinding registry, the scene
registry, and rule files. Of the other 6, one is a third case for a wider `HUNK_CONTEXT_LINES`.
The correctness finder read `CommandTerminalLayer.tsx` for its `panel.close` binding (309), 6
lines past the 3-line window of the comment hunk that describes it. Two were gap reads no width
closes. The spec's `hostFrame` and `focusAcrossFrame` helpers sit 67 to 93 lines above the
partial tier's window, and `enableTerminalClipboard`'s signature sits 29 lines above its hunk's.
The rest were a rule file read whole for its contract, a grep of the spec for an unchanged test,
and a dash scan over the changed files. It ran 8 finders because a comment-only edit under
`src/renderer/utils/` gated `hmr-parity` and a `path.join` context line gated `platform-guard`.
Neither found anything.

The #728 row hit the Read tool's output cap again, like row six, but for one finder only. The
IPC auditor's first 2000-line call failed on the 25,000-token limit, so it read three targeted
windows and skipped the analytics sections as off its checklist. The other finders reported
loading the pack in the two calls the skill sizes. Of the 10 reads beyond the pack, 5 were outside
the changed set: the correctness finder's removed-surface greps and a failed Glob for node-pty's
helper source, and the conventions finder's pass over the `trackEvent` call sites and the installed
Sentry minidump integration. Four were the conventions finder re-reading pack-carried files to
quote exact lines. The last is a `HUNK_CONTEXT_LINES` case. The IPC auditor read `system.ts` lines
575-629 for the `SHELL_EXEC` input guard, which sits just above the 3-line window of the changed
spawn. The driver refuted four of the 11 candidates, each for a stated reason:
- A fail-open ordering case had no SDK-shaped trigger.
- Two platform nits changed no behavior.
- One coverage hole was on code the diff moved without changing.

The task 734 second-pass row re-reviewed the same task's uncommitted work after its first pass.
At 260KB and 4765 lines the pack is past the Read tool's output cap at 2000 lines, and the skill
still sizes the load at one call per 2000 lines. At least three finders (`hmr-parity`,
conventions, `platform-guard`) had that call fail on the 25,000-token limit and fell back to
smaller windows or greps. Two of them reported skipping sections off their checklist rather than
loading the whole pack. So the call-count rule is now wrong for most packs this size, the same
finding as row six. Of the 6 reads beyond the pack, the correctness finder's 4 were outside the
changed set (the adapter's cache path, MCP spawn-override validation, and the model union hook)
or in a window gap of the probe test. The IPC auditor's 2 were the UI mock and `agent-list.ts`,
both outside it. None was a `HUNK_CONTEXT_LINES` case. The driver dropped 11 of 31 candidates.
Most were informational or off the diff. Two convention findings graded against a prompt worded
more strictly than the rules they cited, a hover-only claim on a supplementary `title` and an
adapter-boundary claim on a call that does not branch on an agent.

The task 734 third-pass row is the same task again, with the two earlier passes' tests now
committed and the source still uncommitted. The conventions finder hit the 25,000-token Read cap
on a 2000-line call and loaded the pack in smaller windows, as in the second pass. The IPC, HMR,
and `platform-guard` auditors were told to jump to their sections by the table of contents
instead of loading all 5814 lines, and none reported missing anything. The maintainability
finder did not report its reads, so its count is absent from the 16. Most of the 16 were outside
the changed set: the agent-list handler and config store (IPC), `paths.ts` (`platform-guard`),
and test files for coverage.
None was a `HUNK_CONTEXT_LINES` case. The one High finding came from verification, not from a
finder as raised. `platform-guard` flagged the exact `cliPath` compare as a Low case-sensitivity
nit. The driver traced the spawn path to `resolveShimLaunch`, which swaps an npm `claude.cmd` for
its `.ps1` or extensionless sibling, so the compare always failed there and the spawn-time alias
conversion never ran. The driver dropped 7 of 35 candidates: two duplicates of a non-atomic
write already self-healing on read, a speculative ASCII glyph fallback, a forced-probe cost that
predates the change, a documented cold-start pass-through, an informational mock note, and a
`closeMenu` extraction the effect deps rule out.

The task 529 row is the first pack no finder could load. It reviewed a whole feature branch against
`main`, and at 61,990 lines a full load is 31 Read calls at the skill's 2000-line sizing, several
times what a finder's context holds. So the driver departed from the skill and sharded by AREA
instead of by dimension. Eight area finders each applied every universal criterion, plus the
removed-surface and red-green checks, to their own list of `offset`/`limit` ranges taken from the
pack's table of contents (2,700 to 6,200 pack lines each). The four gated auditors got only the
ranges their globs matched, and the integration finder got the signature delta as usual. The one
stubbed file, `KnowledgeGraphCanvas.tsx` at 1,963 new lines, went to one area finder as a disk read
counted inside its shard. Two things were lost, and both are worth knowing before this happens
again. Coverage was answered by grepping `tests/` rather than by loading the roughly 22,000 lines of
changed test sections, so the changed test files were not themselves reviewed line by line. And no
finder saw the whole change, so a cross-area interaction reached review only through the
integration finder's delta; it found nothing, and verification found none either. The reads
column is a hand tally over twelve reports and is approximate. Most of the 47 were gaps in
hunk-tier files that a finder's criterion needed (a sweep's timer lifetimes, a handler's dispose
path), and one was a range outside the finder's own list, read by mistake and unused. Of about 94
raised findings, 38 were applied, with tests written for each behavior fix. The rest were skipped
with a reason or refuted; two refutations were a summary-pass retry loop that converges and a
schema comment that contradicted a deliberate delete. The skill has no path for a pack this size,
and the sharding here was improvised; a threshold (about 6,000 pack lines per finder) and the
TOC-driven shard lists are the part worth writing into the skill.

The task 529 second pass re-reviewed the same branch after the first pass's fixes landed. It
closed the gap that row named: the roughly 25,000 lines of changed tests went to four test shards
of 5,981 to 6,611 pack lines, each with test-specific criteria, and they raised 23 of the 106
findings. Those included two assertions on test ids that no longer exist in the renderer, a
fixture two rows short of the count it claimed, a guard test whose only discriminating assertion
never touched the skip list it named, and a client name in a comment. The eight source shards ran
2,726 to 6,070 lines, with the stubbed `KnowledgeGraphCanvas.tsx` read from disk inside its shard.
Two mechanics changed. The finders loaded their ranges in 600-line calls, and none reported the
25,000-token cap failing. The shared criteria went into three brief files that every finder read
first, so the driver no longer wrote the criteria out once per finder prompt. The one High finding
came from `platform-guard`. The one-shot CLI runner wrote answer prompts of tens of thousands of
characters to stdin with no `error` listener, so a CLI that exited early would have thrown an
uncaught EPIPE in main. The driver refuted three findings. Two asks racing in one chat are
impossible, because the store refuses a question while a turn is in flight. A warm session cannot
cross projects, because its key carries the search URL. A queued question already stays in the
draft. The main-process and renderer test-builders ran in parallel on disjoint files. One
reverted shared source briefly while the other ran, so the driver re-ran every touched unit file
and UI spec afterwards.

The task 529 third pass kept the second pass's layout and added one input. Before the fan-out the
driver wrote the working-tree line ranges changed since the last review began (its own fix commit
and the four commits after it) to a short file every finder read after its ranges, so the lines no
independent reviewer had seen got the closest look. The pack was built once and never re-based, so
the preexisting-dirty list it writes stayed valid. The signature delta came from a script over the
pack's marked lines, 139KB of it, well past "a few hundred tokens"; a 367-file branch has that many
exported signatures, and the integration finder read it in 600-line calls. Of about 85 raised
findings, 55 were applied and 2 refuted: a store that pins its instance and keeps a dispose stash
(the documented `session-store` shape), and a settings change asking for a rebuild of a stale map,
which is the user's own act. The rest were skipped with a reason, most of them performance work
that needs a measurement first. The highest-value finds sat in code the earlier passes had read:
closing the graph mid-answer killed the warm session and failed the kept turn, a node selection
kept by array position showed another conversation after a rebuild, and a multi-chunk change
record listed its own header as a changed file. Two side effects are worth knowing. On Windows the
new process-tree stop ran a real `taskkill` against a fake child's pid in an existing test (pinned
to the POSIX path since), and a test-builder's first red run printed `process.env` through a
matcher over spawn options, so the neighbouring assertions now read single fields.

The task 529 fourth pass ran on a pack half again the third's size, because the branch had since
moved every PTY into a `kangentic-pty-host` utility process and the index into a retrieval worker.
Shards were cut along those two process boundaries rather than by folder, so one finder held both
sides of each protocol, and each shard's brief named the rule files for its area, since rules do not
auto-load in a subagent. The focus file covered `e01fbbff` onward, the third pass's own fix commit
included, and the removed-surface list was scripted from that range's diff with removed class
methods added (`purgeAll`, `purgeProjectIndex`), which an export-only scan missed. Two practical
limits showed. The session allows 20 concurrent subagents, so four of the 24 finders started as
slots freed. And the signature delta, built from the changes since the last pass rather than the
whole pack, came to 1,515 lines instead of 139KB. Of five High findings, four were fixed and one
was refuted by experiment: freeing the old vec0 table writes to its shadow table, which better-sqlite3's
defensive mode was said to refuse, and a probe under Electron's better-sqlite3 with sqlite-vec
0.1.9 deleted the block and dropped the table without error. The fixed ones were a summary pass
whose failure backoff any board change bypassed, a rejected host spawn that left a promoted queue row
`queued` for good, a live transcript flush that took the seq the legacy conversion wrote next, and a
legacy row whose session lived in an unmigrated project, which stopped the whole storage upkeep.
Two test-builders ran in parallel on disjoint files and were barred from touching `src/`, so red-green
was argued from the code rather than toggled; one of them found the host-loss notice stamped before
its focus gate, fixed in this pass. The two POSIX-only tests for `~/.claude.json`'s mode and symlink
have not run on Windows and get their first run on CI.

The task 529 fifth pass kept the fourth pass's layout and changed how a finder got its shard. A script
copied each shard's pack sections into one file, with the focus ranges at its top, so a finder read
one contiguous file in 600-line calls rather than a list of offsets. Each gated auditor got a file
built from its own glob. The migration auditor's took the whole `src/main/db/migrations/` folder,
since the skill's gate still names the single `migrations.ts` the schema has since outgrown. The
session allows 20 concurrent subagents, so 9 of the 29 started as slots freed. The scripted
removed-surface list caught 2 of the focus range's real removals; the driver found the rest (a
protocol field, a worker event, five reshaped methods) in the diff's removed lines and grepped them
itself before the fan-out. Four finders independently found the Medium the spawn-cancel commit
missed: the MCP task delete dropped the promise `removeByTaskId` now returns, so a worktree could
go while a cancelled spawn's PTY still held it. The other fixed Mediums were a question queued from
Quick Find that the map's first snapshot wiped, an Ask that still ran a paid answer after its chat
ended during the prepare, a retrieval worker that died before ready and so never announced its
replacement, a summary backoff that any Knowledge Graph setting ended, a code index that stored its
head over a failed file, and a closed-project guard the record sweeps bypassed. One test-builder
found two gaps in the driver's own fixes (the mean pool still wrote a NaN row, and a prepare failure
went unflagged), both fixed in this pass. The skipped Mediums are four performance claims that need
a measurement first, a camera fix that needs a look in `/preview`, and recovery for a host crash
that takes a session before its agent id is known, which is a design question.

The task 529 sixth pass kept the fifth pass's layout. A script rebuilt each shard file from the
fifth pass's file lists, the 11 files new since then were placed by hand, and the pty shard was
split into its host and session halves (3,748 and 3,443 lines), since at 6,926 lines it was past
the roughly 6,000-line ceiling. The focus range ran from `0537ddd1` to HEAD, the fifth pass's own
fix commit included. The UI spec holding most of the range's new test code was stubbed in the pack
for size, so its finder read the focus ranges from disk. Two finders read less than their shard and
said so: the second cross-platform auditor stopped at 1,400 of 6,234 lines and one source shard at
2,400 of 5,393, each after its focus ranges. The Mediums all sat in the newest code. The pty host's
crash recovery, which the fifth pass's follow-up added, ignored every exited row when it chose the
lost tasks to start fresh, so a resume whose spawn failed got a fresh agent over it; its locked
re-check also missed a Reset, which deletes no record, and a Resume then a Pause. It now counts
every row but the lost ones, and compares the task's `session_id` and the record's status. Two
finders reported the first independently, one as Low and one as Medium. The others were a Quick
Find question asked while reopening the map on another project, which went to the old project and
was then dropped; an Ask one-shot run that still started when the chat ended between the last check
and the spawn; overlapping settings reconciles that each ended the summary backoff; a request that
timed out while the pty host was down and still ran on its replacement; a `~/.claude.json`
fallback write that deleted the only complete copy when it failed; and a deferred orbit pivot that
re-pointed a fly at the whole map. Two findings were refuted: a package-smoke entry check said to
miss a path in another letter case (Node derives the entry URL from the same `realpathSync` of
`argv[1]`), and a trust-manager coverage hole that the existing test file already covered. The
fifth pass's skipped host-crash question above was resolved by the commit that followed it.

The orbit fix was then checked in `/preview` on a mirrored real index (1,008 nodes), with the
scene hook's own `frameNodes` and `setOrbitAnchor` called from its fiber so the race was exact:
fly to one subset, anchor mid-flight, fly to another before the camera rests. With the pre-fix
hook restored the pivot came to rest 3.63 world units off the second fly's target, on the default
view's centre; with the fix it stayed on it. The first reading said both versions passed, because
camera-controls reports rest some frames before it emits `sleep`, which is when the stale listener
fires; a measurement of this listener has to wait for `sleep` itself. A UI test now runs the same
race and waits the same way; against the pre-fix hook it fails at 38 units. The two Low findings left for
a decision were then fixed: a PTY whose program is the app's own executable is refused like a
one-shot run, and the startup auto-spawn skips a task whose worktree is no longer the one it was
prepared in.

The task 529 seventh pass kept the sixth pass's layout. The same script rebuilt the shard files from
the sixth pass's lists, one new file (`tests/ui/helpers.ts`) was placed by hand, and the focus range
ran from `59861b3d` to HEAD, the sixth pass's fix commit included. `retrieval-store.ts` was stubbed
in the pack this time, so its finder read it from disk inside its shard. Eight finders stopped after
their focus ranges: each prompt named a focus, and they read it as the limit of the job. Each was
resumed with the rest of its shard, so every shard line was read, and the resumed reads raised
nothing new. A prompt that names a focus has to say in the same line that the whole shard is read.
The one Medium sat in the newest code. The sixth pass's fix for a Quick Find question asked while
reopening the map on another project still lost it when a snapshot read for the old project, in
flight across the close, landed after the reopen. Two finders found it independently. The Lows fixed
were a summary backoff that switching summaries off ended, a naming run that announced a project
forgotten while it ran, OpenCode's post-answer session delete recorded as the chat's run and so
stopped when the chat ended, an unlink of deleted tasks' commits written as one uncapped transaction
outside the write budget, and the `'\''` escape `quoteArg` writes, which cut the own-executable
check's path short. The driver refuted two Mediums about the resume pass. A To Do bounce deletes the
task's records, which the resume's locked re-check already catches, and its re-check and cancel log
were pinned by tests the finder's grep missed. The pass first ended with eight findings skipped,
three of them waiting on a decision: whether a resume that fails in its preparation may fall back to
a fresh agent (at startup and after a host crash alike), whether a task moved mid-preparation into a
manual column keeps its Resume, and when a kept `~/.claude.json` copy is worth keeping. The user
decided all three, and a follow-up commit fixed all eight. A resume that cannot be prepared now keeps
its conversation behind a paused placeholder when it has one, and the orbit test sets up its race in
one task, red at 38 units without its fix. A review that ends on a skipped decision with the user at
hand should ask and fix, not hand the decision back in the verdict.

The task 529 eighth pass kept the seventh pass's layout and changed two things. Every prompt, the
shared context file and each shard's focus heading said in the same line that the focus is where to
look hardest and the whole shard is the job, and every finder reported reading all of its shard, so
none was resumed. And the 4,143-line Knowledge Graph UI spec, stubbed in the pack for the third pass
running, got a finder of its own that read it from disk in full; `retrieval-store.ts`, also stubbed,
went to the smallest source shard. That finder found nothing, which closes the gap the sixth and
seventh passes left by reading only its newest ranges. The focus ran from `5f827c0d` to HEAD, about
360 lines of source. The one source Medium sat in it: the seventh pass's own follow-up made a resume
whose preparation failed keep its record resumable, but did so outside the task lock from the
gather-time snapshots, so a Resume during the preparation could see its retired record CAS'd back to
suspended and its live agent's `session_id` cleared. It now runs under the lock with the spawn pass's
re-check, which both now share. Three findings were refuted. A coverage hole the finder's grep missed:
a moved-task test existed, and only its To Do and Done exclusion was unpinned. A kept
`~/.claude.json` copy swept after another writer replaced the file, which needs two independent
failures and sits inside the user's decision to sweep kept copies once a run. And a projection pass
said to read a closed database after the last page's pace: the loop checks its abort at the top of
each page with no await before the read. The driver applied that last one before a test-builder,
asked to pin it, showed no test could go red, and the checks came out again.

The task 529 first-build progress row reviewed one commit on top of the merged branch. The pack in
`.kangentic/` was gone before any UI spec or preview ran in the pass, so the driver rebuilt it,
copied it to the session scratchpad, and gave every finder that path. The HMR auditor hit the
25,000-token Read cap on a 2000-line call and loaded the pack in targeted ranges, as the task 734
passes did. The correctness finder's 3 reads beyond the pack were all into window gaps: two in
Partial files (the store's `close` and `open`, and `resolveEmbedding` in the graph service) and one
in a Changed hunks file (the `readDocumentSums` fraction in the projection engine). That last one is
the only read this row can charge to `HUNK_CONTEXT_LINES`. The IPC auditor's one was
`window-broadcast.ts` by grep, outside the changed set. The performance and conventions finders did
not report their reads, though both cite `settings-card.tsx`. The driver kept 19 of 20 candidates
and refuted one: a width transition on the shared progress track, a file the diff did not touch,
under a composited-motion rule that governs only the activity marks. A test-builder filling a
coverage hole found a twentieth issue the finders missed: a repeat progress push arrives as a fresh
object, so the identity guard meant to make it a no-op never held.

The task 735 pre-PR pass is hunk-heavy: 40 of its 49 files were hunk sections. Its 259KB pack
passed the Read tool's cap, as row six's did, so every pack-carrying finder loaded it in 6 to 9
calls instead of the 3 its prompt sized. Of the 10 file reads beyond the pack, 3 were outside the
changed set (`task-git.ts`, `task-move.ts`, `child-tree-stop.ts`). The other 7 were gaps in
hunk-tier files: `dev.js` for the ephemeral gate above its boot sweep, `index.ts` for the condition
around its preview branch, `spawn-with-abort.ts` for its external-signal wiring, `task-crud.ts` for
its rename guards, `worktree-preview.js` for its own liveness check, and `worktree-manager.ts` twice.
The `dev.js` gate sat 8 lines above its hunk, so a wider window would have carried that one. Seven
of the 19 distinct findings were refuted, and the two that needed an owner's decision were asked
during the pass and fixed in it.

The task 736 pass reviewed a whole feature branch at 14,017 pack lines, more than twice the
roughly 6,000-line ceiling, so it reused task 529's layout at a smaller scale. Six area shards of
929 to 3,318 pack lines each applied every universal criterion to their own TOC ranges: the
process readers and pty host, the kill plan and tag, main's wiring, the renderer, build and docs,
and the E2E specs. Each source shard carried the tests for its own sources, so the red-green
question was answered inside the shard rather than by a grep. The four gated auditors and
`migration-safety` got only the ranges their globs matched, and the integration finder got the
signature delta. One shared brief file held the summary, the criteria and the return shape, and
every finder loaded its ranges in Read calls of at most 600 lines. None reported the Read cap
failing. Of about 34 reads beyond the pack, most were rule files and callers a criterion named,
and one shard did not report its reads. The highest-value finds came from the shards that held
each file's tests next to it: a label path that could carry command-line text, a home directory
reached through a link that became a reap root, and a WSL reap that could boot a stopped default
distro. Two candidates were refuted: the integration finder called `bg-shell-watcher.test.ts`
deleted when only one block of it was, and an E2E toast-lifetime race could not occur, because
the toast is created after the kill it reports. A test-builder's attempts to mutate four Windows
safety gates for red-green were blocked by the permission classifier, so those tests rest on
their positive controls.

The task 736 second pass kept that layout at 15,295 pack lines: seven area shards of 1,254 to
3,257 lines, each gated auditor on its own glob, and the integration finder on a 640-line delta
that now carries two-space class and interface members as well as exports, since the first
version missed `CommandOptions.taskProcessTag` and the new `SessionManager` methods. A scripted
check of the platform gate (every file whose added lines use `child_process`, `path.join`,
`rmSync` or a dash) put nine more files in it, so the cross-platform auditor ran as two finders
of 3,723 and 3,955 lines. The focus ran from `3a19e486`, the first pass's fix commit, to HEAD.
The shard files and the brief lived in the session scratchpad, not `.kangentic/`, after the 529
row that lost its pack mid-pass. Every finder reported reading all of its shard. The one High
came from the driver, not a finder: a scoped run of the existing tests the fixes touched failed
in `resource-cleanup.test.ts`, whose call to `cleanupStaleResourcesAsync` omits the leftover
options the branch made required and reads first. Tests are not typechecked and no finder runs
tests, so that run, made before the test-builders started, is the only step that could catch it.
The Mediums were reap safety at reader edges: a tmux server whose binary an upgrade replaced lost
its protection on Linux, a failed `lsappinfo` dropped the visible-app protection on macOS, and a
cleared-tag child under a withheld orphan was killed with it. Four candidates were refuted,
among them a Windows `describe` gate one finder doubted and another showed pinned by a test. Two
test-builders worked on disjoint files with `src/` closed to them. One showed red-green by
applying each revert to a copy of `src/` in the scratchpad, which kept the working tree clean.

The task 736 third pass kept that layout at 16,632 pack lines: seven area shards of 1,409 to
2,835 lines, six gated auditors on their own ranges (cross-platform in two of 3,680 and 3,720
lines, and `migration-safety` on the 85 lines of `types.ts`), and the integration finder on a
722-line delta that keeps only the import lines of test files. The focus ran from `e56ba0af`,
the second pass's fix commit, to HEAD. A scoped run of the 40 unit files that import the reap
sources passed before the fan-out, so no finder had a broken test to explain. Two finders
independently found the second pass's `lsappinfo` fix incomplete: `runTool` resolved its stdout on
any exit, so a run that exited with an error still read as a list with no windows. The other
Mediums were a root the second plan dropped (its directory moved, or its tag read null) reported
as stopped while it still ran, a package smoke cleanup that could SIGKILL a recycled pid, and the
WSL script's drive-letter case fold and `grep -z` probe, which no test would have failed without.
Seven candidates were refuted, among them a `flushAll` gap that only the quit path can reach. The
three test-builders had `src/` closed, and the driver showed red-green itself by reverting each
fix in place, running the file, and restoring it. The WSL cases are Linux-only and this host's
Ubuntu distro has no node, so a test-builder proved the script logic, and each revert's red, in a
WSL shell harness with the same shim text. The vitest cases themselves first run on CI.

The task 736 fourth pass kept that layout at 17,163 pack lines: eight area shards of 1,582 to
2,804 lines (the renderer and shared types got a shard of their own), six gated auditors on their
own ranges (cross-platform in two of 4,083 and 3,572 lines), and the integration finder on an
893-line delta. The focus ran from `11d60d38`, the third pass's fix commit, to HEAD, which added
one commit: the WSL reap leaving out a task with a live or starting session. Before the fan-out a
scoped run of the 48 unit files the branch changed passed, as did `bg-shell-watcher.test.ts`
(its diff is deletions only, which a list built from changed tests misses), seven parity tests,
and the leftover-processes UI spec against the helpers main had just merged in. Two finders
independently found that newest commit incomplete. It read the live sessions once, before up to
three `wsl.exe` calls, so a To Do task dragged into a running column during a slow listing could
still lose its new agent. The reap now asks again just before the script runs and logs how many
tasks it left out. A session that starts during the script's own second can still lose its agent,
and the comments that said the sweep cannot reach one now say that. Of the three other Mediums,
two were test gaps. A batching test could not fail, because its first request finished before the
report-only request was queued, and no required check covered the Windows reader's visible-app
and console-host roles. The third was skipped as an owner decision: a bulk delete's 60 s
per-task deadline now also covers the reap, whose WSL leg alone can take that long when
`wsl.exe` wedges, so such a delete reports a cleanup failure while its removal finishes later.
The rewritten batching test was shown red under both ways a merged batch could go wrong (the stop
setting OR'd, and the first request's kept). Three candidates were refuted, among them a task-row
read outside the reap's `try` that the same function already makes, unguarded, a few lines
earlier. As in the third pass, `src/` was closed to the two test-builders and the driver reverted
each fix in place to see its test go red.

The task 736 fifth pass kept that layout at 17,608 pack lines: ten area shards of 936 to 2,374 lines
(the activity engine and agent files got their own), six gated auditors on their own ranges
(cross-platform in two of 3,197 and 3,732 lines), and the integration finder on an 855-line delta.
The focus was `1e87a06d`, which cut the three `wsl.exe` bounds from 15 s, 15 s and 30 s to 5 s, 5 s
and 10 s. Before the fan-out the driver ran the 49 changed unit files, the four unit files main had
just merged in that touch branch files, and four UI specs against the merged mock, and all passed.
The brief asked five questions about that commit, and seven finders answered the third one the same
way: the startup sweep passes every archived and To Do task to one `wsl.exe` command line, with no
bound. The driver measured it rather than trusting the arithmetic. 210 tasks with a worktree each
failed with `ENAMETOOLONG`, so the reap now sends the tasks in batches under a 24,000-character
budget that share the 10 s, and the patched function ran 600 such tasks as five calls in 2.5 s.
Measurement also refuted the two concerns most finders raised next. The script costs about 2 ms a
task over 37 distro processes (300 tasks in 0.67 s), so the 10 s bound is far off. And terminating
`wsl.exe` ended the in-distro script before its next command, so a reap past its bound kills nothing
more. Four finders raised that one and none could decide it from the code. Two coverage claims were
refuted by tests the finders had not found (`task-reap-plan.test.ts:110`,
`task-process-tag.test.ts:112`). The one other fix was a reap report that matched a force-pass
survivor to its root by pid alone, so a reused pid could report a stopped root as failed.

The task 736 sixth pass kept that layout at 17,970 pack lines: ten area shards of 1,004 to 2,153
lines, six gated auditors on their own ranges (cross-platform in two of 4,241 and 4,194 lines), and
the integration finder on a 764-line delta. Since the fifth pass one copy commit (`fd92045c`) had
landed and main had been merged in, so before the fan-out the driver ran the 49 changed unit files,
three parity scans, and the leftover-processes and settings UI specs against main's rewritten UI
helpers, and all passed. Every finder reported, and nothing above Medium survived verification. The
driver refuted four candidates by reading the code: a stale barrel mock on a path the test's warm
reopen never reaches, an empty `every()` whose test pins its title with a later resume assertion, a
claim that the WSL script never runs under test (the Linux real-process test runs it), and an 8.3
gap that `fs.promises.realpath`, a native call, does not have. The kept fixes were small. A
survivor's label merged by pid could rename a stopped root whose pid it took. A failed own-session
lookup in the Windows reader compared every process against session 0, and with that fix reverted
the reader opened a session-0 process with `PROCESS_VM_READ`. A label's file check could stat an
unreachable share. The backlog demote scoped its reap to whatever project was open when its lock
came free. The real-process unit test's cleanup signalled pids it had already seen die. The
finders raised six Mediums: the pass applied two (that cleanup, and koffi missing from the docs'
native module lists), refuted two, and skipped two. It skipped 22 findings in all, most as owner
decisions or documented trade-offs. The two skipped Mediums were the failed-stop row copy
(`rowDetailOf` returns the generic failure line before any keep reason, so a tmux row invites a
retry without its warning) and the macOS record parser decoding a whole `KERN_PROCARGS2` record
to strings. Among the Lows were that parser's title and argv tolerances and a Linux role read
whose refusal leaves a process unprotected. Two test-builders worked with `src/` closed and
showed red-green on scratch copies or test-side stand-ins; the driver then reverted each of the five
fixes in place, saw its test go red, and restored it.

The task 736 seventh pass kept that layout at 18,670 pack lines: ten area shards of 1,017 to 2,198
lines, six gated auditors on their own ranges (cross-platform in two of 4,587 and 4,278 lines), and
the integration finder on a 771-line delta. Three commits had landed since the sixth pass: its
fixes, its audit row, and a test commit that runs the reap E2E with worktrees on and pins the
release build's upload flag. Before the fan-out the driver ran the 51 changed unit files, and
alongside it the 22 unchanged ones that import a file those commits touched; all passed. Two Mediums
survived. Three finders (Area D and both cross-platform halves) found that the sixth pass's UNC
guard in `process-label.ts` let the long-path forms `\\?\UNC\host\share` and `//?/UNC/host/share`
through to the stat it exists to skip. Two found that the reap E2E's new worktree poll sat between
the reap and the toast assertion, and a report of stopped processes only is a toast that closes
after the default 4 s, so a slow removal would fail the spec. The toast is now checked first. Four
finders confirmed that `comparable` in `task-directories.ts` matched `normalizeDirectory` character
for character, so it now calls it. The two refuted candidates were a listener singleton that only a
second IPC registration could reach and the quit-only `flushAll` gap decided earlier. Nine Lows were
skipped. Among them is a Windows scan that cannot learn its own session or user and so reports
nothing, which two finders raised and the tests pin on purpose. A test-builder filled three holes
with `src/` closed: the long-path UNC case in the plan, the worktree's real path in the reap
request, and the WSL bounds, which had run only on a Windows host and now fake the platform so CI's
Linux runs them. The driver reverted the label guard, the UNC strip and the real-path lookup in
place and saw each test go red. The toast reorder was only run green, once on Windows with worktrees
on, since a timing race cannot cheaply be forced red. The WSL tests were checked off Windows only
under a faked platform on this host, so their first real Linux run is CI. At the user's request a
follow-up then fixed all nine skipped Lows (`656f5dd8`). For the owner decision on the blind Windows
scan it chose failing the scan over counting the skipped rows, because `unreadableCount` reaches
only a log line while a failure reports `reap_error`. The driver showed four of the fixes red in
place: the scan failure, the toast that now closes with its evicted report (in the store and in a UI
case against `App.tsx`), the upload parity table, and the lockfile comparison. The reap E2E's Linux
start-time check first runs on CI.

The task 736 eighth pass kept that layout at 19,217 pack lines: eleven area shards of 860 to 2,215
lines, six gated auditors on their own ranges (cross-platform in two of 4,514 and 4,328 lines), and
the integration finder on a 1,023-line delta. The focus ran from `727bf24b` to HEAD: the seventh
pass's fixes, the follow-up for its nine skipped Lows, and a doc commit on Stop and late children.
Before the fan-out the driver ran the 51 changed unit files, 31 unchanged importers and parity
tests, and the leftover-processes UI spec, and all passed. It also grepped the whole repo once for
the branch's removed surface and told every finder there were no survivors, so none repeated that
grep. Every finder reported reading all of its shard, and nothing above Low survived. The one gap
two finders raised was `normalizeDirectory` stripping the `\\?\` device prefix but not `\\.\`, so a
`\\.\UNC\server\share` root was not refused as a share root, although `process-label.ts` already
read that form as a share. The other kept fixes were small. The Review list vanished when twenty
newer reports evicted the report it showed; that report now stays while the list is open. Two test
cleanups could signal a recycled pid: the reap E2E's Linux start-time check failed open with no
reading, and the real-process unit test kept the pids its reap had killed when an assertion failed
first. The WSL reap's `wsl.exe` inherited main's own tag when Kangentic runs from a task's
terminal. The real-process workflow's path filter now names `vitest.config.ts`. Ten candidates were
refuted, among them the macOS titled-process undercount, which `darwin-reader.ts` already
documents, and a WSL leave-out gap for a parked session that is past its grace and force-kill by
the time the wait gives up. Seven were skipped. The one that needs an owner is that Linux and macOS
read roles only for tagged processes and their descendants, so an untagged visible app above a
tagged child is not protected. Reading ancestors too could classify a desktop shell as visible and
protect everything under it, so it needs measurement first. One coverage claim was half wrong:
`task-process-tag.test.ts` already pinned the WSL script budget's decrement and exhaustion, so the
new `wsl-reap-script-budget.test.ts` keeps only the cases it missed. Two test-builders worked with
`src/` closed and showed red-green on mutated copies through a scratch vitest alias. The driver then
reverted the device-prefix fix, the open-report exemption, the label pattern's backslash half, the
token query check and the tag strip in place, and saw each test go red.

The task 736 ninth pass kept that layout at 19,642 pack lines: eleven area shards of 893 to 2,260
lines, six gated auditors on their own ranges (cross-platform in two of 4,530 and 4,403 lines), and
the integration finder on a 1,029-line delta. The focus was `ec95aa25`, the eighth pass's fixes,
and `2971793e`, which only wrote down the two decisions that pass left to the owner. Before and
alongside the fan-out the driver ran the 52 changed unit files, 41 unchanged importers and parity
tests, the mock parity and project-scoped IPC tests, and the leftover-processes UI spec, and all
passed. Every finder reported reading all of its shard, and nothing above Low was raised. The focus
held: both cross-platform halves and Area C found the `\\.\` strip consistent with
`process-label.ts` and pinned by tests that fail on revert, and Areas D and E showed the
`wsl.exe` tag delete red-green and the host passing that environment through unmerged. The
applied fixes are prose. The host process table falls back to PowerShell for good on any failed
Toolhelp listing, not only when koffi cannot load, and the header, the rule, three docs and its
test now say so; the latch itself is unchanged. The deployment doc's workflow row names `vitest.config.ts`, and two audit paragraphs lost
their broken wraps. Six candidates were refuted, among them a Windows token guard no test can pin
because the overrun check after it always refuses the same input, and the task-row read outside
the reap's `try` that the fourth pass already refuted. Two were skipped: Linux reading a
backslash in a project path as a separator, and two rows of the new budget test that overlap
older cases while adding assertions those cases lack. A test-builder pinned the newly documented
role decision on Linux, an untagged GUI parent and sibling of a tagged process reading no role,
and the driver reverted the reader's seeding in place and saw that test go red.

The task 741 pre-PR pass is small and mostly body tier. Its one hunk section is the 5,315-line UI
mock. Of the 17 file reads beyond the pack, 12 were outside the changed set: the main handler and
repository behind the default writes, `config-store.ts`, `App.tsx`, the walkthrough hook, and four
sibling specs. The other 5 were gaps in pack-carried files. Two were in `SettingsPanel.tsx`, packed
as one window over lines 47-101, where the correctness and maintainability finders both needed the
selectors above it and the project switcher below it. Two were in the mock, whose `setDefault*`,
`rename` and `relocate` methods sit 60 or more lines from its nearest hunk, so no plausible
`HUNK_CONTEXT_LINES` would have carried them. One was a grep of `project-store.ts` for every writer
of `projects`. The one Medium, a stale initial tab applied by the new relocate re-key, came from the
maintainability finder, and the driver found it on its own while verifying.

The task 741 second pass reviewed the same change plus the first pass's two commits. Of its 15 reads
beyond the pack, 9 were outside the changed set: the IPC auditor's five greps across the channel
layers, the relocation hook, `App.tsx`, one rule file, and one repo-wide grep. The other 6 were gaps
or searches in pack-carried files, and `SettingsPanel.tsx` again drew two of them, since its one
window over lines 47-101 leaves out the selectors above it and the switcher below it. The integration
finder read three file bodies although its prompt carried only the signature delta. The one kept
correctness finding, an explicit-target write that merged over `{}` while the panel's refetch was in
flight, needed main's `saveProjectOverrides` to confirm, because main replaces the whole file.

The task 746 pre-PR pass shows the cap biting at half row six's size. Its pack is 117KB and 2079
lines, and its first 2000 lines still came back over the Read tool's 25,000-token cap, so every
pack-carrying finder that tried the prompt's two calls fell back to 650-line chunks. Three of them
(the IPC auditor, the performance finder, migration-safety) then read only the ranges their
checklist needed, so their clean results cover those ranges only. Of the 11 reads beyond the pack,
3 were outside the changed set: `auto-spawn.ts` for the insert that follows a spawn, the
guarded-sync-writes rule for its scope, and a grep of `docs/architecture.md`. The other 8 were gaps
in hunk-tier files: `session-manager.ts` three times, `transition-engine.ts` twice, and
`sessions.ts`, `session-spawn-flow.ts` and `resume-suspended.ts` once each. The `session-manager.ts`
reads went to the `resize()` stash branch, which ends about 20 lines above a one-line comment hunk,
so a partial-tier window would have carried most of it. Both Medium findings came from that
branch.

## 15. Converging in one pass: measured before the finders changed (2026-10-06)

Tasks bounced between Executing and Code Review 3 to 9 times, and traces of tasks 736, 749, 762,
761 and 765 put the bounce on the process rather than on code that stayed unsafe: the old prose
verdict said Needs revision whenever anything was skipped, and no verified Critical or High was
ever left unfixed in tasks 736, 749 or 762. Phase 1 of task 767 replaced that verdict with
`scripts/review-verdict.mjs` (Ready or Blocked, nothing skipped, decisions applied and recorded,
a `Refuted:`/`Decisions:` ledger in the review commit). The finder changes were held back until
the experiments below, each with a decision rule fixed before it ran
(`scripts/review-eval/decide.mjs`, pinned by `tests/unit/review-eval-decide.test.ts`). The corpus,
harness and runbook are in `scripts/review-eval/`.

### 15.1 Corpus

| State | Commit | Pack | Late defects | Positives | Negatives |
|---|---|---|---|---|---|
| S1, task 736 pass 1 | `ec65a7ae` | 14,017 lines, 146 files | 4 | 8 | 3 (1 dropped by the validity rule) |
| S2, task 762 pass 2 | `89dbaff4d` | 4,881 lines, 39 files | 2 | 0 | 3 |
| S3, task 749 pass 5 | `bc04af481` | 7,640 lines, 52 files | 2 | 0 | 1 |
| S4, task 765 pass 2 | `e1ce85c8e` | 2,221 lines, 18 files | 0 | 3 | 0 |

Every pack was rebuilt by the shipped `build-review-pack.mjs` with `--out-dir` and `--shard-lines
1500`, and each matched the line count the historical pass recorded. Only S1 and D3 are reachable
from a pushed ref (`refs/pull/499/head`); the rest are pinned by local tags.

### 15.2 E4: verdict replay (no model calls)

59 historical passes (20 item-level from the traced tasks, 39 verdict-line passes from the
2026-09-27 to 2026-10-06 tally; 2 passes with no report excluded, 1 duplicate removed), each skip
mapped by the pre-registered rule and run through the real verdict function
(`scripts/review-eval/run-verdict-replay.mjs`).

| Reading | Old Needs revision | New Ready (bounces avoided) | Still Blocked |
|---|---|---|---|
| As mapped | 41 | 35 | 6 |
| macOS-only checks runnable on the CI macOS leg | 41 | 38 | 3 |

No pass whose old report did not say Needs revision becomes Blocked. The six still Blocked: task 736 passes 1, 4 and 5
(each needs a Mac to verify a reader change), and task 749 passes 1 and 2 and task 758 pass 1 (each
needs a live CLI reply captured). The replay is counterfactual: fixing a skip can raise new
findings. E3 (15.5) tested a delta round built to catch them, and it caught none. Section 17
replays the same passes with follow-up items counted as blocked, which changes these counts.

### 15.3 E1: correctness lane

Two repetitions per state. Arm A replayed the historical driver's correctness prompt as one finder,
and for S1 the six historical area shards. Arm B ran the same prompt over 1500-line shards from
`--shard-lines`. Arm C ran arm A's shape on Opus at the agent's medium effort. Arm D, added at the
E1 checkpoint, ran arm B's shard prompts at high effort. On S1 every arm got
the correctness criteria only, plus the union of the area shards' change-specific checks, so only
the shape and the model varied. A blind scorer, given anonymized reports, matched findings to the
ground truth by file and mechanism.

| Arm | Late hits per repetition (mean) | Late ids found | Negatives raised | Raised (all states, both reps) | Cost (both reps) | Wall time per pass |
|---|---|---|---|---|---|---|
| A, today's shape | 1.0 | S2-L2, S3-L1 | 0 | 44 | $13.92 | 1 to 6 min |
| B, 1500-line shards | 0.5 | S2-L2 | 2 | 72 | $13.42 | 1 to 2 min |
| C, one Opus finder | 1.0 | S2-L1, S3-L1 | 0 | 20 | $23.12 | 3 to 13 min |
| D, shards at high effort | 1.0 | S2-L1 (both reps) | 4 | 110 | $37.09 | 3 to 6 min |

Rule outcome: B, before and after arm D (`{"chosen":"B","eligible":["B","A","C","D"],"bestHits":1}`).
The rule cannot separate the arms here. The best arm's whole recall is 1.0 late hit per repetition,
so the one-hit tolerance admits every arm and the cheapest wins, by $0.50 of about $14, a tie. The
user kept B at the checkpoint, since it also matches the earlier choice of sharded Sonnet.

What the numbers say beyond the rule:

- Recall is low for every correctness shape. Three of 8 late defects were found, and only arm D
  found one in both repetitions, at 2.8 times B's cost. All four S1 late defects (WSL argument
  length, the ignored `processIdToSessionId` return, environment inheritance, the `\\.\` prefix)
  were never found by any shape. Run-to-run variance dominates shape and model at this sample size,
  which matches the Snyk VulnBench result that extra findings are random across runs.
- The correctness lane is not the whole review. S3-L2 (`pushSummaryActivity` pushing re-reads for
  projects no map has read) was never raised by any correctness shape, and the E2 performance
  finder raised it in all four of its runs (15.4). S4's three known findings, which every
  correctness shape missed, came from the maintainability and coverage finders. Dropping a
  dimension to save cost would cost recall.
- B shards are blind to whatever lands in another shard. The pack is ordered by churn, so some
  shards held only test files, and those finders reported the production-code checks as out of
  scope.
- B raised 1.6 times A's volume, much of it one stale-comment Low repeated by every S1 shard. Under
  the fix-everything contract, volume is work, which is E2's question.
- B rediscovered the most of what the historical pass found: on S1 it hit 5 of pass 1's 8
  positives in one repetition, against 3 for A and 1 for C.

### 15.4 E2: a precision bar on every finder

Arm A was today's prompts for the whole fan-out: the correctness lane in B's shard shape, plus one
performance, maintainability, conventions and coverage finder each. Arm B added the bar to every
one of them: raise only a correctness or security defect with its triggering input, a stated
requirement the change misses (a coverage hole counts), or a violation of a named rule, each with
`file:line` evidence, and nothing subjective. S2 to S4, two repetitions. Arm A's correctness lane
reuses E1 arm B's runs, whose prompt files are byte-identical. The integration finder was left out
because its input is a driver-built signature delta, not the pack.

| Arm | Late hits per repetition (mean) | Late ids found | S4 positives found | Negatives raised | Raised | New spend |
|---|---|---|---|---|---|---|
| A, today's prompts | 1, 2 (1.5) | S3-L2 (both), S2-L2 (rep 2) | P1, P2, P3 in both reps | S2-N1, S2-N2 | 117 | $12.18 |
| B, the bar | 1, 1 (1.0) | S3-L2 (both) | P3 in both reps | S2-N1 | 47 | $18.92 |

Rule outcome: not adopted (`{"adopt":false,"recallHeld":false,"volumeCut":0.5983}`). The bar cut
volume by 60%, twice the 30% the rule asked for, but recall dropped. The gap is one late defect,
S2-L2, and arm A's hit on it came from the reused E1 arm B rep 2 shard, so it rests on one run. The
positives are the clearer signal: the bar kept S4-P3 and lost P1 (a real exit misread as a failed
fork) and P2 (a parameter list that repeats the crash record), both raised by the maintainability
finder in every arm A run. The four things bundled with the bar (the bar itself, a required `fix`
field, "a real defect is never Low", and a JSON return shape) did not ship.

### 15.5 E3: a delta round over the fix commit

One correctness and one conventions finder read a pack of a single fix commit against its parent,
with the commit's own message as context and the historical criteria. The criteria carried nothing
shaped like a known defect, which would have leaked the ground truth. D1 to D4 each hold a defect a
later pass found in that commit; D5 is task 761's fix round, the control. Two repetitions.

| Case | Defect | Caught (of 2 reps) |
|---|---|---|
| D1 | `readSideAsImage` compares the recent-write fingerprint after reading, not at read time | 0 |
| D2 | `pausedTaskIdsOf` counts a task with a queued respawn as paused, and the commit's test pins it | 0 |
| D3 | `stoppingEnabled()` moved above the `try`, so a throw it caught now escapes and a test fails | 0 |
| D4 | the `fork_failed` guards in `UtilityPtyHostTransport.ensureChild` still had gaps | 0 |

Rule outcome: not adopted, 0 of 4 caught in both repetitions against a bar of 3. Three reports
reached the defect site and cleared it: two on D1's stat and read, one on D3's guard outside the
`try`. A narrow round costs little (about $0.57) and finds little. On the D5 control, one
repetition raised a Low correctness finding (a missing `git` binary's ENOENT read as a quiet missing
file) and the other raised none. So no delta loop shipped. What did ship is cheaper and aimed at
D3's failure: Step 7 now also runs, scoped, each existing unit test file that imports a source file
a fix touched.

### 15.6 What shipped in Phase 2

- **Correctness lane: B.** `--shard-lines 1500` on the Step 4 pack, one Sonnet-medium correctness
  finder per `shards:` range, the other dimensions on the whole pack as before. A shard of tests may
  read the production code it exercises, the one gap B's test-only shards showed. That is a change
  from the measured prompt, which kept each shard to its own files. Phase 2 had the driver merge
  adjacent ranges when the fan-out would pass the harness's 20-agent limit. The task 732 passes in
  section 14.5 then showed merged ranges going unread, so Step 5 now keeps the script's ranges and
  starts the extra shards as slots free.
- **A later pass reads a since-review pack.** When an earlier pass left `*(review)` commits, every
  finder except the correctness lane gets a pack based on the parent of that pass's first commit,
  so the earlier pass's own fixes are reviewed along with the task agent's work since. The run of
  review commits is found by subject prefix, not `--grep`. This is not measured. The one check run
  against it: S3-L2's code (`shownSummaryActivity`) did not exist at task 749's pass 4 review
  commits, so the since-review pack would still have carried it to the performance finder. Track
  it in the dogfood record.
- **Step 7 runs the existing tests a fix could break,** scoped: the unit test files that import a
  touched module, or only those named after it when more than five do. A file that also fails with
  the fix reverted was already broken and becomes a follow-up, not a Blocked verdict. Section 17
  replaced that rule. Such a file is now fixed in the pass or becomes a blocked step.
- **Read calls of at most 1000 lines.** Several Phase 0 finders hit the `Read` tool's 25k-token cap
  on 2000-line calls over dense packs.
- **Not shipped:** the precision bar and its bundle (15.4), and the delta loop (15.5).

### 15.7 Cost and caveats

Phase 0 cost $144.82 at the 2026-09-25 price table (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10 per million
input/output tokens), against a $300 stop line:

| Item | USD |
|---|---|
| E1 finders, arms A to C | 50.46 |
| E1 support (ground truth, E4 mapping, scorers, exploration) | 12.56 |
| Arm D finders | 37.09 |
| Arm D scorers | 3.28 |
| E2 new finders | 31.10 |
| E2 scorers | 3.44 |
| E3 finders | 5.67 |
| E3 scorer | 1.22 |

Advisor calls and the driver session are billed outside these figures.

Caveats:

- The historical prompts include driver hints written after the driver had read the change, which
  helps every arm the same way.
- Late defects are few (8 over 3 states), so a one-hit difference is within run-to-run noise.
- The scorer is one blind agent per case. It matched on mechanism, and its judgment calls are in
  each scores file's `notes`.
- Only S1 and D3 are reachable from a pushed ref, so a rerun elsewhere has two cases unless new
  states are pinned.

## 16. Haiku 5.5 for the finders and the gated auditors (2026-10-07)

Claude Haiku 5.5 shipped on 2026-10-07. A request of up to 100,000 prompt tokens costs a twentieth
of Sonnet 5.5's price per token, and one above that costs five times Haiku's own base rate. Every finder and gated
auditor ran Sonnet, so the question was which of them Haiku could replace. The rules were written
as code and committed before any model call (`adoptFinderModel`, `pickFinderModel` and
`adoptAuditorModel` in `scripts/review-eval/decide.mjs`, the block in `scripts/review-eval/README.md`).

### 16.1 Pricing by request size

`cost.mjs` used to sum tokens per model and price the sum, which cannot see a per-request tier. It
now prices each request on its own: input plus cache read plus cache write over the card's
`promptTokens` puts all five token classes, output included, on the `above` rates. `tally.mjs`
prices the same way and counts the requests over the tier. At 767's price table the new pricer
reproduces E2 arm A's cost: $7.39 for the reused correctness lane and $12.17 for the other four
finders (section 15 printed $12.18, a sum of rounded rows).

E2 arm A's own transcripts, repriced at today's rates, cost $16.54. The same per-request token
stream priced as Haiku would cost $2.79, with 107 of its 363 requests over 100k: 91 of 189 for the
whole-pack finders (their largest prompt is about 270k) and 16 of 174 for the correctness shards
(about 114k). That figure is a floor, since Haiku does not send Sonnet's token stream.

### 16.2 E5: Haiku as every universal finder

E2's shape (1500-line correctness shards plus one performance, maintainability, conventions and
coverage finder each), S2 to S4, two repetitions per arm. Arm M was Haiku at the agent's medium
effort, arm H Haiku at high, both on the `Agent` call. Every transcript answered from
`claude-haiku-5-5`. One blind scorer per case scored M, H and E2 arm A's existing reports mixed
together. Arm A re-scored to exactly its recorded numbers, so the scorer did not drift.

| Arm | Late hits per repetition | Late ids found | S4 positives found | Negatives raised | Raised | Cost | Requests over 100k |
|---|---|---|---|---|---|---|---|
| A, Sonnet medium (E2) | 1, 2 (1.5) | S3-L2 (both), S2-L2 (rep 2) | P1, P2, P3 in both reps | S2-N1, S2-N2 | 117 (58, 59) | $16.54 | none priced (no tier) |
| M, Haiku medium | 2, 2 (2.0) | S2-L2, S3-L2 (both) | P1, P3 in both reps | S2-N1 | 168 (87, 81) | $6.77 | 308 of 552 |
| H, Haiku high | 2, 3 (2.5) | S2-L2, S3-L2 (both), S3-L1 (rep 2) | P1, P2, P3 in rep 1; P2, P3 in rep 2 | S2-N1 | 201 (100, 101) | $12.59 | 616 of 838 |

Rule outcome: no arm adopted, so the finders stay on Sonnet:

```json
{"chosen":null,"passing":[],"verdicts":{"H":{"adopt":false,"lateHits":2.5,"recallHeld":true,"positivesHeld":false,"negatives":1,"negativesHeld":true,"totalRaised":201,"volumeHeld":false},"M":{"adopt":false,"lateHits":2,"recallHeld":true,"positivesHeld":false,"negatives":1,"negativesHeld":true,"totalRaised":168,"volumeHeld":false}}}
```

What the numbers say beyond the rule:

- Haiku found more late defects than Sonnet: S2-L2 in all four Haiku repetitions against one of
  Sonnet's two, and arm H found S3-L1, which E1's one-finder arms had found and E2's had not. With
  4 late defects over 3 states that is within run-to-run noise, but it is not a recall loss.
- It failed on the two bars that hold the driver's work. M lost S4-P2 (a parameter list that
  repeats the crash record) in both repetitions, and H lost S4-P1 (a real exit misread as a failed
  fork) in one. M raised 1.4 times arm A's findings and H 1.7 times, and under the fix-everything
  contract every one of them is an Opus verification the cost column does not show.
- Haiku is not twenty times cheaper here. It read more: its correctness shards reached prompts of
  333k (M) and 383k (H) against Sonnet's 114k, so 44% (M) and 74% (H) of their requests crossed
  the 100k tier. M cost 41% of arm A and H 76%.
- The Haiku runs made 32 advisor calls (9 for M, 23 for H), billed outside these figures. Arm A
  made none.

### 16.3 E6: Haiku as a gated auditor

A detached scratch worktree of HEAD per auditor, each with one planted missing item and one
planted extra one. `doc-auditor` got a new channel constant with no row in `docs/architecture.md`,
and a row for a channel that does not exist; its prompt was the one `/pull-request` gives it.
`ipc-auditor` got a preload method the mock no longer provides, and a mock method with no channel,
type, preload or handler behind it. Sonnet and Haiku ran twice each with only the model varied.
Every extra item a report raised was checked against the planted tree by hand.

| Auditor | Model | Plants found (both runs) | False findings | Cost per run |
|---|---|---|---|---|
| doc-auditor | Sonnet | 4 of 4 | 0 | $0.52, $0.46 |
| doc-auditor | Haiku | 4 of 4 | 0 | $0.05, $0.08 |
| ipc-auditor | Sonnet, medium | 4 of 4 | 0 | $0.13, $0.13 |
| ipc-auditor | Haiku, medium | 4 of 4 | 0 | $0.01, $0.01 |

Rule outcome for both: adopted
(`{"adopt":true,"candidateFound":4,"incumbentFound":4,"of":4,"candidateFalse":0,"incumbentFalse":0}`).
The extras every run raised were true of the tree: an existing prose gap in `task:sessionResync`'s
row, a `handle` pattern where other rows say `invoke`, a Dev-only header that has no count by
design. One Sonnet doc-auditor run printed totals of 355 and 354 channels where the tree has 322 and
322, which is a wrong count rather than a reported gap. One Haiku ipc-auditor run said the missing
mock throws "whenever any task-detail view mounts"; the component that calls it is imported
nowhere, which only the other Haiku run noticed. The gap it reported is real.

### 16.4 What changed

- `.claude/agents/doc-auditor.md` and `.claude/agents/ipc-auditor.md`: `model: haiku`.
  `ipc-auditor` keeps `effort: medium`.
- `review-finder` stays on Sonnet at medium. The integration finder, which uses the same agent, was
  never measured, since its input is a driver-built signature delta (section 15.4).
- The other gated auditors (`platform-guard`, `hmr-parity`, `session-debugger`,
  `migration-safety`) were not measured and stay on Sonnet.
- On Amazon Bedrock the `haiku` alias still resolves to Haiku 4.5, so there the two auditors run a
  model this round did not measure.
- E6 measured a targeted audit of two changed files. `/release` runs `doc-auditor` over every
  anchor, which reads far more and is the run most likely to cross Haiku's 100k tier. That run
  was not measured.

### 16.5 Cost and caveats

The round cost about $30 at the 2026-10-07 price table, against a $75 stop line. Sonnet 5.5 is $2
input, $10 output and $0.10 cache read per million tokens. Haiku 5.5 is $0.10 and $0.50 up to
100,000 prompt tokens per request and $0.50 and $2.50 above. Haiku's 1-hour cache-write rate is
not published, so it is priced at twice input ($0.20, and $1.00 above the tier).

| Item | USD |
|---|---|
| E5 Haiku finders | 19.35 |
| E5 scorers (Opus) | 5.64 |
| E6 auditors | 1.38 |
| Knowledge Graph model round (Ask and summary replays, captures, scorer) | 3.64 |

The Knowledge Graph round's 12 summary capture calls printed plain text with no cost line, so
$0.35 of that row is estimated from the replays of the same batches. Advisor calls and the driver
session are billed outside these figures.

Caveats:

- The scorer is one blind agent per case, as in section 15, and its judgment calls are in each
  scores file's `notes`.
- The S4 positives bar decided E5, and it rests on one finding missed per arm.
- E6's plants are single mechanical gaps in a small diff; an auditor in a real review sees more.
  Two runs per model.
- The ipc-auditor prompt named the two edited namespaces, as a review pack's hunks would.

## 17. Out-of-diff items go back to Executing, not to a follow-up task (2026-10-19)

A pass used to put a verified item it could not fix in place into `followUps` and file one grouped
To Do task per pass ("Follow-ups from code review: <title>"). The Executing column's Apply findings
message already told the task agent to apply findings "here in this task, not as follow-up tasks",
so the review was the last path still filing them. Task 846 retired the field.

### 17.1 Evidence

- 25 "Follow-ups from code review" tasks were filed from 2026-10-07 to 2026-10-19. Three are
  follow-ups of follow-ups (tasks 783, 789 and 801), because a review of a follow-up task files its
  own. One parent task spawned four (tasks 782, 784, 785 and 786), one per pass.
- Task 840 went from Code Review back to Executing twice and left tasks 843 and 845 behind. Its
  second pass (`af4193eb8`) ended Blocked and still filed task 845, so the card went to Executing
  while its out-of-diff items went to To Do.
- Neither task needed a person. Task 843 is a mock fix whose only open check is the UI tier, which
  `/pull-request` runs on CI in Testing. Task 845's first item is an escaping helper and a unit
  test.

### 17.2 What changed

- A verified item ends fixed in the pass or as a non-quick `blocked` finding with a `step`. An
  out-of-diff item the pass understands is fixed there, with a decision when it has more than one
  valid design. A fix whose only unrun check is an unscoped test tier counts as fixed, because
  `/pull-request` runs that tier on CI behind the pass.
- `blocked` is the only route to the task agent. "Back for revisions" sends "Do the numbered steps
  above its verdict", and that block lists only what `computeVerdict` counts as a blocker.
  `followUps` never reached `computeVerdict`, so rewording the skill alone would still have ended
  `Verdict: Ready` and sent the items nowhere.
- `scripts/review-verdict.mjs` refuses a `followUps` key, even an empty one, and a `followUpTask`
  key, with a message that says where the items go instead. A driver on stale instructions fails
  at the script rather than filing a task. `kangentic_create_task` is out of the skill's
  `allowed-tools`, but that only drops its pre-approval. The root `.claude/settings.json` allows
  every `mcp__kangentic` tool, which task agents need, so a review session can still call it. The
  script refusal and the skill's rule are what stop a pass from filing a task. A deny rule written
  into the Code Review column's per-session settings would close that, and was left out of this
  change because it is a board feature, not a skill edit.
- A test file that already fails on the base is fixed in the pass or becomes a step to fix it in
  this task. This replaces the 15.6 rule that made it a follow-up.
- Not chosen: keep `followUps` and have `computeVerdict` count each one as a blocker. That leaves
  two fields with one meaning.

### 17.3 Replay

`run-verdict-replay.mjs` now replays an item mapped `followUp` as a blocked finding. The mapping in
`verdict-replay.json` is unchanged. Four of the 59 passes carried one, and task 749 pass 2 was
already Blocked for a live CLI capture.

| Reading | Ready (of 59) | Bounces avoided (of 41) | Still Blocked | Old Clean now Blocked |
|---|---|---|---|---|
| As mapped, follow-ups not blocking (15.2) | 53 | 35 | 6 | 0 |
| As mapped, follow-ups blocked | 50 | 34 | 7 (adds task 749 pass 4) | 2 (task 741 pass 2, task 751 pass 1) |
| macOS-only checks runnable, follow-ups not blocking | 56 | 38 | 3 | 0 |
| macOS-only checks runnable, follow-ups blocked | 53 | 37 | 4 | 2 |

This replaces 15.2's statement that no pass that did not say Needs revision becomes Blocked: two
passes that ended Clean now do. The corpus predates the follow-up habit, so the live cost is
higher. It is up to 25 extra Executing rounds over 2026-10-07 to 2026-10-19, less the passes that
were already Blocked, such as task 840's second. Fixing more out-of-diff items in the pass is what
keeps that number down.

### 17.4 Loop termination

"Back for revisions" stays at `maxRuns: 3`. A fourth Blocked leaves the card in Code Review with
its verdict and steps showing, which is where a person should step in. Two cases will reach the cap
more often now: a step the task agent cannot do either, such as task 840's live Qwen captures, and
a test file that already fails on the base. The task agent says so in its turn, and the card stops
at the cap waiting on a person instead of on a To Do task nobody watches. Raising the cap waits
until the dogfood record shows passes hitting it.

No ledger line records a step. A step the task agent finished is gone from the code, and one it did
not finish should be raised again. That depends on a later finder seeing it, and neither the full
pack nor the since-review pack carries out-of-diff code nobody touched. So a step the task agent
skipped without saying so can end in a Ready pass. The task agent's own turn is the record.
