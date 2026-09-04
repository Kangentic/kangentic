# Rule: writing style

Prose an agent writes here goes straight to people: `docs/`, `README.md`, PR titles and bodies,
GitHub issue and review comments, commit messages, release notes, task descriptions, and UI copy.
Default model prose has recognizable tells, and it reads as machine-written even when every fact in
it is right. Em-dashes carry a second problem on top of that. They render as garbled characters on
Windows console code pages, and the team ships and dogfoods on Windows.

## The rule

Applies to every piece of prose you author: source comments, docs, the README, commit messages, PR
titles and bodies, issue and review comments, release notes, task descriptions, UI copy, and chat
back to the user.

### Punctuation and characters

- No em-dash (U+2014), en-dash (U+2013), `&mdash;`, or `--` as a separator. Use a period, a comma,
  or a single `-`. Do not reach for a parenthetical instead; that trades one tell for another. If a
  thought needs separating, end the sentence.
- Straight quotes only. No curly quotes (U+2018, U+2019, U+201C, U+201D).
- A colon introduces a list or an example. Not a mid-sentence connector.
- Do not bold every proper noun or acronym.
- Sentence case for headings. No decorative emoji in headings or bullets.
- No bold label and colon that restates its own line ("**Performance:** Performance improved by
  40%"). A bold lead-in that ends in a period, names the thing, and is followed by genuinely new
  detail is fine, and is the shape every `## Enforcement` block in this directory already uses.

### Words

- Cut model vocabulary: additionally, crucial, delve, enduring, enhance, foster, garner, interplay,
  intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore,
  vibrant.
- Cut puffery and promotional words: pivotal moment, testament to, evolving landscape, indelible
  mark, groundbreaking, renowned, seamless, must-have.
- Prefer the plain word. Use, not utilize or leverage. Help, not facilitate. Many, not numerous. If,
  not in the event that. To, not in order to. Because, not due to the fact that.
- Say "is" or "has". Not "serves as", "stands as", "boasts", "features".
- Avoid abstract metaphor nouns: substrate, wedge, vector, locus, nexus, bedrock, modality,
  paradigm, gold-plating, ratchet, endgame, north star, flywheel, and the qualified cases
  `primitive` (as a noun), `harness` (as a metaphor), `scaffolding` (as a metaphor), and `surface`
  (as an abstract noun, as in "API surface"). Name the concrete thing. The qualifiers matter. This
  repo uses several of these as real names, and the ban is on the metaphor, not the name.
- Cut an adverb propping up a weak verb. "Runs quickly" is "is fast", or the measured number.

### Sentences

- One idea per sentence. Split anything the reader has to backtrack to parse.
- Active voice. Name the actor. "The compiler validates queries", not "queries are validated".
  Passive is fine only when the actor is unknown or genuinely does not matter.
- Say what it does, not how it feels. Name the mechanism, the flag, or the number. If a sentence
  would read the same in another project's docs, it says nothing about this one. Cut it.
- State the point directly instead of "not just X, but Y".
- Use the natural number of items. Do not force groups of three.
- Pick one term for a thing and repeat it. No synonym cycling.
- No "from X to Y" range unless X and Y sit on a real scale.
- Drop hedge stacks. "Could potentially possibly be argued that it might" is "may".
- Delete "It is important to note that".
- Name a source or delete the claim. No "experts believe", no "industry reports suggest", no "while
  specific details are limited".
- No chatbot filler: "I hope this helps", "Let me know if", "Of course", "Certainly", "Great
  question", "You're absolutely right", "Found the smoking gun".
- No generic closer. End on a specific fact or the next step, or stop.
- Match the length to the artifact. A PR body, review comment, or task description is a short
  summary, not the working session's transcript. No severity matrices, no sprawling tables, no
  multi-section walls. Keep the analysis in the conversation and put the conclusion in the comment.

### Voice

Flat, voiceless prose is its own tell. Have an opinion instead of listing pros and cons. Vary
sentence length. Say the awkward part out loud when it is true. First person is fine when you are
the one who did the thing.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/writing-style-characters.test.ts` fails on em-dashes, en-dashes, curly
  quotes, and emoji in a markdown heading, across `src/`, `scripts/`, `docs/`, `.claude/rules`,
  `.claude/skills`, `.claude/agents`, `README.md`, and `CLAUDE.md`. Runs in CI via
  `npm run test:unit`.
- **Review:** the `writing-style.md` line in `/code-review`'s Project Conventions list is checked by
  the always-on conventions finder, which runs whatever files changed. That is what gives a
  docs-only or markdown-only change a prose reviewer. The `platform-guard` agent also flags dashes,
  and its `/code-review` gate fires on an em-dash in any hunk, not only on its path globs. Across
  the trees the test above already scans, that overlaps the test rather than adding cover, and it
  checks characters only. So this rule leans on the test for the characters and on the conventions
  finder for the judgment, never on `platform-guard`.

Everything past the character checks is judgment and stays review-only. Two things are left
unmechanized on purpose rather than left as a silent gap:

- **Title-case headings.** This repo's headings are acronym-dense ("IPC Channels", "PTY Lifecycle",
  "Per-Project Directory"), so a case detector false-positives on nearly all of them. A flaky check
  is worse than a named review-only gap.
- **The `--` separator.** `docs/` legitimately carries `npm run x -- --flag`, so a scan cannot tell
  the CLI form from the punctuation form.

## Scope

Prose you author, in any file type.

Content you did not write is exempt: captured terminal scrollback, replay fixtures, assertions that
mirror real agent output, and characters that appear as data rather than punctuation, such as the
curly quotes inside the sanitizer regex classes in `src/main/agent/shared/auto-name.ts` and
`src/main/agent/adapters/qwen-code/transcript-cleanup.ts`. `tests/` is excluded from the mechanical
scan for that reason and stays review-only.

Pre-existing prose is also exempt. This rule governs text you write or rewrite; it does not ask for
a retro-fit of what is already committed. Restyling `CLAUDE.md`, the ` -- ` separators throughout
`docs/` and `.claude/skills/`, and the established metaphor nouns already in the tree are each their
own job, not a finding against a change that happens to touch the file.
