---
paths:
  - "src/renderer/components/settings/settings-registry.ts"
  - "src/renderer/components/settings/settings-tabs.ts"
  - "src/renderer/components/settings/tabs/**"
---
# Rule: a setting's tab must match its persistence scope

`updateProjectOverride` (`src/renderer/stores/config-store.ts`) silently no-ops when no project
is open. That makes the Settings panel's PROJECT/SYSTEM tab split load-bearing, not cosmetic. A
global-only setting (Terminal Colors) bounced across three tab homes before this rule existed
because nothing tied a setting's `scope` to the category of the tab it lived in.

## The rule

Every entry in `SETTINGS_REGISTRY` (`settings-registry.ts`) declares `scope: 'project' |
'global'`. Every tab in `SETTINGS_TABS` (`settings-tabs.ts`) declares `category: 'project' |
'system'`. The two must agree, and the two failure directions are NOT symmetric:

- **A `scope: 'project'` setting MUST live in a `category: 'project'` tab.** SYSTEM tabs render
  with no project open, so a project-scoped control there accepts a click and silently drops the
  write. This is a hard rule with no exceptions.
- **A `scope: 'global'` setting inside a `category: 'project'` tab is a judgment call**, not a
  hard rule. It is merely unreachable with no project open, and a project is required to use
  Kangentic in the first place. Allowed only when genuinely project-contextual (e.g. a per-agent
  global edited against the project's currently-selected agent), and only when recorded in
  `PROJECT_TAB_GLOBALS` (`settings-registry.ts`) with a one-line reason. A new stranded global
  fails until it is either moved to a system tab or deliberately allowlisted.

When you add a setting, decide its `scope` from where it actually persists (`config.set` = global,
`setProjectOverridesByPath` = project), then place its `tabId` accordingly - do not place it by
convenience and fix the scope to match after the fact.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/settings-tab-scope-parity.test.ts` asserts (a) every project-scoped
  setting's tab is `category: 'project'`; (b) every global setting inside a project tab is
  allowlisted in `PROJECT_TAB_GLOBALS`, with no stale allowlist entries; (c) every
  `settingProps(...)` / `searchId` / `searchIds` literal referenced by a tab component names a
  real registry id; (d) every registry `tabId` has a `SETTINGS_TABS` entry and a `TAB_LABELS`
  entry. Runs in CI via `npm run test:unit`.

  The same file also guards a neighbouring bug class - a setting that is reachable in config but
  not in the UI: (e) every `NotificationConfig.desktop` / `.toasts` event boolean has a
  `notifications.<key>` registry row (or an allowlist entry with a reason); (f) both channels
  declare the same event key set, since one dropdown writes both; and (g) every
  `notifications.on*` row is really rendered by a `NotifyChannelRow`, with its `searchId`
  matching its `eventKey`. Checks (a)-(d) only ever walk row -> registry, so a config key with
  no row was invisible to all of them - that is how the Agent Crash notification shipped with
  no Settings control.
- **Review:** `/code-review` flags a new setting whose tab placement does not match its scope.

## Scope

The Settings panel's tab/registry pairing (`src/renderer/components/settings/settings-registry.ts`,
`settings-tabs.ts`, `AppSettingsPanel.tsx`, and `tabs/**`). Does not cover other config surfaces
(board config, keybinding registry) which have their own parity rules.
