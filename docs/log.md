# Log

## 2026-10-22

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
