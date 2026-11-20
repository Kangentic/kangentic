import { describe, expect, it } from 'vitest';
import { interpolateTextMatch } from '../../src/main/automations/interpolate-config';
import { matchFinalLine } from '../../src/shared/final-line-match';

/**
 * A Reply or Prompt line may hold template variables (#872). Each value is
 * matched literally: a task title or key carrying `*` or a leading `!` must
 * never widen or flip a pattern, and `{{agentReply}}` is never filled, since
 * it is the text being matched.
 */
describe('interpolateTextMatch', () => {
  it('fills a variable so "Applied {{issueKey}}" matches this task\'s key and no other', () => {
    const patterns = interpolateTextMatch('Applied {{issueKey}}', { issueKey: 'add-dark-mode' });
    expect(matchFinalLine(patterns, 'Done.\nApplied add-dark-mode').met).toBe(true);
    expect(matchFinalLine(patterns, 'Applied add-export-csv').met).toBe(false);
  });

  it('matches a value literally: its * is no wildcard and its leading ! is no not', () => {
    const wildcard = interpolateTextMatch('Fixed {{title}}', { title: 'Fix *' });
    expect(matchFinalLine(wildcard, 'Fixed Fix everything').met).toBe(false);
    expect(matchFinalLine(wildcard, 'Fixed Fix').met).toBe(true);

    const negation = interpolateTextMatch('{{title}}', { title: '!Ship it' });
    expect(matchFinalLine(negation, 'Ship it').met).toBe(true);
    expect(matchFinalLine(negation, 'Hold it').met).toBe(false);
  });

  it('keeps a value on its own pattern line, so a line break in it adds no pattern', () => {
    expect(interpolateTextMatch('Done {{title}}', { title: 'one\ntwo' }).split('\n')).toHaveLength(1);
  });

  it('never fills agentReply, and leaves a pattern with no variable untouched', () => {
    expect(interpolateTextMatch('{{agentReply}}', { agentReply: 'anything' })).toBe('{{agentReply}}');
    expect(interpolateTextMatch('Ready for *', { title: 'x' })).toBe('Ready for *');
  });
});
