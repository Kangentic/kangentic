---
type: Research
title: Open Knowledge Format for agent-read docs
description: What the Open Knowledge Format is, why its pattern should help an agent find and trust documentation, what Kangentic's own measurements showed, and the design rules the docs follow as a result.
tags: [docs, okf, agents, retrieval, research]
sources:
  - resource: scripts/eval-docs-reads.mjs
  - resource: scripts/measure-docs-structure.mjs
  - resource: scripts/docs-bundle.mjs
---
# Open Knowledge Format for agent-read docs

Task 889 asked whether `docs/` should become an Open Knowledge Format (OKF) bundle so an agent can
read one concept instead of a whole file. This page separates three things that are easy to blur:
what the sources say, what Kangentic measured, and what we infer. It ends with the rules the docs
follow because of all three.

## What the sources say

**OKF itself.** Google Cloud introduced OKF on 2026-06-12 as a directory of markdown files with
YAML frontmatter and a few conventions, so that "wikis written by different producers [can] be
consumed by different agents without translation"
([Introducing the Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)).
`type` is the one required key; `index.md` files exist "for progressive disclosure as agents navigate
the hierarchy". v0.2 added provenance, verification and freshness fields
([SPEC.md](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)). The
README's case for it is qualitative: no SDK between the text and the model, progressive disclosure,
provenance, plain git review ([repository](https://github.com/GoogleCloudPlatform/open-knowledge-format)).
**Neither the spec, the README nor either Google post reports a benchmark, an accuracy figure or a
token saving.** The example bundles were all built by Google. Calling OKF "proven" has no published
measurement behind it yet.

**Its lineage.** Google says OKF formalizes Andrej Karpathy's LLM-wiki pattern
([Knowledge Catalog post](https://cloud.google.com/blog/products/data-analytics/scale-okf-bundles-across-an-organization-with-knowledge-catalog)):
an LLM maintains a persistent wiki of curated pages instead of "rediscovering knowledge from scratch
on every question", keeps an index where each page has "a one-line summary" that it reads first, and
periodically lints the wiki for "stale claims"
([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)).

**The same pattern elsewhere.**

- Anthropic's Agent Skills load only each skill's `name` and `description` at startup, "just enough
  information for Claude to know when each skill should be used", read the body when it is
  relevant, and open linked files only as needed. That is why a skill's content is "effectively
  unbounded". The post's two authoring rules apply directly to docs. "If certain contexts are
  mutually exclusive or rarely used together, keeping the paths separate will reduce the token
  usage", and "Pay special attention to the name and description"
  ([Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)).
- Anthropic's context-engineering guidance treats context as "a finite resource with diminishing
  marginal returns" (context rot, from needle-in-a-haystack studies). It recommends keeping
  "lightweight identifiers" and loading on demand, and notes that "folder hierarchies, naming
  conventions, and timestamps all provide important signals". It also gives the cost: "runtime
  exploration is slower than retrieving pre-computed data", and without guidance an agent can chase
  dead ends. Claude Code is the cited hybrid: CLAUDE.md up front, glob and grep just in time
  ([Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- llms.txt is a curated markdown index of `[name](url): notes` lines, because a context window is
  too small for a whole site and "the detail lives behind the links, and is fetched only when
  needed" ([llmstxt.org](https://llmstxt.org/)).
- Claude Code's team reports that agentic search (the model driving grep and glob) beat a vector
  index for code, on mostly qualitative evidence
  ([The Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny)).
  That matters here, because the baseline an index has to beat is an agent that already greps well.

## Why it should work, in theory

Our inference from the sources, stated as mechanisms an experiment can test:

| Mechanism | What it should change | Where it should show |
|---|---|---|
| Routing by description | An agent picks the right concept from a short index without reading bodies | Questions whose words do not appear in the doc, where grep misses on the first try |
| Concept-sized reads | A read returns one topic, not a slice of a large file with its neighbors | Broad questions that need a whole section, and long reasoning where context rot bites |
| Provenance in `sources:` | A code change names the concepts to re-check, not a whole file | Doc maintenance, not agent reading |
| Concept-aligned passages | A retrieval passage carries its concept's summary | Knowledge Graph search over docs |
| Scale | Index cost grows with the number of concepts; grep hits and file sizes grow with the text | A docs tree many times today's 3 MB |

## What Kangentic measured

The details and numbers are in [log.md](../log.md). In short:

- **Round one**, narrow questions with a greppable keyword and no pointer to an index: the split
  changed bytes read by about 2%, inside run-to-run noise. Agents grep, then read a line range, so a
  smaller file buys nothing on that kind of question.
- **Drift**: concept `sources:` would have flagged at least one touched concept for 110 of 128
  historical commits (recall 0.802), the same coverage the old flat mapping had, but they flagged a
  median of 4 concepts for 1 touched. Broad sources (a whole folder, the shared `types.ts`) caused
  part of that. Narrowing them to files raised recall to 0.821 and cut the flagged share from 67% to
  59% of the old file (measured after the change, so not a pre-registered result).
- **Retrieval**: under the Knowledge Graph's embedding model, MRR@10 went from 0.700 to 0.728. Both
  layouts are cut into the same blind 1,600-character slices, so the split barely changes a passage.
- **Routing**: a cheap model found the right concept in its top three picks 91.7% of the time from
  the concept index and 87.5% from the flat file's heading outline. The index lost exactly where a
  description left out the fact asked about.

No test met its pre-registered bar. Today's docs are small enough that a grepping agent does well
without an index, so a null result at this scale is plausible rather than surprising. None of the
results says the structure hurts, and each one names something the first layout got wrong.

## Design rules that follow

1. **Give agents the entry point.** The index only helps if an agent knows to start there. CLAUDE.md,
   which loads up front, names `docs/index.md`. Each folder's `index.md` lists its concepts with
   their descriptions.
2. **Write descriptions as routing keys.** Each description says what is distinctive about its
   concept: the flags, files, failure modes and decisions someone would ask about. A description
   that could be swapped onto another concept ("how Kangentic detects X, builds its command, maps
   permission modes") routes nothing.
3. **One concept, one context.** Split where questions split (one adapter, one table group, one IPC
   area). Keep each concept readable in a single Read, well under 2,000 lines.
4. **Keep headings specific.** Grep and outline routing found what descriptions missed, so a heading
   names its subject ("Codex directory trust"), not a generic label.
5. **Narrow `sources:`.** List the files a concept enumerates or describes. Do not list a whole
   folder or a shared file such as `src/shared/types.ts` unless the concept really tracks all of it,
   or every change to it flags the concept.
6. **Measure again as the docs grow.** `scripts/measure-docs-structure.mjs` reruns the drift and
   retrieval checks at no cost. `scripts/eval-docs-reads.mjs` reruns the agent comparison when a
   person decides it is worth the quota.

## See Also

- [log.md](../log.md) - The pre-registered tests and their results
- [Agents index](../integrations/agents/index.md) - The pilot concept folder
