#!/usr/bin/env node
/**
 * Computes the /code-review verdict from the findings JSON the review driver writes, so the
 * label is a function of the findings and never of how a report happens to be worded.
 *
 * Why a script: across 42 recent passes the old prose rule ("Needs revision" whenever anything
 * was skipped) gave the same state different labels (one Low skip said Needs revision, eight
 * and twelve skips said Clean), and every Needs revision sent the card back to Executing on
 * skips alone. See docs/audits/code-review-fanout-audit.md section 15.
 *
 * Usage: node scripts/review-verdict.mjs <findings.json> [--ledger]
 *        node scripts/review-verdict.mjs --no-changes [base-ref]
 *   default   prints the Summary block, the Decisions made list, and the closing verdict block.
 *             The skill pastes that output verbatim and makes the closing block the LAST thing in
 *             the pass's final message, so a person and an agent read the same signal: the line
 *             `Verdict: Ready`, or one numbered step per blocker followed by `Verdict: Blocked`.
 *             The verdict is the block's LAST line either way, so the board's Code Review rows
 *             route on it with a Text match (an exact final line, checked in code) rather than
 *             asking an agent to find it.
 *             The old prose verdicts above included a "Clean"; the new one is "Ready" so it
 *             cannot be read as the report's "no uncommitted files" line.
 *   --ledger  prints only the `Refuted:` and `Decisions:` lines for the review commit body. A later
 *             pass reads them back with `git log --grep="(review)" --format=%B <base>..HEAD`. Keyed
 *             by file, symbol and mechanism, never by line number, because line numbers drift
 *             between passes.
 *   --no-changes  prints the whole final message of a pass that found nothing to review (the diff
 *             from the base through the working tree is empty): "No changes to review.", then a
 *             closing block with one step and `Verdict: Blocked`. Blocked, not a third verdict: on
 *             the board an empty diff is a task whose Executing step committed nothing, and the bare
 *             line used to match neither Code Review row, so the workflow moved task 916 on to
 *             Testing unreviewed. The step sends it back to do its work.
 *
 * Exit 0 for both verdicts (each is a valid outcome). Exit 2 for a usage error or an invalid
 * findings file, with every problem listed on stderr.
 *
 * Findings file shape:
 *   {
 *     "checks": { "typecheck": "pass|fail", "hmrVitest": "pass|fail", "scopedTests": "pass|fail|none" },
 *     "findings": [{
 *       "id": 1, "severity": "critical|high|medium|low", "category": "Correctness",
 *       "location": "src/a.ts:42", "file": "src/a.ts", "symbol": "parseFoo" (optional),
 *       "mechanism": "short phrase naming the defect", "status": "fixed|refuted|blocked",
 *       "reason": "required for refuted and blocked",
 *       "step": "required for a blocked finding: what the task agent must do in this task",
 *       "decision": { "chosen": "...", "alternative": "..." } (optional, fixed and not quick only),
 *       "quick": true (optional; a quick fix never affects the verdict and carries no decision),
 *       "reRaise": { "of": "the ledger line", "newEvidence": "..." } (optional)
 *     }]
 *   }
 *
 * There is no followUps or followUpTask key, and the script refuses both. An item outside the diff
 * is fixed in the pass or recorded as a blocked finding whose step reaches the task agent, because
 * a pass files no board task (docs/audits/code-review-fanout-audit.md section 17).
 */
import fs from 'node:fs';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const STATUSES = ['fixed', 'refuted', 'blocked'];

const CHECKS = [
  {
    key: 'typecheck',
    label: 'Typecheck',
    allowed: ['pass', 'fail'],
    step: 'run `npm run typecheck` and fix the errors it reports',
  },
  {
    key: 'hmrVitest',
    label: 'HMR vitest',
    allowed: ['pass', 'fail'],
    step: 'run `npx vitest run tests/unit/hmr-resync.test.ts` and fix the failing assertion',
  },
  {
    key: 'scopedTests',
    label: 'Scoped runs of added tests',
    allowed: ['pass', 'fail', 'none'],
    step: 'run each test file this pass added, scoped to that file, and fix the failures',
  },
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// One line each: a field carried into the ledger or the closing block must not break the
// one-item-per-line shape a later pass and an agent both parse.
function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Returns every problem in the findings file, or an empty array when it is valid. */
export function validateFindings(report) {
  const problems = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return ['the findings file must hold a JSON object'];
  }
  const checks = report.checks;
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)) {
    problems.push('checks must be an object with typecheck, hmrVitest and scopedTests');
  } else {
    for (const check of CHECKS) {
      if (!check.allowed.includes(checks[check.key])) {
        problems.push(`checks.${check.key} must be one of ${check.allowed.join(', ')}`);
      }
    }
  }
  if (!Array.isArray(report.findings)) {
    problems.push('findings must be an array (empty when nothing was raised)');
  } else {
    report.findings.forEach((finding, findingIndex) => {
      const label = `findings[${findingIndex}]`;
      if (finding === null || typeof finding !== 'object') {
        problems.push(`${label} must be an object`);
        return;
      }
      if (finding.id === undefined) problems.push(`${label}.id is required`);
      if (!SEVERITIES.includes(String(finding.severity).toLowerCase())) {
        problems.push(`${label}.severity must be one of ${SEVERITIES.join(', ')}`);
      }
      for (const field of ['category', 'location', 'file', 'mechanism']) {
        if (!isNonEmptyString(finding[field])) problems.push(`${label}.${field} is required`);
      }
      if (!STATUSES.includes(finding.status)) {
        // Named on purpose: "skipped" is the status this script exists to retire.
        problems.push(`${label}.status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(finding.status)})`);
      }
      if ((finding.status === 'refuted' || finding.status === 'blocked') && !isNonEmptyString(finding.reason)) {
        problems.push(`${label}.reason is required for a ${finding.status} finding`);
      }
      if (finding.status === 'blocked' && finding.quick !== true && !isNonEmptyString(finding.step)) {
        problems.push(`${label}.step is required for a blocked finding: name what the task agent must do in this task`);
      }
      if (finding.decision !== undefined) {
        const decision = finding.decision;
        if (decision === null || typeof decision !== 'object' || !isNonEmptyString(decision.chosen) || !isNonEmptyString(decision.alternative)) {
          problems.push(`${label}.decision needs both chosen and alternative`);
        }
        if (finding.status !== 'fixed') problems.push(`${label}.decision is only valid on a fixed finding`);
        // A quick fix is mechanical by definition; one with a decision would also be counted
        // under "Decisions made" while the Fixed count leaves it out.
        if (finding.quick === true) problems.push(`${label}.decision is not valid on a quick finding: a choice between valid answers is not mechanical`);
      }
      if (finding.reRaise !== undefined) {
        const reRaise = finding.reRaise;
        if (reRaise === null || typeof reRaise !== 'object' || !isNonEmptyString(reRaise.of) || !isNonEmptyString(reRaise.newEvidence)) {
          problems.push(`${label}.reRaise needs both of and newEvidence`);
        }
      }
    });
  }
  // Refused even when empty, so a driver on stale instructions fails here instead of filing a task.
  // Each message says where the items go, so the fix is to convert them, never to delete the key.
  if (report.followUps !== undefined) {
    problems.push('followUps is retired: fix each out-of-diff item in this pass, or record it as a blocked finding with a step for the task agent');
  }
  if (report.followUpTask !== undefined) {
    problems.push('followUpTask is retired: a review pass files no board task; record the item as a blocked finding with a step for the task agent');
  }
  return problems;
}

function ledgerKey(finding) {
  const symbol = isNonEmptyString(finding.symbol) ? ` ${oneLine(finding.symbol)}` : '';
  return `${oneLine(finding.file)}${symbol}: ${oneLine(finding.mechanism)}`;
}

/** Ready unless a non-quick finding is blocked or a check failed. Assumes a validated report. */
export function computeVerdict(report) {
  const blockers = [];
  for (const finding of report.findings) {
    if (finding.status === 'blocked' && finding.quick !== true) {
      blockers.push({ location: oneLine(finding.location), step: oneLine(finding.step) });
    }
  }
  for (const check of CHECKS) {
    if (report.checks[check.key] === 'fail') blockers.push({ location: check.label, step: check.step });
  }
  return { verdict: blockers.length === 0 ? 'Ready' : 'Blocked', blockers };
}

/** The Summary block, the Decisions made list, then the closing verdict block. */
export function renderSummary(report) {
  const findings = report.findings;
  const countBySeverity = (severity) =>
    findings.filter((finding) => String(finding.severity).toLowerCase() === severity).length;
  const countByStatus = (status) => findings.filter((finding) => finding.status === status && finding.quick !== true).length;
  const decisions = findings.filter((finding) => finding.status === 'fixed' && finding.decision !== undefined);
  const quickFixes = findings.filter((finding) => finding.quick === true);
  const reRaises = findings.filter((finding) => finding.reRaise !== undefined);

  const lines = ['### Summary', ''];
  lines.push(`- Findings: ${SEVERITIES.map((severity) => `${countBySeverity(severity)} ${severity}`).join(', ')}`);
  lines.push(
    `- Fixed: ${countByStatus('fixed')} (${decisions.length} by decision). Refuted: ${countByStatus('refuted')}. ` +
      `Blocked: ${countByStatus('blocked')}.`,
  );
  lines.push(`- Quick fixes: ${quickFixes.length}`);
  lines.push(`- Re-raised with new evidence: ${reRaises.length}`);
  lines.push(
    `- Checks: ${CHECKS.map((check) => `${check.label.toLowerCase()} ${report.checks[check.key]}`).join(', ')}`,
  );
  lines.push('');
  lines.push(`### Decisions made (${decisions.length})`);
  lines.push('');
  if (decisions.length === 0) {
    lines.push('None.');
  } else {
    decisions.forEach((finding, decisionIndex) => {
      lines.push(
        `${decisionIndex + 1}. ${oneLine(finding.location)}: chose ${oneLine(finding.decision.chosen)}. ` +
          `The alternative was ${oneLine(finding.decision.alternative)}.`,
      );
    });
  }
  lines.push('');
  lines.push(renderClosingBlock(report));
  return lines.join('\n');
}

/**
 * The last block of the pass's final message: any blocking steps, then the verdict. The verdict
 * comes last so it is the message's final line, which is what the board's Text match rows read.
 */
export function renderClosingBlock(report) {
  const { verdict, blockers } = computeVerdict(report);
  const lines = blockers.map((blocker, blockerIndex) => `${blockerIndex + 1}. ${blocker.location}: ${blocker.step}`);
  lines.push(`Verdict: ${verdict}`);
  return lines.join('\n');
}

/**
 * The final message of a pass with nothing to review (`--no-changes`): the closing block in its
 * usual shape, one step above `Verdict: Blocked`. With no base, as when none resolved, the step
 * names the working tree alone.
 */
export function renderNoChanges(base) {
  const step = isNonEmptyString(base)
    ? `${oneLine(base)}: the branch and its working tree match ${oneLine(base)}, so there was nothing to review. Do this task's work, then commit it.`
    : 'Working tree: there are no changes to review. Do this task\'s work, then commit it.';
  return ['No changes to review.', '', `1. ${step}`, 'Verdict: Blocked'].join('\n');
}

/** `Refuted:` and `Decisions:` lines for the review commit body, one per item. */
export function renderLedger(report) {
  const lines = [];
  for (const finding of report.findings) {
    if (finding.status === 'refuted') lines.push(`Refuted: ${ledgerKey(finding)} - ${oneLine(finding.reason)}`);
  }
  for (const finding of report.findings) {
    if (finding.status === 'fixed' && finding.decision !== undefined) {
      lines.push(
        `Decisions: ${ledgerKey(finding)} - chose ${oneLine(finding.decision.chosen)} over ${oneLine(finding.decision.alternative)}`,
      );
    }
  }
  return lines.join('\n');
}

const USAGE = 'usage: node scripts/review-verdict.mjs <findings.json> [--ledger] | --no-changes [base-ref]';

function main(argv) {
  if (argv.includes('--no-changes')) {
    const rest = argv.filter((argument) => argument !== '--no-changes');
    // No ref starts with `-`, so one that does is a flag this mode does not take.
    if (rest.length > 1 || rest.some((argument) => argument.startsWith('-'))) {
      console.error(USAGE);
      return 2;
    }
    console.log(renderNoChanges(rest[0] ?? ''));
    return 0;
  }
  const ledgerOnly = argv.includes('--ledger');
  const positional = argv.filter((argument) => argument !== '--ledger');
  if (positional.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
  } catch (error) {
    console.error(`could not read ${positional[0]} as JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const problems = validateFindings(report);
  if (problems.length > 0) {
    console.error(`invalid findings file (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const problem of problems) console.error(`- ${problem}`);
    return 2;
  }
  console.log(ledgerOnly ? renderLedger(report) : renderSummary(report));
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
