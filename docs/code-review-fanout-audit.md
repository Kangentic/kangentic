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
  `memory.semanticEnabled` defaults off, degrading to FTS5 keyword search that tokenizes
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
