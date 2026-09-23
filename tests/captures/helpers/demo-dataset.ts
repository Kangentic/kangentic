/**
 * The sample install: three projects in two groups, their boards, sessions, backlog, usage, and
 * the terminal recordings behind every running session. One dataset, two consumers: the marketing
 * captures (through `buildMarketingPreConfig()` in marketing-fixture.ts) and the web build
 * (demo/vite.config.mts), so the two cannot drift.
 *
 * Names were chosen with the user on GitHub star and fork data (see demo/README.md): Contoso is
 * the one placeholder company developers in the Microsoft world already know, spring-petclinic
 * is the most-forked sample repo on GitHub, and Online Boutique is the cloud-native reference app.
 *
 * Every timestamp is an OFFSET from boot (`minutesAgo`), so a card reads "3 min ago" whenever the
 * frame opens; a capture that needs a fixed clock pins `Date.now` on the page.
 *
 * No Node imports on purpose: the returned script string runs inside the page against the mock,
 * and demo/vite.config.mts serializes this module into the static build.
 */

import { buildModelDisplayNames } from '../../../src/main/agent/adapters/claude/model-display-name';

export interface DemoScrollbackMap {
  /** Session id to the serialized terminal stream replayed into that session's xterm. */
  [sessionId: string]: string;
}

/** One file of a recorded working tree, in the shape the mock's git.diffFiles returns. */
export interface DemoDiffFile {
  path: string;
  status: string;
  binary?: boolean;
  insertions: number;
  deletions: number;
  original: string;
  modified: string;
  language: string | null;
}

export interface DemoDiff {
  files: DemoDiffFile[];
  totalInsertions: number;
  totalDeletions: number;
}

export interface DemoChangesMap {
  /** Session id to the working tree its agent left behind. */
  [sessionId: string]: DemoDiff;
}

/** One commit of a scaffolded project's history, in git:commitGraph's shape. */
export interface DemoHistoryCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorTimestamp: string;
  subject: string;
}

export interface DemoBlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  date: string;
}

/**
 * The git history behind a scaffolded project, as scripts/capture-demo-history.mjs reads it out
 * of the repo the capture matrix records against: commits newest first, the diff each commit
 * introduces, and the blame of every file a recorded session modified (its recorded working
 * tree applied uncommitted, so the agent's own lines blame as uncommitted).
 */
export interface DemoHistory {
  project: string;
  branch: string;
  tipHash: string;
  commits: DemoHistoryCommit[];
  diffs: Record<string, DemoDiff>;
  blame: Record<string, Record<string, { lines: DemoBlameLine[] }>>;
}

interface DemoProjectGroup {
  id: string;
  name: string;
  position: number;
  is_collapsed: boolean;
}

interface DemoProject {
  id: string;
  name: string;
  path: string;
  github_url: string | null;
  default_agent: string;
  group_id: string | null;
  position: number;
  lastOpenedMinutesAgo: number;
  createdDaysAgo: number;
  /** The project's Browser default URL (Settings, Browser): where a task's Browser pane opens. */
  dev_url?: string;
  /** A page under demo/guest/ that stands in for what the project serves at `dev_url`, for the web
   *  build's iframe stand-in of the desktop's webview (demo/webview-shim.js). Its data is the
   *  project's and its presentation is authored (demo/README.md, Browser guest). */
  guest_page?: string;
}

interface DemoLane {
  slug: string;
  name: string;
  role: 'todo' | 'done' | null;
  color: string;
  icon: string;
  is_archived: boolean;
  auto_spawn: boolean;
  permission_mode: string | null;
  /** The column's agent (the swimlane's agent_override); null inherits the project default. */
  agent: string | null;
}

interface DemoTask {
  id: string;
  projectId: string;
  display_id: number;
  title: string;
  description: string;
  lane: string;
  position: number;
  agent: string | null;
  session_id: string | null;
  worktree_folder: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: 'open' | 'draft' | 'merged' | 'closed' | null;
  pr_merge_readiness: 'ready' | 'blocked' | 'conflicting' | 'queued' | 'running' | 'unknown' | null;
  base_branch: string | null;
  labels: string[];
  priority: number;
  attachment_count: number;
  createdDaysAgo: number;
  updatedMinutesAgo: number;
  archivedDaysAgo?: number;
}

interface DemoSession {
  id: string;
  taskId: string | null;
  projectId: string;
  agent: string;
  status: 'running' | 'suspended' | 'queued';
  activity: 'thinking' | 'idle' | 'permission' | null;
  /** How long before its recording's end the live frame opens this working session, when not the manifest's liveTailMs. */
  liveTailMs?: number;
  startedMinutesAgo: number;
  model: { id: string; displayName: string } | null;
  effort: string | null;
  permissionMode: string;
  contextPercent: number | null;
  contextWindowSize: number;
  costUsd: number;
  durationMinutes: number;
  peek: string[];
  events: Array<{ minutesAgo: number; tool: string; detail: string }>;
  transient?: boolean;
  commandTerminalBranch?: string;
  isolated?: boolean;
  rateLimits?: boolean;
}

interface DemoBacklogItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  position: number;
  external_source: string | null;
  external_id: string | null;
  external_url: string | null;
  createdDaysAgo: number;
}

// ---------------------------------------------------------------- ids
export const PROJECT_CONTOSO = 'proj-contoso-web';
export const PROJECT_PETCLINIC = 'proj-spring-petclinic';
export const PROJECT_BOUTIQUE = 'proj-online-boutique';
export const GROUP_CONTOSO = 'group-contoso';
export const GROUP_OSS = 'group-open-source';

export const TASK_MIDDLEWARE = 'task-cw-middleware';
// The other tasks a scene names: the second working session (tiled beside the middleware
// window), the Planning card a drag scene lifts, and the To Do card a context-menu scene opens on.
export const TASK_API_CLIENT = 'task-cw-api-client';
export const TASK_WEBSOCKET = 'task-cw-websocket';
export const TASK_AUTH = 'task-cw-auth';
export const SESSION_WEBSOCKET = 'sess-cw-websocket';
export const SESSION_MIDDLEWARE = 'sess-cw-middleware';
export const SESSION_API_CLIENT = 'sess-cw-api-client';
export const SESSION_RATE_LIMIT = 'sess-cw-rate-limit';
export const SESSION_INTEGRATION = 'sess-cw-integration';
export const SESSION_CONTOSO_TERMINAL = 'sess-cw-terminal-1';
export const SESSION_PETCLINIC_FLAKY = 'sess-pc-flaky-tests';
export const SESSION_PETCLINIC_SEARCH = 'sess-pc-owner-search';
export const SESSION_PETCLINIC_CACHE = 'sess-pc-caffeine';
export const SESSION_BOUTIQUE_REDIS = 'sess-ob-redis-ttl';
export const SESSION_BOUTIQUE_MTLS = 'sess-ob-mtls';
export const SESSION_BOUTIQUE_A11Y = 'sess-ob-currency-a11y';
export const SESSION_BOUTIQUE_OTEL = 'sess-ob-otel';
export const SESSION_EMPTY_STATES = 'sess-cw-empty-states';
export const SESSION_VITE8 = 'sess-cw-vite8';
export const SESSION_PETCLINIC_BOOT35 = 'sess-pc-boot-35';

// The sample install is a Windows machine, as the recording machine and the mock's platform are.
const HOME = 'C:\\Users\\dev';
/** Where a task's worktree lives under its project, as the desktop lays it out. */
const WORKTREE_SUBPATH = '\\.kangentic\\worktrees\\';

export const DEMO_GROUPS: DemoProjectGroup[] = [
  // Named for the client rather than the category, which is how an agency groups a sidebar and
  // which says WHY these are grouped. "Open source" stays a category beside it: mixing the two
  // shapes is what real sidebars do, and the two repos under it are recognizable enough that
  // calling them "other" would undersell them.
  { id: GROUP_CONTOSO, name: 'Contoso', position: 0, is_collapsed: false },
  { id: GROUP_OSS, name: 'Open source', position: 1, is_collapsed: false },
];

export const DEMO_PROJECTS: DemoProject[] = [
  // The dev URL is the scaffold's own Vite port (its `dev` script, which the Command Terminal
  // recording lists); the guest page shows the scaffold's store data there, in an authored layout.
  { id: PROJECT_CONTOSO, name: 'contoso-web', path: `${HOME}\\work\\contoso-web`, github_url: 'https://github.com/contoso/contoso-web', default_agent: 'claude', group_id: GROUP_CONTOSO, position: 0, lastOpenedMinutesAgo: 2, createdDaysAgo: 140, dev_url: 'http://localhost:5173/', guest_page: 'contoso-web.html' },
  { id: PROJECT_PETCLINIC, name: 'spring-petclinic', path: `${HOME}\\oss\\spring-petclinic`, github_url: 'https://github.com/spring-projects/spring-petclinic', default_agent: 'codex', group_id: GROUP_OSS, position: 1, lastOpenedMinutesAgo: 35, createdDaysAgo: 61 },
  { id: PROJECT_BOUTIQUE, name: 'online-boutique', path: `${HOME}\\oss\\online-boutique`, github_url: 'https://github.com/GoogleCloudPlatform/microservices-demo', default_agent: 'codex', group_id: GROUP_OSS, position: 2, lastOpenedMinutesAgo: 90, createdDaysAgo: 24 },
];

/** The seven default lanes, mirroring src/main/db/migrations/default-data.ts. */
const DEFAULT_LANES: DemoLane[] = [
  { slug: 'todo', name: 'To Do', role: 'todo', color: '#6b7280', icon: 'layers', is_archived: false, auto_spawn: false, permission_mode: null, agent: null },
  { slug: 'planning', name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', is_archived: false, auto_spawn: true, permission_mode: 'plan', agent: null },
  { slug: 'executing', name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'review', name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'testing', name: 'Testing', role: null, color: '#06b6d4', icon: 'flask-conical', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'merge', name: 'Merge', role: null, color: '#f97316', icon: 'merge', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'done', name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', is_archived: true, auto_spawn: false, permission_mode: null, agent: null },
];

/** contoso-web names Claude on every auto-spawn column past Executing, the way a configured board does. */
const CONTOSO_LANES: DemoLane[] = [
  ...DEFAULT_LANES.slice(0, 3),
  ...DEFAULT_LANES.slice(3).map((lane) => (lane.auto_spawn ? { ...lane, agent: 'claude' } : lane)),
];

export const DEMO_LANES_BY_PROJECT: Record<string, DemoLane[]> = {
  [PROJECT_CONTOSO]: CONTOSO_LANES,
  [PROJECT_PETCLINIC]: DEFAULT_LANES,
  [PROJECT_BOUTIQUE]: DEFAULT_LANES,
};

/**
 * The id the seed gives a column, from its project and its slug. Exported because a scene that
 * patches a column names one, and a scene's `__mock*` seed gets none of the id validation a
 * `tasks` or `sessions` patch gets (`tests/unit/scene-registry.test.ts`). A typo'd id fails
 * SILENTLY in the worst way available here: the dialog still opens, the slot still reads "Add
 * automation", the ready selector still resolves, and the alt written from that frame is wrong.
 * The registry test resolves every seeded id through this function, so the formula has one home
 * and the guard cannot drift from what the seed actually writes.
 */
export function demoLaneId(projectId: string, slug: string): string {
  return `lane-${projectId.replace(/^proj-/, '')}-${slug}`;
}

/** Every column id the sample install seeds, for that guard. */
export function demoLaneIds(): string[] {
  return Object.entries(DEMO_LANES_BY_PROJECT).flatMap(
    ([projectId, lanes]) => lanes.map((lane) => demoLaneId(projectId, lane.slug)),
  );
}

/**
 * A label is coloured only when the colour changes what the reader does about it: something is
 * broken (red) or something is slow (amber). Everything else classifies the work rather than
 * flagging it, so it takes one muted slate and stays quiet.
 *
 * This is deliberately not a colour per label. Twelve saturated hues put seven of them on the
 * contoso board at once, which reads as decoration rather than as a team's convention, and a
 * board that looks decorated is the first thing a viewer distrusts about a demo. A new label
 * joins the slate group unless it means broken or slow.
 */
/*
 * A label carries ONE hex, and the frame ships a dark default theme and a light one (the site
 * embeds theme=sand), so each colour is judged on its WORST contrast across the two rather than on
 * how it looks in whichever was opened last. There is a hard ceiling on that: a single colour
 * cannot clear 4.5 against both a near-black and a near-white ground, because the luminance that
 * maximises the worse side lands at about 4.07 for both. So these are chosen to sit as close to
 * that ceiling as a recognizable palette step allows, and 4.5 is not reachable by any hex.
 *
 * Measured against #18181b and #faf7f2, worst of the two: defect 3.96, risk 3.92, build 3.53,
 * neutral 3.72. A colour also has to survive a SECOND test that contrast cannot see. The board
 * already means something by most of the spectrum: emerald #34d399 is a working agent, honey
 * #e3b341 is a session that needs you, the default priority badges take yellow #eab308, orange
 * #f97316 and red #ef4444, the seven swimlane accents run violet through emerald, and the usage
 * dashboard adds six chart series. A label colour landing near any of those reads as a status
 * the user then has to unlearn, so each is also scored on CIE76 distance from every one of them.
 *
 * Four candidates were rejected on that second test after passing the first, and two of them were
 * the colours this board shipped with. Red-600 for bug sat 11 from the Urgent priority badge,
 * close enough that the backlog table rendered an orange High badge and a red bug pill in one row
 * with nothing between them but the title. Amber-700 for perf sat 24 from the High badge.
 * Purple-500 sat 10 from the Planning column and cyan-600 sat 15 from the Testing column, which
 * is the pair a card sits directly beneath. Teal-600 sat 20 from the chart green and 34 from the
 * working spinner, the one confusion a board full of green activity cannot afford.
 *
 * Sweeping hue, saturation and lightness for colours that clear 3.45 on both grounds AND stay 30
 * or more from every reserved colour leaves two windows: magenta through rose, and a warm band
 * that is open only at low saturation, because every reserved colour there is a bright signal.
 * Hence a plum family at 22 percent saturation, plus one warm step from the second window.
 *
 * The family holds two steps and no more. Both grounds have to stay legible, which pins lightness
 * near 50 percent, so there is no room for a light and a dark step of one colour and hue is the
 * only axis left. At 36 percent saturation two steps sit 32 apart and read as two colours; at the
 * softness this board wants they collapse to 17, and below 28 percent no pair in the family
 * clears 26 at all. So defect and risk are deliberately siblings (17), which is the honest way to
 * show that the labels sharing them are related, while build stands apart from both (37 and 51)
 * and from neutral (36).
 */
const LABEL_DEFECT = '#a4647d';
const LABEL_RISK = '#9c6398';
const LABEL_BUILD = '#94815f';
const LABEL_NEUTRAL = '#64748b';

export const DEMO_LABEL_COLORS: Record<string, string> = {
  bug: LABEL_DEFECT,
  security: LABEL_RISK,
  a11y: LABEL_RISK,
  perf: LABEL_DEFECT,
  feature: LABEL_BUILD,
  refactor: LABEL_NEUTRAL,
  tests: LABEL_NEUTRAL,
  design: LABEL_NEUTRAL,
  docs: LABEL_NEUTRAL,
};

function worktree(projectPath: string, folder: string | null): string | null {
  return folder ? `${projectPath}${WORKTREE_SUBPATH}${folder}` : null;
}

// ---------------------------------------------------------------- tasks
const CONTOSO = `${HOME}\\work\\contoso-web`;
const PETCLINIC = `${HOME}\\oss\\spring-petclinic`;
const BOUTIQUE = `${HOME}\\oss\\online-boutique`;

export const DEMO_TASKS: DemoTask[] = [
  // contoso-web
  { id: TASK_AUTH, projectId: PROJECT_CONTOSO, display_id: 1, title: 'Add user auth flow', description: 'Implement OAuth2 login with GitHub and Google providers', lane: 'todo', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['feature', 'security'], priority: 2, attachment_count: 1, createdDaysAgo: 3, updatedMinutesAgo: 340 },
  { id: 'task-cw-api-errors', projectId: PROJECT_CONTOSO, display_id: 2, title: 'Refactor API error handling', description: 'Standardize error responses and add error codes', lane: 'todo', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['refactor'], priority: 1, attachment_count: 0, createdDaysAgo: 5, updatedMinutesAgo: 1500 },
  { id: TASK_WEBSOCKET, projectId: PROJECT_CONTOSO, display_id: 3, title: 'Fix WebSocket reconnection', description: 'Handle dropped connections with exponential backoff', lane: 'planning', position: 0, agent: 'claude', session_id: SESSION_WEBSOCKET, worktree_folder: 'fix-websocket-abc123', branch_name: 'fix-websocket-reconnection', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['bug'], priority: 3, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 4 },
  { id: TASK_MIDDLEWARE, projectId: PROJECT_CONTOSO, display_id: 4, title: 'Extract auth middleware', description: 'Move auth logic into reusable Express middleware', lane: 'executing', position: 0, agent: 'claude', session_id: SESSION_MIDDLEWARE, worktree_folder: 'auth-middleware-def456', branch_name: 'extract-auth-middleware', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['refactor'], priority: 2, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 1 },
  { id: TASK_API_CLIENT, projectId: PROJECT_CONTOSO, display_id: 5, title: 'Generate API client types', description: 'Request and response interfaces for every route in server/routes.ts, and apiFetch generic over them', lane: 'executing', position: 1, agent: 'claude', session_id: SESSION_API_CLIENT, worktree_folder: 'api-types-ghi789', branch_name: 'generate-api-types', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 12 },
  { id: 'task-cw-empty-states', projectId: PROJECT_CONTOSO, display_id: 8, title: 'Onboarding empty states', description: 'First-run screens for the dashboard, projects, and billing pages before any data exists', lane: 'planning', position: 1, agent: null, session_id: SESSION_EMPTY_STATES, worktree_folder: 'empty-states-stu901', branch_name: 'onboarding-empty-states', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['design'], priority: 2, attachment_count: 3, createdDaysAgo: 4, updatedMinutesAgo: 95 },
  { id: 'task-cw-rate-limit', projectId: PROJECT_CONTOSO, display_id: 6, title: 'Add rate limiting', description: 'Implement per-user rate limiting on API endpoints', lane: 'review', position: 0, agent: 'copilot', session_id: SESSION_RATE_LIMIT, worktree_folder: 'rate-limit-jkl012', branch_name: 'add-rate-limiting', pr_number: 42, pr_url: 'https://github.com/contoso/contoso-web/pull/42', pr_state: 'open', base_branch: 'main', labels: ['feature'], priority: 2, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 22 },
  { id: 'task-cw-integration', projectId: PROJECT_CONTOSO, display_id: 7, title: 'Integration test coverage', description: 'Add integration tests for auth and billing flows', lane: 'testing', position: 0, agent: 'cursor', session_id: SESSION_INTEGRATION, worktree_folder: 'integration-tests-mno345', branch_name: 'integration-tests', pr_number: 38, pr_url: 'https://github.com/contoso/contoso-web/pull/38', pr_state: 'open', pr_merge_readiness: 'blocked', base_branch: 'main', labels: ['tests'], priority: 1, attachment_count: 0, createdDaysAgo: 4, updatedMinutesAgo: 6 },
  { id: 'task-cw-vite8', projectId: PROJECT_CONTOSO, display_id: 9, title: 'Upgrade to Vite 8', description: 'Move the build to Vite 8 and drop the legacy Rollup plugins', lane: 'merge', position: 0, agent: null, session_id: SESSION_VITE8, worktree_folder: 'vite-8-pqr678', branch_name: 'upgrade-vite-8', pr_number: 45, pr_url: 'https://github.com/contoso/contoso-web/pull/45', pr_state: 'open', pr_merge_readiness: 'ready', base_branch: 'main', labels: [], priority: 1, attachment_count: 0, createdDaysAgo: 6, updatedMinutesAgo: 48 },
  { id: 'task-cw-done-deploy', projectId: PROJECT_CONTOSO, display_id: 10, title: 'Set up CI/CD pipeline', description: 'GitHub Actions for build, test, deploy', lane: 'done', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: 'setup-cicd', pr_number: 31, pr_url: 'https://github.com/contoso/contoso-web/pull/31', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: [], priority: 0, attachment_count: 0, createdDaysAgo: 12, updatedMinutesAgo: 4300, archivedDaysAgo: 3 },
  { id: 'task-cw-done-schema', projectId: PROJECT_CONTOSO, display_id: 11, title: 'Database schema migration', description: 'Add billing tables and indexes', lane: 'done', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: 'billing-schema', pr_number: 35, pr_url: 'https://github.com/contoso/contoso-web/pull/35', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 0, attachment_count: 0, createdDaysAgo: 10, updatedMinutesAgo: 2900, archivedDaysAgo: 2 },
  { id: 'task-cw-done-logging', projectId: PROJECT_CONTOSO, display_id: 12, title: 'Structured logging', description: 'Replace console.log with pino structured logging', lane: 'done', position: 2, agent: null, session_id: null, worktree_folder: null, branch_name: 'structured-logging', pr_number: 37, pr_url: 'https://github.com/contoso/contoso-web/pull/37', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['refactor'], priority: 0, attachment_count: 0, createdDaysAgo: 8, updatedMinutesAgo: 1450, archivedDaysAgo: 1 },

  // spring-petclinic
  { id: 'task-pc-vets-paging', projectId: PROJECT_PETCLINIC, display_id: 1, title: 'Add pagination to the vets list', description: 'The /vets page renders every vet; page it like the owners list and keep the JSON endpoint stable', lane: 'todo', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 600 },
  { id: 'task-pc-layout-dialect', projectId: PROJECT_PETCLINIC, display_id: 2, title: 'Replace Thymeleaf fragments with the layout dialect', description: 'Every template repeats the header and footer fragments; move to one layout', lane: 'todo', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['refactor'], priority: 0, attachment_count: 0, createdDaysAgo: 7, updatedMinutesAgo: 2100 },
  { id: 'task-pc-testcontainers', projectId: PROJECT_PETCLINIC, display_id: 3, title: 'Migrate integration tests to Testcontainers', description: 'Replace the MySQL and Postgres docker-compose profiles in the integration tests with Testcontainers', lane: 'planning', position: 0, agent: 'codex', session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['tests'], priority: 2, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 3 },
  { id: 'task-pc-flaky-tests', projectId: PROJECT_PETCLINIC, display_id: 4, title: 'Fix flaky PetClinicIntegrationTests on MySQL', description: 'testOwnerDetails fails one run in ten on the MySQL profile; suspect the visit ordering', lane: 'executing', position: 0, agent: 'codex', session_id: SESSION_PETCLINIC_FLAKY, worktree_folder: 'flaky-mysql-9b8c7d', branch_name: 'fix-flaky-mysql-integration', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['bug'], priority: 3, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 2 },
  { id: 'task-pc-owner-search', projectId: PROJECT_PETCLINIC, display_id: 5, title: 'Add owner search by phone number', description: 'The find-owners form only searches last name; add a telephone field and a repository query', lane: 'executing', position: 1, agent: 'gemini', session_id: SESSION_PETCLINIC_SEARCH, worktree_folder: 'owner-phone-search-1e2d3c', branch_name: 'owner-search-by-phone', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 9 },
  { id: 'task-pc-boot-35', projectId: PROJECT_PETCLINIC, display_id: 6, title: 'Upgrade the toolchain to Java 25', description: 'java.version in pom.xml, the GitHub Actions matrix, and the Dockerfile base image', lane: 'review', position: 0, agent: 'claude', session_id: SESSION_PETCLINIC_BOOT35, worktree_folder: 'java-25-7a6b5c', branch_name: 'java-25-toolchain', pr_number: 1412, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1412', pr_state: 'draft', pr_merge_readiness: null, base_branch: 'main', labels: [], priority: 2, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 130 },
  { id: 'task-pc-caffeine', projectId: PROJECT_PETCLINIC, display_id: 7, title: 'Cache vets with Caffeine instead of JCache', description: 'Drop the JCache config in favour of the Caffeine starter; keep the cache name so the actuator view stays', lane: 'testing', position: 0, agent: 'opencode', session_id: SESSION_PETCLINIC_CACHE, worktree_folder: 'caffeine-cache-3c4d5e', branch_name: 'vets-cache-caffeine', pr_number: 1408, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1408', pr_state: 'open', base_branch: 'main', labels: ['perf'], priority: 1, attachment_count: 0, createdDaysAgo: 4, updatedMinutesAgo: 17 },
  { id: 'task-pc-done-java21', projectId: PROJECT_PETCLINIC, display_id: 8, title: 'Bump Java to 21', description: 'Toolchain, CI matrix, and the Dockerfile base image', lane: 'done', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: 'java-21', pr_number: 1391, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1391', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: [], priority: 0, attachment_count: 0, createdDaysAgo: 14, updatedMinutesAgo: 8600, archivedDaysAgo: 5 },
  { id: 'task-pc-done-postgres', projectId: PROJECT_PETCLINIC, display_id: 9, title: 'Add a Postgres profile', description: 'application-postgres.properties plus the docker-compose service', lane: 'done', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: 'postgres-profile', pr_number: 1397, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1397', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 0, attachment_count: 0, createdDaysAgo: 11, updatedMinutesAgo: 7200, archivedDaysAgo: 4 },

  // online-boutique
  { id: 'task-ob-checkout-retry', projectId: PROJECT_BOUTIQUE, display_id: 1, title: 'Add retry with backoff to checkoutservice gRPC calls', description: 'PlaceOrder fails hard when paymentservice restarts; wrap the client calls with a bounded exponential retry', lane: 'todo', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['bug'], priority: 3, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 400 },
  { id: 'task-ob-locust', projectId: PROJECT_BOUTIQUE, display_id: 2, title: 'Locust load profile for cartservice', description: 'Extend loadgenerator with a cart-heavy scenario so the Redis change can be measured', lane: 'todo', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['perf'], priority: 1, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 1900 },
  { id: 'task-ob-py313', projectId: PROJECT_BOUTIQUE, display_id: 3, title: 'Move recommendationservice to Python 3.13', description: 'Base image, grpcio pin, and the profiler dependency that has no 3.13 wheel yet', lane: 'planning', position: 0, agent: 'codex', session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: [], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 240 },
  { id: 'task-ob-redis-ttl', projectId: PROJECT_BOUTIQUE, display_id: 4, title: 'cartservice: expire abandoned carts in Redis', description: 'Carts never expire; set a TTL on write and refresh it on read so the memory store stops growing', lane: 'executing', position: 0, agent: 'codex', session_id: SESSION_BOUTIQUE_REDIS, worktree_folder: 'cart-ttl-8d9e0f', branch_name: 'cartservice-redis-ttl', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['bug', 'perf'], priority: 2, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 5 },
  { id: 'task-ob-mtls', projectId: PROJECT_BOUTIQUE, display_id: 5, title: 'Istio strict mTLS for the frontend namespace', description: 'PeerAuthentication in STRICT mode plus the DestinationRules the frontend needs to keep talking to the services', lane: 'executing', position: 1, agent: 'opencode', session_id: SESSION_BOUTIQUE_MTLS, worktree_folder: 'istio-mtls-2b3c4d', branch_name: 'istio-strict-mtls', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['security'], priority: 2, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 41 },
  { id: 'task-ob-currency-a11y', projectId: PROJECT_BOUTIQUE, display_id: 6, title: 'Frontend: currency selector keyboard and screen-reader support', description: 'The header currency dropdown is a styled div; make it a real select with a label', lane: 'review', position: 0, agent: 'copilot', session_id: SESSION_BOUTIQUE_A11Y, worktree_folder: 'currency-a11y-5e6f7a', branch_name: 'frontend-currency-a11y', pr_number: 2941, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2941', pr_state: 'open', pr_merge_readiness: 'conflicting', base_branch: 'main', labels: ['a11y'], priority: 1, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 75 },
  { id: 'task-ob-otel', projectId: PROJECT_BOUTIQUE, display_id: 7, title: 'OpenTelemetry traces for shippingservice', description: 'Instrument the gRPC server with the otel Go SDK and export to the collector already in the cluster', lane: 'testing', position: 0, agent: 'codex', session_id: SESSION_BOUTIQUE_OTEL, worktree_folder: 'otel-shipping-6f7a8b', branch_name: 'shippingservice-otel', pr_number: 2937, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2937', pr_state: 'open', base_branch: 'main', labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 4, updatedMinutesAgo: 30 },
  { id: 'task-ob-done-go124', projectId: PROJECT_BOUTIQUE, display_id: 8, title: 'Bump Go to 1.24 across services', description: 'go.mod, the Dockerfiles, and the release workflow', lane: 'done', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: 'go-1-24', pr_number: 2921, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2921', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: [], priority: 0, attachment_count: 0, createdDaysAgo: 9, updatedMinutesAgo: 5800, archivedDaysAgo: 3 },
  { id: 'task-ob-done-skaffold', projectId: PROJECT_BOUTIQUE, display_id: 9, title: 'Update the Skaffold profiles for the new registry', description: 'Image names and the kustomize overlays', lane: 'done', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: 'skaffold-registry', pr_number: 2915, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2915', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: [], priority: 0, attachment_count: 0, createdDaysAgo: 12, updatedMinutesAgo: 9000, archivedDaysAgo: 6 },
];

// ---------------------------------------------------------------- sessions
// The models the recordings were made on, named the way each CLI prints them.
const OPUS = { id: 'claude-opus-5', displayName: 'Opus 5 (1M)' };
const CODEX = { id: 'gpt-5.5', displayName: 'GPT-5.5' };
const GEMINI = { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash' };
const OPENCODE = { id: 'opencode/big-pickle', displayName: 'Big Pickle' };
const COPILOT = { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' };
// Cursor and Gemini both run their session on a router rather than a named model, and print that
// router ("Auto") in their own status line. Kangentic does not show a router: it reads the model
// the router RESOLVED to, from Cursor's init event and Gemini's session history, so a card names a
// real model. These are the two the recordings' context windows fit, 1M each: gemini-3-flash is
// the Flash tier in resolveGeminiContextWindowSize (Pro is 2M), and the Cursor id and its display
// string are as "cursor-agent --list-models" prints them, which is Sonnet-first, not 4.5-first.
const CURSOR = { id: 'claude-4.5-sonnet', displayName: 'Claude Sonnet 4.5' };
/** The model a fresh spawn of each agent runs on, for the context bar of a session a visitor starts. */
const MODEL_BY_AGENT: Record<string, { id: string; displayName: string }> = { claude: OPUS, codex: CODEX, gemini: GEMINI, opencode: OPENCODE, copilot: COPILOT, cursor: CURSOR };
/**
 * The model ids a scene's column patches name, so each is spelled once. Opus 5 and GPT-5.5 are
 * what the recordings ran on; Sonnet 5 is a column choice (the build step of a board that plans
 * on Opus, as this repo's own kangentic.json does), not a recorded session.
 */
export const DEMO_COLUMN_MODELS = { opus: OPUS.id, sonnet: 'claude-sonnet-5', codex: CODEX.id } as const;
/** Claude's model list: the mock's aliases plus the two ids the columns name. */
const CLAUDE_MODELS = ['haiku', 'opus', 'sonnet', DEMO_COLUMN_MODELS.opus, DEMO_COLUMN_MODELS.sonnet];
/** The mock's global default, which a lane with no permission mode of its own spawns in. */
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

export const DEMO_SESSIONS: DemoSession[] = [
  { id: SESSION_WEBSOCKET, taskId: 'task-cw-websocket', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 14, model: OPUS, effort: 'medium', permissionMode: 'plan', contextPercent: 12, contextWindowSize: 1000000, costUsd: 0.42, durationMinutes: 14, peek: ['Read src/lib/websocket.ts, src/App.tsx', 'Claude has written up a plan and is ready to execute'], events: [{ minutesAgo: 2, tool: 'Read', detail: 'src/lib/websocket.ts' }, { minutesAgo: 1, tool: 'Grep', detail: 'websocket' }, { minutesAgo: 0.3, tool: 'ExitPlanMode', detail: 'Plan ready for approval' }], rateLimits: true },
  { id: SESSION_MIDDLEWARE, taskId: TASK_MIDDLEWARE, projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'thinking', startedMinutesAgo: 47, model: OPUS, effort: 'high', permissionMode: 'acceptEdits', contextPercent: 53, contextWindowSize: 1000000, costUsd: 2.47, durationMinutes: 47, peek: ['Write server/middleware/auth.ts', 'Edit server/routes.ts', 'Bash npm test'], events: [{ minutesAgo: 6, tool: 'Read', detail: 'server/routes.ts' }, { minutesAgo: 4, tool: 'Write', detail: 'server/middleware/auth.ts' }, { minutesAgo: 2, tool: 'Edit', detail: 'server/routes.ts' }, { minutesAgo: 0.5, tool: 'Bash', detail: 'npm test' }], rateLimits: true },
  { id: SESSION_API_CLIENT, taskId: 'task-cw-api-client', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'thinking', liveTailMs: 150000, startedMinutesAgo: 88, model: OPUS, effort: 'high', permissionMode: 'acceptEdits', contextPercent: 65, contextWindowSize: 1000000, costUsd: 2.87, durationMinutes: 88, peek: ['Write src/types/api.ts', 'Edit src/lib/http-client.ts', 'Bash npm run typecheck'], events: [{ minutesAgo: 4, tool: 'Write', detail: 'src/types/api.ts' }, { minutesAgo: 2, tool: 'Edit', detail: 'src/lib/http-client.ts' }, { minutesAgo: 0.5, tool: 'Bash', detail: 'npm run typecheck' }] },
  { id: SESSION_RATE_LIMIT, taskId: 'task-cw-rate-limit', projectId: PROJECT_CONTOSO, agent: 'copilot', status: 'running', activity: 'idle', startedMinutesAgo: 130, model: COPILOT, effort: null, permissionMode: 'acceptEdits', contextPercent: 51, contextWindowSize: 1000000, costUsd: 4.15, durationMinutes: 130, peek: ['Read server/rate-limit.ts', 'Edit server/rate-limit.ts', 'Bash npm test'], events: [{ minutesAgo: 24, tool: 'Read', detail: 'server/rate-limit.ts' }, { minutesAgo: 22, tool: 'Edit', detail: 'server/rate-limit.ts' }, { minutesAgo: 20, tool: 'Bash', detail: 'npm test' }], isolated: true },
  { id: SESSION_INTEGRATION, taskId: 'task-cw-integration', projectId: PROJECT_CONTOSO, agent: 'cursor', status: 'running', activity: 'idle', startedMinutesAgo: 26, model: CURSOR, effort: null, permissionMode: 'acceptEdits', contextPercent: 9, contextWindowSize: 1000000, costUsd: 0.78, durationMinutes: 26, peek: ['Read server/routes.ts', 'Write tests/auth.integration.test.ts'], events: [{ minutesAgo: 3, tool: 'Read', detail: 'server/routes.ts' }, { minutesAgo: 1, tool: 'Write', detail: 'tests/auth.integration.test.ts' }] },
  { id: SESSION_CONTOSO_TERMINAL, taskId: null, projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'idle', startedMinutesAgo: 9, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 4, contextWindowSize: 1000000, costUsd: 0.06, durationMinutes: 9, peek: ['Summarize what this repository does', 'Baked for 13s'], events: [], transient: true, commandTerminalBranch: 'main' },
  { id: SESSION_EMPTY_STATES, taskId: 'task-cw-empty-states', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 98, model: OPUS, effort: 'medium', permissionMode: 'plan', contextPercent: 16, contextWindowSize: 1000000, costUsd: 0.38, durationMinutes: 98, peek: ['Read src/App.tsx', 'Claude has written up a plan and is ready to execute'], events: [{ minutesAgo: 12, tool: 'Read', detail: 'src/App.tsx' }, { minutesAgo: 9, tool: 'Grep', detail: 'empty' }, { minutesAgo: 6, tool: 'ExitPlanMode', detail: 'Plan ready for approval' }], rateLimits: true },
  { id: SESSION_VITE8, taskId: 'task-cw-vite8', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 51, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 31, contextWindowSize: 1000000, costUsd: 1.05, durationMinutes: 51, peek: ['Bash npx tsc --noEmit', 'Claude wants to fetch content from vitest.dev'], events: [{ minutesAgo: 14, tool: 'Read', detail: 'package.json' }, { minutesAgo: 6, tool: 'Bash', detail: 'npx tsc --noEmit' }, { minutesAgo: 2, tool: 'WebFetch', detail: 'https://vitest.dev/guide/migration.html' }] },

  { id: SESSION_PETCLINIC_FLAKY, taskId: 'task-pc-flaky-tests', projectId: PROJECT_PETCLINIC, agent: 'codex', status: 'running', activity: 'thinking', startedMinutesAgo: 21, model: CODEX, effort: 'high', permissionMode: 'bypassPermissions', contextPercent: 34, contextWindowSize: 400000, costUsd: 0.91, durationMinutes: 21, peek: ['Read PetClinicIntegrationTests.java', 'rg -n @OrderBy src/main/java'], events: [{ minutesAgo: 8, tool: 'Read', detail: 'src/test/java/org/springframework/samples/petclinic/PetClinicIntegrationTests.java' }, { minutesAgo: 2, tool: 'Bash', detail: 'rg -n "@OrderBy\\(" src/main/java' }] },
  { id: SESSION_PETCLINIC_SEARCH, taskId: 'task-pc-owner-search', projectId: PROJECT_PETCLINIC, agent: 'gemini', status: 'running', activity: 'permission', startedMinutesAgo: 39, model: GEMINI, effort: null, permissionMode: 'default', contextPercent: 18, contextWindowSize: 1000000, costUsd: 0.33, durationMinutes: 39, peek: ['ReadFolder src/main/java/org/springframework/samples/petclinic/owner', 'Allow execution of [Shell] .\\gradlew.bat test?'], events: [{ minutesAgo: 12, tool: 'ReadFile', detail: 'src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java' }, { minutesAgo: 9, tool: 'Shell', detail: '.\\gradlew.bat test' }] },
  { id: SESSION_PETCLINIC_CACHE, taskId: 'task-pc-caffeine', projectId: PROJECT_PETCLINIC, agent: 'opencode', status: 'running', activity: 'idle', startedMinutesAgo: 58, model: OPENCODE, effort: null, permissionMode: 'acceptEdits', contextPercent: 27, contextWindowSize: 200000, costUsd: 0, durationMinutes: 58, peek: ['Read src/main/java/org/springframework/samples/petclinic/system/CacheConfiguration.java', 'Grep cache'], events: [{ minutesAgo: 17, tool: 'Read', detail: 'src/main/java/org/springframework/samples/petclinic/system/CacheConfiguration.java' }, { minutesAgo: 9, tool: 'Grep', detail: 'cache' }] },
  { id: SESSION_PETCLINIC_BOOT35, taskId: 'task-pc-boot-35', projectId: PROJECT_PETCLINIC, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 133, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 24, contextWindowSize: 1000000, costUsd: 0.83, durationMinutes: 133, peek: ['Edit pom.xml', 'Edit .github/workflows/maven-build.yml'], events: [{ minutesAgo: 40, tool: 'Read', detail: 'pom.xml' }, { minutesAgo: 36, tool: 'Edit', detail: 'pom.xml' }, { minutesAgo: 33, tool: 'Edit', detail: '.github/workflows/maven-build.yml' }] },

  { id: SESSION_BOUTIQUE_REDIS, taskId: 'task-ob-redis-ttl', projectId: PROJECT_BOUTIQUE, agent: 'codex', status: 'running', activity: 'idle', startedMinutesAgo: 33, model: CODEX, effort: 'medium', permissionMode: 'bypassPermissions', contextPercent: 41, contextWindowSize: 400000, costUsd: 1.12, durationMinutes: 33, peek: ['Read src/cartservice/src/cartstore/RedisCartStore.cs', 'Edit RedisCartStore.cs'], events: [{ minutesAgo: 9, tool: 'Read', detail: 'src/cartservice/src/cartstore/RedisCartStore.cs' }, { minutesAgo: 5, tool: 'Edit', detail: 'src/cartservice/src/cartstore/RedisCartStore.cs' }] },
  { id: SESSION_BOUTIQUE_MTLS, taskId: 'task-ob-mtls', projectId: PROJECT_BOUTIQUE, agent: 'opencode', status: 'suspended', activity: null, startedMinutesAgo: 210, model: OPENCODE, effort: null, permissionMode: 'acceptEdits', contextPercent: 18, contextWindowSize: 200000, costUsd: 0, durationMinutes: 62, peek: ['Write istio-manifests/frontend-peerauth.yaml', 'Write istio-manifests/frontend-destinationrule.yaml'], events: [{ minutesAgo: 152, tool: 'Write', detail: 'istio-manifests/frontend-peerauth.yaml' }, { minutesAgo: 150, tool: 'Write', detail: 'istio-manifests/frontend-destinationrule.yaml' }] },
  { id: SESSION_BOUTIQUE_A11Y, taskId: 'task-ob-currency-a11y', projectId: PROJECT_BOUTIQUE, agent: 'copilot', status: 'running', activity: 'thinking', startedMinutesAgo: 96, model: COPILOT, effort: null, permissionMode: 'acceptEdits', contextPercent: 38, contextWindowSize: 200000, costUsd: 0.7, durationMinutes: 96, peek: ['Edit src/frontend/templates/header.html', 'Shell go test ./...'], events: [{ minutesAgo: 41, tool: 'Edit', detail: 'src/frontend/templates/header.html' }, { minutesAgo: 40, tool: 'Shell', detail: 'go test ./...' }], isolated: true },
  { id: SESSION_BOUTIQUE_OTEL, taskId: 'task-ob-otel', projectId: PROJECT_BOUTIQUE, agent: 'codex', status: 'running', activity: 'thinking', startedMinutesAgo: 44, model: CODEX, effort: 'medium', permissionMode: 'bypassPermissions', contextPercent: 23, contextWindowSize: 400000, costUsd: 0.21, durationMinutes: 44, peek: ['Read src/shippingservice/main.go', 'rg -n otel src/shippingservice'], events: [{ minutesAgo: 7, tool: 'Read', detail: 'src/shippingservice/main.go' }, { minutesAgo: 2, tool: 'Bash', detail: 'rg -n otel src/shippingservice' }] },
];

export const DEMO_BACKLOG: DemoBacklogItem[] = [
  { id: 'backlog-cw-dark-mode', projectId: PROJECT_CONTOSO, title: 'Dark mode for the dashboard', description: 'Token pass over the dashboard cards and charts; the marketing site already ships both themes', priority: 2, labels: ['design'], position: 0, external_source: null, external_id: null, external_url: null, createdDaysAgo: 9 },
  { id: 'backlog-cw-invoice-pdf', projectId: PROJECT_CONTOSO, title: 'Invoice PDF export', description: 'Customers ask for a downloadable invoice from the billing page', priority: 1, labels: ['feature'], position: 1, external_source: 'github', external_id: '112', external_url: 'https://github.com/contoso/contoso-web/issues/112', createdDaysAgo: 15 },
  { id: 'backlog-cw-flaky-e2e', projectId: PROJECT_CONTOSO, title: 'Flaky checkout e2e on Firefox', description: 'The Playwright checkout spec times out on Firefox one run in five', priority: 3, labels: ['bug'], position: 2, external_source: 'github', external_id: '118', external_url: 'https://github.com/contoso/contoso-web/issues/118', createdDaysAgo: 4 },
  { id: 'backlog-pc-i18n-de', projectId: PROJECT_PETCLINIC, title: 'German translations for the visit forms', description: 'messages_de.properties is missing the visit keys added in the last release', priority: 1, labels: ['docs'], position: 0, external_source: 'github', external_id: '1420', external_url: 'https://github.com/spring-projects/spring-petclinic/issues/1420', createdDaysAgo: 6 },
  { id: 'backlog-ob-chaos', projectId: PROJECT_BOUTIQUE, title: 'Chaos test: kill paymentservice during checkout', description: 'A repeatable failure drill for the retry work', priority: 2, labels: ['tests'], position: 0, external_source: null, external_id: null, external_url: null, createdDaysAgo: 3 },
  { id: 'backlog-ob-helm', projectId: PROJECT_BOUTIQUE, title: 'Publish the Helm chart to the OCI registry', description: 'The chart lives in the repo but is not pushed on release', priority: 1, labels: [], position: 1, external_source: null, external_id: null, external_url: null, createdDaysAgo: 11 },
];

/**
 * Agents the sample install reports as installed: those the boards use, at the versions the
 * recordings were made on. `capabilities` is what each adapter's discovery reports for this
 * install, and the Column Manager reads it: without it a Codex column's form hides its Model
 * field. Each block is whole, since the mock's merge is shallow.
 *
 *   - Claude: its --help effort levels, and display names from the adapter's own
 *     buildModelDisplayNames, so a column on claude-opus-5 reads "Opus 5" as on the desktop.
 *   - Codex: no effort levels. Its effort is config.toml only, so Kangentic offers none
 *     (discoverCodexCapabilities), and its models come from session history: the one recorded.
 *   - Copilot: the --reasoning-effort choices its help lists, and its recorded model.
 */
export const DEMO_AGENT_OVERRIDES: Record<string, Record<string, unknown>> = {
  claude: {
    version: '2.1.270',
    capabilities: {
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsModelOverride: true,
      models: CLAUDE_MODELS,
      modelDisplayNames: buildModelDisplayNames(CLAUDE_MODELS),
    },
  },
  codex: {
    found: true, path: '/usr/local/bin/codex', version: '0.141.0',
    capabilities: { supportsModelOverride: true, models: [CODEX.id], effortLevels: [] },
  },
  gemini: { found: true, path: '/usr/local/bin/gemini', version: '0.58.0' },
  opencode: { found: true, path: '/usr/local/bin/opencode', version: '1.18.30' },
  copilot: {
    found: true, path: '/usr/local/bin/copilot', version: '1.0.83',
    capabilities: { supportsModelOverride: true, models: [COPILOT.id], effortLevels: ['low', 'medium', 'high', 'xhigh'] },
  },
};

// ---------------------------------------------------------------- the applier
/**
 * The script the page runs after the mock has loaded. Everything above is inlined as JSON; the
 * only code is the small applier that turns offsets into timestamps and pushes rows.
 */
/**
 * The code points that are not one cell wide, as flat [lo, hi, lo, hi, ...] ranges: `wide` for
 * two cells, `zero` for none. Built by buildCellWidthTable in demo-scrollback.ts from the app's own
 * width table; the seed's frame applier clips rows by cell with it.
 */
export interface DemoCellWidthTable {
  wide: number[];
  zero: number[];
}

export function buildDemoPreConfig(options: {
  scrollback?: DemoScrollbackMap;
  changes?: DemoChangesMap;
  peeks?: Record<string, string[]>;
  ends?: Record<string, { durationMs: number; stopReason: string }>;
  openFrames?: Record<string, { serialized: string; peek: string[] }>;
  /**
   * What a still paints for a session whose window mounted at the tiled width (loadDemoTiledFrames):
   * the tiled recording's final frame, and a working session's opening frame. Only the sessions
   * the manifest gives a tiled sibling; the rest paint the single recording's frames above.
   */
  tiledFrames?: Record<string, { serialized: string; openFrame: { serialized: string; peek: string[] } | null }>;
  peekTimelines?: Record<string, Array<{ t: number; lines: string[] }>>;
  messageTrails?: Record<string, Array<{ t: number; uuid: string; ts: number; text: string }>>;
  /** How many trail lines main keeps per session (MESSAGE_TRAIL_MAX_ENTRIES), so a replay slices as it does. */
  messageTrailMaxEntries?: number;
  liveTailMs?: number;
  currentProjectId?: string;
  appVersion?: string;
  /** Cell widths for the frame applier (buildCellWidthTable); every code point outside the ranges is one cell. */
  cellWidths?: DemoCellWidthTable;
  /** Each scaffolded project's git history (loadDemoHistory), keyed by project name. */
  history?: Record<string, DemoHistory>;
} = {}): string {
  const dataset = {
    groups: DEMO_GROUPS,
    projects: DEMO_PROJECTS,
    // Column ids are computed HERE, not in the applier below. The applier is generated JS text
    // that cannot import anything, so a formula written there would be a second copy of
    // `demoLaneId` and the guard that resolves a scene's seeded ids would drift from what the
    // seed actually writes. Precomputing keeps it one function.
    lanesByProject: Object.fromEntries(
      Object.entries(DEMO_LANES_BY_PROJECT).map(([projectId, lanes]) => [
        projectId,
        lanes.map((lane) => ({ ...lane, id: demoLaneId(projectId, lane.slug) })),
      ]),
    ),
    tasks: DEMO_TASKS.map((task) => ({ ...task, swimlane_id: demoLaneId(task.projectId, task.lane) })),
    sessions: DEMO_SESSIONS,
    backlog: DEMO_BACKLOG,
    labelColors: DEMO_LABEL_COLORS,
    agentOverrides: DEMO_AGENT_OVERRIDES,
    modelByAgent: MODEL_BY_AGENT,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    currentProjectId: options.currentProjectId ?? PROJECT_CONTOSO,
    // The real app version, so the status bar and the What's New gate agree with the build
    // rather than with the mock's placeholder.
    appVersion: options.appVersion ?? null,
    // When each session's recording ends and why (loadDemoEnds): a working session's clock and
    // whether it finishes, without fetching a stream.
    ends: options.ends ?? {},
    // How long before its recording's end the live frame opens a working session (the manifest's
    // liveTailMs; a session row can carry its own).
    liveTailMs: options.liveTailMs ?? 90000,
  };
  const scrollback = options.scrollback ?? {};
  const changes = options.changes ?? {};
  const peeks = options.peeks ?? {};
  // The frame and Monitor peek at the moment the live frame opens each working session
  // (loadDemoOpenFrames): what a still and the captures show for it.
  const openFrames = options.openFrames ?? {};
  const tiledFrames = options.tiledFrames ?? {};
  // How each working session's Monitor peek changes as its recording plays (loadDemoPeekTimelines):
  // the motion a Monitor card shows on the desktop, on the recording's own clock.
  const peekTimelines = options.peekTimelines ?? {};
  // What each session's agent said, on the recording's own clock (loadDemoMessageTrails). The
  // board card's default Card Preview prints the newest line, so this is the card's own text and
  // it moves with the replay. A session absent here legitimately has none; see the loader.
  const messageTrails = options.messageTrails ?? {};
  // Both real callers pass MESSAGE_TRAIL_MAX_ENTRIES. It is restated rather than imported because
  // this module must stay free of Node imports (scripts/capture-demo-sessions.mjs loads it through
  // Node's own type stripping), and the tracker reaches node:events and node:fs.
  const messageTrailMaxEntries = options.messageTrailMaxEntries ?? 5;
  // Every session with a terminal replays a recording; there is no hand-authored fallback. A
  // missing one would be a blank terminal in the frame and in every capture, so it fails the
  // build and the rig instead.
  const missingRecordings = DEMO_SESSIONS
    .filter((session) => session.status !== 'queued' && !(typeof scrollback[session.id] === 'string' && scrollback[session.id].length > 0))
    .map((session) => session.id);
  if (missingRecordings.length > 0) {
    throw new Error(
      `[demo] no terminal recording for ${missingRecordings.join(', ')}: add each to `
      + 'tests/captures/fixtures/demo/manifest.json and run "node scripts/capture-demo-sessions.mjs --skip-existing"',
    );
  }
  return `
    (function () {
      var data = ${JSON.stringify(dataset)};
      var worktreeSubpath = ${JSON.stringify(WORKTREE_SUBPATH)};
      var scrollback = ${JSON.stringify(scrollback)};
      var changes = ${JSON.stringify(changes)};
      var peeks = ${JSON.stringify(peeks)};
      var openFrames = ${JSON.stringify(openFrames)};
      var tiledFrames = ${JSON.stringify(tiledFrames)};
      var peekTimelines = ${JSON.stringify(peekTimelines)};
      var messageTrails = ${JSON.stringify(messageTrails)};
      var messageTrailMaxEntries = ${JSON.stringify(messageTrailMaxEntries)};
      var cellWidths = ${JSON.stringify(options.cellWidths ?? { wide: [], zero: [] })};
      var history = ${JSON.stringify(options.history ?? {})};
      var now = Date.now();
      function minutesAgo(minutes) { return new Date(now - minutes * 60000).toISOString(); }
      function daysAgo(days) { return minutesAgo(days * 1440); }
      var projectsById = {};
      data.projects.forEach(function (project) { projectsById[project.id] = project; });
      var tasksById = {};
      data.tasks.forEach(function (task) { tasksById[task.id] = task; });
      function laneName(projectId, slug) {
        var lanes = data.lanesByProject[projectId] || [];
        for (var index = 0; index < lanes.length; index++) if (lanes[index].slug === slug) return lanes[index].name;
        return slug;
      }
      // The mock's live state (its session, task, and swimlane arrays), kept so a visitor's
      // drag or click can add a session the way the main process would.
      var mockState = null;

      // What sessions.getActivityStats() serves the Developer tab's activity debug overlay.
      // Derived from the session's OWN seeded events and activity state, never authored: the
      // overlay's whole job is to explain why the engine reports what it reports, and a panel of
      // invented counters beside a real activity pill would be the one thing on this board that
      // does not agree with itself.
      //
      // Most of the snapshot has a documented correct value here rather than a derived one, and
      // that is not a shortcut. \`compensationCounters\` is "in a clean session, all eight fields
      // read 0", and no seeded session has had a watchdog fire. \`recentPtyChunks\` is "empty in
      // production builds where the recorder is dead-code-eliminated", which is the build this
      // renderer IS. The background-shell and subagent counters are zero because no seeded
      // session runs either.
      //
      // One field is a placeholder and is called out rather than faked: \`permissionAwaitedToolId\`
      // wants the tool_use_id a PermissionRequest hook carried, and a recording keeps the agent's
      // BYTES, not its hook payloads. Null is what the overlay shows for "not captured"; a
      // plausible id would be the invention this comment exists to refuse.
      function activityStatsFor(session) {
        var events = session.events || [];
        var last = events.length > 0 ? events[events.length - 1] : null;
        var lastSignalAt = last ? now - last.minutesAgo * 60000 : null;
        var thinking = session.activity === 'thinking';
        var permission = session.activity === 'permission';
        var needsUser = session.activity === 'idle' || permission;
        var reason;
        if (permission) reason = { kind: 'permission', since: lastSignalAt || now };
        else if (thinking) reason = { kind: 'tool', pendingCount: 1, currentTool: last ? last.tool : null };
        else reason = { kind: 'idle', since: lastSignalAt || now };
        // One entry per seeded tool call, which is exactly the run the engine would have recorded,
        // plus the step that parked the session when it is not still working.
        var transitions = events.map(function (event) {
          return {
            ts: now - event.minutesAgo * 60000,
            from: 'thinking', to: 'thinking', reasonKind: 'tool',
            trigger: 'event:tool_start', counterDelta: 'tools +1',
          };
        });
        if (needsUser && lastSignalAt !== null) {
          transitions.push({
            ts: lastSignalAt,
            from: 'thinking', to: session.activity, reasonKind: permission ? 'permission' : 'idle',
            trigger: permission ? 'event:permission' : 'event:idle',
            counterDelta: permission ? 'permission yes' : 'turn no',
          });
        }
        return {
          sessionId: session.id,
          activity: session.activity,
          reason: reason,
          pendingToolCount: thinking ? 1 : 0,
          subagentDepth: 0,
          backgroundShellIds: [],
          anonymousBackgroundShellCount: 0,
          exemptBackgroundShellIds: [],
          turnActive: thinking,
          permissionPending: permission,
          permissionAwaitedToolId: null,
          msSinceLastSignal: lastSignalAt === null ? null : now - lastSignalAt,
          lastSignalAt: lastSignalAt,
          lastPtyOutputAt: lastSignalAt,
          msSincePtyOutput: lastSignalAt === null ? null : now - lastSignalAt,
          pendingIdleArmed: false,
          needsUserSince: needsUser ? lastSignalAt : null,
          idleHintPending: false,
          retryFailurePending: false,
          recentTransitions: transitions.slice(-20),
          compensationCounters: {
            staleThinking: 0, bgShellHatch: 0, stuckPendingTools: 0, forceThinking: 0,
            forceIdle: 0, unmatchedBgShellEnd: 0, ignoredInnerSubagentStop: 0, stuckSubagent: 0,
          },
          recentPtyChunks: [],
        };
      }

      // The trail a session has shown by a given moment of its replay: every line up to then,
      // keeping the newest few, which is exactly what MessageTrailTracker.merge pushes.
      function trailAt(sessionId, offsetMs) {
        var all = messageTrails[sessionId] || [];
        var visible = [];
        for (var index = 0; index < all.length; index++) {
          if (all[index].t > offsetMs) break;
          visible.push({ uuid: all[index].uuid, ts: all[index].ts, text: all[index].text });
        }
        return visible.slice(-messageTrailMaxEntries);
      }
      // Where a session's replay opens: a working session opens its recording a tail before the
      // end, and every other one is already at its end, so it shows the line its agent finished on.
      function replayOpensAt(session) {
        var end = data.ends[session.id];
        var duration = end ? end.durationMs : Infinity;
        var tail = session.activity === 'thinking' ? (session.liveTailMs || data.liveTailMs) : 0;
        return Math.max(0, duration - tail);
      }

      // An EMPTY install: the welcome screen a first launch lands on. The frame's boot script sets
      // window.__demoInstall from the scene; nothing but the returning-user markers is seeded, so
      // the renderer hydrates with no project and mounts the welcome screen, whose agent detection
      // grid reads the same agent list the sample install reports.
      var emptyInstall = window.__demoInstall === 'empty';

      window.__mockPreConfigure(function (state) {
        if (emptyInstall) {
          if (data.appVersion) state.config.lastWhatsNewShownVersion = data.appVersion;
          mockState = state;
          return { currentProjectId: null };
        }
        data.groups.forEach(function (group) {
          state.projectGroups.push({ id: group.id, name: group.name, position: group.position, is_collapsed: group.is_collapsed });
        });
        data.projects.forEach(function (project) {
          state.projects.push({
            id: project.id, name: project.name, path: project.path, github_url: project.github_url,
            default_agent: project.default_agent, group_id: project.group_id, position: project.position,
            last_opened: minutesAgo(project.lastOpenedMinutesAgo), created_at: daysAgo(project.createdDaysAgo),
          });
          // The project's Browser default URL, which every task's Browser pane opens on unless
          // the task pins its own (Settings, Browser, Default URL).
          if (project.dev_url) {
            state.projectConfigs[project.path] = Object.assign({}, state.projectConfigs[project.path], { browser: { defaultUrl: project.dev_url } });
          }
          (data.lanesByProject[project.id] || []).forEach(function (lane, index) {
            state.swimlanes.push({
              id: lane.id,
              projectId: project.id,
              name: lane.name, role: lane.role, color: lane.color, icon: lane.icon,
              is_archived: lane.is_archived, is_ghost: false,
              permission_mode: lane.permission_mode, permission_strategy: null,
              auto_spawn: lane.auto_spawn, auto_command: null, plan_exit_target_id: null,
              agent_override: lane.agent || null, handoff_context: false,
              position: index, created_at: daysAgo(project.createdDaysAgo),
            });
          });
        });
        data.tasks.forEach(function (task) {
          var project = projectsById[task.projectId];
          var row = {
            id: task.id, projectId: task.projectId, display_id: task.display_id, title: task.title, description: task.description,
            swimlane_id: task.swimlane_id, position: task.position,
            agent: task.agent, session_id: task.session_id,
            worktree_path: task.worktree_folder ? project.path + worktreeSubpath + task.worktree_folder : null,
            worktree_folder: task.worktree_folder, branch_name: task.branch_name,
            pr_number: task.pr_number, pr_url: task.pr_url, pr_state: task.pr_state, pr_merge_readiness: task.pr_merge_readiness, base_branch: task.base_branch,
            use_worktree: task.worktree_folder ? 1 : null, labels: task.labels, priority: task.priority,
            attachment_count: task.attachment_count, archived_at: task.archivedDaysAgo ? daysAgo(task.archivedDaysAgo) : null,
            created_at: daysAgo(task.createdDaysAgo), updated_at: minutesAgo(task.updatedMinutesAgo),
          };
          if (task.archivedDaysAgo) state.archivedTasks.push(row); else state.tasks.push(row);
        });
        data.sessions.forEach(function (session, index) {
          var project = projectsById[session.projectId];
          var task = session.taskId ? tasksById[session.taskId] : null;
          state.sessions.push({
            id: session.id, taskId: session.taskId, projectId: session.projectId, pid: 20000 + index,
            status: session.status, shell: 'bash',
            cwd: task && task.worktree_folder ? project.path + worktreeSubpath + task.worktree_folder : project.path,
            startedAt: minutesAgo(session.startedMinutesAgo), exitCode: null,
            transient: session.transient || false, branch: session.commandTerminalBranch || null,
          });
          if (session.activity) {
            state.activityCache[session.id] = session.activity;
            state.activityStatsCache[session.id] = activityStatsFor(session);
          }
          // Seeded BEFORE the renderer mounts, not pushed after: syncSessions reconciles the store
          // against the getMessageTrails() snapshot, so a push-only seed would be dropped, and a
          // card would paint its description first and then flip.
          var seededTrail = trailAt(session.id, replayOpensAt(session));
          if (seededTrail.length > 0) state.messageTrailCache[session.id] = seededTrail;
          state.eventCache[session.id] = session.events.map(function (event) {
            return { ts: now - event.minutesAgo * 60000, type: 'tool_start', tool: event.tool, detail: event.detail };
          });
        });
        data.backlog.forEach(function (item) {
          state.backlogTasks.push({
            id: item.id, projectId: item.projectId, title: item.title, description: item.description, priority: item.priority,
            labels: item.labels, position: item.position, assignee: null, due_date: null, item_type: null,
            external_id: item.external_id, external_source: item.external_source, external_url: item.external_url,
            sync_status: item.external_source ? 'synced' : null, external_metadata: null, attachment_count: 0,
            created_at: daysAgo(item.createdDaysAgo), updated_at: daysAgo(item.createdDaysAgo),
          });
        });
        state.config.backlog.labelColors = data.labelColors;
        if (data.appVersion) state.config.lastWhatsNewShownVersion = data.appVersion;
        // The concurrency cap leaves room above the running count, so a drag into an auto-spawn
        // column starts an agent the way it does on the desktop rather than queueing it.
        state.config.agent.maxConcurrentSessions = data.sessions.filter(function (session) { return session.status === 'running'; }).length + 4;
        mockState = state;
        return { currentProjectId: data.currentProjectId };
      });

      if (data.appVersion) {
        window.electronAPI.app.getVersion = function () { return Promise.resolve(data.appVersion); };
      }
      window.__mockAgentListOverrides = data.agentOverrides;

      // Dictation needs nothing seeded. The renderer's whole pipeline runs for real on a press
      // (the hotkey, the mic request the mock grants, the engine start, the audio worklet over
      // the silent stream demo/boot.js supplies), and the chip shows its live state. What the
      // engine would transcribe cannot be shown: with the popup experience the words land in
      // the terminal on release, drawn by the CLI's own echo, and no mock can produce that.

      // Quick Find answers from the sample install itself: a keyword match over the tasks, the
      // backlog, and each session's events, scoped the way the palette asks (this project or all
      // of them). The desktop runs FTS5 in main over the same rows; here the rows are the index,
      // so a visitor's query finds what the desktop's would, ranked title matches first.
      function searchSnippet(text, query) {
        var haystack = String(text || '');
        var at = haystack.toLowerCase().indexOf(query);
        if (at === -1) return null;
        var start = Math.max(0, at - 40);
        var snippet = (start > 0 ? '…' : '') + haystack.slice(start, Math.min(haystack.length, at + query.length + 60));
        var offset = at - start + (start > 0 ? 1 : 0);
        return { snippet: snippet, matchStart: offset, matchEnd: offset + query.length };
      }
      window.electronAPI.search.everything = function (request) {
        var query = String((request && request.query) || '').trim().toLowerCase();
        if (!query || !mockState) return Promise.resolve([]);
        var scopeProject = request && request.scope === 'all' ? null : (request && request.currentProjectId) || null;
        var inScope = function (projectId) { return !scopeProject || projectId === scopeProject; };
        var hits = [];
        var taskHit = function (task, archived) {
          if (!inScope(task.projectId)) return;
          var fromTitle = searchSnippet(task.title, query);
          var match = fromTitle || searchSnippet(task.description, query);
          if (!match) return;
          hits.push({
            kind: 'task', projectId: task.projectId, projectName: projectsById[task.projectId].name,
            snippet: match.snippet, matchStart: match.matchStart, matchEnd: match.matchEnd,
            taskId: task.id, displayId: task.display_id, taskTitle: task.title, archived: archived,
            snippetField: fromTitle ? 'title' : 'description',
          });
        };
        mockState.tasks.forEach(function (task) { taskHit(task, false); });
        mockState.archivedTasks.forEach(function (task) { taskHit(task, true); });
        mockState.backlogTasks.forEach(function (item) {
          if (!inScope(item.projectId)) return;
          var fromTitle = searchSnippet(item.title, query);
          var match = fromTitle || searchSnippet(item.description, query);
          if (!match) return;
          hits.push({
            kind: 'backlog', projectId: item.projectId, projectName: projectsById[item.projectId].name,
            snippet: match.snippet, matchStart: match.matchStart, matchEnd: match.matchEnd,
            backlogId: item.id, backlogTitle: item.title, snippetField: fromTitle ? 'title' : 'description',
          });
        });
        mockState.sessions.forEach(function (session) {
          if (!session.taskId || !inScope(session.projectId)) return;
          var task = tasksById[session.taskId];
          if (!task) return;
          (mockState.eventCache[session.id] || []).forEach(function (event) {
            var match = searchSnippet((event.tool || '') + ' ' + (event.detail || ''), query);
            if (!match) return;
            hits.push({
              kind: 'session_event', projectId: session.projectId, projectName: projectsById[session.projectId].name,
              snippet: match.snippet, matchStart: match.matchStart, matchEnd: match.matchEnd,
              taskId: task.id, taskTitle: task.title, sessionId: session.id, agentName: task.agent || projectsById[session.projectId].default_agent,
              eventTs: event.ts, eventKey: session.id + ':' + event.ts, eventType: event.type,
            });
          });
        });
        return Promise.resolve(hits);
      };

      // Monitor rows are DERIVED from the sessions so the two views cannot disagree. The output
      // peek is the recording's own last lines as the terminal displays them (rendered at build
      // time by loadDemoPeeks), or for a working session the lines at the moment the frame opens
      // it; the authored peek covers only a session with no recording.
      function seededPeek(session) {
        var open = session.activity === 'thinking' ? openFrames[session.id] : null;
        if (open) return open.peek;
        return peeks[session.id] || session.peek;
      }
      window.__mockMonitorRows = (emptyInstall ? [] : data.sessions).map(function (session) {
        var project = projectsById[session.projectId];
        var task = session.taskId ? tasksById[session.taskId] : null;
        return {
          sessionId: session.id, projectId: session.projectId, projectName: project.name,
          taskId: session.taskId || session.id, taskTitle: task ? task.title : 'Command Terminal 1',
          outputPeek: seededPeek(session), displayId: task ? task.display_id : null,
          columnName: task ? laneName(task.projectId, task.lane) : '',
          commandTerminalBranch: session.commandTerminalBranch || null,
          labels: task ? task.labels : [], prUrl: task ? task.pr_url : null, prNumber: task ? task.pr_number : null,
          prState: task ? task.pr_state : null, prMergeReadiness: task ? task.pr_merge_readiness : null,
          agentName: session.agent, modelDisplayName: session.model ? session.model.displayName : null,
          effort: session.effort, permissionMode: session.permissionMode,
          startedAt: minutesAgo(session.startedMinutesAgo), exitedAt: null,
          status: session.status, activity: session.activity, activityReason: null,
          lastEvent: null, contextPercent: session.contextPercent, isolated: session.isolated || false,
          isCommandTerminal: session.transient || false,
        };
      });

      var usageBySession = {};
      data.sessions.forEach(function (session) {
        if (!session.model || session.contextPercent === null) return;
        var used = Math.round(session.contextWindowSize * session.contextPercent / 100);
        usageBySession[session.id] = {
          model: session.model,
          contextWindow: {
            usedPercentage: session.contextPercent, usedTokens: used, cacheTokens: Math.round(used * 0.42),
            totalInputTokens: Math.round(used * 0.7), totalOutputTokens: Math.round(used * 0.3), contextWindowSize: session.contextWindowSize,
          },
          cost: { totalCostUsd: session.costUsd, totalDurationMs: session.durationMinutes * 60000 },
        };
        if (session.rateLimits) {
          usageBySession[session.id].rateLimits = [
            { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 20, resetsAt: Math.floor(now / 1000) + 3600, windowDurationSeconds: 5 * 60 * 60 },
            { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 8, resetsAt: Math.floor(now / 1000) + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 },
          ];
        }
      });
      window.electronAPI.sessions.getUsage = function () { return Promise.resolve(usageBySession); };

      // ---- terminal replay -------------------------------------------------------------
      // A still frame, and the marketing captures, paint each session's final terminal state
      // from the inline scrollback through the production mount-replay path. The live frame
      // replays a recording's timed byte stream instead: a session the app shows as working
      // streams its last stretch after the page opens, a spawn a visitor starts streams from its
      // first byte, and a new Command Terminal boots the way it does on the desktop. Recording
      // files are fetched from the same origin when a terminal mounts (window.__demoRecordings,
      // emitted by the build), and the bytes reach the mounted xterm through the mock's own
      // onData listeners, which is the path main's PTY output takes.
      var recordings = window.__demoRecordings || null;
      var stillFrame = !!(window.__demoBoot && window.__demoBoot.params && window.__demoBoot.params.still);
      var live = !!recordings && !stillFrame;
      var LIVE_TAIL_MS = data.liveTailMs;
      var replays = {};
      var recordingCache = {};
      var replayTimers = {};
      // An index entry names the recording file and the grid it was made at (demo/vite.config.mts);
      // the grid rides on the replay entry so a terminal's first resize can be answered before
      // the file is fetched.
      function gridOf(indexed) { return { cols: indexed.cols, rows: indexed.rows }; }
      function seededSession(sessionId) {
        for (var index = 0; index < data.sessions.length; index++) if (data.sessions[index].id === sessionId) return data.sessions[index];
        return null;
      }
      data.sessions.forEach(function (session) {
        if (!recordings || !recordings.sessions[session.id]) return;
        var indexed = recordings.sessions[session.id];
        // A session the manifest also recorded at the tiled width carries both layouts, the way
        // a Command Terminal boot does (spawnTransient below); the pane its window mounts in
        // picks the one that fills more of it (layoutFor).
        replays[session.id] = {
          file: indexed.file, grid: gridOf(indexed), startedAt: null,
          tail: session.activity === 'thinking' ? (session.liveTailMs || LIVE_TAIL_MS) : 0,
          projectId: session.projectId,
          layouts: indexed.tiled ? { single: indexed, tiled: indexed.tiled } : null,
        };
      });

      // ---- a floating terminal window sized to its recording --------------------------------
      // A floating window a scene marks with fitToRecording (a session id) opens exactly as wide
      // as that session's recording at THIS display's terminal cell, so the terminal fits the
      // recording's columns at the configured type and no hold engages. No fixed fraction of the
      // frame can do that. xterm's WebGL renderer floors the cell to device pixels
      // (WebglRenderer.ts), so the 12px Consolas cell is 6.0 CSS px at 100 percent and 6.5 at
      // 200, and a machine without Consolas draws Courier New or its metric clone Liberation Mono
      // at 7.0. A pane wider than the recording leaves an empty band on the right, since a held
      // grid never scales up; a narrower one holds the recording at a smaller type.
      //
      // The width is measured the way the renderer will measure it: the cell as xterm's
      // CharSizeService does (measureText of W at the configured font), floored to device pixels;
      // the scrollbar gutter as fit-addon.ts does (a scroller's offsetWidth minus its clientWidth:
      // the app's 8px on classic scrollbars, 0 on overlay or hidden ones); and the window frame's
      // border. It runs on the renderer's first config read, which comes after the stylesheet has
      // applied (a module script waits for it), so the probe sees the app's own scrollbar rule.
      // The fraction is taken against the 1600px frame the recordings are measured at, or the
      // frame itself when that is wider: a smaller embed keeps the stage's proportions, and a
      // larger one still fits exactly. The size is fixed at load; a zoom after it falls back to
      // the hold and layoutFor.
      var FIT_REFERENCE_FRAME_WIDTH = 1600;
      // WindowFrame's 1px border on each side, the only chrome between a window's width and its
      // terminal's parent: a task window and a Command Terminal both measure 1024px against a
      // 1022px parent, with no padding.
      var WINDOW_FRAME_BORDER_PX = 2;
      // The terminal's cell in DEVICE pixels at the configured font and this display's scale, as
      // xterm's WebGL renderer sizes it: the width floored and the height ceiled (WebglRenderer.ts
      // _updateDimensions), from the same measureText its CharSizeService reads. Cached per font
      // and scale, since a hold decision asks on every resize and a zoom changes the scale.
      var deviceCellCache = {};
      // useTerminal's own fallback, for a config that names none.
      function configuredFontSize(terminalConfig) {
        return (terminalConfig && terminalConfig.fontSize) || 14;
      }
      function terminalDeviceCell(terminalConfig, fontSizeOverride) {
        var fontSize = fontSizeOverride || configuredFontSize(terminalConfig);
        var fontFamily = (terminalConfig && terminalConfig.fontFamily) || 'Menlo, Consolas, "Courier New", monospace';
        var scale = window.devicePixelRatio || 1;
        var key = fontSize + '|' + fontFamily + '|' + scale;
        if (key in deviceCellCache) return deviceCellCache[key];
        var cell = null;
        var context = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(16, 16).getContext('2d');
        if (context) {
          context.font = fontSize + 'px ' + fontFamily;
          var metrics = context.measureText('W');
          var height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
          if (metrics.width > 0 && height > 0) cell = { width: Math.floor(metrics.width * scale), height: Math.ceil(height * scale), scale: scale };
        }
        deviceCellCache[key] = cell;
        return cell;
      }
      function measuredTerminalCell(terminalConfig) {
        var cell = terminalDeviceCell(terminalConfig);
        return cell ? cell.width / cell.scale : null;
      }
      function scrollbarGutterWidth() {
        var probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;left:-1000px;top:-1000px;width:100px;height:100px;overflow-y:scroll;visibility:hidden';
        (document.body || document.documentElement).appendChild(probe);
        var gutter = Math.max(0, probe.offsetWidth - probe.clientWidth);
        probe.remove();
        return gutter;
      }
      // One layout blob's windows, with each marked window's width set and its marker removed.
      // The blob is copied, not edited, because it is the scene registry's own object.
      function fitLayoutBlob(blob, measure) {
        if (!blob || !Array.isArray(blob.windows)) return blob;
        var marked = false;
        var windows = blob.windows.map(function (managedWindow) {
          if (!managedWindow || typeof managedWindow.fitToRecording !== 'string') return managedWindow;
          marked = true;
          var fitted = Object.assign({}, managedWindow);
          var sessionId = fitted.fitToRecording;
          delete fitted.fitToRecording;
          var indexed = recordings && recordings.sessions ? recordings.sessions[sessionId] : null;
          if (!indexed) {
            // A data error, not a browser limitation: say so, or the band comes back with nothing
            // to explain it.
            console.error('[demo] a window asks to fit the recording of "' + sessionId + '", which the recordings index does not carry');
            return fitted;
          }
          var cell = measure();
          if (!cell) return fitted;
          var frameWidth = Math.max(document.documentElement.clientWidth || 0, FIT_REFERENCE_FRAME_WIDTH);
          // Half a cell of slack, so the parent's rounded width still floors to the recording's columns.
          var width = Math.min(1, (WINDOW_FRAME_BORDER_PX + cell.gutter + (indexed.cols + 0.5) * cell.width) / frameWidth);
          fitted.geometry = Object.assign({}, fitted.geometry, { x: (1 - width) / 2, w: width });
          return fitted;
        });
        return marked ? Object.assign({}, blob, { windows: windows }) : blob;
      }
      var windowsFitted = false;
      function fitMarkedWindows() {
        if (windowsFitted || !mockState) return;
        windowsFitted = true;
        var config = mockState.config;
        var measured;
        var measure = function () {
          if (measured === undefined) {
            var width = measuredTerminalCell(config.terminal);
            measured = width ? { width: width, gutter: scrollbarGutterWidth() } : null;
          }
          return measured;
        };
        if (config.workspaceByProject) {
          var workspaces = {};
          Object.keys(config.workspaceByProject).forEach(function (projectId) {
            workspaces[projectId] = fitLayoutBlob(config.workspaceByProject[projectId], measure);
          });
          config.workspaceByProject = workspaces;
        }
        // The Command Terminal's global blob is read later, when the toggle opens the layer; it is
        // fitted here all the same, since this is the one config every later read returns.
        if (config.commandTerminalWorkspace) config.commandTerminalWorkspace = fitLayoutBlob(config.commandTerminalWorkspace, measure);
      }
      ['get', 'getGlobal'].forEach(function (method) {
        var original = window.electronAPI.config[method];
        window.electronAPI.config[method] = function () {
          fitMarkedWindows();
          return original.apply(this, arguments);
        };
      });

      function fetchRecording(file) {
        if (!recordingCache[file]) {
          recordingCache[file] = fetch(recordings.base + file).then(function (response) {
            if (!response.ok) throw new Error('[demo] recording ' + file + ' returned ' + response.status);
            return response.json();
          });
        }
        return recordingCache[file];
      }
      function emitBytes(sessionId, bytes, projectId) {
        var listeners = (window.__mockDataListeners || []).slice();
        for (var index = 0; index < listeners.length; index++) listeners[index](sessionId, bytes, projectId);
      }
      function clearReplayTimers(sessionId) {
        (replayTimers[sessionId] || []).forEach(function (timer) { clearTimeout(timer); });
        replayTimers[sessionId] = [];
      }
      // A recording that ran to the agent's own end (the capture stopped on idle or exit) flips
      // its session to needs-you when the replay gets there, as main's activity engine does when
      // a turn completes. One cut short (stop-after, stop-when) stays working: its last frame is
      // a spinner and tool calls in flight.
      function endedOnItsOwn(recording) {
        return recording.stopReason === 'idle' || recording.stopReason === 'exited';
      }
      function finishSession(sessionId) {
        var row = sessionById(sessionId);
        if (!row || mockState.activityCache[sessionId] !== 'thinking') return;
        mockState.activityCache[sessionId] = 'idle';
        if (window.__mockFireActivity) window.__mockFireActivity(sessionId, 'idle', null, row.projectId, row.taskId);
        var rows = (window.__mockMonitorRows || []).map(function (monitorRow) {
          return monitorRow.sessionId === sessionId ? Object.assign({}, monitorRow, { activity: 'idle' }) : monitorRow;
        });
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      // The inverse, for loop=1: the session goes back to working and the Monitor says so, the
      // way it does on the desktop when the next turn starts.
      function startSession(sessionId) {
        var row = sessionById(sessionId);
        if (!row || mockState.activityCache[sessionId] === 'thinking') return;
        mockState.activityCache[sessionId] = 'thinking';
        if (window.__mockFireActivity) window.__mockFireActivity(sessionId, 'thinking', null, row.projectId, row.taskId);
        var rows = (window.__mockMonitorRows || []).map(function (monitorRow) {
          return monitorRow.sessionId === sessionId ? Object.assign({}, monitorRow, { activity: 'thinking' }) : monitorRow;
        });
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      // The card's own text as the replay reaches each line, announced the way main announces it
      // (session:messageTrail). The cache is written too, so a re-sync agrees with the push.
      function setMessageTrail(sessionId, offsetMs) {
        var entries = trailAt(sessionId, offsetMs);
        // An EMPTY trail is set, not skipped. A recording shorter than the tail opens before its
        // first line, so a loop=1 restart has to take the card back to its description rather than
        // leave it on the summary the previous cycle ended with.
        if (entries.length === 0 && !(sessionId in messageTrails)) return;
        var row = sessionById(sessionId);
        if (mockState) mockState.messageTrailCache[sessionId] = entries;
        if (window.__mockFireMessageTrail) window.__mockFireMessageTrail(sessionId, entries, row ? row.projectId : undefined);
      }
      function setMonitorPeek(sessionId, peek) {
        var changed = false;
        var rows = (window.__mockMonitorRows || []).map(function (row) {
          if (row.sessionId !== sessionId || JSON.stringify(row.outputPeek) === JSON.stringify(peek)) return row;
          changed = true;
          return Object.assign({}, row, { outputPeek: peek });
        });
        if (!changed) return;
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      // Everything a working session's clock does between now and its recording's end, in one
      // place: the Monitor peek changes on the way, the peek and the activity flip at the end,
      // and under loop=1 the next cycle. The two callers (the seed below, and a terminal
      // mounting) both clear the session's timers and then call this, so neither can schedule
      // half of it. The byte stream is separate because only a mounted terminal needs it: the
      // seed never fetches a recording, which is what keeps a Monitor-only frame off the wire.
      var LOOP_PAUSE_MS = 6000;
      var looping = !!(window.__demoBoot && window.__demoBoot.params && window.__demoBoot.params.loop);
      function scheduleSessionClock(sessionId, entry, clock) {
        if (!replayTimers[sessionId]) replayTimers[sessionId] = [];
        (peekTimelines[sessionId] || []).forEach(function (change) {
          var delay = entry.startedAt + change.t - Date.now();
          if (delay < 0) return;
          replayTimers[sessionId].push(setTimeout(function () { setMonitorPeek(sessionId, change.lines); }, delay));
        });
        // The card's message trail rides the same clock, so the line a visitor reads changes at the
        // moment the terminal shows the answer land, whether or not a terminal is open.
        (messageTrails[sessionId] || []).forEach(function (line) {
          var delay = entry.startedAt + line.t - Date.now();
          if (delay < 0) return;
          replayTimers[sessionId].push(setTimeout(function () { setMessageTrail(sessionId, line.t); }, delay));
        });
        // When the replay reaches the recording's end: the Monitor's output peek becomes the
        // recording's own last displayed lines, and a session whose agent finished flips to
        // needs-you.
        replayTimers[sessionId].push(setTimeout(function () {
          if (clock.endPeek && clock.endPeek.length) setMonitorPeek(sessionId, clock.endPeek);
          if (clock.endedOnItsOwn) finishSession(sessionId);
          // Only a session the board seeds as WORKING has a stretch to replay: every other one
          // carries tail 0, so its recording is already at its end and its clock lands at once.
          // Looping those would flip an idle session to working and blank its terminal, since
          // there is no opening frame to repaint from and no chunk left to schedule. A working
          // session whose terminal cannot take the bytes still loops: its card and its Monitor
          // row are the part that moves, and restartSession emits nothing to it.
          if (!looping || entry.tail <= 0) return;
          replayTimers[sessionId].push(setTimeout(function () { restartSession(sessionId, entry, clock); }, LOOP_PAUSE_MS));
        }, Math.max(0, entry.startedAt + clock.durationMs - Date.now())));
      }
      // loop=1: the session goes back to working and replays the same stretch again, after a beat
      // long enough to read the state it finished in. Each session loops on its own clock, so the
      // Monitor keeps changing instead of going quiet until the longest recording comes round.
      // A mounted terminal is repainted from the opening frame rather than left to grow a
      // cycle's scrollback every time.
      function restartSession(sessionId, entry, clock) {
        clearReplayTimers(sessionId);
        entry.startedAt = Date.now() - Math.max(0, clock.durationMs - entry.tail);
        startSession(sessionId);
        var open = openFrames[sessionId];
        setMonitorPeek(sessionId, open ? open.peek : []);
        // Back to the line the cycle opens on, so the card replays the same progression rather
        // than staying on the summary the last cycle ended with.
        setMessageTrail(sessionId, Math.max(0, clock.durationMs - entry.tail));
        if (entry.mounted && recordingCache[entry.file]) {
          recordingCache[entry.file].then(function (recording) {
            if (entry.frameOnly) {
              // This terminal is fed by the emulator: start it again at the moment the cycle
              // opens on, and paint that. A chunk that did not load (frameScrollback's fallback,
              // and the load is cached, so it fails here on every cycle) paints the recorded
              // frame the cycle opens on instead of leaving the rejection unhandled.
              var grid = mountedGeometry[sessionId];
              startEmulator(sessionId, entry, recording, grid).then(function (state) {
                if (state) emitBytes(sessionId, notePainted(sessionId, state.grid, emulatorPaint(state, true)), entry.projectId);
              }, function (error) {
                console.error('[demo] the replay emulator did not load, so ' + sessionId + ' restarts on its recorded frame', error);
                emitBytes(sessionId, notePainted(sessionId, grid, REPAINT + fitFrameToGrid(open ? open.serialized : recording.serialized, grid, recording)), entry.projectId);
              });
            } else {
              emitBytes(sessionId, REPAINT + (open ? open.serialized : ''), entry.projectId);
              scheduleStreamBytes(sessionId, entry, recording);
            }
            scheduleSessionClock(sessionId, entry, clock);
          });
          return;
        }
        scheduleSessionClock(sessionId, entry, clock);
      }
      // A session's clock is its SINGLE recording's: the seed starts it at page open from
      // data.ends, and the card, the sidebar count, and the Monitor all end on it. A terminal that
      // mounted at the tiled width plays the session's tiled recording, a second run of the same
      // prompt with its own length, so that recording's bytes and frames are laid on the session
      // clock shifted to START where the session's clock does: the variant plays from its first
      // byte at the moment the session's clock began, the terminal shows however far that run has
      // got, and a variant shorter than the stretch already elapsed has finished, so the terminal
      // opens on its final frame and stays there while the session's clock runs on, exactly as
      // the still paints it (loadDemoTiledFrames). Without the shift the variant re-based the
      // clock on its own length, and a session the board showed as working flipped to needs-you
      // the moment a narrow window opened on it. A session the seed did not clock (a spawn, a
      // Command Terminal boot) has no data.ends entry and plays its own recording unshifted.
      function sessionDurationMs(sessionId, recording) {
        var end = data.ends[sessionId];
        if (end && typeof end.durationMs === 'number') return end.durationMs;
        var last = recording.stream[recording.stream.length - 1];
        return last ? last.t : 0;
      }
      function recordingEndMs(recording) {
        var last = recording.stream[recording.stream.length - 1];
        return last ? last.t : 0;
      }
      /**
       * Queue the chunks still ahead of the session's clock, and return the ones already behind
       * it. A recording that has ENDED behind the clock (its last chunk is behind it, which is
       * where a tiled variant shorter than the session's elapsed stretch sits) returns its final
       * frame rather than the whole stream: the frame is the same picture, at a tenth of the bytes.
       */
      function scheduleStreamBytes(sessionId, entry, recording) {
        if (!replayTimers[sessionId]) replayTimers[sessionId] = [];
        var elapsed = Date.now() - entry.startedAt;
        if (recordingEndMs(recording) <= elapsed && typeof recording.serialized === 'string') return recording.serialized;
        var head = '';
        recording.stream.forEach(function (chunk) {
          if (chunk.t <= elapsed) { head += chunk.data; return; }
          replayTimers[sessionId].push(setTimeout(function () { emitBytes(sessionId, chunk.data, entry.projectId); }, Math.max(0, entry.startedAt + chunk.t - Date.now())));
        });
        return head;
      }
      // A terminal on any other grid is fed by the page's OWN emulator: the recording's bytes, on
      // the session's clock, written into a terminal at the RECORDED grid (demo/replay-emulator.ts,
      // a chunk loaded on first use, over the renderer's own xterm and the physical-row serializer
      // the capture script uses), and after each write a repaint of what that terminal shows, as
      // physical rows fitted to the visitor's grid (fitFrameToGrid). It is main's answer for a PTY
      // whose grid the renderer does not share (a parsed-grid frame), at the stream's own pace:
      // a spinner turns and a reply streams as they do on the bytes path, where the recorded frame
      // timeline sampled four a second. Each frame carries the rows above the screen that a taller
      // grid shows, and the cursor shown or hidden as the CLI left it. A repaint replaces the
      // screen rather than appending, so the terminal never grows. It leaves the alternate screen
      // first: an alt frame enters it again itself, and a normal one must not land in the alt
      // buffer the previous repaint left.
      var REPAINT = '\\x1b[?1049l\\x1b[2J\\x1b[3J\\x1b[H';
      // Writes arrive in bursts; one repaint per this many milliseconds at most, the pace of a
      // display refresh or two.
      var REPAINT_INTERVAL_MS = 33;
      var emulatorModule = null;
      function loadEmulatorModule() {
        if (!emulatorModule) {
          emulatorModule = typeof window.__demoLoadReplayEmulator === 'function'
            ? window.__demoLoadReplayEmulator()
            : Promise.reject(new Error('[demo] this build carries no replay emulator (demo/replay-emulator-entry.ts)'));
        }
        return emulatorModule;
      }
      var emulators = {};
      var emulatorGenerations = {};
      // Which sessions a terminal shows, as the renderer publishes it (sessions.setMounted, a
      // whole-set replace). Null until it first does. A session no terminal shows skips the
      // repaint, and once it has gone unshown for EMULATOR_UNMOUNTED_MS its emulator is stopped,
      // since each holds a recording's worth of rows and a visitor may open every card. A
      // terminal mounted again starts it afresh from the session's clock (a head parse, 50 ms for
      // the largest stream); one back within the window keeps it (frameScrollback's reuse).
      var EMULATOR_UNMOUNTED_MS = 10000;
      var mountedSessions = null;
      var originalSetMounted = window.electronAPI.sessions.setMounted;
      window.electronAPI.sessions.setMounted = function (sessionIds) {
        mountedSessions = {};
        (sessionIds || []).forEach(function (id) { mountedSessions[id] = true; });
        Object.keys(emulators).forEach(function (id) {
          if (mountedSessions[id]) return;
          var state = emulators[id];
          setTimeout(function () {
            if (emulators[id] === state && mountedSessions && !mountedSessions[id]) stopEmulator(id);
          }, EMULATOR_UNMOUNTED_MS);
        });
        return originalSetMounted.apply(this, arguments);
      };
      function stopEmulator(sessionId) {
        emulatorGenerations[sessionId] = (emulatorGenerations[sessionId] || 0) + 1;
        var state = emulators[sessionId];
        if (!state) return;
        delete emulators[sessionId];
        if (state.pending) clearTimeout(state.pending);
        state.emulator.dispose();
      }
      // The last frame the seed painted into each session's terminal and the grid it was fitted
      // to, for the demo tier and demo/measure.mjs to read what a terminal SHOWS: a frame fills
      // its terminal's screen, so the pane around it can look full while rows inside it are blank.
      var paintedFrames = {};
      window.__demoPainted = paintedFrames;
      function notePainted(sessionId, grid, frame) {
        paintedFrames[sessionId] = { cols: grid.cols, rows: grid.rows, frame: frame };
        return frame;
      }
      // What a full repaint carries above the screen: the rows a visitor can scroll back through,
      // as the byte replay leaves them.
      var FULL_PAINT_ROWS_ABOVE = 500;
      // The bytes that bring a session's terminal to what its emulator shows now. A FULL paint
      // clears the terminal and writes the screen with the rows above it. Otherwise the paint
      // builds on the last one, the way a stream does: the rows that scrolled above the emulator's
      // screen since then are scrolled into the terminal's own scrollback (a line feed at the
      // bottom row each), and the screen is redrawn in place. A visitor scrolled up through the
      // history stays where they are, which a clear on every paint would take from them; on the
      // desktop, and on the byte replay, they can. A new grid, the alternate screen (which has no
      // history to keep), the CLI clearing its own history, or more rows scrolled than the screen
      // holds between two paints each take a full one.
      function emulatorPaint(state, full) {
        var grid = state.grid;
        var rowsAbove = Math.max(0, grid.rows - state.recording.rows);
        var last = state.painted;
        var snapshot = state.emulator.frame(full ? Math.max(rowsAbove, FULL_PAINT_ROWS_ABOVE) : rowsAbove);
        // How far THIS terminal has scrolled: its content is the emulator's rows above the screen
        // and the screen, and a terminal taller than the recording starts scrolling only once
        // that passes its own height.
        var overflow = function (scrolledRows) { return Math.max(0, scrolledRows + state.recording.rows - grid.rows); };
        var scrolled = last ? overflow(snapshot.scrolledRows) - overflow(last.scrolledRows) : 0;
        var incremental = !full && !!last && !snapshot.alternate && !last.alternate && !snapshot.historyCleared
          && last.cols === grid.cols && last.rows === grid.rows && scrolled >= 0 && scrolled <= grid.rows;
        if (!full && !incremental) snapshot = state.emulator.frame(Math.max(rowsAbove, FULL_PAINT_ROWS_ABOVE));
        state.painted = { cols: grid.cols, rows: grid.rows, alternate: snapshot.alternate, scrolledRows: snapshot.scrolledRows };
        var parts = fitFrameParts(snapshot.frame, grid, state.recording);
        var cursorShown = snapshot.cursorHidden ? '\\x1b[?25l' : '\\x1b[?25h';
        if (!incremental) {
          return REPAINT + (parts.alt ? ALT_PREFIX : '') + '\\x1b[?7l' + parts.rows.join('\\r\\n') + '\\x1b[?7h' + cursorPosition(parts) + cursorShown;
        }
        // The screen's rows: the last grid.rows of the frame, or all of them with blank rows below
        // when the CLI has not filled a screen yet.
        var screen = parts.rows.slice(Math.max(0, parts.rows.length - grid.rows));
        var bytes = '\\x1b[' + grid.rows + ';1H';
        for (var feed = 0; feed < scrolled; feed++) bytes += '\\n';
        bytes += '\\x1b[?7l';
        for (var row = 0; row < grid.rows; row++) bytes += '\\x1b[' + (row + 1) + ';1H\\x1b[0m\\x1b[2K' + (screen[row] || '');
        return bytes + '\\x1b[0m\\x1b[?7h' + cursorPosition(parts) + cursorShown;
      }
      function repaintSoon(sessionId, state) {
        if (state.pending || (mountedSessions && !mountedSessions[sessionId])) return;
        state.pending = setTimeout(function () {
          state.pending = null;
          if (emulators[sessionId] === state) emitBytes(sessionId, notePainted(sessionId, state.grid, emulatorPaint(state, false)), state.projectId);
        }, REPAINT_INTERVAL_MS);
      }
      // Start a session's emulator on a recording, replacing any it had: the chunks behind the
      // clock are written at once, the rest at their times. Resolves with the emulator once the
      // chunks behind the clock are in, or null when a later start or a switch to the bytes path
      // replaced it first.
      function startEmulator(sessionId, entry, recording, grid) {
        stopEmulator(sessionId);
        var generation = emulatorGenerations[sessionId];
        return loadEmulatorModule().then(function (module) {
          if (emulatorGenerations[sessionId] !== generation) return null;
          var state = { emulator: module.createReplayEmulator(recording.cols, recording.rows), recording: recording, file: entry.file, grid: grid, projectId: entry.projectId, pending: null };
          emulators[sessionId] = state;
          if (!replayTimers[sessionId]) replayTimers[sessionId] = [];
          var elapsed = Date.now() - entry.startedAt;
          var head = '';
          recording.stream.forEach(function (chunk) {
            if (chunk.t <= elapsed) { head += chunk.data; return; }
            replayTimers[sessionId].push(setTimeout(function () {
              if (emulators[sessionId] !== state) return;
              state.emulator.write(chunk.data).then(function () { repaintSoon(sessionId, state); });
            }, Math.max(0, entry.startedAt + chunk.t - Date.now())));
          });
          return state.emulator.write(head).then(function () { return emulators[sessionId] === state ? state : null; });
        });
      }
      // Which way each mounted session's terminal is being fed, 'bytes' or 'frames', for the demo
      // tier to assert on: a terminal handed bytes must be on the recording's grid.
      var replayModes = {};
      window.__demoReplayMode = replayModes;
      function liveScrollback(sessionId, entry) {
        return fetchRecording(entry.file).then(function (recording) {
          var duration = sessionDurationMs(sessionId, recording);
          if (entry.startedAt === null) {
            // A pre-seeded working session has been running for a while: everything but its
            // last stretch is already scrollback, and that stretch streams from here.
            entry.startedAt = Date.now() - Math.max(0, duration - entry.tail);
          }
          entry.mounted = true;
          entry.frameOnly = false;
          replayModes[sessionId] = 'bytes';
          clearReplayTimers(sessionId);
          stopEmulator(sessionId);
          delete paintedFrames[sessionId];
          var head = scheduleStreamBytes(sessionId, entry, recording);
          scheduleSessionClock(sessionId, entry, { durationMs: duration, endPeek: recording.peek, endedOnItsOwn: endedOnItsOwn(recording) });
          return head;
        });
      }
      // liveScrollback's twin for a terminal whose grid the bytes do not fit: the same clock
      // (a working session keeps working, a spawn plays its boot from the moment it started, an
      // idle session lands on its end), played through the emulator and painted fitted to the
      // grid. Resolves with the frame for now; the emulator repaints the rest as it goes. A
      // recording already past its end paints its final frame, which is the same picture the
      // bytes would leave, with every row above it. The same recording on a new grid (a resize,
      // a terminal mounted again) keeps its emulator and repaints it for that grid.
      function frameScrollback(sessionId, entry, recording, grid) {
        var duration = sessionDurationMs(sessionId, recording);
        if (entry.startedAt === null) entry.startedAt = Date.now() - Math.max(0, duration - entry.tail);
        entry.mounted = true;
        entry.frameOnly = true;
        replayModes[sessionId] = 'frames';
        var running = emulators[sessionId];
        if (running && running.file === entry.file) {
          running.grid = grid;
          return Promise.resolve(notePainted(sessionId, grid, emulatorPaint(running, true)));
        }
        clearReplayTimers(sessionId);
        scheduleSessionClock(sessionId, entry, { durationMs: duration, endPeek: recording.peek, endedOnItsOwn: endedOnItsOwn(recording) });
        if (recordingEndMs(recording) <= Date.now() - entry.startedAt) {
          stopEmulator(sessionId);
          return Promise.resolve(notePainted(sessionId, grid, REPAINT + fitFrameToGrid(recording.serialized, grid, recording)));
        }
        return startEmulator(sessionId, entry, recording, grid).then(function (state) {
          return state ? notePainted(sessionId, grid, emulatorPaint(state, true)) : '';
        }, function (error) {
          // A build without the emulator chunk, or one that failed to load: the terminal still
          // shows the session, as the recorded frame for the moment it opens at, and the page says
          // why (the demo tier fails on the console error).
          console.error('[demo] the replay emulator did not load, so ' + sessionId + ' shows its recorded frame', error);
          var open = openFrames[sessionId];
          return notePainted(sessionId, grid, REPAINT + fitFrameToGrid(open ? open.serialized : recording.serialized, grid, recording));
        });
      }
      // A working session's clock runs from page open whether or not its terminal is mounted,
      // as an agent's does on the desktop: the recording's end lands at the same moment on the
      // card, in the sidebar count, in the Monitor, and in a window opened later. Where no
      // stream plays (a still frame, the captures' seed) the terminal paints the moment the live
      // frame would open at, when the recording kept that frame; otherwise it paints the end,
      // where a recording that ran to the agent's own end reads as finished.
      var ends = data.ends || {};
      data.sessions.forEach(function (session) {
        var end = ends[session.id];
        if (!end || session.activity !== 'thinking') return;
        var entry = replays[session.id];
        if (!live || !entry) {
          if (openFrames[session.id]) scrollback[session.id] = openFrames[session.id].serialized;
          else if (endedOnItsOwn(end)) finishSession(session.id);
          return;
        }
        entry.startedAt = Date.now() - Math.max(0, end.durationMs - entry.tail);
        // A recording shorter than the tail plays from its first byte, so the Monitor row shows
        // no lines yet; the clock's changes and its end timer fill them in.
        if (!openFrames[session.id]) setMonitorPeek(session.id, []);
        clearReplayTimers(session.id);
        scheduleSessionClock(session.id, entry, { durationMs: end.durationMs, endPeek: peeks[session.id], endedOnItsOwn: endedOnItsOwn(end) });
      });
      window.__demoScrollback = scrollback;
      // The grid a terminal mounts with is the visitor's, not the recording's: the bottom panel
      // is 15 rows tall, and a display scaled to 125 percent fits 144 by 36 in the task window
      // where the recordings hold 154 by 37. A recording's bytes address rows for its own grid
      // (Windows ConPTY re-emits Claude's classic renderer with absolute cursor positions), so
      // replayed into any other grid they land two frames' text on one row. Main routes such a
      // session to its parsed-grid frame instead of the byte replay; so does this. The frame
      // reflows in a different grid, and the session stays on it there: a live stream cannot be
      // re-laid out without the CLI.
      var mountedGeometry = {};
      // A frame is PHYSICAL rows (scripts/lib/demo-frame-serializer.js): one row per recorded
      // row, each self-contained, joined with \\r\\n, behind the alt-screen switch when the
      // recording was on the alternate screen, and ending in one absolute cursor position for
      // the recorded grid. Fitting it to the mounted grid is then row by row:
      //
      // - A row wider than the grid is CUT at the grid's edge, never left to wrap. A CLI would
      //   have re-laid its prose out at this width; a wrap mid-word is what nothing would draw.
      //   A right-aligned tail the CLI placed with a cursor-forward sized to its own width
      //   (Claude's "/rc" at the footer's edge, Copilot's timing beside its border) is pulled in
      //   first by shrinking that gap, so it ends at this edge as the CLI would align it.
      // - A grid WIDER than the recording gets what the CLI draws to its own edge drawn to this
      //   one (widenRow): a right-hand border or scrollbar moves to the new last column and the
      //   box before it widens, a background band (an erase) runs on, a horizontal rule runs on,
      //   a panel's styled padding runs on, and right-aligned text after a wide gap moves out
      //   with the gap. Each only for a row that reached the recorded edge; a row that stopped
      //   short of it is prose or a short rule, and stays as drawn. Never a vertical bar
      //   extended sideways (a stripe, which is what Copilot's border once became), and never a
      //   one-cell gap grown (a box border and a sentence would part).
      // - A TALLER grid on the alternate screen gets rows inserted where the TUI would grow:
      //   below the last of the rows that run down a right-hand scrollbar (Copilot), or below
      //   the last blank row in the lower half (OpenCode, above its input), so the input and the
      //   footer stay at the bottom. A normal-screen frame needs nothing: it carries the rows
      //   above its screen, and a taller grid shows more of them.
      // - Widths are counted in CELLS from the app's own table (cellWidths), so a wide glyph
      //   cuts where the terminal will put it. Autowrap is off while the rows are written, so a
      //   cell the two still disagree on overwrites the last column instead of wrapping.
      // - The cursor is recomputed for the mounted row count: a 37-row frame in a 15-row panel
      //   scrolls 22 rows up, and the cursor's row moves with them.
      var FRAME_SEQUENCE = /^\\x1b\\[[0-9;?]*[A-Za-z]/;
      var CURSOR_FORWARD = /^\\x1b\\[(\\d*)C$/;
      var ERASE_CHARS = /^\\x1b\\[(\\d*)X$/;
      var ALT_PREFIX = '\\x1b[?1049h\\x1b[H';
      var CURSOR_SUFFIX = /\\x1b\\[(\\d+);(\\d+)H$/;
      var HORIZONTAL_RULE_GLYPHS = '\\u2500\\u2501\\u2504\\u2505\\u2508\\u2509\\u254C\\u254D\\u2550\\u2574\\u2576\\u2578\\u257A\\u257C\\u257E\\u2580\\u2581\\u2582\\u2583\\u2584\\u2585\\u2586\\u2587\\u2588\\u2594';
      // What a CLI draws down its right edge: vertical box sides, the right-hand corners and tees
      // of a box, and a scrollbar track (Copilot's is U+2503).
      var VERTICAL_EDGE_GLYPHS = '\\u2502\\u2503\\u2506\\u2507\\u250A\\u250B\\u254E\\u254F\\u2551\\u2590\\u2595\\u2510\\u2513\\u2518\\u251B\\u2524\\u252B\\u2557\\u255D\\u2562\\u2563\\u256E\\u256F';
      function inRanges(ranges, codepoint) {
        var low = 0;
        var high = ranges.length / 2 - 1;
        while (low <= high) {
          var middle = (low + high) >> 1;
          if (codepoint < ranges[middle * 2]) high = middle - 1;
          else if (codepoint > ranges[middle * 2 + 1]) low = middle + 1;
          else return true;
        }
        return false;
      }
      function cellWidth(codepoint) {
        if (inRanges(cellWidths.zero, codepoint)) return 0;
        if (inRanges(cellWidths.wide, codepoint)) return 2;
        return 1;
      }
      function textWidth(text) {
        var width = 0;
        for (var index = 0; index < text.length; index++) {
          var codepoint = text.codePointAt(index);
          if (codepoint > 0xffff) index++;
          width += cellWidth(codepoint);
        }
        return width;
      }
      // The longest prefix of the text that is at most the given number of cells wide; a wide
      // glyph that would straddle the edge is left out.
      function clipText(text, cells) {
        var width = 0;
        var index = 0;
        while (index < text.length) {
          var codepoint = text.codePointAt(index);
          var advance = codepoint > 0xffff ? 2 : 1;
          var glyphWidth = cellWidth(codepoint);
          if (width + glyphWidth > cells) break;
          width += glyphWidth;
          index += advance;
        }
        return { text: text.slice(0, index), width: width };
      }
      function tokenizeRow(row) {
        var tokens = [];
        var index = 0;
        while (index < row.length) {
          if (row.charAt(index) === '\\x1b') {
            var match = FRAME_SEQUENCE.exec(row.slice(index));
            var sequence = match ? match[0] : row.charAt(index);
            var forward = CURSOR_FORWARD.exec(sequence);
            var erase = ERASE_CHARS.exec(sequence);
            if (forward) tokens.push({ forward: Math.max(1, parseInt(forward[1] || '1', 10)) });
            else if (erase) tokens.push({ erase: Math.max(1, parseInt(erase[1] || '1', 10)) });
            else tokens.push({ sequence: sequence });
            index += sequence.length;
          } else {
            var end = row.indexOf('\\x1b', index);
            if (end === -1) end = row.length;
            tokens.push({ text: row.slice(index, end) });
            index = end;
          }
        }
        return tokens;
      }
      function renderTokens(tokens) {
        return tokens.map(function (token) {
          if (token.text !== undefined) return token.text;
          if (token.forward !== undefined) return token.forward > 0 ? '\\x1b[' + token.forward + 'C' : '';
          if (token.erase !== undefined) return token.erase > 0 ? '\\x1b[' + token.erase + 'X' : '';
          return token.sequence;
        }).join('');
      }
      function rowWidth(tokens) {
        return tokens.reduce(function (sum, token) {
          if (token.text !== undefined) return sum + textWidth(token.text);
          if (token.forward !== undefined) return sum + token.forward;
          return sum;
        }, 0);
      }
      // An erase reaches from the cursor to its count, so one past the edge is clamped to the
      // cells left, wherever the row's width otherwise lands.
      function clampErases(tokens, cols) {
        var position = 0;
        var changed = false;
        tokens.forEach(function (token) {
          if (token.text !== undefined) position += textWidth(token.text);
          else if (token.forward !== undefined) position += token.forward;
          else if (token.erase !== undefined && token.erase > cols - position) {
            token.erase = Math.max(0, cols - position);
            changed = true;
          }
        });
        return changed;
      }
      // A row whose last painted glyph is a vertical edge glyph, split around it: the tokens before
      // it (the glyph taken off its text), the SGR that styles it, and the sequences after it.
      // Null when anything but a sequence follows the glyph, since it is then not the row's end.
      function trailingEdgeGlyph(tokens) {
        for (var last = tokens.length - 1; last >= 0; last--) {
          var token = tokens[last];
          if (token.sequence !== undefined) continue;
          if (token.text === undefined || token.text.length === 0) return null;
          var glyph = token.text.charAt(token.text.length - 1);
          if (VERTICAL_EDGE_GLYPHS.indexOf(glyph) === -1) return null;
          var before = tokens.slice(0, last);
          if (token.text.length > 1) before.push({ text: token.text.slice(0, -1) });
          var style = before.filter(function (candidate) {
            return candidate.sequence !== undefined && /m$/.test(candidate.sequence);
          }).map(function (candidate) { return candidate.sequence; }).join('');
          return { before: before, style: style, glyph: glyph, after: tokens.slice(last + 1) };
        }
        return null;
      }
      // How far short of the recorded edge a row may stop and still be one the CLI drew TO its
      // edge: Claude pads a diff line's background band to seven columns short of its width.
      var EDGE_SLACK = 8;
      // A gap at least this wide right before a row's last text is the CLI right-aligning that
      // text. Prose is one space, or Claude's one-cell cursor-forward, between words.
      var TAIL_GAP_MIN = 4;
      // How far short of the recorded edge the CLIs end right-aligned text: Claude keeps two cells
      // of padding and Copilot one. A row that runs to the edge itself is content the CLI cut or
      // wrapped there (Codex's search hits), never a label it placed.
      var TAIL_PADDING_MAX = 2;
      // The index of the last token that paints or moves (text, a gap, an erase) at or before
      // the given one, skipping style sequences; -1 when there is none.
      function paintingBefore(tokens, index) {
        for (var candidate = index; candidate >= 0; candidate--) {
          if (tokens[candidate].sequence === undefined) return candidate;
        }
        return -1;
      }
      // The cell a row's paint reaches: its width, or further when an erase paints ahead of the
      // cursor (a background band, which moves nothing).
      function paintedEnd(tokens) {
        var position = 0;
        var end = 0;
        tokens.forEach(function (token) {
          if (token.text !== undefined) { position += textWidth(token.text); end = Math.max(end, position); }
          else if (token.forward !== undefined) position += token.forward;
          else if (token.erase !== undefined) end = Math.max(end, position + token.erase);
        });
        return end;
      }
      // Whether a style other than the default is in force at a token: a panel's background runs
      // on only where it is painted.
      function styledAt(tokens, index) {
        for (var candidate = index - 1; candidate >= 0; candidate--) {
          var sequence = tokens[candidate].sequence;
          if (sequence === undefined || !/m$/.test(sequence)) continue;
          return sequence !== '\\x1b[0m' && sequence !== '\\x1b[m';
        }
        return false;
      }
      // A row as one item per character, gap, erase or style sequence, so a walk can cross token
      // boundaries; each item knows its token and, for a character, its offset in that text.
      function rowItems(tokens) {
        var items = [];
        tokens.forEach(function (token, index) {
          if (token.text === undefined) { items.push({ token: index, kind: token.sequence !== undefined ? 'sequence' : token.forward !== undefined ? 'forward' : 'erase' }); return; }
          for (var offset = 0; offset < token.text.length; offset++) items.push({ token: index, kind: 'character', offset: offset, character: token.text.charAt(offset) });
        });
        return items;
      }
      function paintingItemBefore(items, position) {
        for (var index = position - 1; index >= 0; index--) if (items[index].kind !== 'sequence') return index;
        return -1;
      }
      // A row that ends at the recorded edge in a right-hand border or scrollbar, widened: the
      // trailing CLUSTER (edge glyphs, and single spaces between them: a scrollbar, or a box's side
      // then a scrollbar) moves to the new edge, and the gap before it takes the extra cells. A
      // gap that is a background band grows its band, a cursor-forward grows, a rule glyph right
      // before the gap runs on (a box's top edge to its corner), and otherwise blank cells go in
      // at the gap's start, in the style in force there. The walk stops at a gap, so a box's
      // LEFT border is never part of the cluster.
      function widenAtEdge(tokens, extra, recordedCols) {
        var items = rowItems(tokens);
        var clusterStart = items.length;
        for (var index = items.length - 1; index >= 0; index--) {
          var item = items[index];
          if (item.kind === 'sequence') continue;
          if (item.kind !== 'character') break;
          if (VERTICAL_EDGE_GLYPHS.indexOf(item.character) !== -1) { clusterStart = index; continue; }
          var left = paintingItemBefore(items, index);
          if (item.character === ' ' && clusterStart < items.length && left !== -1 && items[left].kind === 'character' && VERTICAL_EDGE_GLYPHS.indexOf(items[left].character) !== -1) { clusterStart = index; continue; }
          break;
        }
        var gapStart = clusterStart;
        var gapWidth = 0;
        var bandErase = -1;
        var lastForward = -1;
        for (var gapIndex = clusterStart - 1; gapIndex >= 0; gapIndex--) {
          var gapItem = items[gapIndex];
          if (gapItem.kind === 'sequence') continue;
          if (gapItem.kind === 'character' && gapItem.character !== ' ') break;
          if (gapItem.kind === 'character') gapWidth += 1;
          if (gapItem.kind === 'forward') {
            gapWidth += tokens[gapItem.token].forward;
            if (lastForward === -1) lastForward = gapItem.token;
          }
          if (gapItem.kind === 'erase' && bandErase === -1) {
            var next = tokens[gapItem.token + 1];
            if (next && next.forward !== undefined) bandErase = gapItem.token;
          }
          gapStart = gapIndex;
        }
        var beforeGap = paintingItemBefore(items, gapStart);
        var ruleGlyph = beforeGap !== -1 && items[beforeGap].kind === 'character' && HORIZONTAL_RULE_GLYPHS.indexOf(items[beforeGap].character) !== -1
          ? items[beforeGap].character : '';
        // Text the CLI right-aligned against the border or scrollbar (Copilot's "10s ┃", a cell
        // from it): the tail's own gap takes the extra cells and the text stays against the edge.
        // Two cells or more before a border is a box's padding around content that stops there
        // (Gemini's truncated "old => new" edit line), which widens at the border as any box does.
        if (!ruleGlyph && bandErase === -1 && gapWidth <= 1) {
          var tail = tailGap(tokens, gapStart, recordedCols);
          if (tail) {
            widenTailGap(tokens, tail, extra);
            return renderTokens(tokens);
          }
        }
        if (!ruleGlyph && bandErase !== -1) {
          tokens[bandErase].erase += extra;
          tokens[bandErase + 1].forward += extra;
          return renderTokens(tokens);
        }
        if (!ruleGlyph && lastForward !== -1) {
          tokens[lastForward].forward += extra;
          return renderTokens(tokens);
        }
        var fill = [];
        if (ruleGlyph) {
          var run = '';
          while (run.length < extra) run += ruleGlyph;
          fill.push({ text: run });
        } else {
          fill.push({ erase: extra }, { forward: extra });
        }
        // Split the row at the gap's start and put the fill there.
        var at = items[gapStart];
        var before = tokens.slice(0, at ? at.token : tokens.length);
        var after = at ? tokens.slice(at.token + 1) : [];
        if (at && at.kind === 'character') {
          var text = tokens[at.token].text;
          if (at.offset > 0) before.push({ text: text.slice(0, at.offset) });
          after.unshift({ text: text.slice(at.offset) });
        } else if (at) {
          after.unshift(tokens[at.token]);
        }
        return renderTokens(before.concat(fill, after));
      }
      // Right-aligned text: walking left from the end of the row (or from before the item at end),
      // the tail's words and the one-cell steps between them, up to the first gap TAIL_GAP_MIN or
      // wider. Claude's footer tail is several styled words ("◐ medium · /effort"), so the gap is
      // not always right before the last one. The tail is a label, so it is at most half the
      // row: a Codex search hit's code, after the gap its indentation leaves, runs most of it.
      // A gap with nothing on its left is indentation unless the tail is one word ("/rc"). A tail
      // ending in an ellipsis is text the CLI cut to fit (Gemini's "old => new" edit line), so it
      // filled the space rather than being placed in it. Returns the gap to widen (a
      // cursor-forward in it, or a space in it), or null, and null at a vertical border, so a
      // table's cells never trade width with each other.
      function tailGap(tokens, end, recordedCols) {
        var items = rowItems(tokens);
        var run = 0;
        var seenTail = false;
        var tailWidth = 0;
        var tailWords = 1;
        var forwardToken = -1;
        var spaceItem = null;
        var found = function () {
          if (run < TAIL_GAP_MIN || tailWidth > recordedCols / 2) return null;
          return forwardToken !== -1 ? { forward: forwardToken } : { space: spaceItem };
        };
        for (var index = (end === undefined ? items.length : end) - 1; index >= 0; index--) {
          var item = items[index];
          if (item.kind === 'sequence') continue;
          if (item.kind === 'erase') return null;
          if (item.kind === 'forward' || item.character === ' ') {
            if (!seenTail) continue;
            if (item.kind === 'forward') {
              run += tokens[item.token].forward;
              if (forwardToken === -1) forwardToken = item.token;
            } else {
              run += 1;
              if (!spaceItem) spaceItem = item;
            }
            continue;
          }
          if (VERTICAL_EDGE_GLYPHS.indexOf(item.character) !== -1) return null;
          if (!seenTail && item.character === '\\u2026') return null;
          if (seenTail && run >= TAIL_GAP_MIN) return found();
          if (run > 0) tailWords += 1;
          tailWidth += run + 1;
          seenTail = true;
          run = 0;
          forwardToken = -1;
          spaceItem = null;
        }
        return tailWords === 1 ? found() : null;
      }
      // Widen a gap tailGap found by extra cells, in place.
      function widenTailGap(tokens, gap, extra) {
        if (gap.forward !== undefined) {
          tokens[gap.forward].forward += extra;
          return;
        }
        var spaces = '';
        while (spaces.length < extra) spaces += ' ';
        var text = tokens[gap.space.token].text;
        tokens[gap.space.token].text = text.slice(0, gap.space.offset) + spaces + text.slice(gap.space.offset);
      }
      // A row on a grid wider than the recording by extra columns, with what the CLI draws to its
      // edge drawn to the new one, or null when the row stays as it was drawn.
      function widenRow(tokens, extra, recordedCols) {
        var lastIndex = paintingBefore(tokens, tokens.length - 1);
        if (lastIndex === -1) return null;
        var last = tokens[lastIndex];
        var width = rowWidth(tokens);
        // The glyph a text token ends in; '' for anything else, which no glyph list contains
        // (indexOf('') would answer 0).
        var lastGlyph = last.text !== undefined && last.text.length > 0 ? last.text.charAt(last.text.length - 1) : '';
        // A right-hand border or scrollbar at the recorded edge, or inside the CLI's right padding
        // (Copilot draws its welcome box two cells short).
        if (lastGlyph && width >= recordedCols - TAIL_PADDING_MAX && VERTICAL_EDGE_GLYPHS.indexOf(lastGlyph) !== -1) {
          return widenAtEdge(tokens, extra, recordedCols);
        }
        // A background band reaching the edge: an erase, or an erase and the gap that steps over it.
        var bandIndex = lastIndex;
        if (last.forward !== undefined) {
          var beforeGap = paintingBefore(tokens, lastIndex - 1);
          if (beforeGap !== -1 && tokens[beforeGap].erase !== undefined) bandIndex = beforeGap;
        }
        if (tokens[bandIndex].erase !== undefined && paintedEnd(tokens) >= recordedCols - EDGE_SLACK) {
          tokens[bandIndex].erase += extra;
          if (bandIndex !== lastIndex) last.forward += extra;
          return renderTokens(tokens);
        }
        if (!lastGlyph) return null;
        if (width >= recordedCols - EDGE_SLACK && HORIZONTAL_RULE_GLYPHS.indexOf(lastGlyph) !== -1) {
          var rule = '';
          while (rule.length < extra) rule += lastGlyph;
          last.text += rule;
          return renderTokens(tokens);
        }
        if (width >= recordedCols - EDGE_SLACK && lastGlyph === ' ' && styledAt(tokens, lastIndex)) {
          var padding = '';
          while (padding.length < extra) padding += ' ';
          last.text += padding;
          return renderTokens(tokens);
        }
        if (width >= recordedCols - TAIL_PADDING_MAX && width < recordedCols) {
          var gap = tailGap(tokens, undefined, recordedCols);
          if (gap) {
            widenTailGap(tokens, gap, extra);
            return renderTokens(tokens);
          }
        }
        return null;
      }
      function fitRow(row, cols, recordedCols) {
        var tokens = tokenizeRow(row);
        var erasesClamped = clampErases(tokens, cols);
        var width = rowWidth(tokens);
        if (recordedCols && cols > recordedCols && width <= recordedCols) {
          var widened = widenRow(tokens, cols - recordedCols, recordedCols);
          if (widened !== null) return widened;
          return erasesClamped ? renderTokens(tokens) : row;
        }
        // NARROWER, and the row ends at a vertical edge (a box's right side or corner, Copilot's
        // scrollbar): the CLI drew that glyph at its own last column, so it stays at this one. A cut
        // would drop it from rows that run to the edge and keep it on rows a gap pulls in, which
        // breaks the line down the right side into segments. The rest of the row is fitted one
        // column narrower, then the glyph goes back in the style it was drawn in.
        if (width > cols && cols > 1) {
          var edge = trailingEdgeGlyph(tokens);
          if (edge) return fitRow(renderTokens(edge.before), cols - 1, recordedCols ? recordedCols - 1 : undefined) + edge.style + edge.glyph + renderTokens(edge.after);
        }
        if (width === cols) return erasesClamped ? renderTokens(tokens) : row;
        // A row that stops short of a grid no wider than its recording is drawn as it was.
        if (width < cols && recordedCols) return erasesClamped ? renderTokens(tokens) : row;
        if (width < cols) {
          // A frame with no recorded width to measure against (a caller from before widenRow):
          // only a row whose LAST painted thing is a horizontal rule glyph is stretched.
          for (var last = tokens.length - 1; last >= 0; last--) {
            var end = tokens[last];
            if (end.sequence !== undefined) continue;
            if (end.text === undefined || end.text.length === 0) break;
            var glyph = end.text.charAt(end.text.length - 1);
            if (HORIZONTAL_RULE_GLYPHS.indexOf(glyph) === -1) break;
            var run = '';
            while (run.length < cols - width) run += glyph;
            end.text += run;
            return renderTokens(tokens);
          }
          return erasesClamped ? renderTokens(tokens) : row;
        }
        // NARROWER. Pull a right-aligned tail in by shrinking the gaps before it, last gap first,
        // each down to one cell; then cut whatever still overruns at the edge.
        var excess = width - cols;
        for (var gap = tokens.length - 1; gap >= 0 && excess > 0; gap--) {
          if (tokens[gap].forward === undefined) continue;
          var shrink = Math.min(excess, tokens[gap].forward - 1);
          tokens[gap].forward -= shrink;
          excess -= shrink;
        }
        if (excess === 0) return renderTokens(tokens);
        var kept = [];
        var used = 0;
        var cut = false;
        for (var index = 0; index < tokens.length; index++) {
          var token = tokens[index];
          if (token.sequence !== undefined) { kept.push(token); continue; }
          var room = cols - used;
          if (token.erase !== undefined) {
            if (room > 0) kept.push({ erase: Math.min(token.erase, room) });
            continue;
          }
          if (room <= 0) { cut = true; break; }
          if (token.forward !== undefined) {
            var forward = Math.min(token.forward, room);
            kept.push({ forward: forward });
            used += forward;
            if (forward < token.forward) { cut = true; break; }
            continue;
          }
          var textCells = textWidth(token.text);
          if (textCells <= room) { kept.push(token); used += textCells; continue; }
          var clipped = clipText(token.text, room);
          kept.push({ text: clipped.text });
          used += clipped.width;
          cut = true;
          break;
        }
        // The dropped tail may have carried the row's reset; every clipped row gets one.
        if (cut) kept.push({ sequence: '\\x1b[0m' });
        return renderTokens(kept);
      }
      // Where an alternate-screen frame grows on a taller grid, and the row it grows by: below the
      // last of three or more rows that end in the same right-hand edge glyph at the recorded edge
      // (a scrollbar running down the content, Copilot), each new row that glyph alone in its
      // style; else below the last blank row in the lower half (the space above an input box,
      // OpenCode), a copy of that row. Null when neither is there, and the rows stay where they
      // start, top-aligned as they always were.
      function altRowsInsertion(rows, recordedCols) {
        var edges = rows.map(function (row) {
          var tokens = tokenizeRow(row);
          return rowWidth(tokens) >= recordedCols - 1 ? trailingEdgeGlyph(tokens) : null;
        });
        for (var index = edges.length - 1; index >= 0; index--) {
          var edge = edges[index];
          if (!edge) continue;
          var run = index >= 2 && edges[index - 1] && edges[index - 2]
            && edges[index - 1].glyph === edge.glyph && edges[index - 2].glyph === edge.glyph;
          if (run) return { at: index + 1, row: '\\x1b[' + (recordedCols - 1) + 'C' + edge.style + edge.glyph + '\\x1b[0m' };
          break;
        }
        for (var blank = rows.length - 2; blank >= Math.floor(rows.length / 2); blank--) {
          var text = tokenizeRow(rows[blank]).map(function (token) { return token.text || ''; }).join('');
          if (/^ *$/.test(text)) return { at: blank + 1, row: rows[blank] };
        }
        return null;
      }
      // A frame fitted to a grid, as parts: whether it is on the alternate screen, its rows, and
      // the cursor on the screen the grid shows (null when there is none or it scrolled off).
      function fitFrameParts(frame, grid, recorded) {
        // The grid the frame was recorded at, or only its row count from a caller that predates
        // widenRow (a frame fitted without it is never widened).
        var recordedRows = typeof recorded === 'number' ? recorded : (recorded ? recorded.rows : undefined);
        var recordedCols = recorded && typeof recorded === 'object' ? recorded.cols : undefined;
        var alt = frame.indexOf(ALT_PREFIX) === 0;
        var body = alt ? frame.slice(ALT_PREFIX.length) : frame;
        var cursor = CURSOR_SUFFIX.exec(body);
        var sourceRows = (cursor ? body.slice(0, cursor.index) : body).split('\\r\\n');
        // The suffix is screen-relative for the RECORDED row count; back to the frame's own row,
        // then to the screen row the mounted terminal shows it on. A cursor scrolled off the top
        // is left where the rows put it.
        var frameRow = cursor ? parseInt(cursor[1], 10) - 1 + Math.max(0, sourceRows.length - (recordedRows || sourceRows.length)) : -1;
        if (alt && recordedCols && grid.rows > sourceRows.length) {
          var insertion = altRowsInsertion(sourceRows, recordedCols);
          if (insertion) {
            var added = [];
            while (added.length < grid.rows - sourceRows.length) added.push(insertion.row);
            sourceRows = sourceRows.slice(0, insertion.at).concat(added, sourceRows.slice(insertion.at));
            if (frameRow >= insertion.at) frameRow += added.length;
          }
        }
        var rows = sourceRows.map(function (row) { return fitRow(row, grid.cols, recordedCols); });
        var screenRow = cursor ? frameRow - Math.max(0, rows.length - grid.rows) : -1;
        return {
          alt: alt,
          rows: rows,
          cursor: screenRow >= 0 ? { row: screenRow, col: Math.max(1, Math.min(grid.cols, parseInt(cursor[2], 10))) } : null,
        };
      }
      function cursorPosition(parts) {
        return parts.cursor ? '\\x1b[' + (parts.cursor.row + 1) + ';' + parts.cursor.col + 'H' : '';
      }
      function fitFrameToGrid(frame, grid, recorded) {
        if (!grid || !grid.cols || !grid.rows) return frame;
        var parts = fitFrameParts(frame, grid, recorded);
        return (parts.alt ? ALT_PREFIX : '') + '\\x1b[?7l' + parts.rows.join('\\r\\n') + '\\x1b[?7h' + cursorPosition(parts);
      }
      function geometryFits(sessionId, recording) {
        var geometry = mountedGeometry[sessionId];
        if (!geometry || !recording.cols || !recording.rows) return true;
        return geometry.cols === recording.cols && geometry.rows === recording.rows;
      }
      // A terminal FILLS its pane, whatever the pane's grid. The recording's bytes replay only
      // into its own grid, so a pane of exactly that grid gets them; every other pane plays the
      // recording through the page's own emulator (frameScrollback) at the pane's grid, which the
      // frame fitter widens, heightens, or cuts to (fitFrameToGrid). The terminal is never
      // letterboxed: a recording held at its own grid inside a bigger pane left the rest empty, and
      // that band was on nearly every surface at some display scale (56px beside and 23px below
      // every card window at 125 percent, 314px below the Browser scene's terminal at 100).
      //
      // The type stays the configured size unless the pane is narrower than the recording by more
      // than a column or two (NEAR_MISS_COLUMNS). Then the pane is HELD at a smaller type:
      // main's answer to the renderer's resize names a grid (SessionResizeResult.held), and the
      // terminal conforms to it (useTerminal's conformToHeldGrid, scaling its font down). The
      // held grid is the one the whole pane takes at the type that fits the recording's columns,
      // not the recording's own, so it fills the pane too. Below HOLD_MIN_SCALE the type would be
      // unreadable, and the pane keeps the configured type with the recording cut at its edge.
      var HOLD_MIN_SCALE = 0.6;
      // A pane short of its recording by this many columns or fewer keeps the configured type and
      // cuts them: smaller type is not worth a column or two, and the fitter keeps a right-hand
      // border on the new last column and pulls a right-aligned tail in (fitRow). More than that
      // and the cut takes the ends of the agent's sentences, so the type shrinks instead.
      var NEAR_MISS_COLUMNS = 2;
      // How a pane of cols by rows shows a recording laid out for layout.cols columns: the type
      // scale it shows it at (the held cell over the configured one, in device pixels), and the
      // grid it holds at, null at the configured type.
      //
      // The held grid is predicted from the rule the conform follows: it lands on the LARGEST
      // quarter-pixel font at which the held grid fits (useTerminal's conformToHeldGrid), and a
      // font's cell is what xterm's renderer rounds it to (terminalDeviceCell). So for each cell
      // width a smaller font can draw, largest first, the font that lands is the largest one
      // drawing that width, and the grid is what the pane holds at that font's cell; the first
      // width at which the grid carries the recording's columns, or all but a column or two of
      // them (a near miss at that size, as at the configured one), is the one. The pane is taken at
      // the least its natural grid allows (whole native cells), so the grid always fits; what is
      // left over is under a cell each way, as on the desktop.
      function displayFor(layout, cols, rows) {
        if (cols >= layout.cols - NEAR_MISS_COLUMNS) return { scale: 1, held: null, cut: Math.max(0, layout.cols - cols) };
        var terminalConfig = mockState && mockState.config ? mockState.config.terminal : null;
        var configured = configuredFontSize(terminalConfig);
        var native = terminalDeviceCell(terminalConfig);
        if (!native || cols / layout.cols < HOLD_MIN_SCALE) return { scale: 1, held: null, cut: layout.cols - cols };
        var paneWidth = cols * native.width;
        var paneHeight = rows * native.height;
        var font = configured;
        for (var width = native.width - 1; width >= native.width * HOLD_MIN_SCALE; width--) {
          // The largest font at or below the configured one whose cell is this wide.
          var cell = terminalDeviceCell(terminalConfig, font);
          while (cell && cell.width > width && font > 4) {
            font -= 0.25;
            cell = terminalDeviceCell(terminalConfig, font);
          }
          if (!cell || cell.width !== width) continue;
          var heldCols = Math.floor(paneWidth / width);
          // A column or two short at this size is a near miss here too: the larger type wins.
          if (heldCols < layout.cols - NEAR_MISS_COLUMNS) continue;
          return {
            scale: width / native.width,
            held: { cols: heldCols, rows: Math.max(1, Math.floor(paneHeight / cell.height)) },
            cut: Math.max(0, layout.cols - heldCols),
          };
        }
        return { scale: 1, held: null, cut: layout.cols - cols };
      }
      // A recording made for each layout its window can open in (a Command Terminal boot, or a
      // session the manifest gives a tiled sibling): the one this pane shows best. Every choice now
      // fills the pane, so the question is how much of the pane the AGENT's own layout spans, at
      // the type it is shown in: a wider pane is filled by the fitter running the recording's
      // edges out (rules, bands, borders) while its text stays laid out for fewer columns, and a
      // narrower one by smaller type. So the score is the type scale times the share of the pane's
      // columns the recording was laid out for, squared: the fitter's fill is the part that is not
      // the agent's, and it is weighed as the weaker of the two. A tiled pair or a pane beside the
      // Browser or Changes panel (about 105 to 125 columns) takes the tiled recording at the
      // configured type; a card window at 125 percent (143 columns) or on a Mac (132) takes the
      // single one in smaller type, laid out edge to edge as recorded. The crossover sits near 127
      // columns for recordings of 154 and 115.
      function layoutScore(layout, cols, rows) {
        var display = displayFor(layout, cols, rows);
        var paneCols = display.held ? display.held.cols : cols;
        // The recording's own columns over the pane's when it is widened; the pane's over the
        // recording's when it is cut.
        var share = Math.min(paneCols, layout.cols) / Math.max(paneCols, layout.cols);
        return display.scale * share * share;
      }
      function layoutFor(entry, cols, rows) {
        if (!entry.layouts || !entry.layouts.single || !entry.layouts.tiled) return null;
        var single = entry.layouts.single;
        var tiled = entry.layouts.tiled;
        return layoutScore(tiled, cols, rows) > layoutScore(single, cols, rows) ? tiled : single;
      }
      function applyLayout(entry, cols, rows) {
        var layout = layoutFor(entry, cols, rows);
        if (!layout) return;
        entry.file = layout.file;
        entry.grid = gridOf(layout);
      }
      // What a still paints for a session: the single recording's frame (scrollback, which the
      // seed set to a working session's opening frame above), or the tiled recording's when the
      // window's pane took the tiled layout (layoutFor) and the manifest recorded one. The tiled recording is
      // a second run of the same prompt, so its own opening frame is the moment its bytes
      // would open at; the session's clock, trail and diff stay the single recording's.
      function stillFrameFor(sessionId, entry) {
        var tiled = tiledFrames[sessionId];
        if (entry && entry.layouts && tiled && entry.file === entry.layouts.tiled.file) {
          var seeded = seededSession(sessionId);
          var working = !!seeded && seeded.activity === 'thinking' && !!data.ends[sessionId];
          return working && tiled.openFrame ? tiled.openFrame.serialized : tiled.serialized;
        }
        return scrollback[sessionId] || '';
      }
      window.electronAPI.sessions.getScrollback = function (sessionId) {
        var entry = replays[sessionId];
        if (live && entry) {
          // The layout follows the window's natural grid, as the resize that held it did; the
          // mounted grid is the held one when there is a hold.
          var natural = naturalGeometry[sessionId] || mountedGeometry[sessionId];
          if (natural) applyLayout(entry, natural.cols, natural.rows);
          return fetchRecording(entry.file).then(function (recording) {
            if (geometryFits(sessionId, recording)) return liveScrollback(sessionId, entry);
            // The bytes cannot replay into this grid, so the terminal paints a parsed frame
            // instead, the way main routes a geometry-changed session on the desktop. That does
            // not END the session there: the agent goes on working and only the replay is
            // replaced. So a session the board shows as working keeps the clock the seed
            // started, which emits no bytes of its own, and its card, its sidebar count and its
            // Monitor peeks go on changing; the terminal holds the frame the live replay opens
            // at, since a stream cannot be re-laid out without the CLI. frameOnly means exactly
            // "never emit bytes to this session", nothing about whether it is finished. A spawn
            // plays its boot as frames from the moment it started, rather than jumping to the
            // boot's end, and a session already at its end paints the end (frameScrollback).
            return frameScrollback(sessionId, entry, recording, mountedGeometry[sessionId]);
          });
        }
        // A still paints its frame through the same applier the live frame uses: the renderer
        // resizes before it asks for the scrollback, so the mounted grid is known (the held one
        // when the pane is held), and the frame is fitted to it, widened, heightened or cut as the
        // grid asks. A still's frame carries every row above its screen, so a taller grid shows
        // them. Handed over raw, a row wider than the grid would wrap at its edge.
        var stillFrame = stillFrameFor(sessionId, entry);
        if (stillFrame) {
          var stillGrid = mountedGeometry[sessionId];
          return Promise.resolve(stillGrid ? notePainted(sessionId, stillGrid, fitFrameToGrid(stillFrame, stillGrid, entry && entry.grid ? entry.grid : undefined)) : stillFrame);
        }
        if (entry && recordings) return fetchRecording(entry.file).then(function (recording) { return recording.serialized; });
        return Promise.resolve('');
      };

      // ---- the conversation viewer -----------------------------------------------------
      // The viewer reads the agent's transcript, which main parses out of the agent's own
      // history file on the desktop. The sample install commits one per session the manifest
      // marks (derived at record time by main's own parsers, never written by hand), and the
      // build emits it beside the recordings; it is fetched when a viewer opens, since a docs
      // figure of the viewer is the one thing that needs it. A session with no transcript falls
      // through to the mock's empty answer, which is what the desktop shows for a session whose
      // history file is gone.
      var TRANSCRIPT_REVISION = 1;
      var transcriptCache = {};
      function fetchTranscript(file) {
        if (!transcriptCache[file]) {
          transcriptCache[file] = fetch(recordings.transcriptsBase + file).then(function (response) {
            if (!response.ok) throw new Error('[demo] transcript ' + file + ' returned ' + response.status);
            return response.json();
          });
        }
        return transcriptCache[file];
      }
      function indexedTranscript(sessionId) {
        return recordings && recordings.transcripts ? recordings.transcripts[sessionId] || null : null;
      }
      function agentOf(row) {
        var seeded = seededSession(row.id);
        if (seeded) return seeded.agent;
        var task = row.taskId ? tasksById[row.taskId] : null;
        var project = projectsById[row.projectId];
        return (task && task.agent) || (project ? project.default_agent : 'claude');
      }
      function transcriptSessionMeta(row) {
        return { sessionId: row.id, agentName: agentOf(row), startedAt: row.startedAt, exitedAt: row.exitedAt || null, isolatedSwimlaneId: null, status: row.status };
      }
      var originalTranscriptGet = window.electronAPI.transcripts.get;
      window.electronAPI.transcripts.get = function (input) {
        var row = sessionById(input.sessionId);
        var indexed = row ? indexedTranscript(row.id) : null;
        if (!row || !indexed) return originalTranscriptGet.apply(this, arguments);
        // The viewer polls while the session runs; nothing here ever changes, so a caller that
        // has this revision gets the short answer main gives on an idle tick.
        if (input.knownRevision === TRANSCRIPT_REVISION) return Promise.resolve({ unchanged: true, revision: TRANSCRIPT_REVISION });
        return fetchTranscript(indexed.file).then(function (transcript) {
          var task = row.taskId ? mockState.tasks.find(function (candidate) { return candidate.id === row.taskId; }) : null;
          return {
            sessionId: row.id, taskId: row.taskId, taskTitle: task ? task.title : '', agentName: agentOf(row),
            startedAt: row.startedAt, sessionStatus: row.status, source: 'live', sourcePath: null,
            entries: transcript.entries, degraded: false, sessions: [transcriptSessionMeta(row)], revision: TRANSCRIPT_REVISION,
          };
        });
      };
      var originalTranscriptList = window.electronAPI.transcripts.listSessions;
      window.electronAPI.transcripts.listSessions = function (taskId) {
        var rows = mockState ? mockState.sessions.filter(function (row) { return row.taskId === taskId && !!indexedTranscript(row.id); }) : [];
        if (rows.length === 0) return originalTranscriptList.apply(this, arguments);
        return Promise.resolve(rows.map(transcriptSessionMeta));
      };

      // ---- what a drag or a click starts -----------------------------------------------
      // The transition engine lives in the main process; here the same outcome is produced
      // from the recordings: a card dragged into an auto-spawn column gets its agent started
      // in the lane's permission mode (the boot recorded for that task and mode), a paused
      // session resumes on its own transcript, and a new Command Terminal boots the project's
      // default agent. Each is announced through the same pushes main sends (session status,
      // activity, first output, usage, the Monitor snapshot), so the renderer treats it as it
      // would the real thing.
      function isoNow() { return new Date().toISOString(); }
      function laneById(laneId) {
        return mockState.swimlanes.find(function (lane) { return lane.id === laneId; }) || null;
      }
      function sessionById(sessionId) {
        return mockState.sessions.find(function (session) { return session.id === sessionId; }) || null;
      }
      function seedUsage(sessionId, agent) {
        var model = data.modelByAgent[agent] || null;
        var contextWindowSize = model && model.id.indexOf('opus') !== -1 ? 1000000 : 200000;
        usageBySession[sessionId] = {
          model: model,
          contextWindow: { usedPercentage: 1, usedTokens: Math.round(contextWindowSize / 100), cacheTokens: 0, totalInputTokens: Math.round(contextWindowSize / 140), totalOutputTokens: Math.round(contextWindowSize / 350), contextWindowSize: contextWindowSize },
          cost: { totalCostUsd: 0, totalDurationMs: 0 },
        };
      }
      // The renderer keeps a "Starting agent" veil over a new session's terminal until main
      // reports the PTY's first output, then mounts the terminal (which is what fetches the
      // recording). Main fires that when the first bytes arrive; here it fires when the
      // recording's first window would, or after a beat for a resumed transcript.
      var firstOutputFired = {};
      var originalGetFirstOutput = window.electronAPI.sessions.getFirstOutput;
      window.electronAPI.sessions.getFirstOutput = function () {
        return originalGetFirstOutput.apply(this, arguments).then(function (map) { return Object.assign({}, map, firstOutputFired); });
      };
      // The context bar's pills (model, context window, cost) replace its "Starting agent"
      // spinner once main pushes the session's first usage snapshot, which the CLI's status
      // line delivers a beat after it starts painting. Same order here, from the seeded usage.
      var USAGE_AFTER_FIRST_OUTPUT_MS = 1200;
      function fireFirstOutput(sessionId) {
        firstOutputFired[sessionId] = true;
        if (window.__mockFireFirstOutput) window.__mockFireFirstOutput(sessionId);
        var usage = usageBySession[sessionId];
        if (!usage || !window.__mockFireUsage) return;
        var row = sessionById(sessionId);
        var projectId = row ? row.projectId : (replays[sessionId] ? replays[sessionId].projectId : undefined);
        setTimeout(function () { window.__mockFireUsage(sessionId, usage, projectId); }, USAGE_AFTER_FIRST_OUTPUT_MS);
      }
      function scheduleFirstOutput(sessionId) {
        var entry = replays[sessionId];
        if (live && entry) {
          fetchRecording(entry.file).then(function (recording) {
            var first = recording.stream[0];
            setTimeout(function () { fireFirstOutput(sessionId); }, Math.max(0, entry.startedAt + (first ? first.t : 0) - Date.now()));
          }).catch(function () { fireFirstOutput(sessionId); });
        } else {
          setTimeout(function () { fireFirstOutput(sessionId); }, 300);
        }
      }
      function announceSession(row, activity) {
        mockState.activityCache[row.id] = activity;
        mockState.eventCache[row.id] = [];
        if (window.__mockFireStatus) window.__mockFireStatus(row.id, row, row.projectId);
        if (window.__mockFireActivity) window.__mockFireActivity(row.id, activity, null, row.projectId, row.taskId);
        scheduleFirstOutput(row.id);
      }
      function announceMonitorRow(row, mockTask, agent, permissionMode) {
        var project = projectsById[row.projectId];
        var lane = mockTask ? laneById(mockTask.swimlane_id) : null;
        var model = data.modelByAgent[agent] || null;
        var rows = (window.__mockMonitorRows || []).concat([{
          sessionId: row.id, projectId: row.projectId, projectName: project.name,
          taskId: mockTask ? mockTask.id : row.id, taskTitle: mockTask ? mockTask.title : 'Command Terminal',
          outputPeek: [], displayId: mockTask ? mockTask.display_id : null, columnName: lane ? lane.name : '',
          commandTerminalBranch: row.branch || null,
          labels: mockTask ? mockTask.labels : [], prUrl: mockTask ? mockTask.pr_url : null, prNumber: mockTask ? mockTask.pr_number : null,
          prState: mockTask ? mockTask.pr_state : null, prMergeReadiness: mockTask ? mockTask.pr_merge_readiness : null,
          agentName: agent, modelDisplayName: model ? model.displayName : null, effort: null, permissionMode: permissionMode,
          startedAt: row.startedAt, exitedAt: null, status: 'running', activity: mockState.activityCache[row.id], activityReason: null,
          lastEvent: null, contextPercent: 1, isolated: false, isCommandTerminal: !!row.transient,
        }]);
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      function startTaskSession(mockTask, permissionMode) {
        var project = projectsById[mockTask.projectId];
        var targetLane = laneById(mockTask.swimlane_id);
        var agent = mockTask.agent || (targetLane && targetLane.agent_override) || project.default_agent;
        var id = 'sess-' + mockTask.id.replace(/^task-/, '') + '-' + Date.now().toString(36);
        var row = {
          id: id, taskId: mockTask.id, projectId: mockTask.projectId, pid: 30000 + mockState.sessions.length,
          status: 'running', shell: 'bash', cwd: mockTask.worktree_path || project.path, startedAt: isoNow(), exitCode: null,
          resuming: false, transient: false, branch: null, isolatedSwimlaneId: null, agentSessionId: null,
        };
        mockState.sessions.push(row);
        mockTask.session_id = id;
        mockTask.updated_at = isoNow();
        seedUsage(id, agent);
        // The boot recorded for this task in this mode. A task the visitor created has none and
        // gets the project's Command Terminal boot: the agent starting with nothing to do yet.
        var indexed = recordings ? (recordings.spawns[mockTask.id + ':' + permissionMode] || recordings.terminals[mockTask.projectId] || null) : null;
        if (indexed) replays[id] = { file: indexed.file, grid: gridOf(indexed), startedAt: Date.now(), tail: 0, projectId: mockTask.projectId };
        announceSession(row, 'thinking');
        announceMonitorRow(row, mockTask, agent, permissionMode);
        return row;
      }
      function resumeTaskSession(mockTask, suspended) {
        var project = projectsById[mockTask.projectId];
        var agent = mockTask.agent || project.default_agent;
        var id = 'sess-' + mockTask.id.replace(/^task-/, '') + '-resumed-' + Date.now().toString(36);
        var row = {
          id: id, taskId: mockTask.id, projectId: mockTask.projectId, pid: 30000 + mockState.sessions.length,
          status: 'running', shell: 'bash', cwd: mockTask.worktree_path || project.path, startedAt: isoNow(), exitCode: null,
          resuming: true, transient: false, branch: null, isolatedSwimlaneId: null, agentSessionId: null,
        };
        mockState.sessions.push(row);
        mockTask.session_id = id;
        mockTask.updated_at = isoNow();
        // A resumed agent prints its earlier transcript and waits, so the paused session's final
        // frame is the new one's scrollback, and the row is idle: it needs the user next.
        scrollback[id] = scrollback[suspended.id] || '';
        usageBySession[id] = usageBySession[suspended.id] || usageBySession[id];
        if (!usageBySession[id]) seedUsage(id, agent);
        announceSession(row, 'idle');
        announceMonitorRow(row, mockTask, agent, 'acceptEdits');
        return row;
      }
      var originalMove = window.electronAPI.tasks.move;
      window.electronAPI.tasks.move = function (input) {
        var moveArguments = arguments;
        return originalMove.apply(this, moveArguments).then(function (result) {
          var lane = laneById(input.targetSwimlaneId);
          var mockTask = mockState.tasks.find(function (task) { return task.id === input.taskId; });
          if (lane && lane.auto_spawn && mockTask) {
            // The engine's create_or_resume: a live session follows the card, a paused one
            // resumes, a card with none gets its agent started in the lane's permission mode.
            var current = mockTask.session_id ? sessionById(mockTask.session_id) : null;
            if (!current || current.status !== 'running') {
              if (current && current.status === 'suspended') resumeTaskSession(mockTask, current);
              else startTaskSession(mockTask, lane.permission_mode || data.defaultPermissionMode);
            }
          }
          return result;
        });
      };
      window.electronAPI.sessions.resume = function (taskId) {
        var mockTask = mockState.tasks.find(function (task) { return task.id === taskId; });
        if (!mockTask) return Promise.reject(new Error('Task not found: ' + taskId));
        var previous = mockTask.session_id ? sessionById(mockTask.session_id) : null;
        var lane = laneById(mockTask.swimlane_id);
        var row = previous
          ? resumeTaskSession(mockTask, previous)
          : startTaskSession(mockTask, (lane && lane.permission_mode) || data.defaultPermissionMode);
        return Promise.resolve(row);
      };
      var originalSpawnTransient = window.electronAPI.sessions.spawnTransient;
      window.electronAPI.sessions.spawnTransient = function (input) {
        return originalSpawnTransient.apply(this, arguments).then(function (result) {
          var project = projectsById[input.projectId];
          var agent = project ? project.default_agent : 'claude';
          // The new window opens alone or tiled beside the project's running terminal, and the
          // boot was recorded at both sizes; pick the one for the layout this spawn lands in.
          var tiled = mockState.sessions.some(function (session) {
            return session.transient && session.projectId === input.projectId && session.status === 'running' && session.id !== result.session.id;
          });
          var single = recordings ? recordings.terminals[input.projectId] || null : null;
          var tiledIndexed = recordings ? recordings.terminals[input.projectId + '-tiled'] || null : null;
          var indexed = (tiled && tiledIndexed) || single;
          if (indexed) replays[result.session.id] = { file: indexed.file, grid: gridOf(indexed), startedAt: Date.now(), tail: 0, projectId: input.projectId, layouts: single && tiledIndexed ? { single: single, tiled: tiledIndexed } : null };
          seedUsage(result.session.id, agent);
          announceSession(result.session, 'idle');
          announceMonitorRow(result.session, null, agent, data.defaultPermissionMode);
          return result;
        });
      };

      // A Command Terminal window that tiles beside a new one, or stands alone again when that
      // one stops, changes width, and the desktop's PTY resize has the CLI repaint at the new
      // size. A replay cannot repaint, but a boot recorded at both sizes can be swapped: a
      // resize across the single-window width switches the session to the other recording and
      // repaints it from a cleared screen at the same point in the boot.
      // The hold itself, when the pane shows its recording in smaller type (displayFor, beside
      // layoutFor above): the grid the whole pane takes at that type.
      function heldGridFor(entry, cols, rows) {
        if (!entry || !entry.grid || !entry.grid.cols || !entry.grid.rows) return null;
        return displayFor(entry.grid, cols, rows).held;
      }
      // The last grid the RENDERER named for each session, before any hold. A held session's
      // mountedGeometry is the recording's grid, which can stay identical across a real window
      // resize, so it cannot be what decides whether the window moved. It is kept apart rather
      // than folded into mountedGeometry because the frame fitter and geometryFits both need the
      // grid the terminal actually has, which is the held one.
      var naturalGeometry = {};
      // Read by demo/measure.mjs --geometry: the grid each surface fits at the frame, which is
      // what the capture matrix records at. __resizeCalls cannot serve, since it also logs the
      // held grid a conformed terminal echoes back.
      window.__demoNaturalGeometry = naturalGeometry;
      // The grid each session was last ANSWERED with a hold at. A held terminal resizes its own
      // xterm to that grid and reports it back, so the seed sees two kinds of resize for one
      // session: the window's natural grid, and the terminal echoing the grid it was just held
      // at. Only the first describes the window.
      var heldAnswer = {};
      // Read by the demo tier: whether the seed held a session at a smaller type (and at which
      // grid), or left it at the configured type on its own grid (displayFor).
      window.__demoHeldGrid = heldAnswer;
      var originalResize = window.electronAPI.sessions.resize;
      window.electronAPI.sessions.resize = function (sessionId, cols, rows) {
        // The renderer resizes before it asks for the scrollback, so a mount's grid is known when
        // getScrollback decides between the byte replay and the frame. A later resize of a mounted
        // terminal (a window tiling beside a new one, the panel's terminal handed to a task window)
        // brings no new getScrollback: the desktop's PTY resize has the CLI repaint for the new
        // grid, and here the session repaints from a cleared screen with whichever of its bytes or
        // its frame fits that grid, switching boot recordings by layout on the way. The grid the
        // renderer names is its NATURAL one, at the configured font, whether or not it is held;
        // the boot is chosen by that width, and the held grid, when there is one, is the grid the
        // terminal will actually have.
        var previous = mountedGeometry[sessionId];
        var previousNatural = naturalGeometry[sessionId];
        var previousHeld = heldAnswer[sessionId];
        var entry = replays[sessionId];
        // The terminal reporting exactly the grid it was last held at is the conform LANDING,
        // not the window moving. It must change nothing: treating it as a natural resize fires a
        // repaint on every conform, which reached a session whose replay is already at its end
        // and pushed a whole frame into a terminal that should have received nothing.
        var conformEcho = !!previousHeld && cols === previousHeld.cols && rows === previousHeld.rows;
        if (entry && !conformEcho) applyLayout(entry, cols, rows);
        var held = conformEcho ? previousHeld : (recordings ? heldGridFor(entry, cols, rows) : null);
        // A natural grid whose hold the terminal already declined is not offered it again.
        if (!conformEcho && held && sameGrid(conformDeclined[sessionId], { cols: cols, rows: rows })) held = null;
        var effective = held || { cols: cols, rows: rows };
        mountedGeometry[sessionId] = effective;
        heldAnswer[sessionId] = held;
        if (!conformEcho) naturalGeometry[sessionId] = { cols: cols, rows: rows };
        // A repaint follows a real WINDOW resize, so the natural grid decides, not the held one.
        // While a session is held the held grid can be identical either side of a resize (a
        // Command Terminal that tiles still fits its recording's grid), and keying off it alone
        // skipped the repaint entirely. Whether it skipped depended on where the natural width
        // fell against the layout crossover (layoutFor), which moves with the platform's font metrics:
        // Windows crossed it and Linux CI did not, so the tiling case passed locally and failed
        // on every CI run.
        var changed = !conformEcho
          && ((!!previousNatural && (previousNatural.cols !== cols || previousNatural.rows !== rows))
            || (!!previous && (previous.cols !== effective.cols || previous.rows !== effective.rows)));
        var answer = originalResize.apply(this, arguments);
        if (held) answer = answer.then(function (base) { return Object.assign({}, base, { colsChanged: false, refused: true, held: held }); });
        if (conformEcho) conformLanded[sessionId] = held;
        else if (held && !sameGrid(previousHeld, held)) awaitConform(sessionId, entry, held);
        if (live && entry && changed) repaintSession(sessionId, entry, effective);
        return answer;
      };
      function sameGrid(one, other) {
        return !!one && !!other && one.cols === other.cols && one.rows === other.rows;
      }
      // A session repainted for its terminal's grid now, as a mount would get it: the bytes when
      // the grid is the recording's, the emulator's frame otherwise, on the session's own clock
      // (a resize is not the session ending, so the card and the Monitor keep moving).
      function repaintSession(sessionId, entry, grid) {
        fetchRecording(entry.file).then(function (recording) {
          if (geometryFits(sessionId, recording)) {
            return liveScrollback(sessionId, entry).then(function (head) { emitBytes(sessionId, REPAINT + head, entry.projectId); });
          }
          return frameScrollback(sessionId, entry, recording, grid).then(function (bytes) {
            if (bytes) emitBytes(sessionId, bytes, entry.projectId);
          });
        });
      }
      // The held grid each session's terminal last reported back: the conform landing. And the
      // natural grid a session's terminal declined a hold at, so the next resize at that grid
      // does not offer it again.
      var conformLanded = {};
      var conformDeclined = {};
      // A held terminal that never reports the held grid back declined it (the pane measured
      // other than the natural grid said, or its font could not get there), and kept its own
      // grid. The session is then shown at the configured type on that grid instead, as a pane a
      // column or two short is: frames fitted to a grid the terminal does not have would be cut at
      // its edge. The conform lands within a resize debounce, well inside this wait.
      var CONFORM_WAIT_MS = 2000;
      function awaitConform(sessionId, entry, held) {
        conformLanded[sessionId] = null;
        setTimeout(function () {
          if (!sameGrid(heldAnswer[sessionId], held) || sameGrid(conformLanded[sessionId], held)) return;
          var natural = naturalGeometry[sessionId];
          if (!natural) return;
          conformDeclined[sessionId] = { cols: natural.cols, rows: natural.rows };
          heldAnswer[sessionId] = null;
          mountedGeometry[sessionId] = { cols: natural.cols, rows: natural.rows };
          if (live && entry) {
            repaintSession(sessionId, entry, mountedGeometry[sessionId]);
            return;
          }
          var stillFrame = stillFrameFor(sessionId, entry);
          if (stillFrame) emitBytes(sessionId, REPAINT + notePainted(sessionId, mountedGeometry[sessionId], fitFrameToGrid(stillFrame, mountedGeometry[sessionId], entry ? entry.grid : undefined)), entry ? entry.projectId : undefined);
        }, CONFORM_WAIT_MS);
      }

      // The working tree each recorded session left behind, keyed by its task's worktree folder,
      // so a task's Changes panel shows what its agent changed, in three scopes. The Branch scope is everything the branch
      // changes against its base, which with nothing committed is the whole recorded diff. The
      // split between Working and Staged follows what an agent does with a NEW file: it stages
      // it (git add) so the file is tracked and shows in git diff --cached, while its edits
      // to existing files stay unstaged. So added files are the staged set and modified files
      // the working set, derived from the recorded statuses rather than authored per task; a
      // session that only edited existing files has an empty Staged tab, as it would.
      function scopeOf(diff, keep) {
        var files = diff.files.filter(keep);
        return {
          files: files,
          totalInsertions: files.reduce(function (sum, file) { return sum + (file.insertions || 0); }, 0),
          totalDeletions: files.reduce(function (sum, file) { return sum + (file.deletions || 0); }, 0),
        };
      }
      var diffByWorktree = {};
      data.tasks.forEach(function (task) {
        var diff = task.session_id && changes[task.session_id];
        if (!diff || !task.worktree_folder) return;
        diffByWorktree[task.worktree_folder] = {
          working: scopeOf(diff, function (file) { return file.status !== 'A'; }),
          staged: scopeOf(diff, function (file) { return file.status === 'A'; }),
          branch: diff,
        };
      });
      window.__mockGitDiffByWorktree = diffByWorktree;

      // A scaffolded project's real history (loadDemoHistory), served per worktree the way the
      // desktop's git reads it: the History pane's graph, the diff a selected commit introduces,
      // the header's branch summary, each file's history, and the blame gutter over the working
      // tree the session left. A task branch has no commits of its own, so its tip IS the base
      // and the graph's three anchors coincide, which is what a fresh worktree shows.
      var commitGraphByWorktree = {};
      var branchSummaryByWorktree = {};
      var blameByWorktree = {};
      var fileHistoryByWorktree = {};
      var diffByCommit = {};
      data.tasks.forEach(function (task) {
        var project = projectsById[task.projectId];
        var projectHistory = project && history[project.name];
        if (!projectHistory || !task.worktree_folder) return;
        var tip = projectHistory.commits[0];
        commitGraphByWorktree[task.worktree_folder] = {
          commits: projectHistory.commits, tipHash: projectHistory.tipHash, baseHash: projectHistory.tipHash,
          mergeBaseHash: projectHistory.tipHash, currentBranch: task.branch_name, truncated: false,
        };
        branchSummaryByWorktree[task.worktree_folder] = {
          currentBranch: task.branch_name, ahead: 0, behind: 0,
          lastCommit: { hash: tip.shortHash, subject: tip.subject, timestamp: tip.authorTimestamp },
        };
        var byPath = {};
        projectHistory.commits.forEach(function (commit) {
          var diff = projectHistory.diffs[commit.hash];
          (diff ? diff.files : []).forEach(function (file) {
            if (!byPath[file.path]) byPath[file.path] = { commits: [] };
            byPath[file.path].commits.push({ hash: commit.hash, shortHash: commit.shortHash, authorName: commit.authorName, authorTimestamp: commit.authorTimestamp, subject: commit.subject });
          });
        });
        fileHistoryByWorktree[task.worktree_folder] = byPath;
        if (task.session_id && projectHistory.blame[task.session_id]) blameByWorktree[task.worktree_folder] = projectHistory.blame[task.session_id];
        Object.keys(projectHistory.diffs).forEach(function (hash) { diffByCommit[hash] = projectHistory.diffs[hash]; });
      });
      window.__mockCommitGraphByWorktree = commitGraphByWorktree;
      window.__mockBranchSummaryByWorktree = branchSummaryByWorktree;
      window.__mockBlameByWorktree = blameByWorktree;
      window.__mockFileHistoryByWorktree = fileHistoryByWorktree;
      window.__mockGitDiffByCommit = diffByCommit;

      // A deterministic usage dashboard: fourteen days of sessions per project, seeded so every
      // boot draws the same charts, scaled by the project's share of the sample install.
      function seeded(seed) { var value = seed; return function () { value = (value * 1664525 + 1013904223) % 4294967296; return value / 4294967296; }; }
      window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
        var hourMs = 3600000;
        var dayMs = 24 * hourMs;
        var random = seeded(scope.kind === 'all' ? 7 : (String(scope.projectId || '').length + 11));
        var scale = scope.kind === 'all' ? 1 : 0.42;
        var days = period === 'all' ? 90 : period === '7d' ? 7 : 14;
        var rangeStartMs = Math.floor(now / dayMs) * dayMs - (days - 1) * dayMs;

        // The stacked cost chart keys its series off the model ids the byModel breakdown returns,
        // and that breakdown is derived from the sessions the boards actually show. So the daily
        // split has to come from the SAME set: a hardcoded model list drew an empty chart, because
        // none of its ids appeared in the legend the breakdown had already built.
        var chartSessions = data.sessions.filter(function (session) {
          return session.model && session.contextPercent !== null && (scope.kind === 'all' || session.projectId === scope.projectId);
        });
        var modelWeights = [];
        chartSessions.forEach(function (session) {
          var existing = modelWeights.filter(function (entry) { return entry.modelId === session.model.id; })[0];
          var weight = session.contextWindowSize * session.contextPercent / 100;
          if (existing) existing.weight += weight;
          else modelWeights.push({ modelId: session.model.id, weight: weight });
        });
        var weightTotal = modelWeights.reduce(function (sum, entry) { return sum + entry.weight; }, 0) || 1;
        modelWeights.sort(function (left, right) { return right.weight - left.weight; });

        var costSeries = [];
        var totalCost = 0, totalInput = 0, totalOutput = 0, sessionCount = 0;
        for (var day = 0; day < days; day++) {
          var bucketStart = rangeStartMs + day * dayMs;
          var weekend = new Date(bucketStart).getDay() % 6 === 0;
          // Real histories have gaps and bursts rather than a smooth band, which is what the
          // /preview seeder reproduces and what makes a 90-day chart worth looking at: roughly one
          // day in eight is idle, and one in twelve is a push at three times the volume.
          var dayRoll = random();
          var idle = day < days - 1 && dayRoll < 0.12;
          var spike = dayRoll > 0.92 ? 3 : 1;
          var cost = idle ? 0 : (weekend ? 1.2 : 6.5 + random() * 5) * scale * spike;
          var input = idle ? 0 : Math.round((weekend ? 40000 : 180000 + random() * 120000) * scale * spike);
          var output = Math.round(input * 0.28);
          var sessions = idle ? 0 : Math.max(1, Math.round((weekend ? 1 : 3 + random() * 4) * spike));
          totalCost += cost; totalInput += input; totalOutput += output; sessionCount += sessions;
          var dayModels = modelWeights.map(function (entry) {
            var share = entry.weight / weightTotal;
            return {
              modelId: entry.modelId, costUsd: cost * share,
              inputTokens: Math.round(input * share), outputTokens: Math.round(output * share),
            };
          });
          costSeries.push({
            bucketStartMs: bucketStart, costUsd: cost, inputTokens: input, outputTokens: output, sessionCount: sessions,
            byModel: dayModels,
          });
        }
        var tokenSeries = [];
        var bucketCount = 12;
        var tokenStart = Math.floor(now / hourMs) * hourMs - (bucketCount - 1) * hourMs;
        for (var bucket = 0; bucket < bucketCount; bucket++) {
          var perBucketInput = Math.round((6000 + random() * 9000) * scale);
          tokenSeries.push({
            bucketStartMs: tokenStart + bucket * hourMs, inputTokens: perBucketInput, outputTokens: Math.round(perBucketInput * 0.3),
            cacheCreationTokens: Math.round(perBucketInput * 0.15), cacheReadTokens: Math.round(perBucketInput * 4.5),
            allocatedCostUsd: (0.18 + random() * 0.3) * scale, turnCount: 4 + Math.floor(random() * 6),
          });
        }
        var kpis = {
          totalCostUsd: totalCost, costKnown: true, totalInputTokens: totalInput, totalOutputTokens: totalOutput,
          totalTokens: totalInput + totalOutput, sessionCount: sessionCount, toolCallCount: Math.round(sessionCount * 41),
          linesAdded: Math.round(sessionCount * 160), linesRemoved: Math.round(sessionCount * 55), filesChanged: Math.round(sessionCount * 7),
          compactionCount: Math.round(sessionCount / 6), totalDurationMs: sessionCount * 38 * 60000,
          turnInputTokens: Math.round(totalInput * 0.35), turnOutputTokens: Math.round(totalOutput * 0.5),
          cacheCreationTokens: Math.round(totalInput * 0.2), cacheReadTokens: Math.round(totalInput * 5.5),
          burnRateTokensPerHour: Math.round(26000 * scale), burnRateUsdPerHour: 1.7 * scale,
          // Active (agent-working) time, and the sessions the interval ledger
          // reaches. Deliberately BOTH lower than their wall-clock/sessionCount
          // neighbours above: active time runs well under session duration, and
          // per-interval recording covers fewer sessions than the usage ledger,
          // which is exactly what the Avg Active tile's caveat describes.
          activeMs: Math.round(sessionCount * 38 * 60000 * 0.39),
          activeSessionsCovered: Math.max(1, Math.round(sessionCount * 0.72)),
        };
        var previous = {};
        Object.keys(kpis).forEach(function (key) { previous[key] = typeof kpis[key] === 'number' ? Math.round(kpis[key] * 0.86 * 1000) / 1000 : kpis[key]; });
        // The model, agent, and effort breakdowns come from the sessions the boards actually show,
        // weighted by the tokens each has used, so the dashboard names the same models the
        // terminals do.
        var scopedSessions = chartSessions;
        function breakdown(keyOf, labelOf) {
          var groups = {};
          var totalWeight = 0;
          scopedSessions.forEach(function (session) {
            var key = keyOf(session);
            if (key === null || key === undefined) return;
            var weight = session.contextWindowSize * session.contextPercent / 100;
            if (!groups[key]) groups[key] = { key: key, label: labelOf ? labelOf(session) : key, weight: 0, cost: 0, count: 0 };
            groups[key].weight += weight;
            groups[key].cost += session.costUsd;
            groups[key].count += 1;
            totalWeight += weight;
          });
          var totalGroupCost = Object.keys(groups).reduce(function (sum, key) { return sum + groups[key].cost; }, 0);
          return Object.keys(groups).map(function (key) {
            var group = groups[key];
            var share = totalWeight ? group.weight / totalWeight : 0;
            var costShare = totalGroupCost ? group.cost / totalGroupCost : share;
            return {
              key: key, label: group.label,
              inputTokens: Math.round(totalInput * share), outputTokens: Math.round(totalOutput * share),
              costUsd: totalCost * costShare, sessionCount: Math.max(1, Math.round(sessionCount * share)),
            };
          }).sort(function (left, right) { return right.inputTokens - left.inputTokens; });
        }
        return {
          scope: scope, period: period, rangeStartMs: rangeStartMs, rangeEndMs: now, bucketSizeMs: hourMs, costBucketSizeMs: dayMs, generatedAtMs: now,
          kpis: kpis, previousKpis: period === 'all' ? null : previous, tokenSeries: tokenSeries, costSeries: costSeries,
          byModel: breakdown(function (session) { return session.model ? session.model.id : null; }, function (session) { return session.model.displayName; }).map(function (row) {
            return { modelId: row.key, modelDisplayName: row.label, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, sessionCount: row.sessionCount };
          }),
          byAgent: breakdown(function (session) { return session.agent; }).map(function (row) {
            return { agent: row.key, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, sessionCount: row.sessionCount };
          }),
          byEffort: breakdown(function (session) { return session.effort || '(default)'; }).map(function (row) {
            return { effort: row.key === '(default)' ? null : row.key, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, sessionCount: row.sessionCount };
          }),
          perProject: scope.kind === 'all'
            ? data.projects.map(function (project, index) {
                var share = [0.55, 0.27, 0.18][index] || 0.1;
                return {
                  projectId: project.id, projectName: project.name, inputTokens: Math.round(totalInput * share), outputTokens: Math.round(totalOutput * share),
                  costUsd: totalCost * share, sessionCount: Math.round(sessionCount * share), toolCallCount: Math.round(sessionCount * 41 * share),
                  linesAdded: Math.round(sessionCount * 160 * share), linesRemoved: Math.round(sessionCount * 55 * share), filesChanged: Math.round(sessionCount * 7 * share),
                  totalDurationMs: Math.round(sessionCount * 38 * 60000 * share), lastActiveMs: now - project.lastOpenedMinutesAgo * 60000, topAgent: project.default_agent,
                  activeMs: Math.round(sessionCount * 38 * 60000 * share * 0.39),
                  activeSessionsCovered: Math.max(1, Math.round(sessionCount * share * 0.72)),
                };
              })
            : undefined,
          // No live overlay reaches this fixture, so the ledger already holds
          // everything the renderer would layer on: nothing to subtract.
          liveLedgerBaseline: { costUsd: 0 },
          // Per-turn capture starts later than the cost ledger, so a long range
          // shows the Tokens tile's partial-coverage note, as a real install does.
          earliestTurnMs: now - 30 * dayMs,
        };
      };
    })();
  `;
}
