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

/** E1 allows an arm within this many hits of the best arm's recall: with 8 late defects over two
 *  repetitions, a one-hit gap is noise. */
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

/*
 * E5 and E6: which model a finder or a gated auditor runs on. Written and tested on 2026-10-07,
 * before any E5 or E6 run, when Claude Haiku 5.5 shipped at about a twentieth of Sonnet 5.5's
 * price per token. Results are in docs/code-review-fanout-audit.md section 16.
 */

/**
 * E2 arm A (Sonnet 5.5 at medium, today's prompts, the correctness lane in 1500-line shards) over
 * S2 to S4, two repetitions, as the blind scorer counted it in section 15.4:
 *   late hits per repetition: 1 (S3-L2) and 2 (S3-L2, S2-L2), mean 1.5
 *   S4 positives: P1, P2 and P3 in both repetitions
 *   negatives raised: S2-N1 and S2-N2, distinct across both repetitions, so 2
 *   raised: S4 19 + 23, S2 21 + 16, S3 18 + 20 = 117
 */
export const E2_ARM_A = Object.freeze({ lateHits: 1.5, negativesRaised: 2, totalRaised: 117 });

/** E5 lets a candidate trail the baseline's late-defect recall by at most this many hits. */
export const E5_RECALL_TOLERANCE_HITS = 1;
/** The S4 positives a candidate must raise in every repetition. */
export const E5_REQUIRED_POSITIVES = Object.freeze(['S4-P1', 'S4-P2', 'S4-P3']);
export const E5_REPETITIONS = 2;
/** Lower effort first: on an exact cost tie between passing arms, the lower effort wins. */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * E5: whether one candidate finder model passes every bar against the baseline. All four must hold.
 * The one-hit recall tolerance alone admitted every E1 arm and would pick the cheapest on price, so
 * the other three bars hold the work the candidate hands the driver: the S4 positives the
 * maintainability and coverage finders found in every arm A run, no more refuted negatives than
 * arm A, and no more raised findings than arm A (the Opus driver verifies every one, and cost.mjs
 * never sees the driver).
 * @param {{ lateHits: number, negativesRaised: number, totalRaised: number }} baseline
 * @param {{ name: string, lateHitsByRep: number[], s4PositivesByRep: string[][], negativesRaised: string[], totalRaised: number }} arm
 *   lateHitsByRep: distinct late hits across S2 to S4, one count per repetition;
 *   s4PositivesByRep: the S4 positive ids raised, one list per repetition;
 *   negativesRaised: the negative ids raised, across every state and repetition;
 *   totalRaised: the scorer's raised count summed over every state and repetition.
 */
export function adoptFinderModel(baseline, arm) {
  for (const field of ['lateHitsByRep', 's4PositivesByRep', 'negativesRaised']) {
    if (!Array.isArray(arm[field])) throw new Error(`adoptFinderModel: arm ${arm.name} has no ${field} list`);
  }
  if (typeof arm.totalRaised !== 'number') throw new Error(`adoptFinderModel: arm ${arm.name} has no totalRaised`);
  for (const field of ['lateHits', 'negativesRaised', 'totalRaised']) {
    if (typeof baseline[field] !== 'number') throw new Error(`adoptFinderModel: baseline has no ${field}`);
  }
  if (arm.lateHitsByRep.length !== E5_REPETITIONS || arm.s4PositivesByRep.length !== E5_REPETITIONS) {
    throw new Error(`adoptFinderModel: arm ${arm.name} needs exactly ${E5_REPETITIONS} repetitions`);
  }
  const lateHits = arm.lateHitsByRep.reduce((sum, hits) => sum + hits, 0) / E5_REPETITIONS;
  const negatives = new Set(arm.negativesRaised).size;
  const recallHeld = lateHits >= baseline.lateHits - E5_RECALL_TOLERANCE_HITS;
  const positivesHeld = arm.s4PositivesByRep.every((raised) => E5_REQUIRED_POSITIVES.every((id) => raised.includes(id)));
  const negativesHeld = negatives <= baseline.negativesRaised;
  const volumeHeld = arm.totalRaised <= baseline.totalRaised;
  return {
    adopt: recallHeld && positivesHeld && negativesHeld && volumeHeld,
    lateHits,
    recallHeld,
    positivesHeld,
    negatives,
    negativesHeld,
    totalRaised: arm.totalRaised,
    volumeHeld,
  };
}

/**
 * E5: of the candidate arms that pass adoptFinderModel, the cheapest. An exact cost tie goes to the
 * lower effort. `chosen` is null when none passes, which keeps the incumbent model.
 * @param {{ lateHits: number, negativesRaised: number, totalRaised: number }} baseline
 * @param {Array<Parameters<typeof adoptFinderModel>[1] & { effort: string, costUsd: number }>} arms
 */
export function pickFinderModel(baseline, arms) {
  if (arms.length === 0) throw new Error('pickFinderModel needs at least one arm');
  for (const arm of arms) {
    if (!EFFORT_ORDER.includes(arm.effort)) throw new Error(`pickFinderModel: arm ${arm.name} has unknown effort ${arm.effort}`);
    if (typeof arm.costUsd !== 'number') throw new Error(`pickFinderModel: arm ${arm.name} has no costUsd`);
  }
  const verdicts = Object.fromEntries(arms.map((arm) => [arm.name, adoptFinderModel(baseline, arm)]));
  const passing = arms
    .filter((arm) => verdicts[arm.name].adopt)
    .sort((left, right) => left.costUsd - right.costUsd || EFFORT_ORDER.indexOf(left.effort) - EFFORT_ORDER.indexOf(right.effort));
  return { chosen: passing.length > 0 ? passing[0].name : null, passing: passing.map((arm) => arm.name), verdicts };
}

/** E6 runs each auditor this many times per model. */
export const E6_RUNS = 2;

/**
 * E6: adopt the candidate model for a gated auditor (doc-auditor, ipc-auditor) only when it found
 * both planted gaps (the missing item and the extra one) in every one of its runs, and raised no
 * more false findings in total than the incumbent. A false finding is a reported gap the planted
 * tree does not have, checked by hand against that tree.
 * @param {Array<{ missingFound: boolean, extraFound: boolean, falseFindings: number }>} incumbentRuns
 * @param {Array<{ missingFound: boolean, extraFound: boolean, falseFindings: number }>} candidateRuns
 */
export function adoptAuditorModel(incumbentRuns, candidateRuns) {
  for (const [label, runs] of [['incumbent', incumbentRuns], ['candidate', candidateRuns]]) {
    if (runs.length !== E6_RUNS) throw new Error(`adoptAuditorModel: the ${label} needs exactly ${E6_RUNS} runs`);
    for (const run of runs) {
      if (typeof run.missingFound !== 'boolean' || typeof run.extraFound !== 'boolean' || typeof run.falseFindings !== 'number') {
        throw new Error(`adoptAuditorModel: every ${label} run needs missingFound, extraFound and falseFindings`);
      }
    }
  }
  const plantsFound = (runs) => runs.reduce((sum, run) => sum + Number(run.missingFound) + Number(run.extraFound), 0);
  const falseFindings = (runs) => runs.reduce((sum, run) => sum + run.falseFindings, 0);
  const candidateFound = plantsFound(candidateRuns);
  const allFound = candidateFound === E6_RUNS * 2;
  const falseHeld = falseFindings(candidateRuns) <= falseFindings(incumbentRuns);
  return {
    adopt: allFound && falseHeld,
    candidateFound,
    incumbentFound: plantsFound(incumbentRuns),
    of: E6_RUNS * 2,
    candidateFalse: falseFindings(candidateRuns),
    incumbentFalse: falseFindings(incumbentRuns),
  };
}
