---
paths:
  - "src/main/agent/mcp-http/**"
  - "src/shared/mcp-tool-manifest.ts"
  - "src/renderer/components/settings/tabs/McpServerTab.tsx"
  - "docs/mcp-server.md"
---
# Rule: MCP tool-list parity (panel + docs track the registrations)

The Kangentic MCP server registers its tools across the `*-tools.ts` files in
`src/main/agent/mcp-http/`. Two human-facing surfaces enumerate those tools: the Settings -> MCP
Server "Available Tools" list (`McpServerTab.tsx`) and `docs/mcp-server.md`. Nothing forced either
to track the registrations, so both drifted: the panel hardcoded 10 of 46 registered tools, missing
the entire browser and backlog families, `list_projects`, `search_everything`, and move/delete task.
A user reading the panel had no idea most of the agent's board, browser, and session capabilities
existed.

The fix is one source of truth, `src/shared/mcp-tool-manifest.ts` (`MCP_TOOL_MANIFEST`), that both
the panel renders from and the parity test checks. Drift becomes a failing build.

## The rule

When you add, rename, or remove a tool registered via `server.registerTool('kangentic_...', ...)`
under `src/main/agent/mcp-http/*-tools.ts`, keep its user-facing surfaces in sync:

1. **Manifest:** add / rename / remove the matching entry in `MCP_TOOL_MANIFEST`
   (`src/shared/mcp-tool-manifest.ts`). The entry's `name` MUST equal the registered tool name.
   Give it a `label`, a one-line `blurb`, and a `category`.
2. **Panel:** `McpServerTab.tsx` renders every manifest entry as a pill, grouped by category.
   You do not edit the panel for a new tool - listing it in the manifest is enough.
3. **Docs:** document the tool in `docs/mcp-server.md` (the exhaustive reference). This couples to
   [[docs-stay-in-sync]]: the MCP tool list is a doc anchor.
4. **Diagnostics group:** the dev-leaning diagnostics tools (and the read-only `kangentic_query_db`)
   carry `category: 'diagnostics'`, so they render last under their own header. They are listed in
   full like every other tool - there is no hidden flag. Do not drop a tool from the manifest to keep
   it out of the panel; every registered tool belongs in the list.

The dev-only `kangentic_devtools_*` tools live under `src/devtools/`, outside the scanned glob, and
are intentionally not part of this surface.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/mcp-tool-list-parity.test.ts` parses every
  `registerTool('<name>', ...)` literal under `src/main/agent/mcp-http/*-tools.ts` (it globs by the
  `-tools.ts` suffix, so a brand-new registration file is auto-covered) and asserts (a) every
  registered tool has a manifest entry; (b) every manifest entry names a real registered tool
  (catches a rename/removal); (c) every manifest tool appears in
  `docs/mcp-server.md`. It additionally asserts (d) every registration declares `annotations:` via
  one of the two shared constants in `src/main/agent/mcp-http/annotations.ts`
  (`READ_ONLY_ANNOTATIONS` / `MUTATING_ANNOTATIONS`), that those constants keep their spec-correct
  values, that no `*-tools.ts` redefines them locally, and that any tool named with a mutating verb
  (`create` / `update` / `delete` / `move` / `promote` / `link`) is annotated mutating - so a tool
  can never ship unannotated (which would prompt on every plan-mode call) or with a mutation
  dishonestly marked read-only (which would be silently auto-approved in plan mode). Runs in CI via
  `npm run test:unit`.

  The `kangentic_browser_*` family is checked separately, because none of its names carry a
  recognized mutating verb. Its annotation is derived from the capability tier the tool declares -
  either the inline `drive('<tier>', ...)` gate or an explicit `capability: '<tier>'` for a tool whose
  `withGuest` call lives in a helper module. A tool that declares NO tier (it attaches no CDP) must be
  listed in the test's `NON_DRIVING_TOOL_ANNOTATIONS` with the annotation its real effect deserves, and
  an unlisted one fails: `list_panes` is a pure registry read (read-only) while `close_pane` mutates
  renderer pane state (mutating), so "no tier" alone cannot be allowed to default to read-only.

  Because the rule is path-scoped, a brand-new `*-tools.ts` file does not pre-load this rule (the
  read-trigger gap); the CI test is the real guarantee.
- **Review:** `/code-review` flags a new `registerTool` call site without a matching manifest entry,
  and the `doc-auditor` agent reports a tool missing from `docs/mcp-server.md`.

Do not weaken these by deleting a manifest entry to silence the test - that reintroduces the exact
drift the rule prevents.

## Scope

Tools registered under `src/main/agent/mcp-http/*-tools.ts` and the two surfaces that enumerate them
for humans (the settings panel via `MCP_TOOL_MANIFEST`, and `docs/mcp-server.md`). The dev-only
`kangentic_devtools_*` tools under `src/devtools/` are out of scope. The tools' own server-facing
`description` strings (sent to agents) are authored independently of the manifest's short UI copy;
this rule governs name parity, not description wording.
