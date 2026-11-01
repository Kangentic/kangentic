# Log

## 2026-10-31

**New audit:** `audits/spare-worktree-audit.md`, the measured decision on keeping a pre-installed
spare worktree per project, with `scripts/measure-spare-worktree.mjs` behind its numbers. The same
change corrects `integrations/agents/session-history.md`, which still said a worktree folder follows
a renamed branch. Folders have been fixed at creation since 2026-07-30.

## 2026-10-22

**Review note** on the second-round question set, before the end-to-end run. Five `expect` patterns
pass an answer that only restates its question or names the agents it asks about:
`codex-no-quotes`, `which-agent-starts`, `folder-trust-compared`, `mcp-delivery-compared` and
`agents-without-hooks`. The set stays as registered, so that run's pass-rate check is weaker on
those five than it reads. Tighten them to the mechanism each answer must name before a later round.

**Rollout.** The pilot's measurements did not show an agent reading less, and the decision to roll
out anyway was made on the design argument in `research/okf-knowledge-format.md`: as the docs grow,
an agent should reach the one concept that answers a question by reading descriptions, not by
grepping 100 KB files. Every doc in `docs/` is now a concept, 137 of them under 24 indexes rooted at
`index.md`, which alone carries `okf_version: "0.2"`. The median concept is 14.6 KB. Three are over
60 KB: the code review fan-out audit (a running record), the browser decision log (now one heading
per decision) and `settings/app-config.md` (kept whole as the one key reference, with a heading per
key group). `telemetry/error-reporting.md` (57 KB) had no headings and now has eight. Each concept's
H1 is its title, every `sources:` path exists, and no two descriptions match
(`tests/unit/okf-docs-conformance.test.ts`).
Content moved verbatim except where the split left duplicate or orphaned headings, "see above"
references that now cross files, key tables that moved to `settings/app-config.md` beside the
behavior concepts that link them, and a few stale facts corrected on the way (handoff passes the
source agent's session file; a To Do move resets a task; Asana is an import source). The four audits
keep their bodies. The code review fan-out audit's citations of retired paths are history, and the
citation test skips that file; the other three are scanned, since one line in them pointed at a
deleted doc as the description of what shipped.
CLAUDE.md now points at `index.md` and lost three sections to `settings/settings-panel.md` and
`contributing/`, 28,571 to 23,086 characters in every session's load.

**Correction** to the drift numbers below, and a post-hoc rerun. `headingsOf` reports 1-based lines,
and `measure-docs-structure.mjs` read them as 0-based, so a changed heading line was charged to the
section before it. Fixed, the same concepts give recall 0.802 (89 commits fully predicted, 18 with
none) and the same 67% median size; retrieval is unchanged. Then the pilot's 22 descriptions were
rewritten as routing keys and its `sources:` narrowed to files, per the design rules in
`research/okf-knowledge-format.md`. That is a change made after seeing the results, so these numbers
are evidence, not a pre-registered pass: drift recall 0.821 (91 full, 14 none) with a median of 59% of
the old file flagged; retrieval MRR@10 0.702 and recall@5 0.938 under the embedding model, 0.670 under
BM25.

**Update** with the second round's three cheap tests. None met its bar; each found something to fix.

- **Drift** (`node scripts/measure-docs-structure.mjs drift`): 128 commits changed the flat file with
  a source file, and 2,054 of their 2,065 changed lines mapped to a concept. Recall was 0.785 (bar
  0.8); 87 commits had every touched concept predicted, 18 none, mostly source files at paths that
  no longer exist. The predicted concepts' median size was 67% of the whole file (bar 25%): a commit
  touched a median of 1 concept and flagged 4, because `adapter-types.md` lists the whole adapters
  folder and `src/shared/types.ts`, and `agent-adapter.ts` feeds four concepts. The flat row would
  have flagged 110 of the 128 commits.
- **Retrieval** (`node scripts/measure-docs-structure.mjs retrieval`, granite-r2): MRR@10 0.700 flat
  against 0.728 concepts under the embedding model (bar +0.1), 0.700 against 0.621 under BM25, and
  recall@5 0.875 for both. `codeChunks` cuts both layouts into the same blind 1,600-character slices,
  so the split changes little but one description line per passage.
- **Routing** (Haiku 5.5 at low effort, 96 calls, $0.03): a concept in the top three picks 0.917 of
  the time from the index (22 entries) against 0.875 from the heading outline (158 entries), with
  first picks equal at 0.813 (bar +10 points). The index lost where a description left out the fact
  asked about: Antigravity's says nothing about tokenizing its own hook commands. Most adapter
  descriptions read alike, which is what routing on descriptions cannot survive.

**Creation** of the second round, fixed here before any of it ran. The first round asked narrow
questions that each carried a keyword to grep for, and nothing told the agent where the docs index
was, so it never had a reason to route through one. The theory behind the concept layout (written up
in `research/okf-knowledge-format.md`) predicts gains in four places. Each has a test, cheapest first,
and a reading fixed in advance:

- **Drift detection, no agent.** Every commit before the split that changed `agent-integration.md`
  together with a file under `src/`: map the doc lines it changed to the concepts that now hold them,
  and ask `docs-bundle.mjs sources` which concepts the commit's source files predict. The theory holds
  if recall is at least 0.8 and the predicted concepts' median size is at most a quarter of the old
  255 KB file. Recall under 0.6 means `sources:` do not track authority well enough to help.
- **Retrieval, local compute.** The Knowledge Graph's default embedding model and a BM25 reference
  rank the passages `codeChunks` makes from the old flat file and from the concepts, for the 16
  questions in `scripts/eval-docs-reads-questions-v2.json`. The theory holds if the concepts raise
  MRR@10 by at least 0.1 under the embedding model.
- **Routing, a few cents.** Haiku 5.5 at low effort, with no tools, picks the files that answer each
  question from either the concept folder's `index.md` or the old file's heading outline, three
  times per question per arm. The theory holds if the index routes at least 10 points more often to
  a concept holding the answer.
- **End to end, priced before it runs.** The second-round set against `492f0c474` (flat) and
  `20dbe2a55` (the pilot), with the same prompt naming `docs/README.md` in both arms and the
  harness's own files deleted from both checkouts. The concepts help agents if the pass rate does
  not drop and the 95% interval of the candidate-over-baseline context-token ratio lies below 1. An
  interval that spans 1 is no detectable difference.

Adopting the topic layout for people browsing the repo does not wait on any of these.

**Update** of the restructure: the pilot failed the gate, so the rollout stops here.
`agent-integration.md` was split into 22 concepts under `integrations/agents/` and measured against
the baseline, both at three runs per question. The pilot questions' summed median tool-output bytes
went from 44,654 to 45,631, a rise of 977 bytes. One control question moved by 8,559 bytes between
the two runs while its doc's content did not change, only a few of its links. All 24 answers were
correct in both runs. An agent already greps and then reads a narrow line range of a large file;
after the split it reads a whole small concept instead, and the bytes come out the same. These were
narrow fact lookups with a run-to-run swing near a fifth of the pilot sum, so the result reads as no
saving detectable at this resolution, not as proof that a split can never help.

**Creation** of the docs restructure measurement, before any doc moved. `scripts/eval-docs-reads.mjs`
asks a real agent (Sonnet 5.5 at medium effort, Read, Grep and Glob only, no MCP, three runs per
question) the eight questions in `scripts/eval-docs-reads-questions.json` and counts the bytes of tool
output its context received. Four questions are answered in the agent adapter docs, the pilot; four
are answered elsewhere and act as controls. The gate was fixed here, before the pilot ran: the
restructure continues past the pilot only if the drop in summed median tool-output bytes over the
pilot questions is larger than the largest change any control question shows between the two runs,
and no pilot question passes fewer runs than before.
