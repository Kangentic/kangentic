/**
 * Text match: the Condition kind checked in code against the last line of the
 * agent's final message (`src/shared/final-line-match.ts`).
 *
 * The endings below are the tails of real replies this board's agents wrote,
 * taken from the recorded cases the Condition eval replays (its `build` step
 * writes them), trimmed to the lines that matter
 * and stripped of task and PR numbers. Where a real reply never showed a shape
 * the matcher must forgive (bold, a closing period, a bullet), the case is that
 * same real ending with the mark added, and says so.
 */
import { describe, it, expect } from 'vitest';
import {
  TEXT_MATCH_NO_REPLY_REASON,
  TEXT_MATCH_PLACEHOLDER,
  TEXT_MATCH_WILDCARD_EXAMPLES,
  conditionKindsAsStored,
  finalMatchLine,
  lineMatchesPattern,
  matchFinalLine,
  normalizeForMatch,
  textMatchCanMatch,
} from '../../src/shared/final-line-match';
import { renderClosingBlock } from '../../scripts/review-verdict.mjs';

/** Executing: the agent's answer to Apply findings, ending on the line the column moves on. */
const EXECUTING_APPLIED = [
  '**Verification.**',
  '- The two Workflows specs, run three times each with no retries: 174 of 174 passed.',
  '- The heavy group where the flake first appeared, now including the gestures spec, with no retries: 134 of 134 passed.',
  '',
  "Nothing is committed and the task hasn't moved columns.",
  '',
  'Findings: applied',
].join('\n');

/** Executing: a reply that QUOTES the line mid-message and ends on a question. */
const EXECUTING_QUOTED_MID_MESSAGE = [
  '- **On to Code Review, not met:** "The reply does not end with \'Findings: applied\'..."',
  '- **Hovering the mark shows the agent\'s reason.** Hovering the name still shows the condition text.',
  '',
  'Want me to put this on the design canvas next to the current card for sign-off, then build it in this task\'s worktree?',
].join('\n');

/** Executing: work reported with no closing line at all. */
const EXECUTING_NO_LINE = [
  'Typecheck and lint are clean, 28 unit tests pass, and every UI spec that touches these two hooks passes.',
  '',
  "I checked all of this in the preview. Nothing is committed and the task hasn't moved columns.",
].join('\n');

/** Code Review: the report's tail, `scripts/review-verdict.mjs`'s closing block last. */
const CODE_REVIEW_READY = [
  '### Decisions made (2)',
  '',
  '1. src/shared/docs-links.ts:28: chose remove the unused contract and its pin. The alternative was keep the contract.',
  '2. README.md:23: chose keep the screenshot as the live-demo link. The alternative was drop the link.',
  '',
  'Verdict: Ready',
].join('\n');

/** Testing: the pull request skill's last line, alone. */
const TESTING_READY = [
  '- **Hero images:** the screenshots still show as missing in the PR view until the merge, because the README points at `main`.',
  '',
  'PR: ready to merge',
].join('\n');

/** Testing: a reply that names the line in a suggestion, then ends on something else. */
const TESTING_QUOTED_MID_MESSAGE = [
  '2. **Make the Conditions easier to answer**, for example "The last line of the agent\'s message is exactly `PR: ready to merge`".',
  '',
  "The PR's CI watch ended before I saw a final result, so I'm checking that next.",
].join('\n');

describe('matchFinalLine: the board rows on real endings', () => {
  it('Executing "On to Code Review" moves on a reply that ends "Findings: applied"', () => {
    expect(matchFinalLine('Findings: applied', EXECUTING_APPLIED)).toEqual({
      met: true,
      reason: 'The final line reads "Findings: applied".',
    });
  });

  it('a line quoted mid-message is not met, and the reason names the line actually read', () => {
    const match = matchFinalLine('Findings: applied', EXECUTING_QUOTED_MID_MESSAGE);
    expect(match.met).toBe(false);
    expect(match.reason).toContain('The final line reads "Want me to put this on the design canvas');
  });

  it('a reply with no closing line is not met', () => {
    expect(matchFinalLine('Findings: applied', EXECUTING_NO_LINE).met).toBe(false);
  });

  it('Code Review "On to Testing" moves on the closing block\'s verdict, and "Back for revisions" does not', () => {
    expect(matchFinalLine('Verdict: Ready', CODE_REVIEW_READY).met).toBe(true);
    expect(matchFinalLine('Verdict: Blocked', CODE_REVIEW_READY).met).toBe(false);
  });

  it('Testing "On to Merge" moves on "PR: ready to merge" and not on a reply that only names it', () => {
    expect(matchFinalLine('PR: ready to merge', TESTING_READY).met).toBe(true);
    expect(matchFinalLine('PR: ready to merge', TESTING_QUOTED_MID_MESSAGE).met).toBe(false);
  });

  it("review-verdict.mjs's real Blocked closing block ends on the verdict, so Back for revisions matches it", () => {
    const report = {
      checks: { typecheck: 'pass', hmrVitest: 'pass', scopedTests: 'none' },
      findings: [{
        id: 1,
        severity: 'medium',
        category: 'Correctness',
        location: 'src/main/cli-parser.ts:30',
        symbol: 'parseReply',
        mechanism: 'a reply shape no fixture covers',
        status: 'blocked',
        reason: 'needs a real CLI capture',
        step: 'capture a real reply into tests/fixtures/cli-reply.jsonl',
      }],
    };
    const reply = `### Decisions made (0)\n\nNone.\n\n${renderClosingBlock(report)}`;
    expect(matchFinalLine('Verdict: Blocked', reply).met).toBe(true);
    expect(matchFinalLine('Verdict: Ready', reply).met).toBe(false);
  });
});

describe('matchFinalLine: what it forgives', () => {
  // The same real ending, with the mark an agent sometimes adds.
  it.each([
    ['bold', 'Verdict: Ready', `${CODE_REVIEW_READY.replace('Verdict: Ready', '**Verdict: Ready**')}`],
    ['code marks', 'PR: ready to merge', TESTING_READY.replace('PR: ready to merge', '`PR: ready to merge`')],
    ['italics with underscores', 'Findings: applied', EXECUTING_APPLIED.replace('Findings: applied', '_Findings: applied_')],
    ['a closing period', 'Findings: applied', `${EXECUTING_APPLIED}.`],
    ['a list bullet', 'Findings: applied', EXECUTING_APPLIED.replace('Findings: applied', '- Findings: applied')],
    ['case', 'Findings: applied', EXECUTING_APPLIED.replace('Findings: applied', 'findings: APPLIED')],
    ['trailing spaces and blank lines', 'PR: ready to merge', `${TESTING_READY}   \n\n  \n`],
    ['Windows line endings', 'Verdict: Ready', CODE_REVIEW_READY.replace(/\n/g, '\r\n')],
    ['spaces inside the line', 'Verdict: Ready', CODE_REVIEW_READY.replace('Verdict: Ready', 'Verdict:   Ready')],
  ])('%s', (_shape, pattern, reply) => {
    expect(matchFinalLine(pattern, reply).met).toBe(true);
  });

  it('skips a closing line with no words in it (a code fence, a rule) and reads the one above', () => {
    expect(matchFinalLine('Findings: applied', `${EXECUTING_APPLIED}\n\`\`\``).met).toBe(true);
    expect(matchFinalLine('Findings: applied', `${EXECUTING_APPLIED}\n\n---\n`).met).toBe(true);
    expect(finalMatchLine(`${EXECUTING_APPLIED}\n**`)).toBe('Findings: applied');
  });

  it('still needs the whole line: a longer line is not met', () => {
    expect(matchFinalLine('Findings: applied', `${EXECUTING_APPLIED} (3 of 3)`).met).toBe(false);
    expect(matchFinalLine('Verdict: Ready', CODE_REVIEW_READY.replace('Verdict: Ready', 'Verdict: Ready for testing')).met).toBe(false);
  });
});

describe('matchFinalLine: wildcards', () => {
  it('* stands for any text and the pattern still covers the whole line', () => {
    expect(lineMatchesPattern('Verdict: *', 'Verdict: Blocked')).toBe(true);
    expect(lineMatchesPattern('Verdict: *', 'Verdict: Ready')).toBe(true);
    expect(lineMatchesPattern('Verdict: *', 'The verdict: Ready')).toBe(false);
    expect(lineMatchesPattern('PR: *', 'PR: ready to merge')).toBe(true);
    expect(lineMatchesPattern('* applied', 'Findings: applied')).toBe(true);
    expect(lineMatchesPattern('*ready*', 'PR: ready to merge')).toBe(true);
    expect(lineMatchesPattern('*', 'anything at all')).toBe(true);
  });

  it('keeps the space beside a wildcard, as a glob does', () => {
    expect(lineMatchesPattern('Ready for *', 'Ready for testing')).toBe(true);
    expect(lineMatchesPattern('Ready for *', 'Ready forever')).toBe(false);
    expect(lineMatchesPattern('* for review', 'for review')).toBe(false);
  });

  it('reads regex characters in a pattern as text', () => {
    expect(lineMatchesPattern('Done (all)', 'Done all')).toBe(true);
    expect(lineMatchesPattern('a.b', 'axb')).toBe(false);
  });

  it("every example in the field's tip matches its own sample and the placeholder", () => {
    expect(TEXT_MATCH_WILDCARD_EXAMPLES[0].pattern).toBe(TEXT_MATCH_PLACEHOLDER);
    for (const example of TEXT_MATCH_WILDCARD_EXAMPLES) {
      expect(lineMatchesPattern(example.pattern, TEXT_MATCH_PLACEHOLDER)).toBe(true);
      if (example.sample !== null) expect(lineMatchesPattern(example.pattern, example.sample)).toBe(true);
    }
  });
});

describe('matchFinalLine: nothing to read', () => {
  it.each([
    ['a null reply', null],
    ['an empty reply', ''],
    ['a reply of only blank and punctuation lines', '\n  \n```\n---\n'],
  ])('%s is not met, with the no-reply reason', (_shape, reply) => {
    expect(matchFinalLine('Findings: applied', reply)).toEqual({ met: false, reason: TEXT_MATCH_NO_REPLY_REASON });
  });

  it('clips a very long final line in the reason', () => {
    const longLine = 'x'.repeat(300);
    const match = matchFinalLine('Findings: applied', longLine);
    expect(match.reason).toBe(`The final line reads "${'x'.repeat(120)}...".`);
  });

  it('normalizes case, punctuation and spaces', () => {
    expect(normalizeForMatch('  **Verdict:  Ready.**  ')).toBe('verdict ready');
  });
});

describe('matchFinalLine: characters that draw nothing', () => {
  // Built from code points, so this file holds none of them literally.
  const checkMarkEmoji = String.fromCodePoint(0x2705);
  const variationSelector = String.fromCodePoint(0xfe0f);
  const combiningKeycap = String.fromCodePoint(0x20e3);
  const zeroWidthSpace = String.fromCodePoint(0x200b);
  const zeroWidthJoiner = String.fromCodePoint(0x200d);
  const byteOrderMark = String.fromCodePoint(0xfeff);

  it.each([
    ['a check mark emoji with its variation selector before the line', CODE_REVIEW_READY.replace('Verdict: Ready', `${checkMarkEmoji}${variationSelector} Verdict: Ready`)],
    ['a zero-width space at the end of the line', `${CODE_REVIEW_READY}${zeroWidthSpace}`],
    ['a byte order mark before the line', CODE_REVIEW_READY.replace('Verdict: Ready', `${byteOrderMark}Verdict: Ready`)],
    ['a keycap emoji after the line', `${CODE_REVIEW_READY} #${variationSelector}${combiningKeycap}`],
  ])('%s still matches', (_shape, reply) => {
    expect(matchFinalLine('Verdict: Ready', reply).met).toBe(true);
  });

  it('skips a closing line of only invisible characters and reads the one above', () => {
    expect(finalMatchLine(`${CODE_REVIEW_READY}\n${zeroWidthSpace}`)).toBe('Verdict: Ready');
    expect(finalMatchLine(`${CODE_REVIEW_READY}\n${checkMarkEmoji}${variationSelector}`)).toBe('Verdict: Ready');
    expect(finalMatchLine(`${CODE_REVIEW_READY}\n${zeroWidthJoiner}${byteOrderMark}`)).toBe('Verdict: Ready');
  });
});

describe('matchFinalLine: no pattern stalls the match', () => {
  // A backtracking regular expression takes about n^k steps for k separated
  // wildcards on a line of n near-misses, so this case never finished under
  // one. The test's own timeout is the assertion.
  it('a pattern of many separated wildcards against a long line of near-misses fails at once', () => {
    const pattern = `${'*a'.repeat(16)}*b`;
    const line = 'a '.repeat(4000);
    expect(lineMatchesPattern(pattern, line)).toBe(false);
    expect(lineMatchesPattern(pattern, `${line}b`)).toBe(true);
  });

  it('reads a run of wildcards as one', () => {
    expect(lineMatchesPattern('Verdict: **', 'Verdict: Ready')).toBe(true);
    expect(lineMatchesPattern('**ready***', 'PR: ready to merge')).toBe(true);
    expect(lineMatchesPattern('a**********************b', 'a'.repeat(300))).toBe(false);
  });

  it('places each middle part after the one before, never overlapping the end', () => {
    expect(lineMatchesPattern('*ready*merge', 'PR: ready to merge')).toBe(true);
    expect(lineMatchesPattern('*merge*ready', 'PR: ready to merge')).toBe(false);
    expect(lineMatchesPattern('ab*ba', 'aba')).toBe(false);
  });
});

describe('textMatchCanMatch', () => {
  it('is false for a pattern of only punctuation, which no line with words can match', () => {
    expect(textMatchCanMatch('---')).toBe(false);
    expect(textMatchCanMatch('...')).toBe(false);
  });

  it('is true for a pattern with a word or a wildcard', () => {
    expect(textMatchCanMatch('Verdict: Ready')).toBe(true);
    expect(textMatchCanMatch('*')).toBe(true);
    expect(textMatchCanMatch('**')).toBe(true);
  });
});

describe('conditionKindsAsStored', () => {
  it('keeps a Text match on a turn end and stores no Condition beside it', () => {
    expect(conditionKindsAsStored({ trigger: 'turn_end', condition: 'CI is green', final_line: ' Verdict: Ready ' }))
      .toEqual({ condition: null, final_line: 'Verdict: Ready' });
  });

  it('drops a Text match off a turn end and keeps the Condition', () => {
    expect(conditionKindsAsStored({ trigger: 'enter', condition: ' CI is green ', final_line: 'Verdict: Ready' }))
      .toEqual({ condition: 'CI is green', final_line: null });
  });

  it('reads a blank of either kind as none', () => {
    expect(conditionKindsAsStored({ trigger: 'turn_end', condition: '  ', final_line: '  ' }))
      .toEqual({ condition: null, final_line: null });
    expect(conditionKindsAsStored({ trigger: 'turn_end' })).toEqual({ condition: null, final_line: null });
  });
});
