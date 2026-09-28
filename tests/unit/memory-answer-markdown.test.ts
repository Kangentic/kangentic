/**
 * Turning an agent's markdown answer into a rendered one, without losing the
 * tickets in it, which are controls.
 *
 * The answer is markdown, and it names tasks by board ticket, `#561`, which
 * the chat draws as the board's own mark. Rewriting a ticket to a link lets the
 * markdown parser do the parsing while the renderer decides what it becomes.
 *
 * These pin the rewrite, which is the part that can silently corrupt an answer,
 * and the stripping of the answer's `SELECTED:` protocol line.
 */

import { describe, it, expect } from 'vitest';
import {
  keepMarksWithPunctuation,
  linkifyTickets,
  stripProtocolLine,
  type AnswerTreeNode,
} from '../../src/renderer/components/memory/MemoryChatText';

describe('linkifying tickets in an answer', () => {
  it('rewrites a ticket into a private link', () => {
    expect(linkifyTickets('See #12 and #561.'))
      .toBe('See [#12](#kng-ticket-12) and [#561](#kng-ticket-561).');
  });

  it('leaves markdown structure untouched', () => {
    const answer = '**Mobile Bridge**\n\n- #4 the bridge\n- #9 the relay';
    expect(linkifyTickets(answer))
      .toBe('**Mobile Bridge**\n\n- [#4](#kng-ticket-4) the bridge\n- [#9](#kng-ticket-9) the relay');
  });

  it('does not touch a ticket inside a fenced code block', () => {
    const answer = 'Before #1.\n```ts\nconst issue = "#2";\n```\nAfter #3.';
    const out = linkifyTickets(answer);
    expect(out).toContain('const issue = "#2";');
    expect(out).toContain('Before [#1](#kng-ticket-1).');
    expect(out).toContain('After [#3](#kng-ticket-3).');
  });

  it('closes a tilde fence as well as a backtick one', () => {
    const out = linkifyTickets('~~~\n#7\n~~~\n#8');
    expect(out).toContain('\n#7\n');
    expect(out).toContain('[#8](#kng-ticket-8)');
  });

  it('does not touch a ticket inside inline code', () => {
    expect(linkifyTickets('Use `#5` literally, but cite #6.'))
      .toBe('Use `#5` literally, but cite [#6](#kng-ticket-6).');
  });

  it('leaves a ticket that is already link text alone', () => {
    const answer = 'See [#3](https://example.com/issues/3).';
    expect(linkifyTickets(answer)).toBe(answer);
  });

  it('leaves a fragment inside a URL alone', () => {
    const answer = 'Read https://example.com/docs/#12 first.';
    expect(linkifyTickets(answer)).toBe(answer);
  });

  it('leaves a pull request number alone', () => {
    // "#659 was reviewing PR #417": #417 there is a pull request, not task 417.
    expect(linkifyTickets('#659 was reviewing PR #417.'))
      .toBe('[#659](#kng-ticket-659) was reviewing PR #417.');
    expect(linkifyTickets('see pull request #12')).toBe('see pull request #12');
  });

  it('marks every ticket in a slash-joined run, not only the first', () => {
    // Seen in a real answer: "#413/#503/#494 (relay config and presentation)"
    // drew one mark and two plain numbers.
    expect(linkifyTickets('#413/#503/#494 (relay config)'))
      .toBe('[#413](#kng-ticket-413)/[#503](#kng-ticket-503)/[#494](#kng-ticket-494) (relay config)');
  });

  it('drops bold around nothing but tickets, and keeps bold around words', () => {
    expect(linkifyTickets('**#377, #378, and #381** form the core.'))
      .toBe('[#377](#kng-ticket-377), [#378](#kng-ticket-378), and [#381](#kng-ticket-381) form the core.');
    expect(linkifyTickets('**#377** and **the relay** matter.'))
      .toBe('[#377](#kng-ticket-377) and **the relay** matter.');
  });

  it('ignores a # that is part of a longer token or an entity', () => {
    expect(linkifyTickets('Color a#12 and &#12; and ##3.')).toBe('Color a#12 and &#12; and ##3.');
  });

  it('marks another project\'s ticket with its prefix, for the prefixes the answer carries', () => {
    // An answer across projects: mobile-app#88 is not the open project's #88.
    const prefixes = new Set(['mobile-app', 'mobile']);
    expect(linkifyTickets('Mostly Mobile-App#88, mobile#3 and #88; not web#4.', prefixes))
      .toBe('Mostly [Mobile-App#88](#kng-ticket-88-mobile-app), [mobile#3](#kng-ticket-3-mobile) and [#88](#kng-ticket-88); not web#4.');
    expect(linkifyTickets('**mobile#3 and #4** matter.', prefixes))
      .toBe('[mobile#3](#kng-ticket-3-mobile) and [#4](#kng-ticket-4) matter.');
  });
});

describe('keeping a mark on one line with its punctuation', () => {
  // Seen in a real answer: "#383" ended a line and ", #377" opened the next,
  // since Chrome breaks beside an inline-block where it would not beside a word.
  const text = (value: string): AnswerTreeNode => ({ type: 'text', value });
  const mark = (ticket: number): AnswerTreeNode => ({
    type: 'element', tagName: 'a', properties: { href: `#kng-ticket-${ticket}` }, children: [text(`#${ticket}`)],
  });
  /** A node read back as text, with `[...]` around each no-wrap group. */
  const flatten = (node: AnswerTreeNode): string => {
    if (node.type === 'text') return node.value ?? '';
    const inner = (node.children ?? []).map(flatten).join('');
    const className = node.properties?.className;
    return Array.isArray(className) && className.includes('whitespace-nowrap') ? `[${inner}]` : inner;
  };

  it('groups a mark with the punctuation after it and a ( before it', () => {
    const paragraph: AnswerTreeNode = {
      type: 'element', tagName: 'p',
      children: [text('Mostly '), mark(383), text(', then '), mark(381), text(' (see '), mark(413), text(').')],
    };
    keepMarksWithPunctuation(paragraph);
    expect(flatten(paragraph)).toBe('Mostly [#383,] then #381 (see [#413).]');
  });

  it('takes the ( directly before a mark, and reaches marks nested in other elements', () => {
    const paragraph: AnswerTreeNode = {
      type: 'element', tagName: 'p',
      children: [text('Both ('), { type: 'element', tagName: 'strong', children: [mark(5)] }, text(' and ('), mark(6), text(')')],
    };
    keepMarksWithPunctuation(paragraph);
    // The first mark sits inside <strong>, so its ( is outside its parent and stays put.
    expect(flatten(paragraph)).toBe('Both (#5 and [(#6)]');
  });

  it('leaves a link that is not a ticket alone', () => {
    const paragraph: AnswerTreeNode = {
      type: 'element', tagName: 'p',
      children: [{ type: 'element', tagName: 'a', properties: { href: 'https://example.com' }, children: [text('docs')] }, text('.')],
    };
    keepMarksWithPunctuation(paragraph);
    expect(flatten(paragraph)).toBe('docs.');
  });
});

describe('stripping the protocol line', () => {
  it('removes a finished SELECTED line', () => {
    expect(stripProtocolLine('#378 cost the most.\nSELECTED: #378, #377')).toBe('#378 cost the most.');
  });

  it('removes one still being written, so it never flashes on screen', () => {
    expect(stripProtocolLine('#378 cost the most.\nSE')).toBe('#378 cost the most.');
    expect(stripProtocolLine('#378 cost the most.\nSELECTED')).toBe('#378 cost the most.');
    expect(stripProtocolLine('#378 cost the most.\nSELECTED: #3')).toBe('#378 cost the most.');
  });

  it('leaves an answer with no protocol line alone', () => {
    expect(stripProtocolLine('Nothing covers that.')).toBe('Nothing covers that.');
    // A last line that merely starts with the same letters is prose.
    expect(stripProtocolLine('One task.\nSelection happens on drop.')).toBe('One task.\nSelection happens on drop.');
  });

  it('strips a protocol line that is the whole answer', () => {
    expect(stripProtocolLine('SELECTED: none')).toBe('');
  });
});
