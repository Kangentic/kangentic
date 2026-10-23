---
type: Reference
title: Knowledge Graph index and workers
description: When Knowledge Graph indexing, embedding and task-summary passes run and back off, what Rebuild resets, how the retrieval and embed workers idle out and fall back to keyword search, how the Index card counts sources, the Intel Mac exclusion, and the local model and agent choices.
tags: [knowledge-graph, embeddings, retrieval, summaries]
sources:
  - resource: src/main/retrieval/summary/
  - resource: src/main/retrieval/retrieval-service.ts
  - resource: src/main/retrieval/embedder/embed-client.ts
  - resource: src/main/retrieval/index-counts.ts
  - resource: src/shared/index-summary.ts
    title: sumIndexCounts, isIndexedProject
  - resource: src/shared/embedding-models.ts
    title: EMBEDDING_MODELS
---
# Knowledge Graph index and workers

The Knowledge Graph tab (id `knowledgeGraph`, the Brain icon) hosts conversation search + recall - a local index over agent conversation transcripts, tasks and commits powering the Quick Find "Conversations" group (keyword matches, for you), the Knowledge Graph, and the `kangentic_search` MCP tool (for agents). It was the Memory tab until every card on it turned out to serve the Knowledge Graph.

It is two cards, in setup order. The **Knowledge Graph** card holds the one switch that turns the feature on (`knowledgeGraph.enabled`), then the local model's rows (Search quality, the "Local model" status row, a License line, Model acceleration), then the agent's (Agent, Model and Effort). The local model finds work by meaning and draws the map; the agent answers questions and writes the task summaries. The card replaced two, Semantic search and the Knowledge Graph agent, whose separate switches read as the same feature. It always shows: while indexing is off it is dimmed with the tag "Needs indexing" and its switch reads off, but the switch still works, and turning it on turns indexing on in the same write, so the card is never a dead end above the switch it needs. While its switch is off its rows are hidden and its description stays. The status row is labelled "Local model", never "Model", because the agent's Model row sits below it.

The **Index** card (`knowledgeGraph.indexingEnabled`) lists each source on one line of a `CardSourceList` (`settings-card.tsx`), and ends in one Rebuild: Conversations, Tasks and Commits on locked switches, always indexed while the index is on, then Task summaries and Source code with real switches, both on by default. A line shows its count with a check once caught up, the share done and the time left over a progress track while it runs (no verb: the line's name says what runs), what switching it on would cover while off, muted, and a tag in place of the value while a prerequisite is missing. Both wait for the Knowledge Graph ("Needs the Knowledge Graph"), then an agent ("Needs a supported agent" while no installed agent can answer, "Needs an agent" while none is chosen); Task summaries also wait for a model ("Needs a model"). A waiting line's switch stays usable, so a source can be turned off before the agent that would start it is chosen. It is a System tab, so the figures are every indexed project's, not the open one's: each project with a conversation in the index (`isIndexedProject` in `src/shared/index-summary.ts`, the same set the Knowledge Graph's All projects button selects), read in one `status.indexAll` worker call and summed on main. Each project is counted by the same read as the Knowledge Graph's snapshot (`readIndexCounts` in `src/main/retrieval/index-counts.ts`): a passage counts as embedded only with the selected model's vector, the corpus totals are kept for 30 to 60 seconds per project (the share fixed per project, so they do not all fall due on one poll), and the passages still waiting and the summaries' counts are read on every poll. A project with no vector table yet, one not drained since semantic search was switched on, is counted from its totals instead, so its passages read as waiting rather than embedded. Measured on 19 real projects, a poll costs 8.5 ms, and 173 ms with every database opened cold after a worker restart. A poll reads for at most 2 seconds, stalest projects first, and counts any project it did not reach as it last read, so a busy worker's waits between projects can never run the call past its 15-second limit. A poll that finds passages waiting in a project nobody has open marks it for the embedding drain, as the map's snapshot read does, so a running line always moves; source code counts only while it is switched on, since a project's code index is cleared on its next open while it is off. The Source code line's branch-size estimate is the open project's alone, read from git at most once a minute and only while no project holds code. Session changes are indexed but not listed: nothing searches them, they only feed the task summaries. The Knowledge Graph's Index panel shows the same lines with no switches (`CardSourceList` with `readOnly`, built in `knowledge-graph/index-panel-lines.ts`), both sum the one per-project record with `sumIndexCounts` (the panel through `sumIndex`, which adds the size on disk) and read their line's facts and tags through the same functions (`src/shared/index-summary.ts`, `sourceRequirements` in `tabs/index-sources.ts`), so on All projects the two read the same figures. Both read the Knowledge Graph as on only while its setting is on and the vectors are there (`use-index-source-lines.ts`): the vectors that still draw a map outlive switching it off, and nothing embeds then. The panel carries no rate, so a running line there shows its share without a time left.

On Intel Macs the Knowledge Graph card has no switch. It carries the tag "Unavailable" and one line, "The local model does not run on Intel Macs.", and the Knowledge Graph page shows the same card in place of a map. onnxruntime-node, which the local model runs on and transformers.js pins to an exact version, ships no darwin x64 binding from 1.30.0, so an embed worker forked there would exit on every start. `src/shared/embedding-runtime.ts` lists the targets with no binding (from `embedding-runtime-gaps.json`). On one of them main treats `knowledgeGraph.enabled` as off whatever the config says, so it never builds an embed client, downloads the model, writes task summaries or indexes source code. The renderer reads the same list through `window.electronAPI.platform` and `arch`. The Index card, Quick Find and `kangentic_search` load no model, so they work there by keyword. The Index card's Task summaries and Source code lines, both found by meaning, carry the tag "Unavailable" there in place of "Needs the Knowledge Graph" (`sourceRequirements`).

The local model's status is a `CardStatusRow`: the state on the label's line, its value at the switch's edge, a track while it runs, a check beside a ready value, and a warning or failure state tinted with its icon right before the label while the value stays neutral. Dictation lists its two models in a read-only `CardSourceList` instead, one line per slot, and both tabs name the running models' licenses in a `CardLinkRow` under them. The tab sits next to Dictation (both are on-device, keyless, model-backed AI features). Global-only (per-machine). Keyword search is on by default; the Knowledge Graph is opt-in.

These settings lived under `memory` through v0.43.2. The first launch after reads that block once and writes it as `knowledgeGraph` (`src/main/config/legacy-memory-keys.ts`): `indexingEnabled` and `acceleration` keep their names, `semanticEnabled` becomes `enabled` and `embeddingModel` becomes `localModel`, and a key already set under its new name wins.

The `knowledgeGraph.*` keys, with their types and defaults, are listed in
[App config keys](../settings/app-config.md#knowledgegraph).

Relevance filtering is automatic, with no user-facing threshold. These
sentence-embedding models are anisotropic: unrelated text does not score ~0, it
scores near a high, model-specific cosine baseline (0.52 for bge-small, 0.66 for Granite R2), so a raw
cosine threshold is neither portable across models nor legible to a user. Each
model instead declares an empirical `noiseFloor`, and the search filter rescales
raw cosine against it into a model-independent relevance (`(cos - floor) / (1 -
floor)`); a single internal cutoff then drops off-topic and gibberish hits on
every model while keeping genuine matches. Only the semantic layer is filtered;
lexical (keyword) hits always appear. Applied wherever semantic search runs:
the Knowledge Graph and `kangentic_search`.

Quick Find is keyword-only whatever `knowledgeGraph.enabled` says, and opening it
starts no embedding model; its last row hands the query to the Knowledge Graph,
which answers by meaning. The Index card's "Rebuild the index" reads every source again,
in every project: each project forgets what its sources were read from (never the chunks
or their vectors, so nothing indexed is lost and unchanged text keeps its vector), and the
task summaries written with another agent or model are marked for rewriting. The open project
is read again at once, every other project on its next open, and the other projects' summaries
are rewritten on their next pass: a board change there, or the next launch's ask of every
project. Rebuild asks first only when it
will spend agent calls ("Rebuild everything?", naming how many summaries are rewritten and
about how many calls); otherwise it runs at once. A Search quality change re-embeds on its own.

When the embedding worker crashes three times inside five minutes, the restart
policy stops respawning it and search falls back to keyword matches until the
window decays. The Knowledge Graph card's note then names the reason (`KnowledgeGraphStatus.workerError`:
how the worker stopped plus the first error line of its stderr, for example
`exited with code 1: Error: Cannot find module 'onnxruntime-common'`, or `failed to start` for a
fork that threw), and the
same text is in `<project>/.kangentic/logs/<date>.log` as a
`[utility-process]` warning.
