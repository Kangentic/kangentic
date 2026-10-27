/**
 * Settings tab metadata, decoupled from icon components so this module has no
 * JSX/lucide dependency and can be imported directly by tests/unit (node
 * environment), the same way settings-registry.ts already is.
 *
 * `category` is the source of truth for the PROJECT/SYSTEM split, replacing
 * the old positional `separator: true` marker. Tabs above the separator
 * ('project') save to the project's override file when a project is open;
 * tabs below it ('system') are shared settings that apply across all
 * projects and MUST remain fully functional with no project open (see
 * .claude/rules/settings-tab-scope.md).
 */
import { msg } from '@lingui/core/runtime-macro';
import type { LocalizedText } from '../../../shared/i18n/text';

/**
 * `tier` further groups `category: 'system'` tabs in the sidebar (Project
 * tabs and any tab without a tier render with no extra grouping). Tiers must
 * appear as a contiguous run in SETTINGS_TABS - the sidebar prints a header
 * at the first tab of each new tier, so an interleaved tier would print the
 * same header twice. Enforced by settings-tab-scope-parity.test.ts.
 */
export type SettingsTabTier = 'core' | 'advanced' | 'other';

/** Sidebar header text for each tier. 'core' is intentionally absent: it is
 *  the first, unlabeled group directly under the System header. Privacy and
 *  Developer share the 'other' tier rather than each getting a single-tab
 *  tier of their own: a tier header that just repeats its lone tab's name
 *  reads as redundant. 'other' also avoids implying Privacy is a power-user
 *  concern the way a "Developer" header over both tabs would. */
export const TIER_LABELS: Record<Exclude<SettingsTabTier, 'core'>, string> = {
  advanced: 'Advanced',
  other: 'Other',
};

export interface SettingsTabMeta {
  id: string;
  /** Resolved where it renders (`translateText`); a descriptor once translated. */
  label: LocalizedText;
  category: 'project' | 'system';
  /** Tooltip shown on hover (e.g. "Applies to all projects"). */
  tooltip?: LocalizedText;
  /** Sidebar sub-grouping within the System group. See SettingsTabTier. */
  tier?: SettingsTabTier;
}

/**
 * Order within each group (Project; each System tier) is curated, not
 * alphabetical: General/Core-tier tabs lead with the most-landed-on and
 * most-frequently-touched tabs, and related tabs stay adjacent (e.g. Board /
 * Task / Changes / Terminal as the "display" cluster). Alphabetizing would
 * scatter those groupings, bump General out of the landing slot, and couple
 * sidebar position to label spelling - a tab rename would silently reorder
 * the sidebar. The settings search bar already covers fast lookup-by-name, so
 * this list is free to optimize for browsing and muscle memory instead.
 */
export const SETTINGS_TABS: SettingsTabMeta[] = [
  // -- Per-project settings --
  { id: 'general', label: 'General', category: 'project' },
  { id: 'theme', label: 'Theme', category: 'project' },
  { id: 'agent', label: 'Agent', category: 'project' },
  { id: 'git', label: 'Git', category: 'project' },
  { id: 'browser', label: 'Browser', category: 'project' },
  { id: 'shortcuts', label: 'Shortcuts', category: 'project' },
  // -- Shared settings: Core tier --
  // First under System: the one tab a user who cannot read the rest must find.
  { id: 'language', label: msg`Language`, category: 'system', tier: 'core', tooltip: msg`Applies to all projects` },
  { id: 'board', label: 'Board', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  { id: 'task', label: 'Task', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  { id: 'changes', label: 'Changes', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  // Terminal is global-only: shell/font/scrollback/cursor are cosmetic
  // per-machine preferences (nobody wants per-project fonts), and shell in
  // particular was never reliably project-scoped at the PTY-spawn level -
  // SessionManager caches a single configuredShell keyed to whichever project
  // is currently focused (src/main/pty/session-manager.ts), so a background
  // project's spawn/resume could silently pick up the wrong shell.
  { id: 'terminal', label: 'Terminal', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  { id: 'behavior', label: 'Behavior', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  // Chromium rendering and app-wide motion. Neither had an honest home:
  // Animations lived under Board > Window despite toggling .no-motion on
  // <html>, and graphics acceleration (Sentry DESKTOP-18/DESKTOP-W) had
  // nowhere at all. Core rather than Advanced because Advanced is opt-in
  // subsystems (Dictation, Knowledge Graph, MCP Server, Agent Browser, Mobile), and
  // because a recovery toast sends users straight here.
  { id: 'performance', label: 'Performance', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  { id: 'hotkeys', label: 'Hotkeys', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  { id: 'notifications', label: 'Notifications', category: 'system', tier: 'core', tooltip: 'Applies to all projects' },
  // -- Shared settings: Advanced tier --
  // First in the tier: the opt-in subsystem most likely to be opened. Its
  // Automation agent answers every automation's Condition, so a user setting up
  // a Code Review loop lands here before any workflow exists.
  { id: 'workflows', label: 'Workflows', category: 'system', tier: 'advanced', tooltip: 'Applies to all projects' },
  { id: 'dictation', label: 'Dictation', category: 'system', tier: 'advanced', tooltip: 'Applies to all projects' },
  // Every card here serves the Knowledge Graph; the index also feeds Quick Find
  // and `kangentic_search`.
  { id: 'knowledgeGraph', label: 'Knowledge Graph', category: 'system', tier: 'advanced', tooltip: 'The Knowledge Graph and the index it reads. Applies to all projects' },
  { id: 'mcpServer', label: 'MCP Server', category: 'system', tier: 'advanced', tooltip: 'Applies to all projects' },
  { id: 'browserAutomation', label: 'Agent Browser', category: 'system', tier: 'advanced', tooltip: 'Applies to all projects' },
  { id: 'mobile', label: 'Mobile Devices', category: 'system', tier: 'advanced', tooltip: 'Applies to all projects' },
  // -- Shared settings: Other tier --
  { id: 'privacy', label: 'Privacy', category: 'system', tier: 'other', tooltip: 'Applies to all projects' },
  { id: 'developer', label: 'Developer', category: 'system', tier: 'other', tooltip: 'Applies to all projects' },
];
