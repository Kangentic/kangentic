/**
 * E4: replays historical /code-review passes through scripts/review-verdict.mjs. Each pass's skipped
 * items were mapped by the pre-registered rule in README.md into verdict-replay.json; this turns each
 * pass into a findings report the real verdict function accepts, and counts the passes that said
 * Needs revision then and would end Ready now (a bounce avoided).
 *
 * Usage: node scripts/review-eval/run-verdict-replay.mjs [verdict-replay.json] [--macos-runnable]
 *   --macos-runnable  re-runs the count treating skips that were blocked only for needing a Mac as
 *                     runnable (through the CI macOS leg), the sensitivity reading the rule left open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFindings, computeVerdict, SEVERITIES } from '../review-verdict.mjs';

const MACOS_PATTERN = /\bmac(os)?\b|\bdarwin\b/i;

/** One historical pass as a findings report: every mapped item becomes a finding or a follow-up. */
export function reportForPass(pass, { macosRunnable = false } = {}) {
  const findings = [];
  const followUps = [];
  (pass.items || []).forEach((item, itemIndex) => {
    let mapped = item.mappedTo;
    if (mapped === 'blocked' && macosRunnable && MACOS_PATTERN.test(item.skipReason || '')) mapped = 'fixed';
    // Historical reports wrote severity loosely ("Low, coverage", "n/a"); severity never decides a
    // verdict, so an unrecognized one reads as low.
    const rawSeverity = String(item.severity || '').toLowerCase();
    const base = {
      id: itemIndex + 1,
      severity: SEVERITIES.find((name) => rawSeverity.includes(name)) || 'low',
      category: 'Replay',
      location: item.ref || `item ${itemIndex + 1}`,
      file: item.ref || `item ${itemIndex + 1}`,
      mechanism: item.skipReason || 'historical skip',
    };
    if (mapped === 'followUp') {
      followUps.push({ title: base.location, location: base.location, why: base.mechanism });
    } else if (mapped === 'blocked') {
      findings.push({ ...base, status: 'blocked', reason: item.skipReason || 'blocked', step: item.why || 'needs a person' });
    } else if (mapped === 'refuted') {
      findings.push({ ...base, status: 'refuted', reason: item.why || 'no change needed' });
    } else if (mapped === 'decision') {
      findings.push({ ...base, status: 'fixed', decision: { chosen: 'the recommended option', alternative: 'the other option' } });
    } else {
      findings.push({ ...base, status: 'fixed' });
    }
  });
  const failed = pass.checkFailed === true ? 'fail' : 'pass';
  return {
    checks: { typecheck: failed, hmrVitest: 'pass', scopedTests: 'pass' },
    findings,
    followUps,
    ...(followUps.length > 0 ? { followUpTask: 'replay' } : {}),
  };
}

export function replay(passes, options = {}) {
  const rows = passes.map((pass) => {
    const report = reportForPass(pass, options);
    const problems = validateFindings(report);
    if (problems.length > 0) throw new Error(`task ${pass.task} pass ${pass.pass ?? pass.session}: ${problems.join('; ')}`);
    const wasNeedsRevision = /needs revision/i.test(pass.oldVerdict || '');
    const verdict = computeVerdict(report).verdict;
    return { task: pass.task, pass: pass.pass ?? null, session: pass.session || '', level: pass.level, wasNeedsRevision, verdict };
  });
  const needsRevision = rows.filter((row) => row.wasNeedsRevision);
  return {
    passes: rows.length,
    oldNeedsRevision: needsRevision.length,
    bouncesAvoided: needsRevision.filter((row) => row.verdict === 'Ready').length,
    stillBlocked: needsRevision.filter((row) => row.verdict === 'Blocked').map((row) => `task ${row.task} ${row.pass ?? row.session}`),
    oldCleanNowBlocked: rows.filter((row) => !row.wasNeedsRevision && row.verdict === 'Blocked').length,
    byLevel: ['item', 'verdict-line'].map((level) => {
      const levelRows = needsRevision.filter((row) => row.level === level);
      return { level, oldNeedsRevision: levelRows.length, bouncesAvoided: levelRows.filter((row) => row.verdict === 'Ready').length };
    }),
  };
}

function isEntrypoint() {
  return process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
}

if (isEntrypoint()) {
  const argumentsList = process.argv.slice(2);
  const macosRunnable = argumentsList.includes('--macos-runnable');
  const inputPath = argumentsList.find((argument) => !argument.startsWith('--'))
    || path.join(path.dirname(fileURLToPath(import.meta.url)), 'verdict-replay.json');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  console.log(JSON.stringify(replay(input.passes, { macosRunnable }), null, 2));
}
