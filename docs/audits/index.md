# Audits

## Point-in-time findings, kept for the reasoning they record

* [Conversation history paging audit](conversation-history-paging-audit.md) - Whether the Conversation viewer can scroll past the 16 MiB transcript read cap (2026-10-21): per-read worker costs on transcripts up to 548 MB, seven options weighed against the August OOM, and the capped paging design built for every agent whose transcript Kangentic reads.
* [Board card drag performance audit](board-drag-perf-audit.md) - Measurements of the board card drag on a production build (2026-09-16): no dropped frames in the gesture, one stall from an xterm built mid-drag that is now held until the drop, and dev mode 4 to 7 times slower on every synchronous cost.
* [Spare worktree audit](spare-worktree-audit.md) - Whether to keep one pre-installed spare worktree per project (2026-10-31): a pnpm workspace's 25 s install becomes a 4.8 s claim, a moved spare breaks every package link, and the four bars set before measuring pass, the claim bar narrowly, so build it for projects with an init script, adopted in place, never moved.
* [Code review fan-out audit](code-review-fanout-audit.md) - Where a /code-review fan-out's tokens went on 2026-08-29 and which driver changes cut them, followed by a running table of every later review pass: pack size, finders, reads, and findings raised, fixed and refuted.
* [Transcript pipeline audit](transcript-pipeline-audit.md) - Hardening the session transcript pipeline for cross-agent use (2026-06-12): a parseTranscript per adapter, Claude parser fidelity fixes, and checks against real session files from six agents.
