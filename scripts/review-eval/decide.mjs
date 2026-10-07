/**
 * The pre-registered decision rules for the /code-review Phase 0 experiments, as code, so the
 * thresholds are fixed before any run and cannot drift toward a result after it. Written and
 * tested on 2026-10-06, before E1 started. See scripts/review-eval/README.md for the corpus and
 * docs/code-review-fanout-audit.md section 15 for the results.
 *
 * Recall is counted in late-defect hits: for one repetition, the number of distinct ground-truth
 * `late` defects the arm raised across every state in the experiment, as the blind scorer matched
 * them. An arm's `lateHits` is the mean of that count over its repetitions.
 */

/** E1 allows an arm within this many hits of the best arm's recall: with about ten late defects
 *  over two repetitions, a one-hit gap is noise. */
export const E1_RECALL_TOLERANCE_HITS = 1;

/** E2 adopts the precision bar only if it cuts total raised findings by at least this share. */
export const E2_MIN_VOLUME_CUT = 0.3;

/** E3 adopts delta verify only if it catches at least this many of the counted delta cases. */
export const E3_MIN_CAUGHT = 3;
/** The delta cases E3 counts. D5 (task 761) is a reported control, not one of them. */
export const E3_COUNTED_CASES = ['D1', 'D2', 'D3', 'D4'];
export const E3_CASES = E3_COUNTED_CASES.length;

/**
 * E1: the cheapest arm within E1_RECALL_TOLERANCE_HITS of the best recall. B wins a tie with C:
 * when the cheapest eligible arm is C and B is eligible with recall at least C's, B is chosen.
 * @param {Array<{ name: string, lateHits: number, costUsd: number }>} arms
 * @returns {{ chosen: string, eligible: string[], bestHits: number }}
 */
export function pickCorrectnessArm(arms) {
  if (arms.length === 0) throw new Error('pickCorrectnessArm needs at least one arm');
  const bestHits = Math.max(...arms.map((arm) => arm.lateHits));
  const eligible = arms
    .filter((arm) => arm.lateHits >= bestHits - E1_RECALL_TOLERANCE_HITS)
    .sort((left, right) => left.costUsd - right.costUsd || left.name.localeCompare(right.name));
  let chosen = eligible[0];
  if (chosen.name === 'C') {
    const armB = eligible.find((arm) => arm.name === 'B');
    if (armB && armB.lateHits >= chosen.lateHits) chosen = armB;
  }
  return { chosen: chosen.name, eligible: eligible.map((arm) => arm.name), bestHits };
}

/**
 * E2: adopt arm B (the precision bar) when its recall does not drop below arm A's and its total
 * raised count falls by at least E2_MIN_VOLUME_CUT.
 * @param {{ lateHits: number, totalRaised: number }} armA today's prompts
 * @param {{ lateHits: number, totalRaised: number }} armB the precision bar
 */
export function adoptPrecisionBar(armA, armB) {
  const volumeCut = armA.totalRaised === 0 ? 0 : (armA.totalRaised - armB.totalRaised) / armA.totalRaised;
  const recallHeld = armB.lateHits >= armA.lateHits;
  // Rounded to the cent of a percent so a 30.000000004% float lands on the right side.
  const volumeCutRounded = Math.round(volumeCut * 10000) / 10000;
  return { adopt: recallHeld && volumeCutRounded >= E2_MIN_VOLUME_CUT, recallHeld, volumeCut: volumeCutRounded };
}

/**
 * E3: adopt delta verify when it catches at least E3_MIN_CAUGHT of the E3_COUNTED_CASES.
 * @param {Record<string, boolean>} caughtByCase keyed by every id in E3_COUNTED_CASES
 */
export function adoptDeltaVerify(caughtByCase) {
  for (const caseId of E3_COUNTED_CASES) {
    if (typeof caughtByCase[caseId] !== 'boolean') throw new Error(`adoptDeltaVerify needs a result for ${caseId}`);
  }
  const caught = E3_COUNTED_CASES.filter((caseId) => caughtByCase[caseId]).length;
  return { adopt: caught >= E3_MIN_CAUGHT, caught, of: E3_CASES };
}
