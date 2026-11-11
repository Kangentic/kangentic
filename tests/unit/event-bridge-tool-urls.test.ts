/**
 * The `extractToolUrls` directive in `event-bridge.js` (#1056), run through the
 * real `transformHookEvent` that the bridge process and main both use. A user
 * loses: an Artifact page Claude published never reaching the task's Artifacts
 * list, or a list full of pages Claude merely read, listed or deleted.
 *
 * Claude's directive is taken from what `buildHooks` really wires, so the
 * tested spec is the shipped one. Directives for the edge cases are authored
 * with the builder, never a hand-written wire string.
 *
 * Red-green: remove the `actions.includes` check in the bridge and the read
 * and list cases fail; remove the `URL_LIMIT` break and the cap case fails.
 */
import { describe, it, expect } from 'vitest';
import { transformHookEvent } from '../../src/main/agent/event-bridge';
import { buildHooks as buildClaudeHooks } from '../../src/main/agent/adapters/claude';
import { extractToolUrls } from '../../src/main/agent/shared/directive-builders';

interface BridgeRun {
  event: Record<string, unknown>;
  errors: string[];
}

function run(directives: string[], input: unknown): BridgeRun {
  const errors: string[] = [];
  const lines = transformHookEvent({
    eventType: 'tool_end',
    directives,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    now: 1_700_000_000_000,
    logError: (message: string) => errors.push(message),
  });
  return { event: JSON.parse(lines[lines.length - 1]) as Record<string, unknown>, errors };
}

/** The extractToolUrls directive Claude's PostToolUse hook really wires. */
function claudePublishDirective(): string {
  const hooks = buildClaudeHooks('/mock/event-bridge.js', '/mock/events.jsonl', {});
  const command = hooks.PostToolUse[hooks.PostToolUse.length - 1].hooks[0].command;
  const directive = command.split(' ').find((token: string) => token.startsWith('extractToolUrls:'));
  if (!directive) throw new Error('Claude PostToolUse wires no extractToolUrls directive');
  return directive;
}

const PAGE = 'https://claude.ai/public/artifacts/abc-123';

describe('extractToolUrls with Claude\'s shipped spec', () => {
  const directive = claudePublishDirective();

  it('reads the link out of an object tool_response and ends it at the quote', () => {
    const { event, errors } = run([directive], {
      tool_name: 'Artifact',
      tool_input: { action: 'publish', title: 'Checkout mock' },
      tool_response: { url: PAGE, id: 'abc-123' },
    });
    expect(event.urls).toEqual([PAGE]);
    expect(errors).toEqual([]);
  });

  it('reads the link out of a string tool_response and drops the sentence full stop', () => {
    const { event } = run([directive], {
      tool_name: 'Artifact',
      tool_input: {},
      tool_response: `Published. View it at ${PAGE}.`,
    });
    expect(event.urls).toEqual([PAGE]);
  });

  it('keeps a closing bracket the link opened, and drops the full stop after it', () => {
    const link = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    const { event } = run([directive], { tool_name: 'Artifact', tool_input: {}, tool_response: `Published ${link}.` });
    expect(event.urls).toEqual([link]);
  });

  it('drops a closing bracket the link did not open', () => {
    const { event } = run([directive], { tool_name: 'Artifact', tool_input: {}, tool_response: `Published (${PAGE})` });
    expect(event.urls).toEqual([PAGE]);
  });

  // The trim is one backward pass; a per-character rescan is quadratic here.
  it('finds the link when 60,000 full stops follow it', () => {
    const { event } = run([directive], { tool_name: 'Artifact', tool_input: {}, tool_response: PAGE + '.'.repeat(60000) });
    expect(event.urls).toEqual([PAGE]);
  });

  it('treats a missing action as a publish', () => {
    const { event } = run([directive], { tool_name: 'Artifact', tool_input: { title: 'T' }, tool_response: PAGE });
    expect(event.urls).toEqual([PAGE]);
  });

  it.each(['read', 'list', 'delete', 'pin'])('gives no links for action %s', (action) => {
    const { event } = run([directive], { tool_name: 'Artifact', tool_input: { action }, tool_response: { url: PAGE } });
    expect(event.urls).toBeUndefined();
  });

  it('gives no links for another tool whose result carries a link', () => {
    const { event } = run([directive], { tool_name: 'WebFetch', tool_input: {}, tool_response: PAGE });
    expect(event.urls).toBeUndefined();
  });

  it('carries the title from tool_input.title', () => {
    const { event } = run([directive], {
      tool_name: 'Artifact',
      tool_input: { action: 'publish', title: '  Checkout mock  ' },
      tool_response: PAGE,
    });
    expect(event.urlsTitle).toBe('Checkout mock');
  });

  it('carries no title when the call gave none or a blank one', () => {
    expect(run([directive], { tool_name: 'Artifact', tool_input: {}, tool_response: PAGE }).event.urlsTitle).toBeUndefined();
    expect(run([directive], { tool_name: 'Artifact', tool_input: { title: '  ' }, tool_response: PAGE }).event.urlsTitle).toBeUndefined();
  });

  // The shape a live session returned on 2026-11-10 for a publish from an
  // Artifact type, and again for each later update of that artifact: the
  // artifact first, then the type it was made from. Only the first is the
  // task's; taking both put the type on the task as a second artifact. The two
  // ids are placeholders of the same length and alphabet as the captured ones.
  it('takes only the artifact from a result that also names the type it was made from', () => {
    const artifact = 'https://claude.ai/artifact/Ab3dEf6hIj9kLm2nOp5qRs';
    const type = 'https://claude.ai/artifact/Zy8xWv5uTs2rQp9oNm6lKj';
    const { event } = run([directive], {
      tool_name: 'Artifact',
      tool_input: { type_url: type, title: 'Settings search ranks by tab', auto_open: 'after_first_write' },
      tool_response: `Created a new Artifact at ${artifact} (version 1794360328-7383) from the Artifact type ${type} (release 1794327254-4710). `
        + 'File names below are names chosen by the type\'s publisher. Its own files (add yours under `project/`): none.',
    });
    expect(event.urls).toEqual([artifact]);
    expect(event.urlsTitle).toBe('Settings search ranks by tab');
  });

  it('gives no links for the quickstart action, which publishes nothing', () => {
    const { event } = run([directive], {
      tool_name: 'Artifact',
      tool_input: { action: 'quickstart', intent: 'design' },
      tool_response: 'Start from the Design type https://claude.ai/artifact/Zy8xWv5uTs2rQp9oNm6lKj',
    });
    expect(event.urls).toBeUndefined();
  });
});

describe('extractToolUrls with no limit', () => {
  it('keeps at most 10 links, each once', () => {
    const unlimited = extractToolUrls({ toolField: 'tool_name', tools: ['Artifact'], responsePath: ['tool_response'] });
    const links = Array.from({ length: 15 }, (_, position) => `https://claude.ai/public/artifacts/page-${position}`);
    const { event } = run([unlimited], {
      tool_name: 'Artifact',
      tool_input: {},
      tool_response: `${links.join(' ')} ${links[0]}`,
    });
    expect(event.urls).toEqual(links.slice(0, 10));
  });
});

describe('extractToolUrls with Claude\'s shipped spec, without a result', () => {
  const directive = claudePublishDirective();


  it('adds nothing when the response has no link or no response at all', () => {
    expect(run([directive], { tool_name: 'Artifact', tool_input: {}, tool_response: 'done' }).event.urls).toBeUndefined();
    expect(run([directive], { tool_name: 'Artifact', tool_input: {} }).event.urls).toBeUndefined();
  });

  it('is a no-op on a malformed payload', () => {
    const { event, errors } = run([directive], 'this is not json');
    expect(event.urls).toBeUndefined();
    expect(event.type).toBe('tool_end');
    expect(errors).toEqual([]);
  });
});

describe('extractToolUrls authored with the builder', () => {
  const baseSpec = { toolField: 'tool_name', tools: ['Publish'], responsePath: ['tool_response', 'links'] };

  it('reads from the response path, without an action gate when none is named', () => {
    const { event } = run([extractToolUrls(baseSpec)], { tool_name: 'Publish', tool_response: { links: [PAGE] } });
    expect(event.urls).toEqual([PAGE]);
  });

  it('refuses an absent action unless allowNoAction is set', () => {
    const gated = extractToolUrls({ ...baseSpec, actionPath: ['tool_input', 'action'], actions: ['publish'] });
    const payload = { tool_name: 'Publish', tool_input: {}, tool_response: { links: [PAGE] } };
    expect(run([gated], payload).event.urls).toBeUndefined();
  });

  it('refuses a malformed directive payload, and the builder refuses an empty spec', () => {
    const { event, errors } = run(['extractToolUrls:!!not-base64-json'], { tool_name: 'Publish', tool_response: PAGE });
    expect(event.urls).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(() => extractToolUrls({ ...baseSpec, tools: [] })).toThrow();
    expect(() => extractToolUrls({ ...baseSpec, responsePath: [] })).toThrow();
  });
});
