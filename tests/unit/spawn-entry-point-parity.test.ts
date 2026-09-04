/**
 * Spawn entry-point parity guard (see .claude/rules/spawn-entry-point-parity.md).
 *
 * Every way a task agent can be spawned must route through one of the two
 * spawn chokepoints, because spawn-affecting behavior (the first-spawn
 * Advanced-override lock, agent resolution, permission-mode resolution,
 * auto_command handling) is applied there and ONLY there:
 *
 *   - board-driven spawns (task move, create-into-spawn-column, backlog
 *     promote, MCP create, unarchive) go through `spawnAgent`
 *     (src/main/ipc/helpers/agent-spawn.ts);
 *   - startup spawns (crash recovery, reconcile) go through
 *     `prepareAgentSpawn` (src/main/transition-engine/session-startup/
 *     prepare-spawn.ts).
 *
 * Both chokepoints run `runSpawnPreamble` (src/main/transition-engine/
 * spawn-preamble.ts): the lock, then agent resolution, in that order.
 *
 * This shipped as a bug: the first-spawn override lock landed in only 2 of
 * the 4 entry points that existed at the time (task-crud.ts and task-move's
 * spawnAgent call), so a task whose true first spawn happened via startup
 * recovery or unarchive never locked its overrides - and the create path
 * persisted a locked agent while the engine spawned a different one, because
 * it passed `agentOverride: undefined` and `executeSpawnAgent` never reads
 * `task.agent_override`.
 *
 * This test makes that class of drift unmergeable by pure source analysis:
 *   (a) every direct call to the engine spawn sinks (`executeTransition` /
 *       `resumeSuspendedSession`) must be in an explicitly classified file;
 *   (b) every raw PTY spawn (`sessionManager.spawn(`) must be in an
 *       explicitly classified file;
 *   (c) the chokepoints must actually contain their preamble calls, so an
 *       allowlisted file cannot silently drop the shared behavior;
 *   (d) the first-spawn lock has exactly one call site (inside the preamble),
 *       so an ad-hoc handler-level lock cannot reappear and diverge from
 *       agent-resolution ordering.
 *
 * A new entry point therefore cannot ship without a deliberate decision:
 * route it through a chokepoint, or add a justified allowlist entry here AND
 * update the rule file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_DIR = path.join(REPO_ROOT, 'src/main');
const RULE_FILE = '.claude/rules/spawn-entry-point-parity.md';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Files allowed to call `engine.executeTransition` / `engine.resumeSuspendedSession`
 * directly, each with the reason it is exempt from routing through `spawnAgent`.
 */
const ENGINE_SINK_FILES: Record<string, string> = {
  'src/main/ipc/helpers/agent-spawn.ts':
    'spawnAgent: the shared board-spawn chokepoint itself; runs runSpawnPreamble before every engine call',
  'src/main/ipc/handlers/sessions.ts':
    'SESSION_RESUME: in-place resume of the task in its CURRENT lane; not a first-spawn entry point '
    + '(agent stickiness comes from the session-type-scoped resume lookup). Known edge: with no '
    + 'resumable record it fresh-spawns the default agent (agentOverride undefined) - pre-existing, '
    + 'candidate follow-up',
  'src/main/ipc/handlers/session-reconcile.ts':
    'restartSessionForSettingsChange: suspend-and-respawn in place to apply CLI flags to an EXISTING '
    + 'session; not a first-spawn entry point',
};

/**
 * Files allowed to call `sessionManager.spawn(` (the raw PTY sink), each with
 * the reason. Anything else is a brand-new spawn stack bypassing both
 * chokepoints.
 */
const PTY_SINK_FILES: Record<string, string> = {
  'src/main/transition-engine/transition-engine.ts':
    'executeSpawnAgent (the engine sink every board-driven spawn funnels into) and the run_script action',
  'src/main/transition-engine/session-startup/auto-spawn.ts':
    'startup reconcile; prepares every spawn via prepareAgentSpawn (asserted below)',
  'src/main/transition-engine/session-startup/resume-suspended.ts':
    'startup crash recovery; prepares every spawn via prepareAgentSpawn (asserted below)',
  'src/main/ipc/handlers/sessions.ts':
    'raw SESSION_SPAWN passthrough: renderer-supplied command, no task-agent resolution involved',
  'src/main/ipc/handlers/transient-sessions.ts':
    'transient Command Terminal sessions: not task agents, no overrides or lock apply',
};

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

// Skips full-line comments (// and JSDoc bodies). task-lifecycle-lock.ts, for
// example, shows an `engine.resumeSuspendedSession(...)` call in its JSDoc.
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

type SinkCall = { relativePath: string; line: number; location: string };

function collectSinkCalls(pattern: RegExp): SinkCall[] {
  const calls: SinkCall[] = [];
  for (const filePath of collectSourceFiles(MAIN_DIR)) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (pattern.test(line)) {
        calls.push({ relativePath, line: index + 1, location: `${relativePath}:${index + 1}` });
      }
    });
  }
  return calls;
}

// Lines strictly BEFORE `beforeLine` (1-based), so a call sharing a line with the
// site being checked does not count as preceding it.
function fileHasNonCommentCallBefore(relativePath: string, beforeLine: number, callName: string): boolean {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
  return source
    .split('\n')
    .slice(0, beforeLine - 1)
    .some((line) => !isCommentLine(line) && line.includes(`${callName}(`));
}

function fileHasNonCommentCall(relativePath: string, callName: string): boolean {
  return fileHasNonCommentCallBefore(relativePath, Number.POSITIVE_INFINITY, callName);
}

type ReceiverCall = SinkCall & { receiver: string };

// Like collectSinkCalls, but captures the receiver identifier so a pairing check can
// demand the SAME receiver instead of a variable literally named `adapter`. Without
// this, a future spawn site written `claudeAdapter.buildCommand(...)` is never
// collected at all, and the scan passes by finding nothing rather than by finding it
// safe. A leading `.` also keeps method DECLARATIONS (`buildCommand(options) {`) out.
function collectReceiverCalls(methodName: string): ReceiverCall[] {
  const pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.${methodName}\\s*\\(`);
  const calls: ReceiverCall[] = [];
  for (const filePath of collectSourceFiles(MAIN_DIR)) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      const match = pattern.exec(line);
      if (match === null) return;
      calls.push({
        relativePath,
        line: index + 1,
        location: `${relativePath}:${index + 1}`,
        receiver: match[1],
      });
    });
  }
  return calls;
}

const ENGINE_SINK_PATTERN = /\.(executeTransition|resumeSuspendedSession)\s*\(/;
const PTY_SINK_PATTERN = /sessionManager\.spawn\s*\(/;

describe('spawn entry-point parity: engine sinks', () => {
  it('every direct engine.executeTransition / engine.resumeSuspendedSession call site is classified', () => {
    const unclassified = collectSinkCalls(ENGINE_SINK_PATTERN)
      .filter((call) => !(call.relativePath in ENGINE_SINK_FILES))
      .map((call) => call.location);
    expect(
      unclassified,
      `Direct engine spawn call(s) outside the classified files:\n${unclassified.join('\n')}\n\n`
        + `A board-driven spawn must route through spawnAgent (src/main/ipc/helpers/agent-spawn.ts) `
        + `so the shared spawn preamble (first-spawn override lock + agent resolution) applies. `
        + `Either route through spawnAgent / prepareAgentSpawn, or add a justified ENGINE_SINK_FILES `
        + `entry here and update ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: raw PTY sinks', () => {
  it('every sessionManager.spawn( call site is classified', () => {
    const unclassified = collectSinkCalls(PTY_SINK_PATTERN)
      .filter((call) => !(call.relativePath in PTY_SINK_FILES))
      .map((call) => call.location);
    expect(
      unclassified,
      `Raw sessionManager.spawn( call(s) outside the classified files:\n${unclassified.join('\n')}\n\n`
        + `A new spawn stack bypasses BOTH spawn chokepoints (spawnAgent and prepareAgentSpawn), so `
        + `none of the shared spawn behavior (override lock, agent/permission resolution) applies. `
        + `Route through a chokepoint, or add a justified PTY_SINK_FILES entry here and update `
        + `${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: chokepoints actually run the shared preamble', () => {
  // An allowlisted chokepoint that silently drops its preamble call would pass
  // the classification checks above while losing the shared behavior. Pin the
  // positive side too.
  it.each([
    'src/main/ipc/helpers/agent-spawn.ts',
    'src/main/transition-engine/session-startup/prepare-spawn.ts',
  ])('%s calls runSpawnPreamble(', (relativePath) => {
    expect(
      fileHasNonCommentCall(relativePath, 'runSpawnPreamble'),
      `${relativePath} must call runSpawnPreamble() (the first-spawn override lock + agent `
        + `resolution, in that order) before spawning. See ${RULE_FILE}.`,
    ).toBe(true);
  });

  it.each([
    'src/main/transition-engine/session-startup/auto-spawn.ts',
    'src/main/transition-engine/session-startup/resume-suspended.ts',
  ])('%s prepares spawns via prepareAgentSpawn(', (relativePath) => {
    expect(
      fileHasNonCommentCall(relativePath, 'prepareAgentSpawn'),
      `${relativePath} must build its spawns through prepareAgentSpawn() so the startup path `
        + `shares the spawn preamble. See ${RULE_FILE}.`,
    ).toBe(true);
  });

  it.each([
    'src/main/transition-engine/transition-engine.ts',
    'src/main/transition-engine/session-startup/prepare-spawn.ts',
  ])('%s resolves permission via resolveEffectivePermissionMode(', (relativePath) => {
    expect(
      fileHasNonCommentCall(relativePath, 'resolveEffectivePermissionMode'),
      `${relativePath} must resolve the effective permission mode via `
        + `resolveEffectivePermissionMode() (lane 'plan' always wins, else task -> lane -> global) `
        + `instead of an inline ternary. See ${RULE_FILE}.`,
    ).toBe(true);
  });
});

describe('spawn entry-point parity: every buildCommand site runs ensureTrust first', () => {
  // `adapter.ensureTrust` is the adapter's pre-spawn global-config step (trust
  // entries, and for Claude the diff-panel write in diff-panel.ts). The
  // Command Terminal (transient-sessions.ts) is allowlisted out of both
  // chokepoints above, so nothing else guarantees it keeps calling it - and a
  // maximized Command Terminal is exactly where Claude's diff panel would
  // otherwise come back. Pin: every file that builds an agent command calls
  // ensureTrust( on the SAME receiver, on an earlier non-comment line.
  //
  // Deliberate limits of a static scan, so nobody reads it as more than it is:
  // it proves line ORDER within a file, not that the two calls sit on one
  // control-flow path, and it only sees paths that build their command through
  // an adapter (a raw passthrough spawning a caller-supplied command string is
  // invisible to it). Runtime ordering is pinned by the handler-level tests.
  it('every buildCommand( call site is preceded by the same receiver calling ensureTrust(', () => {
    const buildSites = collectReceiverCalls('buildCommand');
    expect(buildSites.length, 'expected at least one buildCommand( call site').toBeGreaterThan(0);
    const missing = buildSites
      .filter((site) => !fileHasNonCommentCallBefore(site.relativePath, site.line, `${site.receiver}.ensureTrust`))
      .map((site) => `${site.location} (receiver: ${site.receiver})`);
    expect(
      missing,
      `buildCommand( without an earlier ensureTrust( on the same receiver:\n`
        + `${missing.join('\n')}\n\n`
        + `Pre-spawn global-config state (trust entries, Claude's diff-panel write) must apply on `
        + `every path that builds an agent command, including the Command Terminal. Call `
        + `<receiver>.ensureTrust(cwd) before building the command. See ${RULE_FILE}.`,
    ).toEqual([]);
  });
});

describe('spawn entry-point parity: single lock call site', () => {
  it('lockAdvancedOverridesOnFirstSpawn is only referenced inside spawn-preamble.ts', () => {
    const outsideCalls = collectSinkCalls(/\blockAdvancedOverridesOnFirstSpawn\s*\(/)
      .filter((call) => call.relativePath !== 'src/main/transition-engine/spawn-preamble.ts')
      .map((call) => call.location);
    expect(
      outsideCalls,
      `lockAdvancedOverridesOnFirstSpawn( referenced outside spawn-preamble.ts:\n`
        + `${outsideCalls.join('\n')}\n\n`
        + `The lock runs only inside runSpawnPreamble, BEFORE agent resolution - a handler-level `
        + `call site can drift out of that ordering. Route the path through a spawn chokepoint `
        + `instead. See ${RULE_FILE}.`,
    ).toEqual([]);
  });
});
