/**
 * The web demo's Command Terminal Earlier search (the `command-terminal-earlier` scene): the mock
 * `searchCommandTerminalHistory` and its `earlierSnippet`, lifted out of the GENERATED seed script
 * (buildDemoPreConfig) the way demo-layout-choice.test.ts lifts displayFor. The scene's poster
 * shows the hit's passage with the matched word highlighted by offsets, so the offsets must point
 * at the word, a hit needs every query word, and the passage must stay inside the rail's row.
 */
import { describe, expect, it } from 'vitest';
import { buildDemoPreConfig, DEMO_COMMAND_TERMINAL_EARLIER } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';

interface Hit { agentSessionId: string; snippet: string; matchStart: number; matchEnd: number }
interface SearchAnswer { indexingOff: boolean; hits: Hit[] }
type Search = (projectId: string, query: string) => Promise<SearchAnswer>;

const PROJECT_ID = 'project-under-test';
const SNIPPET_WORDS = 12;
const ELLIPSIS = '…';

/** A source range out of the generated script, by brace matching from the first `{` after `start`. */
function braceBlock(script: string, start: number): string {
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced block in the generated seed');
}

const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });

function liftSearch(): Search {
  const snippetStart = script.indexOf('function earlierSnippet(');
  const searchMarker = 'window.electronAPI.sessions.searchCommandTerminalHistory = ';
  const searchStart = script.indexOf(searchMarker);
  if (snippetStart === -1 || searchStart === -1) throw new Error('the Earlier search is not in the generated seed');
  const constants = script.match(/var EARLIER_SNIPPET_WORDS = \d+;\s*var EARLIER_SNIPPET_LEAD_WORDS = \d+;/);
  if (!constants) throw new Error('the snippet window constants are not in the generated seed');
  const source = [
    'var earlierSeeded = true;',
    'function seedEarlier() {}',
    constants[0],
    braceBlock(script, snippetStart),
    `var window = { __mockCommandTerminalHistory: { ${JSON.stringify(PROJECT_ID)}: data.commandTerminalEarlier.map(function (conversation) { return { agentSessionId: conversation.agentSessionId }; }) }, electronAPI: { sessions: {} } };`,
    `${searchMarker}${braceBlock(script, searchStart + searchMarker.length)};`,
    'return window.electronAPI.sessions.searchCommandTerminalHistory;',
  ].join('\n');
  return new Function('data', source)({ commandTerminalEarlier: DEMO_COMMAND_TERMINAL_EARLIER }) as Search;
}

const search = liftSearch();

describe('the demo Command Terminal Earlier search', () => {
  it('points matchStart and matchEnd at the query word inside the snippet, whatever its case', async () => {
    const answer = await search(PROJECT_ID, 'CHECKOUT');
    expect(answer.hits.length).toBeGreaterThan(0);
    for (const hit of answer.hits) {
      expect(hit.snippet.slice(hit.matchStart, hit.matchEnd).toLowerCase()).toBe('checkout');
    }
  });

  it('keeps a snippet to 12 words and marks only the sides it cut', async () => {
    const answer = await search(PROJECT_ID, 'checkout');
    const byId = new Map(answer.hits.map((hit) => [hit.agentSessionId, hit]));
    for (const hit of answer.hits) {
      const bare = hit.snippet.split(ELLIPSIS).join('');
      expect(bare.split(/\s+/).length).toBeLessThanOrEqual(SNIPPET_WORDS);
    }
    for (const conversation of DEMO_COMMAND_TERMINAL_EARLIER) {
      const hit = byId.get(conversation.agentSessionId);
      if (!hit) continue;
      const words = conversation.text.split(/\s+/);
      const bare = hit.snippet.split(ELLIPSIS).join('').split(/\s+/);
      const startIndex = words.findIndex((_word, index) => words.slice(index, index + bare.length).join(' ') === bare.join(' '));
      expect(startIndex, 'the snippet is a run of the conversation text').toBeGreaterThanOrEqual(0);
      expect(hit.snippet.startsWith(ELLIPSIS), `${conversation.agentSessionId} leading ellipsis`).toBe(startIndex > 0);
      expect(hit.snippet.endsWith(ELLIPSIS), `${conversation.agentSessionId} trailing ellipsis`).toBe(startIndex + bare.length < words.length);
    }
    // The CI keys conversation names the word deep in its text, so its leading side is cut.
    const deep = byId.get('c4f80b13-6e2a-4a97-9d51-3b6ae0c8d734');
    expect(deep?.snippet.startsWith(ELLIPSIS)).toBe(true);
  });

  it('answers a two-word query only for conversations holding both words', async () => {
    const both = await search(PROJECT_ID, 'checkout refund');
    expect(both.hits.map((hit) => hit.agentSessionId)).toEqual(['c4f80b13-6e2a-4a97-9d51-3b6ae0c8d734']);
    const oneMissing = await search(PROJECT_ID, 'checkout zzzunmatched');
    expect(oneMissing.hits).toEqual([]);
  });

  it('answers a blank query with no hits and indexing on', async () => {
    expect(await search(PROJECT_ID, '   ')).toEqual({ indexingOff: false, hits: [] });
    expect(await search(PROJECT_ID, '')).toEqual({ indexingOff: false, hits: [] });
  });
});
