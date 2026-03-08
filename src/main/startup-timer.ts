import { app } from 'electron';

interface PhaseEntry {
  label: string;
  startTime: number;
}

const marks: Array<{ label: string; elapsed: number }> = [];
const phases = new Map<string, PhaseEntry>();
let processStartTime = 0;

/** Initialize the timer with the process start timestamp. */
export function initStartupTimer(startTime: number): void {
  processStartTime = startTime;
}

/** Record an instant mark relative to process start. */
export function mark(label: string): void {
  if (app.isPackaged) return;
  marks.push({ label, elapsed: performance.now() - processStartTime });
}

/** Start a named phase interval. */
export function phase(label: string): void {
  if (app.isPackaged) return;
  phases.set(label, { label, startTime: performance.now() });
}

/** End a named phase interval, recording it as a mark with duration. */
export function endPhase(label: string): void {
  if (app.isPackaged) return;
  const entry = phases.get(label);
  if (!entry) return;
  phases.delete(label);
  const duration = performance.now() - entry.startTime;
  marks.push({ label: `${label} (${duration.toFixed(0)}ms)`, elapsed: performance.now() - processStartTime });
}

/** Log a formatted summary table of all marks. */
export function finishStartupTimer(): void {
  if (app.isPackaged) return;
  if (marks.length === 0) return;

  const lines = ['\n[startup] Timeline:'];
  lines.push(`  ${'Mark'.padEnd(45)} ${'Elapsed'.padStart(8)}`);
  lines.push('  ' + '-'.repeat(55));
  for (const { label, elapsed } of marks) {
    lines.push(`  ${label.padEnd(45)} ${(Math.round(elapsed) + 'ms').padStart(8)}`);
  }
  console.log(lines.join('\n') + '\n');

  // Reset so a second createWindow() (macOS activate) doesn't accumulate stale marks
  marks.length = 0;
  phases.clear();
}
