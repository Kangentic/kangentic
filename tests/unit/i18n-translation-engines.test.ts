/**
 * The translation harness's two engines (scripts/i18n/engines/, docs/contributing/translations.md).
 * No test starts the claude CLI, so the Claude engine is covered through `readJsonResult` alone.
 * The local engine runs against a stubbed `globalThis.fetch`, so no test reaches a network.
 *
 * `readJsonResult` is pinned to a REAL capture (tests/fixtures/claude-print-result-json-schema.json)
 * and to variations derived from it. The two local-server bodies are the documented OpenAI chat
 * completion and llama.cpp `/completion` shapes, built by hand because no capture exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonResult } from '../../scripts/i18n/engines/claude.mjs';
import { createOpenAiCompatibleEngine, DEFAULT_LOCAL_URL, REFILL_MODEL, translateGemmaPrompt } from '../../scripts/i18n/engines/openai-compatible.mjs';
import { prepareMessage, targetKeys } from '../../scripts/i18n/messages.mjs';
import { readReplies, REPLY_SCHEMA, requestItem, systemPrompt, userPrompt } from '../../scripts/i18n/prompt.mjs';

interface TranslationReply {
  key: string;
  text?: string;
  forms?: Record<string, string>;
}

interface ResultCapture {
  type: string;
  is_error: boolean;
  result: string;
  structured_output?: { translations: TranslationReply[] };
  total_cost_usd: number;
  duration_ms: number;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
}

interface RequestItem {
  key: string;
  text?: string;
  forms?: Record<string, string>;
  write?: string[];
  englishFor?: Record<string, string>;
}

const fixturesDirectory = path.join(__dirname, '..', 'fixtures');
const captureLine = fs.readFileSync(path.join(fixturesDirectory, 'claude-print-result-json-schema.json'), 'utf-8').trim();
const capture = JSON.parse(captureLine) as ResultCapture;

const LOCAL_URL = 'http://127.0.0.1:9931/v1';
const COMPLETION_URL = 'http://127.0.0.1:9931/completion';
const MESSAGE = { context: 'board', comments: [], origin: [['src/renderer/Example.tsx', null]] };
const NO_GLOSSARY_TERMS = { kept: [], fixed: [] };

/** The OpenAI chat-completion response shape. Documented, not captured: no real llama-server sample. */
function openAiCompatibleChatCompletionShape(content: unknown, usage?: { prompt_tokens: number; completion_tokens: number }): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/** The llama.cpp `/completion` response shape. Documented, not captured: no real llama-server sample. */
function llamaCppCompletionShape(content: string, tokensEvaluated: number, tokensPredicted: number): unknown {
  return { content, stop: true, tokens_evaluated: tokensEvaluated, tokens_predicted: tokensPredicted };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Stubs `fetch` with a function that builds a FRESH Response per call (a Response body reads
 * once, and the translategemma style makes one request per form). `respond` gets the 1-based
 * call number.
 */
function stubFetch(respond: (callNumber: number) => Response) {
  let callNumber = 0;
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
  fetchMock.mockImplementation(() => {
    callNumber += 1;
    return Promise.resolve(respond(callNumber));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof stubFetch>, callIndex: number): unknown {
  return JSON.parse(String(fetchMock.mock.calls[callIndex][1].body));
}

function textRequestItem(): RequestItem {
  const prepared = prepareMessage('Delete {name}?');
  return requestItem({
    key: 'text-key', prepared, keys: targetKeys(prepared, 'ru'), locale: 'ru', message: MESSAGE,
    neighbours: [], hint: null, glossaryTerms: NO_GLOSSARY_TERMS, budget: null, problems: [],
  });
}

/** A plural item for Russian: `one` and `other` are written in English, `few` and `many` borrowed. */
function pluralRequestItem(): RequestItem {
  const prepared = prepareMessage('{count, plural, one {# task} other {# tasks}}');
  return requestItem({
    key: 'plural-key', prepared, keys: targetKeys(prepared, 'ru'), locale: 'ru', message: MESSAGE,
    neighbours: [], hint: null, glossaryTerms: NO_GLOSSARY_TERMS, budget: null, problems: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readJsonResult (Claude engine, real capture)', () => {
  const capturedInputTokens = capture.usage.input_tokens + capture.usage.cache_creation_input_tokens + capture.usage.cache_read_input_tokens;

  it('reads the structured reply, the answer, the cost, the duration and the tokens from the real result line', () => {
    const result = readJsonResult(captureLine);

    expect(result.structured).toEqual(capture.structured_output);
    expect(result.structured).toEqual({ translations: [{ key: 'k1', text: '{1} löschen?' }] });
    expect(result.answer).toBe(capture.result);
    expect(result.isError).toBe(false);
    expect(result.costUsd).toBe(capture.total_cost_usd);
    expect(result.durationMs).toBe(capture.duration_ms);
    // The capture's cache field is non-zero, so a sum that dropped it would not equal the plain input count.
    expect(capturedInputTokens).toBeGreaterThan(capture.usage.input_tokens);
    expect(result.inputTokens).toBe(capturedInputTokens);
    expect(result.outputTokens).toBe(capture.usage.output_tokens);
  });

  it('finds the result line among a non-JSON line, an unrelated JSON line, and trailing noise', () => {
    const noisy = [
      'Warning: a banner the CLI printed first',
      JSON.stringify({ type: 'system', subtype: 'init' }),
      captureLine,
    ].join('\n');
    const withTrailingNoise = `${noisy}\n${JSON.stringify({ type: 'system', subtype: 'exit' })}\nbye\n`;

    expect(readJsonResult(noisy)).toEqual(readJsonResult(captureLine));
    expect(readJsonResult(withTrailingNoise)).toEqual(readJsonResult(captureLine));
  });

  it('reports is_error: true as isError, keeping the message a caller shows', () => {
    const failed = readJsonResult(JSON.stringify({ ...capture, is_error: true, result: 'API Error: 529 overloaded' }));

    expect(failed.isError).toBe(true);
    expect(failed.answer).toBe('API Error: 529 overloaded');
  });

  it('gives structured: null for a result without structured_output, and keeps the answer string', () => {
    const withoutStructured: Record<string, unknown> = { ...capture };
    delete withoutStructured.structured_output;
    const result = readJsonResult(JSON.stringify(withoutStructured));

    expect(result.structured).toBeNull();
    expect(result.answer).toBe(capture.result);
    expect(result.isError).toBe(false);
  });

  it('counts a missing or mistyped number as 0 instead of NaN or a string', () => {
    const noUsage = readJsonResult(JSON.stringify({ ...capture, usage: undefined, total_cost_usd: '0.02', duration_ms: null }));

    expect(noUsage.inputTokens).toBe(0);
    expect(noUsage.outputTokens).toBe(0);
    expect(noUsage.costUsd).toBe(0);
    expect(noUsage.durationMs).toBe(0);
    expect(noUsage.structured).toEqual(capture.structured_output);
  });

  it('returns the failed fallback when no line is a result', () => {
    const fallback = { answer: null, structured: null, costUsd: 0, durationMs: 0, isError: true, inputTokens: 0, outputTokens: 0 };

    expect(readJsonResult('')).toEqual(fallback);
    expect(readJsonResult('error: unknown option \'--bogus\'\n')).toEqual(fallback);
    expect(readJsonResult(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n{"type":"assistant"`)).toEqual(fallback);
  });

  it('feeds the capture\'s structured reply, and its answer string, through readReplies to a Map by key', () => {
    const fromStructured = readReplies(capture.structured_output);
    const fromAnswer = readReplies(capture.result);

    expect([...fromStructured.keys()]).toEqual(['k1']);
    expect(fromStructured.get('k1')).toEqual({ key: 'k1', text: '{1} löschen?' });
    expect(fromAnswer).toEqual(fromStructured);
  });
});

describe('createOpenAiCompatibleEngine, instructed style', () => {
  it('posts one chat-completions request carrying the prompts, the reply schema and thinking off', async () => {
    const items = [textRequestItem(), pluralRequestItem()];
    const fetchMock = stubFetch(() => jsonResponse(openAiCompatibleChatCompletionShape('{"translations":[]}')));
    // A trailing slash on the URL must not double the slash before /chat/completions.
    const engine = createOpenAiCompatibleEngine({ url: `${LOCAL_URL}/`, model: 'test-model', temperature: 0.4 });

    await engine.translateBatch({ locale: 'ru', items });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe('http://127.0.0.1:9931/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody(fetchMock, 0)).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: systemPrompt('ru') },
        { role: 'user', content: userPrompt(items) },
      ],
      temperature: 0.4,
      response_format: { type: 'json_schema', json_schema: { name: 'translations', strict: true, schema: REPLY_SCHEMA } },
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('reads the reply Map from the message content and maps the usage block, at no cost', async () => {
    const reply = {
      translations: [
        { key: 'text-key', text: 'Удалить {1}?' },
        { key: 'plural-key', forms: { one: '{1} задача', few: '{1} задачи', many: '{1} задач', other: '{1} задачи' } },
      ],
    };
    stubFetch(() => jsonResponse(openAiCompatibleChatCompletionShape(JSON.stringify(reply), { prompt_tokens: 812, completion_tokens: 64 })));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model' });

    const result = await engine.translateBatch({ locale: 'ru', items: [textRequestItem(), pluralRequestItem()] });

    expect(result.replies).toBeInstanceOf(Map);
    expect([...result.replies.keys()]).toEqual(['text-key', 'plural-key']);
    expect(result.replies.get('text-key')).toEqual(reply.translations[0]);
    expect(result.replies.get('plural-key')).toEqual(reply.translations[1]);
    expect(result.usage).toEqual({ inputTokens: 812, outputTokens: 64, costUsd: 0, durationMs: expect.any(Number) });
  });

  it('reports zero tokens when the server sends no usage block', async () => {
    stubFetch(() => jsonResponse(openAiCompatibleChatCompletionShape('{"translations":[{"key":"text-key","text":"x"}]}')));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model' });

    const result = await engine.translateBatch({ locale: 'ru', items: [textRequestItem()] });

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: expect.any(Number) });
  });

  it('throws when the server returns no string message content', async () => {
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model' });
    const items = [textRequestItem()];

    for (const body of [
      openAiCompatibleChatCompletionShape(null),
      openAiCompatibleChatCompletionShape({ translations: [] }),
      { id: 'chatcmpl-test', object: 'chat.completion', choices: [] },
      { error: { message: 'model not loaded' } },
    ]) {
      stubFetch(() => jsonResponse(body));
      await expect(engine.translateBatch({ locale: 'ru', items })).rejects.toThrow('the server returned no message content');
    }
  });

  it('throws when the content is not the reply shape, so the call counts as failed for every item', async () => {
    stubFetch(() => jsonResponse(openAiCompatibleChatCompletionShape('{"answer":"nope"}')));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model' });

    await expect(engine.translateBatch({ locale: 'ru', items: [textRequestItem()] })).rejects.toThrow('the reply has no "translations" list');
  });

  it('throws "HTTP <status> from <endpoint>" with the start of the body on a non-2xx response', async () => {
    stubFetch(() => new Response('model overloaded', { status: 503 }));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model' });

    await expect(engine.translateBatch({ locale: 'ru', items: [textRequestItem()] })).rejects.toThrow(
      /^HTTP 503 from http:\/\/127\.0\.0\.1:9931\/v1\/chat\/completions: model overloaded$/,
    );
  });

  it('cuts a long error body to 400 characters', async () => {
    stubFetch(() => new Response('x'.repeat(1000), { status: 500 }));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model' });

    const failure = await engine.translateBatch({ locale: 'ru', items: [textRequestItem()] }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message.startsWith('HTTP 500 from ')).toBe(true);
    expect(message.endsWith('x'.repeat(400))).toBe(true);
    expect(message).not.toContain('x'.repeat(401));
  });
});

describe('createOpenAiCompatibleEngine, translategemma style', () => {
  const evaluatedTokens = [11, 22, 33, 44, 55];
  const predictedTokens = [3, 5, 7, 9, 11];

  /** A distinct padded reply and distinct token counts per call, so a mix-up or a missing trim shows. */
  function completionRespond(callNumber: number): Response {
    return jsonResponse(llamaCppCompletionShape(`  ru-${callNumber} \n`, evaluatedTokens[callNumber - 1], predictedTokens[callNumber - 1]));
  }

  it('sends items shaped like a real run\'s, with a plural that borrows few and many', () => {
    const item = pluralRequestItem();

    expect(item.write).toEqual(['one', 'few', 'many', 'other']);
    expect(Object.keys(item.forms ?? {})).toEqual(['one', 'other']);
    expect(Object.keys(item.englishFor ?? {})).toEqual(['few', 'many']);
    expect(textRequestItem().text).toBe('Delete {1}?');
  });

  it('asks /completion at the host root once per form, with the raw prompt, temperature 0 and the stop token', async () => {
    const textItem = textRequestItem();
    const pluralItem = pluralRequestItem();
    const fetchMock = stubFetch(completionRespond);
    const engine = createOpenAiCompatibleEngine({ url: `${LOCAL_URL}/`, model: 'test-model', promptStyle: 'translategemma', temperature: 0.9 });

    await engine.translateBatch({ locale: 'ru', items: [textItem, pluralItem] });

    // One request for the text item, then one per written form of the plural: one, few, many, other.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const expectedSources = [
      textItem.text,
      pluralItem.forms?.one,
      pluralItem.englishFor?.few,
      pluralItem.englishFor?.many,
      pluralItem.forms?.other,
    ];
    expectedSources.forEach((source, callIndex) => {
      expect(fetchMock.mock.calls[callIndex][0]).toBe(COMPLETION_URL);
      expect(fetchMock.mock.calls[callIndex][1].method).toBe('POST');
      expect(requestBody(fetchMock, callIndex)).toEqual({
        prompt: translateGemmaPrompt(source as string, 'ru'),
        n_predict: 1024,
        // Not the engine's `temperature` option. TranslateGemma is always asked greedily.
        temperature: 0,
        stop: ['<end_of_turn>'],
      });
    });
  });

  it('replies { key, text } for a text item and { key, forms } with every written form for a plural, trimmed', async () => {
    stubFetch(completionRespond);
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model', promptStyle: 'translategemma' });

    const result = await engine.translateBatch({ locale: 'ru', items: [textRequestItem(), pluralRequestItem()] });

    expect(result.replies).toBeInstanceOf(Map);
    expect([...result.replies.keys()]).toEqual(['text-key', 'plural-key']);
    expect(result.replies.get('text-key')).toEqual({ key: 'text-key', text: 'ru-1' });
    expect(result.replies.get('plural-key')).toEqual({
      key: 'plural-key',
      forms: { one: 'ru-2', few: 'ru-3', many: 'ru-4', other: 'ru-5' },
    });
  });

  it('sums tokens_evaluated and tokens_predicted over every request, at no cost', async () => {
    stubFetch(completionRespond);
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model', promptStyle: 'translategemma' });

    const result = await engine.translateBatch({ locale: 'ru', items: [textRequestItem(), pluralRequestItem()] });

    expect(result.usage).toEqual({
      inputTokens: evaluatedTokens.reduce((sum, count) => sum + count, 0),
      outputTokens: predictedTokens.reduce((sum, count) => sum + count, 0),
      costUsd: 0,
      durationMs: expect.any(Number),
    });
  });

  it('translates a borrowed form from the item\'s englishFor sentence for that key, not from "other"', async () => {
    // pluralRequestItem() cannot show this: its englishFor sentences equal forms.other, so a
    // fallback to "other" would pass. A variation of it with a distinct sentence per borrowed key can.
    const pluralItem = pluralRequestItem();
    const distinct: RequestItem = {
      ...pluralItem,
      englishFor: { few: 'The distinct few sentence, {1} tasks', many: 'The distinct many sentence, {1} tasks' },
    };
    const fetchMock = stubFetch(completionRespond);
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model', promptStyle: 'translategemma' });

    await engine.translateBatch({ locale: 'ru', items: [distinct] });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const sentPrompts = [0, 1, 2, 3].map((callIndex) => (requestBody(fetchMock, callIndex) as { prompt: string }).prompt);
    expect(sentPrompts).toEqual([
      translateGemmaPrompt(pluralItem.forms?.one as string, 'ru'),
      translateGemmaPrompt('The distinct few sentence, {1} tasks', 'ru'),
      translateGemmaPrompt('The distinct many sentence, {1} tasks', 'ru'),
      translateGemmaPrompt(pluralItem.forms?.other as string, 'ru'),
    ]);
  });

  it('reaches /completion at the root for a server URL given with no /v1 too', async () => {
    const fetchMock = stubFetch(completionRespond);
    const engine = createOpenAiCompatibleEngine({ url: 'http://127.0.0.1:9931', model: 'test-model', promptStyle: 'translategemma' });

    await engine.translateBatch({ locale: 'ru', items: [textRequestItem()] });

    expect(fetchMock.mock.calls[0][0]).toBe(COMPLETION_URL);
  });

  it('throws "HTTP <status> from <endpoint>" when /completion fails, and stops asking', async () => {
    const fetchMock = stubFetch(() => new Response('no slot available', { status: 503 }));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'test-model', promptStyle: 'translategemma' });

    await expect(engine.translateBatch({ locale: 'ru', items: [pluralRequestItem()] })).rejects.toThrow(
      /^HTTP 503 from http:\/\/127\.0\.0\.1:9931\/completion: no slot available$/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createOpenAiCompatibleEngine, identity', () => {
  it('is named local:<model> and closes without throwing or reaching the network', () => {
    const fetchMock = stubFetch(() => jsonResponse({}));
    const engine = createOpenAiCompatibleEngine({ url: LOCAL_URL, model: 'my-model' });

    expect(engine.name).toBe('local:my-model');
    expect(() => engine.close()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to llama-server\'s address and the refill model the bake-off picked', async () => {
    const fetchMock = stubFetch(() => jsonResponse(openAiCompatibleChatCompletionShape('{"translations":[]}')));
    const engine = createOpenAiCompatibleEngine({});

    expect(engine.name).toBe(`local:${REFILL_MODEL.name}`);
    await engine.translateBatch({ locale: 'de', items: [textRequestItem()] });

    expect(DEFAULT_LOCAL_URL).toBe(LOCAL_URL);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9931/v1/chat/completions');
    expect((requestBody(fetchMock, 0) as { model: string }).model).toBe(REFILL_MODEL.name);
  });
});
