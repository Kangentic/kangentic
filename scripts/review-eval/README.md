# /code-review replay benchmark

A rerunnable benchmark for changes to `.claude/skills/code-review/SKILL.md` and
`.claude/agents/review-finder.md`. It replays historical review states, runs finder arms over the
pack the shipped `scripts/build-review-pack.mjs` builds, and scores what each arm raises against
ground truth taken from later passes. Results and the first run's outcome are in
`docs/code-review-fanout-audit.md` section 15; the model round's are in section 16.

## Files

| File | What it is |
|---|---|
| `corpus.json` | States S1 to S4 and delta commits D1 to D5: commit, tag, base, reachability, and ground truth |
| `decide.mjs` | The pre-registered decision rules as code (`tests/unit/review-eval-decide.test.ts`) |
| `prepare.mjs` | Makes a detached replay worktree and builds its pack with `--out-dir` and `--shard-lines 1500` |
| `extract-finder-prompts.mjs` | Pulls a historical driver's Agent prompts out of its session transcript |
| `collect-reports.mjs` | Writes each finder's final report under a random id for the blind scorer, plus a key file beside the folder |
| `cost.mjs` | Tokens, USD, advisor calls and tool calls from subagent transcripts, with prices passed in and each request priced on its own rate card |
| `tally.mjs` | Joins a scorer's output with the key, the corpus and the transcripts into per-arm hits and USD for one case |
| `verdict-replay.json` | E4's input: historical passes, each item mapped by the rule below |
| `run-verdict-replay.mjs` | E4: turns each pass in `verdict-replay.json` into a findings report and counts the bounces avoided |

## Reachability

The states are pinned by local tags (`review-eval/S1` and so on). Only S1 and D3 are reachable from a
pushed ref (`refs/pull/499/head`). S2, S3, S4, D1, D2, D4 and D5 exist only in the machine that ran
the first round, because their branches were rebased or squash-merged afterwards. A rerun elsewhere
can use S1 and D3, or pin new states the same way. `corpus.json` records this per entry.

## Ground truth classes

- `late`: a real defect present at the state that an earlier correctness finder had read and missed,
  found by a later pass. Recall is counted on these.
- `positive`: a real defect the pass at that state did find. A good arm should find it too.
- `negative`: an item refuted at least twice in later passes. A good bar does not raise it.

Every entry names `file`, `symbol` and `mechanism` and the line where the defect sits at the state.
The validity rule: an entry whose line cannot be confirmed with `git show <sha>:<file>` is dropped.

## Running a round

1. `node scripts/review-eval/prepare.mjs <id> --scratch <scratchpad>/review-eval` for each case.
2. Spawn finders with the `Agent` tool as `review-finder`. Each prompt is the historical driver's
   prompt for that dimension (from `extract-finder-prompts.mjs`), with the pack path, read plan and
   changed-file list swapped for the replay's. Each prompt names the replay worktree as the ONLY
   repository the finder may read, so a later fix in the current checkout cannot leak in.
3. Arms: A is today's shape (one finder when the pack fits; the historical area shards for S1),
   B reads the header plus one `shards:` range per finder, C is arm A's shape with `model: opus`
   (effort stays at the agent's medium), D (only if A to C leave a gap) is Sonnet at high effort.
4. `node scripts/review-eval/collect-reports.mjs <runs.json> <experiment> <case id> <out dir>` saves
   each finder's final message under a random id, into a new folder. A blind scorer agent gets the
   anonymized files and the ground truth and returns, per finding, the matched entry id or none.
5. `node scripts/review-eval/cost.mjs --prices <prices.json> <transcripts>` per arm, with prices
   from the `claude-api` skill on the day of the run. A model billed by request size gets an
   `above` card beside its base rates, `{ "promptTokens": 100000, "input": ..., "output": ... }`
   with all five classes. Each request is priced on its own: input plus cache read plus cache write
   tokens over `promptTokens` puts all five classes, output included, on the `above` card. The
   output counts those requests per model (`aboveTier`).
6. `node scripts/review-eval/tally.mjs <case id> <scores.json> <key.json> --prices <prices.json>`
   joins the scores, the key and the costs per arm. Feed its hits and costs to `decide.mjs`.

Clean up worktrees with `git worktree remove --force <exact path>`. Never delete by glob: a cleanup
glob in another session once removed a temp folder that session had not created.

## Pre-registered rules (fixed on 2026-10-06, before any run)

- **E1, correctness lane:** the cheapest arm within 1 late-defect hit of the best arm's mean recall;
  B wins a recall tie with C. S4 runs first as the cost probe; if it projects Phase 0 above $300,
  stop and report before S1.
- **E2, finder bar:** adopt the precision bar if late-defect recall does not drop and total raised
  falls by 30% or more. The bar: a finding must be a correctness or security defect with its
  triggering input, a stated requirement, or a named `.claude/rules` or `CLAUDE.md` rule, with
  `file:line` evidence, and no subjective "consider" items.
- **E3, delta verify:** adopt if one correctness plus one conventions finder over a pack of the
  commit alone catches at least 3 of D1 to D4. D5 is reported, not counted: it shows whether the
  narrow delta would start a needless second round. Added before E3 ran (after E1): E3 runs two
  repetitions, and the count is the mean over the two, because a production delta round is a
  single run. A case is caught in a repetition when either finder raises its defect.
- **Arm D (added at the E1 checkpoint, by the user's choice):** Sonnet at high effort in arm B's
  shape, two repetitions over S1 to S4, scored and decided with the same E1 rule.
- **E2 shape (fixed at the E1 checkpoint):** the correctness lane is arm B's shards in both E2 arms.
  The other universal finders (performance, maintainability, conventions, coverage) run as one
  finder each with the historical prompt. The integration finder is left out: it reads a
  driver-built signature delta, not the pack, and so has no replayable input.
- **E4, verdict replay (no model calls):** map every historical skipped item with this rule, then
  run `scripts/review-verdict.mjs` logic over each pass.
  - `blocked`: the skip needs a person or a tool the session lacks: a live CLI or login capture, a
    physical device, a secret. A packaged build, a local measurement, or a fixture the session can
    generate is NOT blocked, because the pass can run it.
  - `fixed` with a decision: the skip waits on a human call (a design or product choice, a
    trade-off, UX copy, a policy).
  - follow-up: the skip is outside the diff AND needs its own design (more than one site).
  - `refuted`: the skip says no change is needed (deliberate, documented, informational).
  - `fixed`: everything else that names a concrete change (optional, style, a small refactor, a
    comment, a coverage hole in any tier, a one-site out-of-diff fix).

  A pass whose old verdict was Needs revision and whose new verdict is Ready is one bounce avoided.
  Run it with `node scripts/review-eval/run-verdict-replay.mjs`, and add `--macos-runnable` for the
  reading that treats a Mac-only skip as runnable through the CI macOS leg.
  The replay is counterfactual: fixing a skip can itself raise new findings. E3 tested a delta round
  for exactly that and it was not adopted (audit section 15).

## Pre-registered rules for the model round (fixed on 2026-10-07, before any run)

Claude Haiku 5.5 shipped on 2026-10-07. These rules choose which model the finders and two gated
auditors run on. They are `adoptFinderModel`, `pickFinderModel` and `adoptAuditorModel` in
`decide.mjs`.

- **E5, finder model:** the E2 shape (correctness in 1500-line shards plus the performance,
  maintainability, conventions and coverage finders), two repetitions over S2 to S4. Two arms:
  Haiku 5.5 at medium (`model: 'haiku'` on the `Agent` call; effort stays at the agent's medium)
  and Haiku 5.5 at high (`model: 'haiku', effort: 'high'`). The baseline is E2 arm A as recorded
  (`E2_ARM_A`). An arm is adopted only if all four hold: mean late hits at least 1.5 - 1; S4-P1,
  P2 and P3 in both repetitions; at most 2 distinct negatives; at most 117 raised. The one-hit
  tolerance alone admitted every E1 arm, so it would pick Haiku on price; the other three bars hold
  the verification work the Opus driver does, which `cost.mjs` never sees. Of the passing arms the
  cheapest wins, an exact tie goes to the lower effort, and none passing keeps Sonnet.
  Every transcript's model is checked before scoring, and the scorer gets E5's two arms mixed blind
  with E2 arm A's existing reports. Arm A's re-scored numbers are reported as a drift check only; the
  rule compares against the recorded baseline.
- **E6, gated auditor model:** `doc-auditor` (and `ipc-auditor` if the round is still under $50)
  over a scratch worktree of HEAD with one planted missing item and one planted extra one. Sonnet
  and Haiku, two runs each, only the model varied. Haiku is adopted only if it finds both plants in
  both runs and raises no more false findings, in total, than Sonnet. A false finding is a reported
  gap the planted tree does not have, checked by hand.

## How the first round ran (2026-10-06)

- **E2 arm A reuses runs.** Its correctness lane is E1 arm B's two repetitions, not new finders: the
  prompt files are byte-identical (historical correctness prompt plus the same shard read plan), so
  a rerun would only have added variance and cost. Arm A ran new finders for the other four
  dimensions only.
- **E3 prompts carry generic criteria.** Each delta finder got the delta pack, the commit's own
  message as context, and the historical correctness or conventions criteria with nothing shaped
  like a known D1 to D4 defect, since a tailored criterion would leak the ground truth.
- **D3's defect path** was corrected after the round to
  `src/main/transition-engine/resource-cleanup.ts`. The scorer matched on symbol and mechanism, so
  the result did not change.

## How the model round ran (2026-10-07)

- **E5's arm A is E2 arm A's own transcripts,** read through explicit `transcript` paths in the
  scoring ledger and scored blind beside the two Haiku arms. It re-scored to exactly the recorded
  baseline (1.5 late hits, S2-N1 and S2-N2, 117 raised), so the scorer did not drift.
- **E6 plants** went into a detached scratch worktree of HEAD. doc-auditor: a channel constant with
  no row in `docs/architecture.md`, and a row for a channel that does not exist. ipc-auditor: a
  preload method the mock no longer provides, and a mock method with no channel behind it.
- **The Knowledge Graph half** ran through `scripts/eval-answer-models.mjs` over calls captured
  from a `/preview` seeded with `dev.seedKnowledgeGraphReal`, its `agent.cliPaths.claude` pointed
  at a scratch tee wrapper. `recommendAnswerLevel` returned `low` for Haiku 5.5, and
  `adoptSummaryModel` returned `{"adopt":false,"nothingInvented":false,"coverageHeld":true}`. One
  setting chooses the model for both jobs, and it has no default, so nothing in the code changed.
- **The counting question is synthetic:** task 529's 300-row table question (its
  `effort-thinking.mjs` prompt), sent through the captured Ask arguments, settings and MCP config.
  Its answers were regraded strictly, a stated 14 and `#300`, because `eval-ask.mjs`'s `grade()`
  is a substring match and reads the 14 inside `#147` as the count. That grader bug is still open.
- **`tableRefsOf` was fixed after the runs.** It split the raw stdin, and the Ask path sends the
  prompt as one stream-json line, so it found no table and every named ref read as invented. The
  fixed reader brought every run's invented refs to zero; no pass or fail changed.
- **The thin summary inputs are thinner than the real board's.** The preview seed mirrors tasks
  from the conversation index, and some of them carry only a title and the seed's own note.
