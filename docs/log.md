# Log

## 2026-10-22

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
