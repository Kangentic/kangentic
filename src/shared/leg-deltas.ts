/**
 * Each session record's own share of its conversation's cost and runtime.
 *
 * An agent reports cost and duration as CUMULATIVE readings for the whole
 * conversation, and a `--resume` is a new session record, so a record's raw
 * reading includes every earlier leg. A leg's share is its own reading minus
 * the highest reading of a PRIOR leg of the same conversation, clamped at 0
 * (a CLI that reset its counter contributes nothing rather than a negative).
 * This is the rule `LINEAGE_DELTA_SET_SQL` applies to `usage_history`
 * (`src/main/db/repositories/usage-history-repository.ts`), kept in one pure
 * function for the readers that start from `sessions` rows, so the per-leg
 * figures always add up to the conversation's final reading.
 *
 * "Prior" is by start time with the record id breaking a tie. A record with no
 * lineage IS its own conversation, so its reading is its share. A record with
 * no cost reading (a run that never reported usage) has no share of cost or
 * runtime and is never a baseline for a later leg. An agent that reports usage
 * reports a cost, zero when it has none, so these are the records the task
 * summary's roll-up skips too (`SessionRepository.getSummaryForTask`), and the
 * shares add up to its totals.
 */

export interface LegReading {
  recordId: string;
  /** The conversation the record belongs to; null when it has none. */
  lineageId: string | null;
  /** UTC ISO 8601. */
  startedAt: string;
  /** The agent's cumulative reading at this record's end; null when none was reported. */
  cumulativeCostUsd: number | null;
  cumulativeDurationMs: number | null;
}

export interface LegShare {
  /** Null when the record reported no cost. */
  costUsd: number | null;
  /** Null when the record reported no duration. */
  durationMs: number | null;
}

function hasReading(leg: LegReading): boolean {
  return leg.cumulativeCostUsd !== null;
}

function isPrior(candidate: LegReading, reading: LegReading): boolean {
  if (candidate.startedAt !== reading.startedAt) return candidate.startedAt < reading.startedAt;
  return candidate.recordId < reading.recordId;
}

function share(
  reading: LegReading,
  priors: LegReading[],
  pick: (leg: LegReading) => number | null,
): number | null {
  const own = pick(reading);
  if (own === null) return null;
  let baseline = 0;
  for (const prior of priors) {
    const value = pick(prior);
    if (value !== null && value > baseline) baseline = value;
  }
  return Math.max(0, own - baseline);
}

/** Every record's share, keyed by record id. */
export function legDeltas(readings: ReadonlyArray<LegReading>): Map<string, LegShare> {
  const shares = new Map<string, LegShare>();
  for (const reading of readings) {
    if (!hasReading(reading)) {
      shares.set(reading.recordId, { costUsd: null, durationMs: null });
      continue;
    }
    const priors = reading.lineageId === null
      ? []
      : readings.filter((candidate) => candidate.lineageId === reading.lineageId && hasReading(candidate) && isPrior(candidate, reading));
    shares.set(reading.recordId, {
      costUsd: share(reading, priors, (leg) => leg.cumulativeCostUsd),
      durationMs: share(reading, priors, (leg) => leg.cumulativeDurationMs),
    });
  }
  return shares;
}
