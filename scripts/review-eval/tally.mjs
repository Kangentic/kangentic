/**
 * Joins a blind scorer's output with the anonymization key, the corpus and the run transcripts, and
 * prints per-arm results for one case: distinct late defects hit per repetition, positives hit,
 * negatives raised, total raised, and USD from cost.mjs. The numbers feed decide.mjs.
 *
 * Usage: node scripts/review-eval/tally.mjs <case id> <scores.json> <key.json> --prices <prices.json> [--transcript-dir <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tallyTranscript, costOfRequests } from './cost.mjs';
import { isEntrypoint } from '../lib/is-entrypoint.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per arm and repetition: which ground-truth ids were hit, and how many findings were raised. Takes
 * a state id only. A D case has one defect, counted caught or not by the E3 rule in README.md.
 */
export function tallyCase(caseId, scores, key, corpus) {
  const state = corpus.states.find((entry) => entry.id === caseId);
  // An unknown id would tally every arm at zero recall and still feed decide.mjs.
  if (!state) throw new Error(`no state ${caseId} in corpus.json; tally.mjs scores states only, not D cases`);
  const classOf = new Map(state.groundTruth.map((entry) => [entry.id, entry.class]));
  const byArmRep = new Map();
  for (const run of key) {
    const scored = scores.reports[run.anonymousId];
    if (!scored) throw new Error(`no score for report ${run.anonymousId}`);
    const slot = `${run.arm}|${run.rep}`;
    if (!byArmRep.has(slot)) byArmRep.set(slot, { arm: run.arm, rep: run.rep, hits: new Set(), raised: 0, runs: [] });
    const bucket = byArmRep.get(slot);
    bucket.raised += scored.raised;
    bucket.runs.push(run);
    for (const finding of scored.findings || []) if (finding.match) bucket.hits.add(finding.match);
  }
  const rows = [...byArmRep.values()].map((bucket) => {
    const hits = [...bucket.hits];
    return {
      arm: bucket.arm,
      rep: bucket.rep,
      late: hits.filter((id) => classOf.get(id) === 'late').sort(),
      positive: hits.filter((id) => classOf.get(id) === 'positive').sort(),
      negative: hits.filter((id) => classOf.get(id) === 'negative').sort(),
      raised: bucket.raised,
      runs: bucket.runs,
    };
  });
  return rows.sort((left, right) => left.arm.localeCompare(right.arm) || left.rep - right.rep);
}

function main(argv) {
  const pricesIndex = argv.indexOf('--prices');
  const transcriptIndex = argv.indexOf('--transcript-dir');
  const flagPositions = new Set();
  for (const flagIndex of [pricesIndex, transcriptIndex]) {
    if (flagIndex !== -1) {
      flagPositions.add(flagIndex);
      flagPositions.add(flagIndex + 1);
    }
  }
  const positional = argv.filter((_, index) => !flagPositions.has(index));
  if (positional.length !== 3 || pricesIndex === -1) {
    console.error('usage: node scripts/review-eval/tally.mjs <case id> <scores.json> <key.json> --prices <prices.json> [--transcript-dir <dir>]');
    return 2;
  }
  const [caseId, scoresPath, keyPath] = positional;
  const scores = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(scriptDirectory, 'corpus.json'), 'utf8'));
  const prices = JSON.parse(fs.readFileSync(argv[pricesIndex + 1], 'utf8'));
  const rows = tallyCase(caseId, scores, key, corpus).map((row) => {
    let usd = 0;
    let advisorCalls = 0;
    let requestsAboveTier = 0;
    const models = new Set();
    for (const run of row.runs) {
      const transcriptPath = transcriptIndex === -1 ? run.transcript : path.join(argv[transcriptIndex + 1], `agent-${run.agentId}.jsonl`);
      const tally = tallyTranscript(fs.readFileSync(transcriptPath, 'utf8'));
      const cost = costOfRequests(tally.requests, prices);
      usd += cost.usd;
      advisorCalls += tally.advisorCalls;
      for (const counts of Object.values(cost.aboveTier)) requestsAboveTier += counts.above;
      for (const model of Object.keys(tally.tokensByModel)) models.add(model);
    }
    const { runs, ...rest } = row;
    // The models every run of the row answered from, so an arm whose override did not take shows.
    return { ...rest, finders: runs.length, usd: Math.round(usd * 100) / 100, advisorCalls, requestsAboveTier, models: [...models].sort() };
  });
  console.log(JSON.stringify({ case: caseId, rows }, null, 2));
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
