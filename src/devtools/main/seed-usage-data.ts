/**
 * Dev-only: seed realistic usage data into EVERY registered preview project
 * (the preview always starts with Project 1 + Project 2) so the usage
 * dashboard (title-bar chart icon / Mod+Shift+U) has rich charts to show in a
 * /preview session without hours of real agent runs - including a meaningful
 * "This Project" vs "All Projects" difference and a populated per-project
 * table (volumes descend per project).
 *
 * Writes through the SAME repository paths real capture uses - so seeded rows
 * are shape-identical to real ones:
 *   - `UsageHistoryRepository.recordSessionUsage` (per-finalized-session
 *     totals: KPI tiles, cost/day bars, by-model and by-agent breakdowns)
 *   - `ConversationUsageStore.recordTurns` (per-turn time series: burn-rate
 *     and token-trend charts; each turn's `session_id` matches its
 *     usage_history row so the $/hr proportional cost allocation works)
 *
 * Data shape: N days of sessions across several agents/models (weekend dip,
 * working-hours spread), a subscription-style agent reporting $0 with real
 * tokens, and the newest session landing inside the trailing 2-hour window so
 * the Live range moves too. Each click appends a fresh batch (ids carry a
 * per-click run index), so re-clicking while the dashboard is open shows the
 * charts animating to the new totals.
 *
 * Build-excluded from production: imported only behind `__KANGENTIC_DEV__`
 * guards (src/main/index.ts), so esbuild dead-code elimination drops this
 * module from prod bundles. See `.claude/rules/dev-tooling-build-exclusion.md`.
 * The CLI sibling for seeding a REAL install's data dir is
 * `scripts/seed-usage-data.js`.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../../main/db/database';
import { UsageHistoryRepository } from '../../main/db/repositories/usage-history-repository';
import { ConversationUsageStore, type TurnUsageInput } from '../../main/retrieval/conversation/conversation-usage-store';
import type { DevSeedUsageDataResult } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';

interface SeedAgentProfile {
  agent: string;
  modelId: string | null;
  modelDisplayName: string | null;
  costPerMTokens: number;
  weight: number;
  /** Applied-effort mix for this profile; null = agent default (no flag). */
  efforts: ReadonlyArray<string | null>;
}

const AGENT_PROFILES: SeedAgentProfile[] = [
  { agent: 'claude', modelId: 'claude-opus-4-8', modelDisplayName: 'Opus 4.8', costPerMTokens: 45, weight: 0.5, efforts: ['high', 'max', null] },
  { agent: 'claude', modelId: 'claude-sonnet-5', modelDisplayName: 'Sonnet 5', costPerMTokens: 12, weight: 0.2, efforts: ['medium', null] },
  { agent: 'codex', modelId: 'gpt-5.2-codex', modelDisplayName: 'GPT-5.2 Codex', costPerMTokens: 15, weight: 0.15, efforts: ['high', 'medium'] },
  { agent: 'gemini', modelId: 'gemini-3-pro', modelDisplayName: 'Gemini 3 Pro', costPerMTokens: 10, weight: 0.1, efforts: [null] },
  // Subscription-style agent: real tokens, zero reported cost (exercises the
  // dashboard's costKnown degradation only when it is the sole agent).
  { agent: 'aider', modelId: null, modelDisplayName: null, costPerMTokens: 0, weight: 0.05, efforts: [null] },
];

function pickEffort(profile: SeedAgentProfile): string | null {
  return profile.efforts[Math.floor(Math.random() * profile.efforts.length)] ?? null;
}

function pickProfile(): SeedAgentProfile {
  const roll = Math.random();
  let cumulative = 0;
  for (const profile of AGENT_PROFILES) {
    cumulative += profile.weight;
    if (roll <= cumulative) return profile;
  }
  return AGENT_PROFILES[0];
}

// Module state; resets when the main process restarts. Each click uses a
// fresh index so re-clicks append a new, non-colliding batch.
let seedRunIndex = 0;

/** Seed one project's ledgers. `volumeScale` shrinks the per-day session count
 *  so different projects get visibly different volumes. */
function seedOneProject(projectId: string, days: number, runIndex: number, volumeScale: number, nowMs: number): { sessions: number; turns: number } {
  const db = getProjectDb(projectId);
  const usageHistory = new UsageHistoryRepository(db);
  const turnUsage = new ConversationUsageStore(db);

  let sessionCount = 0;
  let turnCount = 0;

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
    const day = new Date();
    day.setDate(day.getDate() - dayOffset);
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    // Production-shaped variance: real histories have gaps and bursts, not a
    // smooth band. ~12% of past days are idle (nothing recorded) and ~8% are
    // spike days (a heavy push at ~3x volume); today always gets data so the
    // Live/Today ranges are never empty right after seeding.
    const dayRoll = Math.random();
    if (dayOffset > 0 && dayRoll < 0.12) continue;
    const spikeFactor = dayRoll > 0.92 ? 3 : 1;
    const sessionsToday = Math.max(1, Math.round((isWeekend ? 2 : 5) * (0.5 + Math.random()) * volumeScale * spikeFactor));

    for (let sessionIndex = 0; sessionIndex < sessionsToday; sessionIndex++) {
      const profile = pickProfile();

      // Past days spread over local working hours. TODAY spreads over the
      // hours that have actually elapsed (midnight -> now) - working hours
      // would all be in the future when previewing early in the day, leaving
      // Today empty. Today's LAST session starts inside the trailing 2-hour
      // window so the Live range has data.
      const isLiveWindowSession = dayOffset === 0 && sessionIndex === sessionsToday - 1;
      let startMs: number;
      if (isLiveWindowSession) {
        startMs = nowMs - (10 + Math.floor(Math.random() * 60)) * 60_000;
      } else if (dayOffset === 0) {
        const midnightMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        startMs = midnightMs + Math.floor(Math.random() * Math.max(nowMs - midnightMs, 1));
      } else {
        const startHour = 9 + Math.floor(Math.random() * 10);
        startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, Math.floor(Math.random() * 60)).getTime();
      }
      if (startMs > nowMs) continue;

      const sessionId = `dev-seed-usage-${projectId.slice(0, 8)}-${runIndex}-${dayOffset}-${sessionCount++}`;
      const turnsThisSession = 4 + Math.floor(Math.random() * 20);
      const durationMs = turnsThisSession * (30_000 + Math.floor(Math.random() * 90_000));

      let sessionInput = 0;
      let sessionOutput = 0;
      const turns: TurnUsageInput[] = [];
      for (let turnIndex = 0; turnIndex < turnsThisSession; turnIndex++) {
        const ts = Math.min(startMs + Math.floor((durationMs * turnIndex) / turnsThisSession), nowMs);
        const inputTokens = 500 + Math.floor(Math.random() * 6_000);
        const outputTokens = 200 + Math.floor(Math.random() * 2_500);
        sessionInput += inputTokens;
        sessionOutput += outputTokens;
        turns.push({
          turnUuid: `dev-seed-turn-${sessionId}-${turnCount++}`,
          ts,
          model: profile.modelId,
          usage: {
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: Math.floor(inputTokens * 0.4),
            cacheReadInputTokens: Math.floor(inputTokens * (8 + Math.random() * 10)),
          },
        });
      }
      turnUsage.recordTurns(
        { agentSessionId: null, sessionId, taskId: null },
        turns,
        new Date(Math.min(startMs + durationMs, nowMs)).toISOString(),
      );

      const totalTokens = sessionInput + sessionOutput;
      const costUsd = (totalTokens / 1_000_000) * profile.costPerMTokens * (0.8 + Math.random() * 0.4);
      usageHistory.recordSessionUsage({
        sessionRecordId: sessionId,
        sessionStartedAt: new Date(startMs).toISOString(),
        sessionType: 'main',
        totalCostUsd: Math.round(costUsd * 10_000) / 10_000,
        // Snapshot-style tokens: the last context window, not the cumulative sum.
        totalInputTokens: Math.floor(sessionInput / Math.max(1, turnsThisSession / 3)),
        totalOutputTokens: Math.floor(sessionOutput / Math.max(1, turnsThisSession / 3)),
        totalDurationMs: durationMs,
        toolCallCount: Math.floor(turnsThisSession * (1 + Math.random() * 2)),
        modelId: profile.modelId,
        modelDisplayName: profile.modelDisplayName,
        compactionCount: Math.random() < 0.15 ? 1 : 0,
        agent: profile.agent,
        effort: pickEffort(profile),
      });
      usageHistory.updateGitStats(sessionId, {
        linesAdded: Math.floor(Math.random() * 400),
        linesRemoved: Math.floor(Math.random() * 120),
        filesChanged: Math.floor(Math.random() * 20),
      });
    }
  }

  return { sessions: sessionCount, turns: turnCount };
}

/**
 * Seed `days` of synthetic usage into EVERY registered project (the preview
 * always has Project 1 + Project 2, plus any added via "Create Project"), at
 * a descending volume per project - so "This Project" vs the other project
 * shows a real difference and the All Projects rollup / per-project table has
 * something to reconcile. Throws when no project is registered.
 */
export function seedUsageData(context: IpcContext, days: number): DevSeedUsageDataResult {
  const projects = context.projectRepo.list();
  if (projects.length === 0) throw new Error('No registered projects to seed usage data into');

  seedRunIndex += 1;
  const runIndex = seedRunIndex;
  const nowMs = Date.now();

  let sessionCount = 0;
  let turnCount = 0;
  projects.forEach((project, projectIndex) => {
    // First project gets full volume, each subsequent one roughly half the
    // previous (floored), so per-project numbers are clearly distinct.
    const volumeScale = 1 / Math.pow(2, projectIndex);
    const seeded = seedOneProject(project.id, days, runIndex, Math.max(volumeScale, 0.2), nowMs);
    sessionCount += seeded.sessions;
    turnCount += seeded.turns;
  });

  return { sessions: sessionCount, turns: turnCount, days, projects: projects.length };
}

let devIpcRegistered = false;

/** Register the dev-only IPC behind the TestHarness "Seed Usage Data" button.
 *  Idempotent. */
export function registerSeedUsageDataDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_SEED_USAGE_DATA, (_event, days: number): DevSeedUsageDataResult => {
    const context = getContext();
    if (!context) throw new Error('IPC not initialized');
    return seedUsageData(context, days);
  });
}
