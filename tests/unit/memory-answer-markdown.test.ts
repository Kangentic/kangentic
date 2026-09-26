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
import { linkifyTickets, stripProtocolLine } from '../../src/renderer/components/memory/MemoryChatText';

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

  it('drops bold around nothing but tickets, and keeps bold around words', () => {
    expect(linkifyTickets('**#377, #378, and #381** form the core.'))
      .toBe('[#377](#kng-ticket-377), [#378](#kng-ticket-378), and [#381](#kng-ticket-381) form the core.');
    expect(linkifyTickets('**#377** and **the relay** matter.'))
      .toBe('[#377](#kng-ticket-377) and **the relay** matter.');
  });

  it('ignores a # that is part of a longer token or an entity', () => {
    expect(linkifyTickets('Color a#12 and &#12; and ##3.')).toBe('Color a#12 and &#12; and ##3.');
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
