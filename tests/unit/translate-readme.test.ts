/**
 * The exported pieces of scripts/i18n/translate-readme.mjs (`npm run i18n:translate-readme`): its
 * command line, the request it sends, how it decides a translation is current, restampable or
 * stale, the retry loop around one locale, the files it keeps rather than redrafts, and the summary
 * line /release reads. All pure or driven through a stub caller, so nothing here calls a model, git
 * or the disk. The checks a translation must pass are pinned in readme-translations.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL } from '../../scripts/i18n/engines/claude.mjs';
import { loadGlossary } from '../../scripts/i18n/glossary.mjs';
import {
  composeTranslation,
  ENGLISH_NOTICE,
  gitBlobHash,
  readStamp,
  renderSwitcher,
  replaceSwitcher,
  translatableSource,
} from '../../scripts/i18n/readme.mjs';
import { DEFAULT_MAX_RETRIES } from '../../scripts/i18n/translate-catalog.mjs';
import {
  keptTranslation,
  parseArgs,
  readmeUserPrompt,
  runSummary,
  translateLocale,
  translationState,
} from '../../scripts/i18n/translate-readme.mjs';

const SWITCHER_START = '<!-- language-switcher -->';
const SWITCHER_END = '<!-- /language-switcher -->';

interface PromptTerms {
  keep: string[];
  terms: Array<{ english: string; use: string }>;
}

interface PromptRequest {
  markdown: string;
  notice: string;
  glossary?: PromptTerms;
  problems?: string[];
}

interface AskRequest {
  system: string;
  user: string;
  schema: { required?: string[] };
}

function parsePrompt(user: string): PromptRequest {
  return JSON.parse(user) as PromptRequest;
}

describe('parseArgs', () => {
  it('defaults to every locale, a full run, 4 at once, and the claude engine defaults', () => {
    expect(parseArgs([])).toEqual({
      locales: [],
      stale: false,
      check: false,
      concurrency: 4,
      model: DEFAULT_CLAUDE_MODEL,
      effort: DEFAULT_CLAUDE_EFFORT,
      cli: 'claude',
    });
  });

  it('sets each field from its flag', () => {
    expect(parseArgs([
      '--locales', 'de,fr',
      '--stale',
      '--check',
      '--concurrency', '8',
      '--model', 'some-model',
      '--effort', 'high',
      '--cli', '/opt/tools/claude',
    ])).toEqual({
      locales: ['de', 'fr'],
      stale: true,
      check: true,
      concurrency: 8,
      model: 'some-model',
      effort: 'high',
      cli: '/opt/tools/claude',
    });
  });

  it('reads --stale and --check as separate switches', () => {
    expect(parseArgs(['--stale'])).toMatchObject({ stale: true, check: false });
    expect(parseArgs(['--check'])).toMatchObject({ stale: false, check: true });
  });

  it('runs a repeated locale once, since each one is a paid call', () => {
    expect(parseArgs(['--locales', 'de,de,fr']).locales).toEqual(['de', 'fr']);
    expect(parseArgs(['--locales', 'fr,de,fr,de']).locales).toEqual(['fr', 'de']);
  });
});

describe('readmeUserPrompt', () => {
  const source = '# Install\n\nRun it.';

  it('sends the README and the English notice, and nothing else when there are no terms or problems', () => {
    const parsed = parsePrompt(readmeUserPrompt({ source, terms: { keep: [], terms: [] }, problems: [] }));
    expect(parsed).toEqual({ markdown: source, notice: ENGLISH_NOTICE });
    expect(Object.keys(parsed).sort()).toEqual(['markdown', 'notice']);
  });

  it('adds the glossary when only kept names are given', () => {
    const terms: PromptTerms = { keep: ['Git'], terms: [] };
    const parsed = parsePrompt(readmeUserPrompt({ source, terms, problems: [] }));
    expect(parsed.glossary).toEqual(terms);
    expect(Object.keys(parsed).sort()).toEqual(['glossary', 'markdown', 'notice']);
  });

  it('adds the glossary when only fixed terms are given', () => {
    const terms: PromptTerms = { keep: [], terms: [{ english: 'worktree', use: 'Worktree' }] };
    const parsed = parsePrompt(readmeUserPrompt({ source, terms, problems: [] }));
    expect(parsed.glossary).toEqual(terms);
    expect(Object.keys(parsed).sort()).toEqual(['glossary', 'markdown', 'notice']);
  });

  it('adds the problems of the last answer, without a glossary when there are no terms', () => {
    const problems = ['keep the name "Git" exactly as written', 'the English has 2 headings and the translation has 1'];
    const parsed = parsePrompt(readmeUserPrompt({ source, terms: { keep: [], terms: [] }, problems }));
    expect(parsed.problems).toEqual(problems);
    expect(Object.keys(parsed).sort()).toEqual(['markdown', 'notice', 'problems']);
  });

  it('adds both the glossary and the problems when both are non-empty', () => {
    const terms: PromptTerms = { keep: ['Git'], terms: [{ english: 'worktree', use: 'Worktree' }] };
    const parsed = parsePrompt(readmeUserPrompt({ source, terms, problems: ['fix this'] }));
    expect(parsed).toEqual({ markdown: source, notice: ENGLISH_NOTICE, glossary: terms, problems: ['fix this'] });
  });
});

describe('translationState', () => {
  const english = [
    '# Kangentic',
    '',
    SWITCHER_START,
    '<p align="center">',
    '  English |',
    '  <a href="README.de.md">Deutsch</a>',
    '</p>',
    SWITCHER_END,
    '',
    'Body text.',
    '',
  ].join('\n');
  const englishBlob = gitBlobHash(english);
  const englishSource = translatableSource(english);

  const switcherOnlyReadme = replaceSwitcher(english, `${SWITCHER_START}\nan older switcher\n${SWITCHER_END}`);
  const editedBodyReadme = english.replace('Body text.', 'Older body text.');
  const noSwitcherReadme = '# Kangentic\n\nBody text.\n';
  const switcherOnlyBlob = gitBlobHash(switcherOnlyReadme);
  const editedBodyBlob = gitBlobHash(editedBodyReadme);
  const noSwitcherBlob = gitBlobHash(noSwitcherReadme);
  const unreadableBlob = 'c'.repeat(40);

  const stampedWith = (blob: string): string => composeTranslation({ blob, notice: ENGLISH_NOTICE, body: '# Titel\n\nText.\n' });

  // A strict reader. It throws for any blob outside the map, and for null. A state decided before git is
  // asked (missing, current, no stamp) therefore cannot hide behind a reader that answers null.
  const knownBlobs = new Map<string, string | null>([
    [switcherOnlyBlob, switcherOnlyReadme],
    [editedBodyBlob, editedBodyReadme],
    [noSwitcherBlob, noSwitcherReadme],
    [unreadableBlob, null],
  ]);
  const readBlob = vi.fn((blob: string | null): string | null => {
    if (blob === null || !knownBlobs.has(blob)) throw new Error(`readBlob was not expected to be asked for ${String(blob)}`);
    return knownBlobs.get(blob) ?? null;
  });

  beforeEach(() => {
    readBlob.mockClear();
  });

  const rows: Array<{ name: string; text: string | null; expected: string; asksGit: boolean }> = [
    { name: 'no file is missing', text: null, expected: 'missing', asksGit: false },
    { name: 'a stamp naming the current README.md is current', text: stampedWith(englishBlob), expected: 'current', asksGit: false },
    { name: 'a file with no stamp is stale', text: '# Titel\n\nText.\n', expected: 'stale', asksGit: false },
    { name: 'a stamp naming a blob git cannot read is stale', text: stampedWith(unreadableBlob), expected: 'stale', asksGit: true },
    { name: 'a stamped README that differs only inside the switcher is restampable', text: stampedWith(switcherOnlyBlob), expected: 'restampable', asksGit: true },
    { name: 'a stamped README that differs outside the switcher is stale', text: stampedWith(editedBodyBlob), expected: 'stale', asksGit: true },
    { name: 'a stamped README with no switcher block is stale, not an error', text: stampedWith(noSwitcherBlob), expected: 'stale', asksGit: true },
  ];

  it.each(rows)('$name', ({ text, expected, asksGit }) => {
    expect(translationState({ text, englishBlob, englishSource, readBlob })).toBe(expected);
    expect(readBlob).toHaveBeenCalledTimes(asksGit ? 1 : 0);
  });
});

describe('translateLocale', () => {
  const SOURCE_FIXTURE = [
    '<p align="center">',
    '  <picture>',
    '    <source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png" />',
    '    <img src="https://example.com/logo.png" alt="Example logo" width="96" />',
    '  </picture>',
    '</p>',
    '',
    SWITCHER_START,
    SWITCHER_END,
    '',
    '## Install',
    '',
    '```bash',
    'npx kangentic',
    '```',
    '',
    'Run `npx kangentic`, then set `KANGENTIC_TELEMETRY=0`. See [the guide](https://example.com/guide/) and the [supported agents](#supported-agents).',
    '',
    '<a name="supported-agents"></a>',
    '## Supported agents',
    '',
    '- [Claude Code](https://docs.anthropic.com/claude-code) and [Cursor CLI](https://cursor.com/cli) work in a worktree.',
    '- Email support@example.com.',
  ].join('\n');

  const GERMAN_FIXTURE = [
    '<p align="center">',
    '  <picture>',
    '    <source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png" />',
    '    <img src="https://example.com/logo.png" alt="Beispiel-Logo" width="96" />',
    '  </picture>',
    '</p>',
    '',
    SWITCHER_START,
    SWITCHER_END,
    '',
    '## Installation',
    '',
    '```bash',
    'npx kangentic',
    '```',
    '',
    'Setzen Sie `KANGENTIC_TELEMETRY=0`, nachdem Sie `npx kangentic` ausgeführt haben. Siehe [die Anleitung](https://example.com/guide/) und die [unterstützten Agents](#supported-agents).',
    '',
    '<a name="supported-agents"></a>',
    '## Unterstützte Agents',
    '',
    '- [Claude Code](https://docs.anthropic.com/claude-code) und [Cursor CLI](https://cursor.com/cli) arbeiten in einem Worktree.',
    '- E-Mail an support@example.com.',
  ].join('\n');

  const GERMAN_NOTICE = 'Dies ist eine maschinelle Übersetzung von {readme} beim Stand {revision}. Die englische Fassung ist maßgeblich.';

  // Three replies that each fail a different check, so the problems of one attempt identify it.
  const DROPS_CODE_SPAN = { markdown: GERMAN_FIXTURE.replace('`npx kangentic`', 'npx kangentic'), notice: GERMAN_NOTICE };
  const DROPS_HEADING = { markdown: GERMAN_FIXTURE.replace('## Installation', 'Installation'), notice: GERMAN_NOTICE };
  const DROPS_TOKEN = { markdown: GERMAN_FIXTURE, notice: 'Maschinelle Übersetzung von {readme}.' };
  const GOOD_REPLY = { markdown: GERMAN_FIXTURE, notice: GERMAN_NOTICE };
  const TOKEN_PROBLEM = 'the notice must hold {revision} exactly once, as written';

  const glossary = loadGlossary();

  type Outcome = { kind: 'reply'; reply: unknown; costUsd: number } | { kind: 'throw'; thrown: unknown };
  const replied = (reply: unknown, costUsd = 0): Outcome => ({ kind: 'reply', reply, costUsd });
  const threw = (thrown: unknown): Outcome => ({ kind: 'throw', thrown });

  /** A caller that plays `outcomes` in order and repeats the last one, recording every request. */
  function scriptedCaller(outcomes: Outcome[]) {
    const requests: AskRequest[] = [];
    const caller = {
      ask: async (request: AskRequest) => {
        const outcome = outcomes[Math.min(requests.length, outcomes.length - 1)];
        requests.push(request);
        if (outcome.kind === 'throw') throw outcome.thrown;
        return { reply: outcome.reply, usage: { costUsd: outcome.costUsd } };
      },
    };
    return { caller, requests };
  }

  const translate = (caller: ReturnType<typeof scriptedCaller>['caller']) => (
    translateLocale({ caller, locale: 'de', source: SOURCE_FIXTURE, glossary })
  );

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a good first reply after one call, and sends the README, the notice and the glossary terms', async () => {
    const { caller, requests } = scriptedCaller([replied(GOOD_REPLY, 0.5)]);
    const result = await translate(caller);
    expect(result).toEqual({ ok: true, markdown: GERMAN_FIXTURE, notice: GERMAN_NOTICE, usage: { calls: 1, costUsd: 0.5 } });
    expect(requests).toHaveLength(1);
    const first = parsePrompt(requests[0].user);
    expect(first.markdown).toBe(SOURCE_FIXTURE);
    expect(first.notice).toBe(ENGLISH_NOTICE);
    expect(first.glossary?.keep).toContain('Claude Code');
    expect(first.glossary?.terms).toContainEqual({ english: 'worktree', use: 'Worktree' });
    expect(first.problems, 'the first attempt has no earlier answer to fix').toBeUndefined();
  });

  it('retries a reply that fails the checks, sending its problems with the second call', async () => {
    const { caller, requests } = scriptedCaller([replied(DROPS_CODE_SPAN), replied(GOOD_REPLY)]);
    const result = await translate(caller);
    expect(result.ok).toBe(true);
    expect(result.usage.calls).toBe(2);
    expect(requests).toHaveLength(2);
    const second = parsePrompt(requests[1].user);
    expect(Array.isArray(second.problems)).toBe(true);
    expect(second.problems?.some((problem) => problem.includes('inline code span'))).toBe(true);
  });

  it('retries a call that throws, counts its billed cost, and tells the model the call failed', async () => {
    const billedFailure = Object.assign(new Error('boom'), { costUsd: 0.25 });
    const { caller, requests } = scriptedCaller([threw(billedFailure), replied(GOOD_REPLY, 0.5)]);
    const result = await translate(caller);
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ calls: 2, costUsd: 0.75 });
    expect(parsePrompt(requests[1].user).problems).toEqual(['the call failed: boom']);
  });

  it('counts no cost for a thrown error that carries none, and names a thrown non-error', async () => {
    const { caller, requests } = scriptedCaller([threw(new Error('offline')), threw('quota'), replied(GOOD_REPLY, 0.5)]);
    const result = await translate(caller);
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ calls: 3, costUsd: 0.5 });
    expect(parsePrompt(requests[1].user).problems).toEqual(['the call failed: offline']);
    expect(parsePrompt(requests[2].user).problems).toEqual(['the call failed: quota']);
  });

  it.each([
    { name: 'a null reply', reply: null },
    { name: 'a markdown that is not a string', reply: { markdown: 5, notice: 'x' } },
    { name: 'an empty object', reply: {} },
    { name: 'a notice that is not a string', reply: { markdown: GERMAN_FIXTURE, notice: 7 } },
  ])('counts $name as a failed attempt without throwing', async ({ reply }) => {
    const { caller, requests } = scriptedCaller([replied(reply), replied(GOOD_REPLY)]);
    const result = await translate(caller);
    expect(result.ok).toBe(true);
    expect(result.usage.calls).toBe(2);
    const problems = parsePrompt(requests[1].user).problems ?? [];
    expect(problems.length, 'the drifted reply must fail the checks').toBeGreaterThan(0);
    expect(problems.every((problem) => !problem.startsWith('the call failed')), 'the guards ran, so this was not a thrown call').toBe(true);
  });

  it('gives up after DEFAULT_MAX_RETRIES + 1 calls and returns the last attempt\'s problems, a thrown call', async () => {
    const { caller, requests } = scriptedCaller([
      replied(DROPS_CODE_SPAN, 0.5),
      replied(DROPS_HEADING, 0.25),
      threw(Object.assign(new Error('last'), { costUsd: 0.25 })),
    ]);
    const result = await translate(caller);
    expect(requests).toHaveLength(DEFAULT_MAX_RETRIES + 1);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['the call failed: last']);
    expect(result.usage).toEqual({ calls: DEFAULT_MAX_RETRIES + 1, costUsd: 1 });
    expect(result.markdown, 'a failed locale writes nothing').toBeUndefined();
  });

  it('gives up with the last attempt\'s problems when the last attempt is a bad reply', async () => {
    const { caller, requests } = scriptedCaller([replied(DROPS_CODE_SPAN), replied(DROPS_HEADING), replied(DROPS_TOKEN)]);
    const result = await translate(caller);
    expect(requests).toHaveLength(DEFAULT_MAX_RETRIES + 1);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([TOKEN_PROBLEM]);
  });

  it('sends the same system prompt on every attempt, naming the language', async () => {
    const { caller, requests } = scriptedCaller([replied(DROPS_CODE_SPAN), replied(DROPS_HEADING), replied(DROPS_TOKEN)]);
    await translate(caller);
    expect(requests).toHaveLength(DEFAULT_MAX_RETRIES + 1);
    expect(new Set(requests.map((request) => request.system)).size).toBe(1);
    expect(requests[0].system).toContain('(de)');
    for (const request of requests) expect(request.schema.required).toEqual(['markdown', 'notice']);
  });

  it('feeds each attempt the problems of the attempt before it, not of the first', async () => {
    const { caller, requests } = scriptedCaller([replied(DROPS_CODE_SPAN), replied(DROPS_HEADING), replied(GOOD_REPLY)]);
    const result = await translate(caller);
    expect(result.ok).toBe(true);
    const secondProblems = parsePrompt(requests[1].user).problems ?? [];
    const thirdProblems = parsePrompt(requests[2].user).problems ?? [];
    expect(secondProblems.some((problem) => problem.includes('inline code span'))).toBe(true);
    expect(thirdProblems.some((problem) => problem.includes('inline code span'))).toBe(false);
    expect(thirdProblems).toContain('the English has 2 headings and the translation has 1');
  });
});

describe('keptTranslation', () => {
  const oldBlob = 'a'.repeat(40);
  const newBlob = 'b'.repeat(40);
  const switcher = renderSwitcher('de', ['en', 'de'], { en: 'English', de: 'Deutsch' }, 'en');
  const oldBody = `# Titel\n\n${SWITCHER_START}\nOLD SWITCHER\n${SWITCHER_END}\n\nText.`;
  const newBody = `# Titel\n\n${switcher}\n\nText.`;
  const translation = composeTranslation({ blob: oldBlob, notice: ENGLISH_NOTICE, body: oldBody });

  it('re-renders the switcher and restamps the stamp and the notice hash when the state is restampable', () => {
    const kept = keptTranslation({ text: translation, state: 'restampable', englishBlob: newBlob, switcher });
    expect(kept).toBe(composeTranslation({ blob: newBlob, notice: ENGLISH_NOTICE, body: newBody }));
    expect(readStamp(kept)).toBe(newBlob);
    expect(kept).not.toContain('OLD SWITCHER');
  });

  // For the next two, englishBlob deliberately differs from the stamped blob. With equal blobs a
  // restamp would change nothing, so the test could not tell a kept stamp from a rewritten one.
  it('re-renders the switcher and leaves the stamp alone when the state is stale', () => {
    const kept = keptTranslation({ text: translation, state: 'stale', englishBlob: newBlob, switcher });
    expect(kept).toBe(composeTranslation({ blob: oldBlob, notice: ENGLISH_NOTICE, body: newBody }));
    expect(readStamp(kept)).toBe(oldBlob);
  });

  it('re-renders the switcher and leaves the stamp alone when the state is current', () => {
    const kept = keptTranslation({ text: translation, state: 'current', englishBlob: newBlob, switcher });
    expect(kept).toBe(composeTranslation({ blob: oldBlob, notice: ENGLISH_NOTICE, body: newBody }));
    expect(readStamp(kept)).toBe(oldBlob);
  });

  it('throws when the text has lost its switcher block', () => {
    const withoutBlock = composeTranslation({ blob: oldBlob, notice: ENGLISH_NOTICE, body: '# Titel\n\nText.' });
    expect(() => keptTranslation({ text: withoutBlock, state: 'current', englishBlob: oldBlob, switcher })).toThrow(/language-switcher/);
  });

  it('throws on a restampable file whose notice no longer shows the old short hash, which a stale file survives', () => {
    const noHashNotice = `<!-- readme-translation source-blob=${oldBlob} -->\n> Dies ist eine Übersetzung.\n\n${oldBody}\n`;
    expect(() => keptTranslation({ text: noHashNotice, state: 'restampable', englishBlob: newBlob, switcher })).toThrow(/does not show `aaaaaaa`/);
    expect(keptTranslation({ text: noHashNotice, state: 'stale', englishBlob: newBlob, switcher })).toBe(replaceSwitcher(noHashNotice, switcher));
  });
});

describe('runSummary', () => {
  const fourteen = ['de', 'fr', 'es', 'it', 'pt-BR', 'ru', 'pl', 'cs', 'hu', 'tr', 'ja', 'ko', 'zh-CN', 'zh-TW'];

  it('says all are current when nothing was translated, restamped or left stale', () => {
    const states = new Map(fourteen.map((locale) => [locale, 'current']));
    expect(runSummary({ shortBlob: 'abc1234', translatedLocales: fourteen, states, translated: [], restamped: [], updated: [], costUsd: 0 }))
      .toBe('README translations at abc1234: all 14 current ($0.00)');
  });

  it('counts the others as already current once any locale was translated', () => {
    const states = new Map(fourteen.map((locale) => [locale, locale === 'de' ? 'stale' : 'current']));
    expect(runSummary({ shortBlob: 'abc1234', translatedLocales: fourteen, states, translated: ['de'], restamped: [], updated: [], costUsd: 0.75 }))
      .toBe('README translations at abc1234: translated de; 13 already current ($0.75)');
  });

  it('lists translated, restamped, left-stale and updated entries, and counts already current as the rest', () => {
    const locales = ['de', 'fr', 'es', 'it', 'ja', 'ko'];
    const states = new Map([
      ['de', 'stale'], // translated this run, so it is not "still stale"
      ['fr', 'restampable'],
      ['es', 'stale'], // left alone
      ['it', 'missing'], // left alone
      ['ja', 'current'],
      ['ko', 'current'],
    ]);
    expect(runSummary({
      shortBlob: 'abc1234',
      translatedLocales: locales,
      states,
      translated: ['de'],
      restamped: ['fr'],
      updated: ['README.md switcher', 'README.ja.md switcher'],
      costUsd: 1.5,
    })).toBe('README translations at abc1234: translated de; restamped fr; still stale or missing es, it; 2 already current; updated README.md switcher, README.ja.md switcher ($1.50)');
  });

  it('formats the cost to two decimals', () => {
    const states = new Map([['de', 'current']]);
    const summaryFor = (costUsd: number): string => runSummary({ shortBlob: 'abc1234', translatedLocales: ['de'], states, translated: [], restamped: [], updated: [], costUsd });
    expect(summaryFor(12.3456)).toBe('README translations at abc1234: all 1 current ($12.35)');
    expect(summaryFor(0.1 + 0.2)).toBe('README translations at abc1234: all 1 current ($0.30)');
    expect(summaryFor(3)).toBe('README translations at abc1234: all 1 current ($3.00)');
  });
});
