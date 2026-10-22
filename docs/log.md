# Log

## 2026-10-22

**Creation** of the docs restructure measurement, before any doc moved. `scripts/eval-docs-reads.mjs`
asks a real agent (Sonnet 5.5 at medium effort, Read, Grep and Glob only, no MCP, three runs per
question) the eight questions in `scripts/eval-docs-reads-questions.json` and counts the bytes of tool
output its context received. Four questions are answered in the agent adapter docs, the pilot; four
are answered elsewhere and act as controls. The gate was fixed here, before the pilot ran: the
restructure continues past the pilot only if the drop in summed median tool-output bytes over the
pilot questions is larger than the largest change any control question shows between the two runs,
and no pilot question passes fewer runs than before.
