/**
 * Launches a person quit on, carried over to the next launch to report.
 *
 * Quitting a terminal that never started is how a person gives up, and it is the
 * one ending the exit listener never sees: `killAllSessions` detaches it. Nothing
 * sent from the quit path lands either (`synchronous-shutdown.md`, rule 3), so
 * this follows `run-uptime.ts`: one synchronous disk write on the way out, read
 * and reported by the next launch. A person who never opens the app again is not
 * reported, which is the cost of adding no wait to a quit.
 *
 * The file holds only the fixed values a report would have carried, so it needs
 * none of a report's care about commands, output or paths. Its values are read
 * back through a pattern anyway, since anything can edit a file on disk.
 */

import fs from 'node:fs';
import { atomicWriteJson } from '../config/board-config/atomic-write';
import { reportLaunchFailure, type LaunchTags } from './agent-launch-report';

/**
 * More than this came from a quit with many broken launches, and the first few say
 * it. Each one logs at the next launch, and the latch sends one event per agent.
 */
const MAX_RECORDED_LAUNCHES = 8;

const TAG_NAME = /^[a-z_]{1,32}$/;
const TAG_VALUE = /^[0-9A-Za-z._+<>-]{1,64}$/;

/**
 * Write the launches a quit is about to end. Synchronous, for the quit path. Its
 * caller is a `runCleanupStep`, so a throw here cannot skip the PTY kill.
 */
export function recordAbandonedLaunches(filePath: string, launches: readonly LaunchTags[]): void {
  if (launches.length === 0) return;
  atomicWriteJson(filePath, launches.slice(0, MAX_RECORDED_LAUNCHES));
}

function isSafeTags(value: unknown): value is LaunchTags {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([name, tag]) => TAG_NAME.test(name) && typeof tag === 'string' && TAG_VALUE.test(tag));
}

/**
 * Report what the last run recorded, then delete it. Deleted first, so a report
 * that throws cannot send the same launches on every start.
 */
export function reportAbandonedLaunches(filePath: string): void {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  fs.rmSync(filePath, { force: true });
  let launches: unknown;
  try {
    launches = JSON.parse(contents);
  } catch {
    return;
  }
  if (!Array.isArray(launches)) return;
  for (const tags of launches.slice(0, MAX_RECORDED_LAUNCHES)) {
    if (isSafeTags(tags)) reportLaunchFailure({ stage: 'abandoned', cause: 'unknown', tags });
  }
}
