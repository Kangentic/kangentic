---
type: Guide
title: Translations
description: "How Kangentic's UI translations are drafted and reviewed: the translation harness that fills the PO catalogs with Claude or a local model, the fuzzy review mark, refining a translation by hand, running a refill after rewording, the glossary, and the local model bake-off."
tags: [i18n, translation, lingui, glossary, local-model]
sources:
  - resource: scripts/i18n/translate.mjs
  - resource: scripts/i18n/cli.mjs
  - resource: scripts/i18n/translate-catalog.mjs
  - resource: scripts/i18n/messages.mjs
  - resource: scripts/i18n/validate.mjs
  - resource: scripts/i18n/context.mjs
  - resource: scripts/i18n/prompt.mjs
  - resource: scripts/i18n/catalogs.mjs
  - resource: scripts/i18n/glossary.mjs
  - resource: scripts/i18n/glossary.json
  - resource: scripts/i18n/engines/claude.mjs
  - resource: scripts/i18n/engines/openai-compatible.mjs
  - resource: scripts/i18n/bake-off/run.mjs
  - resource: scripts/i18n/bake-off/sample.json
  - resource: scripts/i18n/bake-off/arms.json
  - resource: scripts/i18n/bake-off/results.json
---
# Translations

Kangentic's UI text lives in Lingui PO catalogs, one file per area per locale
(`src/locales/<locale>/<area>.po`). [Display language and i18n](../architecture/i18n.md) covers the
layout and the runtime. This guide covers how the translations in those files get written.

A machine drafts every translation first, and people correct it. Claude drafts the first pass for
every language. A local model refills the strings that change after that, so a contributor who
rewords a string can keep the other 14 languages current on their own machine.

## The review mark

A machine translation carries the PO `fuzzy` flag:

```po
#: src/renderer/components/settings/tabs/LanguageTab.tsx
#, fuzzy
msgid "Select display language"
msgstr "Anzeigesprache auswählen"
```

The flag means nobody has reviewed the entry yet. The UI still shows the translation:
`lingui compile` and the Vite plugin read `msgstr` and ignore flags, and `lingui extract` keeps
the flag on every run. `tests/unit/i18n-translation-harness.test.ts` pins both behaviours, so a
Lingui update that started dropping fuzzy entries, as gettext's own compiler does, would fail
there rather than quietly switching every draft back to English.

An entry with a translation and no flag counts as reviewed. The harness never changes it.

## Refining a translation

1. Open the locale's PO file for the area, say `src/locales/de/settings.po`. Each entry names the
   source file it comes from.
2. Edit the `msgstr`. Keep every `{placeholder}`, every `<0>...</0>` tag and the ICU plural
   syntax. A plural needs a case for each category the language uses (Polish and Russian need
   `one`, `few`, `many` and `other`).
3. Delete the `#, fuzzy` line. Poedit's "Needs work" toggle does the same thing.
4. Never edit `msgid` or `msgctxt`. They identify the message.
5. Make the same change in every other area of the locale that holds the message. The renderer
   merges a locale's areas and the last one wins, so a corrected copy does not show while another
   copy differs, and `tests/unit/i18n-boundaries.test.ts` fails until they match.
6. Run `npm run i18n:check`, then commit the PO files.

A reviewed entry stays reviewed until its English changes. Rewording a string gives it a new ID,
so every language gets a fresh draft, and the old translation goes along as a hint (below).

## Running the harness

`npm run i18n:translate` fills every entry with no translation. With `--redraft` it also re-drafts
entries still marked `fuzzy`, which is how a glossary change reaches existing drafts. A message that
another area of the locale already translates is copied from that area instead of drafted, a
reviewed copy first, so one message reads one way everywhere. It writes each result marked `fuzzy`,
then runs the catalog gate and fails if the catalogs no longer match the source.

```sh
# The first pass, or any refill, with Claude (needs a signed-in Claude Code)
npm run i18n:translate -- --engine claude --locales de,ja

# A refill with a local model behind an OpenAI-compatible server
npm run i18n:translate -- --engine local --url http://127.0.0.1:9931/v1

# What would be translated, without calling anything
npm run i18n:translate -- --dry-run
```

`--areas settings,dialogs` limits it to some catalogs, and `--limit 20` is a trial run. `--base
<ref>` sets where a reworded string's old translation is read from (the default is the merge-base
with `origin/main`). Every run writes a JSON report to a temp folder, or to `--out`, listing what it
flagged and why. The script refuses to run when `CI` is set, because every string is a real model
call.

The Claude engine runs headless `claude -p` with the Claude adapter's answer flags: no tools, no
MCP servers, an empty temp working folder, and a translator system prompt in place of Claude
Code's. On Windows an npm install of Claude Code puts only `claude.cmd` on PATH, which cannot start
without a shell. Pass `--cli` with the path to the real executable.

The local engine works with any server that offers an OpenAI-compatible `/v1/chat/completions` with
JSON Schema output. llama.cpp's `llama-server` (default port 9931), Ollama (11434) and LM Studio
(1234) all do. The refill model is Gemma 4 26B-A4B, which the bake-off below picked. It needs about
22 GB of GPU memory:

```sh
# gemma-4-26B_q4_0-it.gguf, downloaded from huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf
llama-server -m gemma-4-26B_q4_0-it.gguf -ngl 999 -c 16384 --flash-attn on --jinja
npm run i18n:translate -- --engine local
```

Ollama and LM Studio route requests by model name, so pass `--model` with the name they show, and
`--url` with their address.

## What the harness checks

A model never sees ICU syntax. Each placeholder, the plural `#`, and each quoted literal such as
`'{{cwd}}'` becomes a numbered token like `{1}`, with a legend saying what it stands for. A
message with one plural is split into whole sentences, one per plural category the target language
uses (from `Intl.PluralRules`), because Polish or Russian inflect the words around the number too.
The reply is rebuilt into a plural whose every case is a whole sentence. A message with two plurals
is left for a person.

Each request carries the string's context, its extracted comment, its source file, the strings
next to it in that file with the translations they already have, the glossary terms it uses, and,
for a reworded string, the previous English and its translation from the base branch. The base
branch is the only place that hint survives, because `lingui extract --clean` removes the old entry.

Every result is checked before it is written:

- the rebuilt message compiles as ICU, with valid plural keys for the language;
- every token and tag comes back exactly, and the number never drops out of a plural case;
- kept names and fixed terms from the glossary are there;
- a settings description still fits its one-line budget (60, 66 or 54 columns, from the settings
  card scan in `tests/unit/helpers/settings-card-scan.ts`), with a CJK character counted as two.

A result that fails goes back to the model with the problems, up to two more times. One that still
fails stays untranslated, so the UI shows its English, and the report lists it.

## The first pass

Claude drafted all 14 languages on 2026-10-28 (task 919): `claude-opus-5-5` at medium effort,
one locale per process, 44,780 empty entries in all. The validator flagged none of the drafts. A
run that hit the Claude Code usage limit lost 869 entries to failed calls, and the one rerun of
those locales drafted them all.

154 entries were written by hand, the same 11 messages in every language: each has two plurals or
selects, which the harness leaves to a person. They carry every plural category the language uses,
were checked with the harness's own ICU parse and compile, and are marked `fuzzy` like the drafts.
The six zh-CN first-launch strings keep the design's wording and no flag.

Each area was drafted on its own, so a word can differ between areas in one language. Italian has
both "task" and "attività" for a task, and Traditional Chinese both 工作 and 任務. A reviewer
choosing one term per language is the first useful pass. The same message drafted in two areas
came out two ways in 391 cases across the 14 languages, and the review pass set every copy to the
one the renderer showed.

## The glossary

`scripts/i18n/glossary.json` holds two lists. Kept names stay exactly as written in every language:
Kangentic, the agent CLIs (Claude Code, Codex, Gemini CLI and the rest), the board providers, MCP,
PTY, WSL, Git and PR. Fixed terms have one translation per language: worktree, branch, commit, pull
request and repository.

The fixed terms follow VS Code's language packs, so a developer who uses VS Code in their language
meets the same words. Two exceptions are deliberate. Commit stays "commit" where VS Code translates
it (French "valider", Russian "фиксация"), because that is the word developers use. Pull request
stays English where VS Code's translation runs to a phrase. VS Code ships no Hungarian pack, so
Hungarian has no fixed terms yet. Cursor and Linear are not kept names, because "cursor" is also the
terminal's cursor.

A fixed term that inflects gives the part every form contains as `match`: Polish "gałąź" becomes
"gałęzi", so it matches "gał".

## Local model bake-off

The bake-off picks the local refill model. `scripts/i18n/bake-off/run.mjs` runs it in three steps:
`translate` for each arm, `judge`, then `score --write`.

The sample is 200 English strings (`scripts/i18n/bake-off/sample.json`), written in the form
Lingui extracts them, because the catalogs held only the setup strings when the bake-off was built.
It mixes short labels (with `context` on Done, Merge and Open), 40 settings descriptions with their
budgets, placeholders, plurals, `<0>` tags, long dialog and toast text, glossary terms, quoted
literals and hotkey labels. Each arm translates it into zh-CN, ja, de, ru and pl through the real
harness pipeline: Chinese and Japanese for width, German for length, Russian and Polish for
four-form plurals.

Two numbers decide it. The validation pass rate, on the first try and after retries, counts
placeholders, tags, plurals, the glossary and width. A Claude judge (Opus 5.5) then sees every
arm's translation of each string side by side under shuffled letters. It scores accuracy and
fluency from 1 to 5 and flags critical errors.

The winner rule was fixed before any arm ran. Among the eligible arms that pass validation on at
least 95% of strings in every locale, the best mean judge score wins. An arm within 0.15 of the
best wins instead when it is faster.

| Arm | Model | Role |
| --- | --- | --- |
| claude-opus | Claude Opus 5.5 | Reference that calibrates the judge, not eligible |
| gemma-4-31b | Gemma 4 31B, q4_0 QAT (`google/gemma-4-31B-it-qat-q4_0-gguf`) | Candidate, Apache 2.0 |
| gemma-4-26b-a4b | Gemma 4 26B-A4B, q4_0 QAT (`google/gemma-4-26B-A4B-it-qat-q4_0-gguf`) | Candidate, Apache 2.0 |
| qwen3.6-27b | Qwen3.6-27B, Q4_K_M (`ggml-org/Qwen3.6-27B-GGUF`) | Candidate, Apache 2.0 per its model card |
| translategemma-12b | TranslateGemma 12B, Q8_0 (`mradermacher/translategemma-12b-it-GGUF`) | Baseline, Gemma terms |

TranslateGemma is the baseline, not a candidate. Its Gemma terms differ from Apache 2.0, and its
fixed prompt has no room for a glossary or context. Three models were ruled out before the run:
HY-MT1.5 (its license excludes the EU, the UK and South Korea and bars using its output to improve
other models), Cohere North Small Translate (CC-BY-NC) and NLLB (a non-commercial research model).

The runtime is llama.cpp's `llama-server` (build b11935): a portable zip with no installer or
background service, and the engine Ollama and LM Studio build on. Each local arm ran alone on an RTX
5090 (32 GB), started with the flags in `arms.json` (`-ngl 999 -c 16384 --flash-attn on --jinja
--port 9931`) plus `-m <model file>`. Every bake-off step makes one model call at a time unless
`--concurrency` says otherwise, so a run never competes with the work on the same machine.

### Results

Run on 2026-10-27, one model at a time, one request at a time. `results.json` holds the per-string
scores. The translated text stayed out of the repo.

| Arm | First-try pass | Final pass | Worst locale | Judge mean | Critical errors | 1,000 strings | Peak GPU memory |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-opus (reference) | 99.7% | 100% | 100% | 4.90 | 0.1% | 26 min | none |
| gemma-4-26b-a4b | 94.5% | 99.4% | 98.5% | 4.68 | 3.3% | 4.7 min | 21.4 GB |
| gemma-4-31b | 97.4% | 99.8% | 99.0% | 4.78 | 0.9% | 17.1 min | 28.1 GB |
| qwen3.6-27b | 97.1% | 99.5% | 98.5% | 4.72 | 1.2% | 12.1 min | 24.1 GB |
| translategemma-12b (baseline) | 81.8% | 82.1% | 79.0% | 3.56 | 26% | 5.9 min | 17.2 GB |

Peak GPU memory includes about 3 GB the desktop already used. The Claude arm's time is network
time, one call at a time.

**Gemma 4 26B-A4B wins.** All three candidates clear the 95% gate in every locale. Gemma 4 31B has
the best judge mean (4.78). The 26B-A4B (4.68) and Qwen3.6-27B (4.72) fall within the 0.15 margin,
and the 26B-A4B is the fastest by far: an active-4B mixture of experts that ran the sample in under
five minutes.

The rule weighs judge means, not critical errors, and that is where the 26B-A4B is weakest. Its
critical-error rate is 3.3% (5% in Russian, 6% in Polish) against 0.9% for the 31B. A refill
translates tens of strings, so the 31B's slower pace costs little there. The 31B runs with the same
command and `gemma-4-31B_q4_0-it.gguf` from `google/gemma-4-31B-it-qat-q4_0-gguf`, plus `--model
gemma-4-31b`.

Width is the commonest failure for every model: a settings description in German, Russian, Polish or
Japanese that cannot fit its one-line budget stays English. TranslateGemma confirms why the harness
sends context and a glossary. Without them it missed a glossary term in 50 strings, overflowed more
than half of the descriptions, and scored 2.6 on plurals. Its labels scored 3.1, because a bare "Open" or "Done"
has no context to translate from.

The judge is Claude judging Claude's own reference arm, so that row calibrates the scale and is not a
fair rival. One of the 4,808 translations that passed validation came back without a verdict.

Two harness fixes came out of the first runs, and every arm was rerun with them. A plural now always
offers the number token, because Russian writes "3 конфликта" where English has "Conflicts
detected". The legend for a quoted literal no longer says "copy it exactly", which had models
writing `{{description}}` out instead of its token. TranslateGemma also needed its prompt sent to
llama.cpp's raw `/completion` endpoint, because the chat endpoint drops the language codes its
template reads.

## Decision record

**Headless `claude -p` over the Anthropic API for Claude** (2026-10-27). It runs on the
contributor's existing Claude Code login with no API key, adds no SDK dependency, and validates the
reply against a JSON Schema itself. `--bare` was rejected for the same reason: it reads only
`ANTHROPIC_API_KEY`.

**`fuzzy` over a translator comment as the review mark.** Both survive `lingui extract`. Checked in
Lingui 6.10's source and pinned in a test: the formatter keeps flags, and compile and the Vite
plugin serve a fuzzy entry's translation. `fuzzy` won because PO editors and reviewers already read
it as "needs review".

**The reworded-string hint comes from git.** The catalog gate runs `check sync --clean`, so a
committed catalog never holds an obsolete entry to offer. The base branch's PO file still has it.
