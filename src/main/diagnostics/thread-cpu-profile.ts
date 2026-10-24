/**
 * Dev-only CPU profile of the calling thread, returned whole.
 *
 * Main has its own profilers (`src/devtools/main/stall-profiler.ts`), but the
 * pty host cannot import the dev tooling tree, and a busy host is otherwise a
 * black box: its labelled spans name only the work someone wrapped, and the
 * headless xterm parse of every session runs on xterm's own timer, outside
 * every label. The host answers a `devCpuProfile` request with this, and
 * main summarizes and saves the profile.
 *
 * The inspector is loaded on first use, so a production build, where the
 * caller's `__KANGENTIC_DEV__` branch is gone, never loads it.
 */

import type { Profiler } from 'node:inspector';

/** Microseconds between samples, as main's profilers use. */
const SAMPLING_INTERVAL_US = 1_000;
/** Longest capture, so a forgotten request cannot grow without bound. */
const MAX_CAPTURE_MS = 120_000;

export async function captureThreadCpuProfile(durationMs: number): Promise<Profiler.Profile> {
  if (!__KANGENTIC_DEV__) throw new Error('CPU profiles are dev-only');
  const boundedMs = Math.max(100, Math.min(MAX_CAPTURE_MS, Math.round(durationMs)));
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    await session.post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, boundedMs));
    const { profile } = await session.post('Profiler.stop');
    return profile;
  } finally {
    session.disconnect();
  }
}
