/**
 * Turning an agent's markdown answer into a rendered one, without losing the
 * two things in it that are controls.
 *
 * The answer is markdown - agents write headings, bold and fenced code unasked,
 * and rendering it preformatted put `**Mobile Bridge phases**` on screen
 * literally. But it also carries `[3]` (an excerpt) and `T12` (a task), both of
 * which must stay clickable. Rewriting them to links lets the markdown parser
 * do the parsing while the renderer decides what each one becomes.
 *
 * These pin the rewrite, which is the part that can silently corrupt an answer.
 */

import { describe, it, expect } from 'vitest';
import { linkifyReferences } from '../../src/renderer/components/memory/MemoryAnswer';

describe('linkifying an answer', () => {
  it('rewrites both reference forms', () => {
    expect(linkifyReferences('See T12 and [3].'))
      .toBe('See [T12](#kng-task-12) and [3](#kng-cite-3).');
  });

  it('leaves markdown structure untouched', () => {
    // The whole reason for the change: this used to reach the screen literally.
    const answer = '**Mobile Bridge phases**\n\n- T4 the bridge\n- T9 the relay';
    expect(linkifyReferences(answer))
      .toBe('**Mobile Bridge phases**\n\n- [T4](#kng-task-4) the bridge\n- [T9](#kng-task-9) the relay');
  });

  it('does not touch a reference inside a fenced code block', () => {
    // A code sample naming T12 is showing you code, not citing a task, and
    // turning it into a link would corrupt what the agent wrote.
    const answer = 'Before T1.\n```ts\nconst T2 = load([3]);\n```\nAfter T3.';
    const out = linkifyReferences(answer);
    expect(out).toContain('const T2 = load([3]);');
    expect(out).toContain('Before [T1](#kng-task-1).');
    expect(out).toContain('After [T3](#kng-task-3).');
  });

  it('does not touch a reference inside inline code', () => {
    const out = linkifyReferences('Use `T5` literally, but cite T6.');
    expect(out).toBe('Use `T5` literally, but cite [T6](#kng-task-6).');
  });

  it('leaves a real markdown link alone', () => {
    // `[3](...)` is already a link. Rewriting it would nest one inside another
    // and lose the agent's href.
    const answer = 'See [3](https://example.com/spec) for detail.';
    expect(linkifyReferences(answer)).toBe(answer);
  });

  it('leaves an image alone', () => {
    const answer = '![3](chart.png)';
    expect(linkifyReferences(answer)).toBe(answer);
  });

  it('closes a tilde fence as well as a backtick one', () => {
    const answer = '~~~\nT7\n~~~\nT8';
    const out = linkifyReferences(answer);
    expect(out).toContain('\nT7\n');
    expect(out).toContain('[T8](#kng-task-8)');
  });

  it('ignores a T that is part of a longer token', () => {
    // Word-bounded, or `WT12` and `PART3` would light random tasks.
    expect(linkifyReferences('The WT12 branch and PART3 changed.'))
      .toBe('The WT12 branch and PART3 changed.');
  });
});
