---
paths:
  - src/main/browser/**
  - src/devtools/main/cookie-jar-routes.ts
  - src/shared/browser-partition.ts
---

# Rule: browser cookie jars are copied only through `cookie-seed.ts`, and localhost is never copied

The embedded Browser pane shares a project's identity-provider (Google, etc.) login across its
tasks by COPYING non-localhost cookies between per-task jars via a project identity jar, while
keeping each task's `localhost` dev-app session isolated (decision 33 in
`docs/embedded-browser.md`). Two failures would be silent and serious: a copy path that bypasses
the localhost exclusion would leak one task's dev-server session into another's jar (or into the
shared identity jar, then into every task), reintroducing the exact cross-worktree collision the
per-task keying prevents; and a second, ad-hoc cookie-copy path would let that invariant drift.

## The rule

- **All reading and writing of a browser jar's cookies goes through
  `src/main/browser/cookie-seed.ts`.** `copyCookies` is the only cookie-copy primitive;
  `cookieToSetDetails` is the only `Cookie` -> `CookiesSetDetails` translation. Nothing else calls
  `session.fromPartition(...).cookies.get(...)` / `.set(...)` to move cookies between jars.
- **`isLocalCookieDomain` (in `cookie-seed.ts`) is the SINGLE localhost exclusion.** Every copy and
  every write-back excludes it (`copyCookies` defaults `excludeLocal` true; the jar-seeder
  write-back skips it). Do not add a second definition of "is this localhost", and do not copy a
  cookie without passing it through this check.
- **The sanctioned cookie-API users are exactly three files:** `cookie-seed.ts` (the primitive),
  `src/main/browser/jar-seeder.ts` (the load-boundary sync + one-way identity write-back), and
  `src/devtools/main/cookie-jar-routes.ts` (the dev-only rig). A new file that needs to touch jar
  cookies routes through `cookie-seed.ts`; if it genuinely must call the cookie API directly, it
  carries a `// cookie-copy-ok: <reason>` marker on the call line.
- **Partition names stay self-describing and task-keyed.** Jars are
  `persist:kng-<projectId>-<taskId>` and `persist:kng-<projectId>-identity`
  (`browserPartitionForTask` / `browserPartitionForProjectIdentity` in `browser-partition.ts`),
  never keyed by worktree path - that keying is what lets a jar follow a task and lets the sweep
  parse a jar back to its project + task.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/cookie-jar-sharing.test.ts` scans `src/**` (whitespace-insensitively, so a
  line-wrapped `.cookies\n.set(` is still caught) and fails on any `.cookies.set(` / `.cookies.get(`
  outside the three allowlisted files without a `// cookie-copy-ok:` marker. It also asserts that
  `cookie-seed.ts` defines `isLocalCookieDomain` and that both `copyCookies` and the jar-seeder
  write-back reference it, so the localhost exclusion cannot be silently removed. Runs in CI via
  `npm run test:unit`.
- **Review:** `/code-review` flags a new cookie-copy path or a partition keyed by anything other
  than task identity.

## Scope

The embedded-browser cookie-sharing subsystem: `src/main/browser/cookie-seed.ts`,
`jar-seeder.ts`, `browser-partition-cleanup.ts`, the dev rig, and `src/shared/browser-partition.ts`.
Does not govern `clearStorageData` (which wipes a jar, not copies it) or non-browser cookie use.
