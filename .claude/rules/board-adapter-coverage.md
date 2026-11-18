---
paths:
  - "src/main/boards/**"
  - "scripts/check-integrations.mjs"
  - "docs/integrations/boards.md"
---
# Rule: a new board ships with the coverage the others have

GitLab landed as the tenth board adapter, with a fourth browser sign-in and an empty client id. The
daily sign-in check, written the same week, asked about three sign-ins, and the owner steps listed
two. Nothing tied a new sign-in to either, so an audit by hand found the gap on 2026-11-17. It
matters because a browser sign-in depends on a registration outside this repository: an OAuth app,
a key's allowed origins, a page on kangentic.com. Any of them can be revoked or changed with no
commit, every test tier fakes them, and the daily check is the only thing that would notice before
a user does in the Connect dialog.

## The rule

When you add a board adapter, or give an existing one a browser sign-in:

1. **A docs row for every adapter.** Each adapter in `boardRegistry` has a row in the "Adapter
   Status" table of `docs/integrations/boards.md` that says how it signs in.
2. **A browser sign-in is declared once.** It runs through `runLoopbackSignIn`
   (`src/main/boards/shared/loopback-sign-in.ts`) under its own name in the `LoopbackProvider`
   union. That union is the list of browser sign-ins the steps below are held to. Never open a
   second loopback listener for a board.
3. **Its id is one constant, and empty means not shipped.** The client id or key is an exported
   string in the adapter's `constants.ts`. While it is empty the sign-in is hidden and nothing is
   sent to the provider on its behalf.
4. **A row in the daily check.** `scripts/check-integrations.mjs` reads that constant from the
   checkout and asks the provider about it, under an area named for the `LoopbackProvider`. The row
   is `pending` and sends nothing while the id is empty, `ok` on the answer a client the provider
   knows gets, and `fail` on the answer an unknown one gets. Record the answer a stranger can get
   today in `tests/fixtures/sign-in-check-live-answers.json`. A page or route on kangentic.com
   that the sign-in needs gets a row of its own.
5. **Owner steps and the probe, written down.** A row in "Owner steps for the browser sign-ins"
   with what to register (redirect URIs, scopes, the switches that default the wrong way) and where
   the id goes, and a row in the "Daily sign-in check" table. Both are in
   `docs/integrations/boards.md`.
6. **A second way in.** A browser sign-in sits beside a pasted token or key, never in place of
   one.
7. **No secret in the app.** PKCE to the loopback where the provider takes a public client. Where
   it does not, the secret lives in a kangentic.com Function, as Jira's does.

A provider that signs in through a CLI's own login (`gh`, `az`), a pasted token alone, or a local
folder has no browser sign-in. Step 1 is all it owes.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/board-adapter-coverage.test.ts` holds steps 1, 2, 4 and 5
  against the real registry, the real `LoopbackProvider` union and the real check script. It fails
  when a registered adapter has no row in the "Adapter Status" table, and when a `LoopbackProvider`
  has no `pending` row in the daily check with its id empty, is sent a request while its id is
  empty, has no `fail` row when its provider does not answer, or is missing from the owner steps
  or the "Daily sign-in check" table. It runs `runChecks` itself, so a row that exists only on paper
  does not pass. Its red cases add a provider to the union and remove a row from the docs in
  memory. Runs in CI via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/check-integrations.test.ts` holds every value the check
  reads equal to the real export, and the workflow's path filter equal to the files the check
  reads, so a new constants file re-runs the check on the pull request that fills it.
- **Review:** `/code-review` judges steps 3, 6 and 7: that an empty id hides the sign-in, that the
  token or key path is still offered, and that no secret ships.

Mechanical coverage stops at the row existing and behaving. Whether its `ok` answer is the one a
real client gets is only known once the app is registered, which is why each unseen answer is
listed under "Answers not yet seen" in `docs/integrations/boards.md`.

## Scope

Board adapters under `src/main/boards/adapters/`, the daily sign-in check, and
`docs/integrations/boards.md`. Not the kanban board's own config, which is
[[board-config-parity]], and not agent adapters.
