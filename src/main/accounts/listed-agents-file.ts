import fs from 'node:fs';
import path from 'node:path';
import type { ListedAgent } from '../../shared/agent-accounts';
import { safeWriteJson } from '../safe-write';

/**
 * The agents the last checked accounts list held, saved between launches (task #1202), so the
 * Accounts tab's first answer after a restart needs no CLI check. One file in Kangentic's config
 * folder, shaped `{ agents: ListedAgent[] }`.
 */
const LISTED_AGENTS_FILE = 'accounts-listed.json';

export function listedAgentsPath(configDir: string): string {
  return path.join(configDir, LISTED_AGENTS_FILE);
}

/** The saved listed agents, or null when the file is missing or not in the shape this release writes. */
export function readListedAgentsFile(filePath: string): ListedAgent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // report-ok: a missing file is the first launch, and an unreadable one is rewritten by the next check.
    return null;
  }
  const agents = (parsed as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return null;
  return agents.flatMap((entry: unknown): ListedAgent[] => {
    const { agent, unsupportedTarget } = (entry ?? {}) as { agent?: unknown; unsupportedTarget?: unknown };
    return typeof agent === 'string' ? [{ agent, unsupportedTarget: unsupportedTarget === true }] : [];
  });
}

/** Saves the listed agents. False when the write failed, which `safeWriteJson` has already reported. */
export function writeListedAgentsFile(filePath: string, agents: readonly ListedAgent[]): boolean {
  return safeWriteJson(filePath, { agents }, 'accounts_listed');
}
